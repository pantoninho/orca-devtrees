// The services panel. Every read and action goes through the worker (src/worker.ts), which posts
// `stack.changed` after actions, on workspace changes and on its poll. An action names the line
// pressed; the focused worktree only decides what is drawn first.
//
// Three parts, top to bottom:
// - the focused worktree, always open: `<repo> · <branch>`, its actions, and one line per service
//   (its own, then the repo's shared ones);
// - a flat list of the other stacks that run, `<repo> · <name>` and a dot per service, plus each
//   running shared instance as `<repo> · shared`. A line opens in place to show the same actions
//   and services;
// - every other stopped worktree, folded into one muted "N stopped" line.
// Stopped stacks are muted everywhere: grey text, hollow dots, no bold.
import {
  atom,
  Button,
  Callout,
  EmptyState,
  IconButton,
  Link,
  plugin,
  read,
  RelativeTime,
  Row,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  update,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { MIN_DEVTREES_VERSION } from './devtrees'
import type { InstanceView, RepoView, RowView, StackAction, StackView, TerminalKind } from './protocol'
import {
  instanceDot,
  layoutOf,
  nameOf,
  portLabels,
  rowDot,
  rowNote,
  serviceDot,
  serviceLines,
  type Dot,
  type ListEntry,
  type Placed,
  type ServiceLine
} from './view'

const view = atom<StackView | null>(null)
/** Why the last press did not start, or why the worker failed to answer. */
const notice = atom<string | null>(null)
/**
 * Lines the person opened, by workspace id, `shared:<repo key>` or `stopped`. Keyed, so it
 * survives a hot reload. Every line starts closed; the focused worktree is always open.
 */
const expanded = atom<Record<string, boolean>>('expanded', {})

async function load(refresh = false): Promise<void> {
  try {
    set(view, await plugin.request('stack.get', { refresh }))
    set(notice, null)
  } catch (error) {
    set(notice, (error as Error).message)
  }
}

async function start(workspaceId: string, action: StackAction, service?: string): Promise<void> {
  try {
    const input = service ? { workspaceId, action, service } : { workspaceId, action }
    const answer = await plugin.request('stack.action', input)
    set(notice, answer.started ? null : answer.reason)
  } catch (error) {
    set(notice, (error as Error).message)
  }
}

async function openTerminal(workspaceId: string, what: TerminalKind, options: { service?: string; shared?: boolean } = {}) {
  try {
    const answer = await plugin.request('terminal.open', { workspaceId, what, ...options })
    set(notice, answer.started ? null : answer.reason)
  } catch (error) {
    set(notice, (error as Error).message)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('stack.changed', (next) => set(view, next)))
  void load()
}

const BUSY_TEXT = { up: 'Starting', down: 'Stopping', restart: 'Restarting', 'restart-service': 'Restarting' } as const

const isOpen = (key: string) => read(expanded)[key] ?? false
const toggle = (key: string) => update(expanded, (prev) => ({ ...prev, [key]: !(prev[key] ?? false) }))

/** A filled dot in its tone; a stopped one is hollow and grey. */
function dot(tone: Dot, key?: string) {
  return tone === 'neutral' ? (
    <Text size="xs" muted key={key}>
      ○
    </Text>
  ) : (
    <Text size="xs" tone={tone} key={key}>
      ●
    </Text>
  )
}

/** `<repo> · <name>`, the repo part muted; all muted, and never bold, when stopped. */
function title(repo: string, name: string, options: { stopped: boolean; strong?: boolean }, key = 'title') {
  const weight = options.strong && !options.stopped ? 'semibold' : 'regular'
  return (
    <Text size="sm" muted={options.stopped} truncate key={key}>
      <Text size="sm" muted>
        {`${repo} · `}
      </Text>
      <Text size="sm" weight={weight} muted={options.stopped}>
        {name}
      </Text>
    </Text>
  )
}

/** Where a service's buttons run, and whether it belongs to the shared instance. */
interface Owner {
  /** The workspace the commands run in: the row's own, or for the shared instance one row of its repo. */
  workspaceId: string
  /** Prefix of the buttons' keys: the row's workspace id; `shared:<repo key>` for shared services. */
  key: string
  repoKey: string
}

/** One service: a dot, its name, its ports on one line, a `shared` tag, and its buttons. */
function serviceLine({ service, shared, placeholder }: ServiceLine, owner: Owner, showTag: boolean, disabled: boolean) {
  const key = shared ? `shared:${owner.repoKey}` : owner.key
  const stopped = placeholder || service.state !== 'active'
  const labels = portLabels(service.ports)
  const workspaceId = owner.workspaceId
  return (
    <Row key={`service:${key}:${service.name}`} justify="between" align="center" gap="xs">
      <Row gap="xs" align="center">
        {dot(serviceDot(service))}
        <Text size="sm" muted={stopped}>
          {service.name}
        </Text>
        {labels.length === 0 ? null : (
          <Text size="xs" muted truncate>
            {labels.flatMap((p, i) => [
              i === 0 ? '' : ' ',
              labels.length === 1 ? '' : `${p.label} `,
              <Link href={`http://localhost:${p.port}`} key={p.name}>{`:${p.port}`}</Link>
            ])}
          </Text>
        )}
        {showTag && shared ? (
          <Text size="xs" muted>
            shared
          </Text>
        ) : null}
      </Row>
      <Row gap="none" align="center">
        {!shared && service.tier === 'isolated' ? (
          <IconButton
            key={`restart:${key}:${service.name}`}
            icon="refresh"
            label={`Restart ${service.name}`}
            tooltip={`Restart ${service.name}`}
            variant="ghost"
            size="xs"
            disabled={disabled || placeholder}
            onPress={() => start(workspaceId, 'restart-service', service.name)}
          />
        ) : null}
        <IconButton
          key={`logs:${key}:${service.name}`}
          icon="file-text"
          label={`Logs ${service.name}`}
          tooltip={`Follow the logs of ${service.name}`}
          variant="ghost"
          size="xs"
          disabled={placeholder}
          onPress={() => openTerminal(workspaceId, 'logs', { service: service.name, shared })}
        />
        <IconButton
          key={`attach:${key}:${service.name}`}
          icon="terminal"
          label={`Attach ${service.name}`}
          tooltip={shared ? 'Open the shared instance in process-compose' : 'Open this stack in process-compose'}
          variant="ghost"
          size="xs"
          disabled={placeholder}
          onPress={() => openTerminal(workspaceId, 'attach', { shared })}
        />
      </Row>
    </Row>
  )
}

function services(lines: ServiceLine[], owner: Owner, showTag: boolean, disabled: boolean, emptyText: string) {
  if (lines.length === 0) {
    return (
      <Text muted size="xs" key={`services:${owner.key}`}>
        {emptyText}
      </Text>
    )
  }
  return (
    <Stack gap="none" key={`services:${owner.key}`}>
      {lines.map((l) => serviceLine(l, owner, showTag, disabled))}
    </Stack>
  )
}

/** Up, Down and Restart, then the logs of every service and Attach. Up is the one left when stopped. */
function actions(row: RowView) {
  const id = row.workspace.id
  const busy = row.busy !== null
  const down = row.stack?.status === 'down'
  const unreadable = row.stack === null
  return (
    <Row gap="none" align="center" key={`actions:${id}`}>
      <Button key={`up:${id}`} icon="play" size="xs" variant="ghost" tone={down ? 'accent' : undefined} disabled={busy} onPress={() => start(id, 'up')}>
        Up
      </Button>
      <Button key={`down:${id}`} icon="stop" size="xs" variant="ghost" disabled={busy || down} onPress={() => start(id, 'down')}>
        Down
      </Button>
      <IconButton
        key={`restart:${id}`}
        icon="refresh"
        label="Restart"
        tooltip="Restart the stack"
        size="xs"
        variant="ghost"
        disabled={busy || down}
        onPress={() => start(id, 'restart')}
      />
      <IconButton
        key={`logs:${id}`}
        icon="file-text"
        label="Logs all"
        tooltip="Follow the logs of every service"
        size="xs"
        variant="ghost"
        disabled={unreadable || down}
        onPress={() => openTerminal(id, 'logs')}
      />
      <IconButton
        key={`attach:${id}`}
        icon="terminal"
        label="Attach"
        tooltip="Open the process-compose TUI"
        size="xs"
        variant="ghost"
        disabled={unreadable || down}
        onPress={() => openTerminal(id, 'attach')}
      />
    </Row>
  )
}

/** What is going on in a worktree: the action running, the last failure, and its services. */
function details({ repo, row }: Placed, withShared: boolean) {
  const id = row.workspace.id
  const lines = serviceLines(repo, row, withShared)
  return [
    row.busy === null ? null : (
      <Text size="xs" tone="accent" key={`busy:${id}`}>
        {BUSY_TEXT[row.busy.action]}
        {row.busy.service === null ? '' : ` ${row.busy.service}`}, since <RelativeTime at={row.busy.since} />
      </Text>
    ),
    row.lastError === null ? null : (
      <Callout tone="danger" title={`${row.lastError.action} failed: ${row.lastError.code}`} key={`error:${id}`}>
        <Text size="xs">{row.lastError.message}</Text>
      </Callout>
    ),
    row.stack === null ? (
      <Text muted size="xs" key={`services:${id}`}>
        Could not read this stack.
      </Text>
    ) : (
      services(lines, { workspaceId: id, key: id, repoKey: repo.key }, withShared, row.busy !== null, row.stack.status === 'down' ? 'Not running.' : 'No services reported.')
    )
  ]
}

const stoppedRow = (row: RowView) => rowDot(row) === 'neutral'

/** A short note after a line's name, such as `starting` or `up failed`. */
function note(row: RowView) {
  const text = rowNote(row)
  if (text === null) return null
  const failed = row.lastError !== null || row.stack === null
  return failed ? (
    <Text size="xs" tone="danger" truncate key="note">
      {text}
    </Text>
  ) : (
    <Text size="xs" muted truncate key="note">
      {text}
    </Text>
  )
}

/** The focused worktree: its title and actions on one line, then its services. Always open. */
function focusedSection(placed: Placed) {
  const { repo, row } = placed
  const id = row.workspace.id
  return (
    <Stack gap="xs" key={`focused:${id}`}>
      <Row key={`line:${id}`} justify="between" align="center" gap="xs" wrap>
        <Row gap="xs" align="center">
          {title(repo.label, nameOf(row), { stopped: stoppedRow(row), strong: true })}
          {note(row)}
        </Row>
        {actions(row)}
      </Row>
      {details(placed, true)}
    </Stack>
  )
}

/** One closed-or-open line: a dot, `<repo> · <name>`, what follows, and a chevron at the right. */
function line(key: string, label: string, head: OrcaNode, open: boolean) {
  return (
    <Row key={`line:${key}`} justify="between" align="center" gap="xs">
      <Row gap="xs" align="center">
        {head}
      </Row>
      <IconButton
        key={`row:${key}`}
        icon={open ? 'expand' : 'next'}
        label={`${open ? 'Close' : 'Open'} ${label}`}
        variant="ghost"
        size="xs"
        onPress={() => toggle(key)}
      />
    </Row>
  )
}

function rowEntry(placed: Placed) {
  const { repo, row } = placed
  const id = row.workspace.id
  const open = isOpen(id)
  const stopped = stoppedRow(row)
  const dots = serviceLines(repo, row, false).map((l) => serviceDot(l.service))
  return (
    <Stack gap="xs" key={`entry:${id}`}>
      {line(
        id,
        `${repo.label} · ${nameOf(row)}`,
        [
          dot(rowDot(row), 'dot'),
          title(repo.label, nameOf(row), { stopped }),
          stopped || dots.length === 0 ? null : (
            <Text size="xs" key="dots">
              {dots.map((d, i) => dot(d, String(i)))}
            </Text>
          ),
          note(row)
        ],
        open
      )}
      {open ? (
        <Stack gap="xs" key={`open:${id}`}>
          <Row justify="end" key={`bar:${id}`}>
            {actions(row)}
          </Row>
          {details(placed, false)}
        </Stack>
      ) : null}
    </Stack>
  )
}

/** A repo's running shared instance, `<repo> · shared`. Its commands run in one of the repo's worktrees. */
function sharedEntry(repo: RepoView, instance: InstanceView) {
  const key = `shared:${repo.key}`
  const owner: Owner = { workspaceId: repo.rows[0]?.workspace.id ?? '', key, repoKey: repo.key }
  const open = isOpen(key)
  const lines = instance.services.map((s): ServiceLine => ({ service: s, shared: true, placeholder: false }))
  return (
    <Stack gap="xs" key={`entry:${key}`}>
      {line(
        key,
        `${repo.label} · shared`,
        [
          dot(instanceDot(instance), 'dot'),
          title(repo.label, 'shared', { stopped: false }),
          <Text size="xs" key="dots">
            {lines.map((l, i) => dot(serviceDot(l.service), String(i)))}
          </Text>
        ],
        open
      )}
      {open ? (
        <Stack gap="xs" key={`open:${key}`}>
          <Row justify="end" key={`bar:${key}`}>
            <IconButton
              key={`attach:${key}`}
              icon="terminal"
              label="Attach"
              tooltip="Open the shared instance's process-compose TUI"
              size="xs"
              variant="ghost"
              onPress={() => openTerminal(owner.workspaceId, 'attach', { shared: true })}
            />
          </Row>
          {services(lines, owner, false, true, 'No services reported.')}
        </Stack>
      ) : null}
    </Stack>
  )
}

function entry(e: ListEntry) {
  return e.kind === 'row' ? rowEntry(e) : sharedEntry(e.repo, e.repo.shared as InstanceView)
}

/** Every stopped worktree that is not focused, in one dim line that opens to list them. */
function stoppedSection(stopped: Placed[]) {
  const open = isOpen('stopped')
  return (
    <Stack gap="xs" key="stopped">
      {line('stopped', `${stopped.length} stopped`, <Text size="sm" muted>{`${stopped.length} stopped`}</Text>, open)}
      {open ? (
        <Stack gap="xs" key="open:stopped">
          {stopped.map(rowEntry)}
        </Stack>
      ) : null}
    </Stack>
  )
}

function Problem({ v }: { v: StackView }) {
  if (v.kind === 'not-installed') {
    return (
      <EmptyState
        icon="warning"
        title="devtrees not found"
        description={`Could not run "${v.executable}". Install devtrees ${MIN_DEVTREES_VERSION} or newer, or set its path in the plugin settings.`}
      />
    )
  }
  return (
    <EmptyState
      icon="warning"
      title="devtrees is too old"
      description={`"${v.executable}" lacks ls --services. Upgrade to devtrees ${MIN_DEVTREES_VERSION} or newer.`}
    />
  )
}

function Stacks({ v }: { v: StackView }) {
  const { focused, running, stopped } = layoutOf(v)
  const failures = v.repos.filter((r) => r.kind === 'error')
  const below = running.length > 0 || stopped.length > 0
  return (
    <Stack gap="sm">
      {failures.map((r) => (
        <Text size="xs" tone="danger" key={`failed:${r.key}`}>
          {`${r.label}: devtrees failed: ${r.message ?? 'unknown error'}`}
        </Text>
      ))}
      {focused === null ? null : focusedSection(focused)}
      {focused !== null && below ? <Separator key="separator" /> : null}
      {running.length === 0 ? null : (
        <Stack gap="xs" key="running">
          {running.map(entry)}
        </Stack>
      )}
      {stopped.length === 0 ? null : stoppedSection(stopped)}
    </Stack>
  )
}

export default function Panel() {
  const v = read(view)
  const note = read(notice)
  if (v === null) {
    return note === null ? <Skeleton lines={3} label="Loading stacks" /> : <Callout tone="danger" title="No answer from the worker">{note}</Callout>
  }
  return (
    <Stack gap="sm">
      {note === null ? null : <Callout tone="warning">{note}</Callout>}
      {v.kind !== 'ok' ? (
        <Problem v={v} />
      ) : v.repos.length === 0 ? (
        <EmptyState icon="folder" title="No devtrees worktrees" description="No local worktree open in Orca has a devtrees.yaml." />
      ) : (
        <Stacks v={v} />
      )}
      <Row justify="between" align="center">
        <Text muted size="xs">
          {v.focusUnknown ? 'The orca CLI could not be run, so the focused worktree is not shown.' : ''}
        </Text>
        <IconButton icon="refresh" label="Refresh" tooltip="Refresh" variant="ghost" size="xs" onPress={() => load(true)} />
      </Row>
    </Stack>
  )
}
