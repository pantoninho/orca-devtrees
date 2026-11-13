// The services panel: every local worktree with a devtrees.yaml, grouped by repo, each with its
// stack and its own Up, Down and Restart. Every read and action goes through the worker
// (src/worker.ts), which posts `stack.changed` after actions, on workspace changes and on its poll.
// An action names the row pressed; the focused worktree only highlights a row.
//
// One line per worktree: a status dot, the name, and the branch when it differs. Running rows and
// the focused one come first; the other stopped rows fold into one "N stopped" line. A row opens
// to show its actions and services.
import {
  atom,
  Box,
  Button,
  Callout,
  Code,
  Collapsible,
  EmptyState,
  IconButton,
  Link,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import { MIN_DEVTREES_VERSION } from './devtrees'
import type { InstanceView, RepoView, RowView, ServiceView, StackAction, StackView, TerminalKind } from './protocol'
import { branchNote, portLabels, rowDot, rowNote, runningCount, serviceDot, splitRows, type Dot } from './view'

const view = atom<StackView | null>(null)
/** Why the last press did not start, or why the worker failed to answer. */
const notice = atom<string | null>(null)
/**
 * Rows the person opened or closed, by workspace id. Keyed, so it survives a hot reload; a row
 * not in it is open when it is the focused one.
 */
const expanded = atom<Record<string, boolean>>('expanded', {})
/** Open "N stopped" lines and shared sections, by `stopped:<repo key>` or `shared:<repo key>`. */
const sections = atom<Record<string, boolean>>('sections', {})

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

const HEALTH_TEXT = { ready: 'healthy', not_ready: 'not ready', unknown: 'no health check' } as const
const BUSY_TEXT = { up: 'Starting', down: 'Stopping', restart: 'Restarting', 'restart-service': 'Restarting' } as const

function StatusDot({ tone }: { tone: Dot }) {
  return tone === 'neutral' ? <Text size="xs" muted>●</Text> : <Text size="xs" tone={tone}>●</Text>
}

/** Where a service's buttons run, and whether it belongs to the shared instance. */
interface Owner {
  /** The workspace the commands run in: the row's own, or for the shared instance one row of its repo. */
  workspaceId: string
  shared: boolean
  /** Prefix of the buttons' keys: the row's workspace id, or `shared:<repo key>`. */
  key: string
}

/** Such as `running · healthy`, and the tier when a worktree's service is a shared one. */
function detailOf(service: ServiceView, owner: Owner): string {
  const parts = [service.status.toLowerCase()]
  if (service.state === 'active') parts.push(HEALTH_TEXT[service.health])
  if (!owner.shared && service.tier === 'shared') parts.push('shared')
  return parts.join(' · ')
}

/** `web :52896 · api :52897`, each port a localhost link, wrapping like a sentence. */
function Ports({ service }: { service: ServiceView }) {
  if (service.ports.length === 0) return null
  const labels = portLabels(service.ports)
  return (
    <Text size="xs" muted>
      {labels.flatMap((p, i) => [
        i === 0 ? '' : ' · ',
        `${p.label} `,
        <Link href={`http://localhost:${p.port}`} key={p.name}>{`:${p.port}`}</Link>
      ])}
    </Text>
  )
}

function ServiceRow({ service, owner, disabled }: { service: ServiceView; owner: Owner; disabled: boolean }) {
  // Shared services are never restarted from a worktree.
  const canRestart = !owner.shared && service.tier === 'isolated'
  const workspaceId = owner.workspaceId
  return (
    <Stack gap="none">
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <StatusDot tone={serviceDot(service)} />
          <Text size="sm">{service.name}</Text>
          <Text size="xs" muted truncate>
            {detailOf(service, owner)}
          </Text>
        </Row>
        <Row gap="none" align="center">
          <IconButton
            key={`logs:${owner.key}:${service.name}`}
            icon="file-text"
            label={`Logs ${service.name}`}
            tooltip={`Follow the logs of ${service.name}`}
            variant="ghost"
            size="xs"
            onPress={() => openTerminal(workspaceId, 'logs', { service: service.name, shared: owner.shared })}
          />
          {canRestart ? (
            <IconButton
              key={`restart:${owner.key}:${service.name}`}
              icon="refresh"
              label={`Restart ${service.name}`}
              tooltip={`Restart ${service.name}`}
              variant="ghost"
              size="xs"
              disabled={disabled}
              onPress={() => start(workspaceId, 'restart-service', service.name)}
            />
          ) : null}
        </Row>
      </Row>
      <Box paddingX="md">
        <Ports service={service} />
      </Box>
    </Stack>
  )
}

function Services({ instance, owner, disabled }: { instance: InstanceView; owner: Owner; disabled: boolean }) {
  if (instance.services.length === 0) {
    return <Text muted size="xs">{instance.status === 'down' ? 'Not running.' : 'No services reported.'}</Text>
  }
  return (
    <Stack gap="xs">
      {instance.services.map((s) => (
        <ServiceRow service={s} owner={owner} disabled={disabled} key={s.name} />
      ))}
    </Stack>
  )
}

/** The actions of an open row: small buttons with labels. */
function Actions({ row }: { row: RowView }) {
  const id = row.workspace.id
  const busy = row.busy !== null
  const down = row.stack?.status === 'down'
  const unreadable = row.stack === null
  return (
    <Row gap="none" wrap>
      <Button key={`up:${id}`} icon="play" size="xs" variant="ghost" disabled={busy} onPress={() => start(id, 'up')}>
        Up
      </Button>
      <Button key={`down:${id}`} icon="stop" size="xs" variant="ghost" disabled={busy || down} onPress={() => start(id, 'down')}>
        Down
      </Button>
      <Button key={`restart:${id}`} icon="refresh" size="xs" variant="ghost" disabled={busy || down} onPress={() => start(id, 'restart')}>
        Restart
      </Button>
      <Button
        key={`logs:${id}`}
        icon="file-text"
        size="xs"
        variant="ghost"
        tooltip="Follow the logs of every service"
        disabled={unreadable || down}
        onPress={() => openTerminal(id, 'logs')}
      >
        Logs
      </Button>
      <Button
        key={`attach:${id}`}
        icon="terminal"
        size="xs"
        variant="ghost"
        tooltip="Open the process-compose TUI"
        disabled={unreadable || down}
        onPress={() => openTerminal(id, 'attach')}
      >
        Attach
      </Button>
    </Row>
  )
}

function WorktreeRow({ row, focused, executable }: { row: RowView; focused: boolean; executable: string }) {
  const id = row.workspace.id
  const open = read(expanded)[id] ?? focused
  const branch = branchNote(row)
  const note = rowNote(row)
  const failed = row.lastError !== null || row.stack === null
  return (
    <Box radius="md" paddingX="xs" background={focused ? 'muted' : 'none'}>
      <Stack gap="xs">
        <Row key={`line:${id}`} gap="xs" align="center">
          <IconButton
            key={`row:${id}`}
            icon={open ? 'expand' : 'next'}
            label={`${open ? 'Close' : 'Open'} ${row.workspace.name}`}
            variant="ghost"
            size="xs"
            onPress={() => update(expanded, (prev) => ({ ...prev, [id]: !open }))}
          />
          <StatusDot tone={rowDot(row)} />
          <Text size="sm" weight={focused ? 'semibold' : 'medium'} truncate>
            {row.workspace.name}
          </Text>
          {branch === null ? null : (
            <Text size="xs" muted truncate>
              {branch}
            </Text>
          )}
          {note === null ? null : failed ? (
            <Text size="xs" tone="danger" truncate>
              {note}
            </Text>
          ) : (
            <Text size="xs" muted truncate>
              {note}
            </Text>
          )}
        </Row>
        {open ? (
          <Box paddingX="md" paddingY="xs">
            <Stack gap="sm">
              <Actions row={row} />
              {row.busy === null ? null : (
                <Text size="xs" tone="accent">
                  {BUSY_TEXT[row.busy.action]}
                  {row.busy.service === null ? '' : ` ${row.busy.service}`}, since <RelativeTime at={row.busy.since} />
                </Text>
              )}
              {row.lastError === null ? null : (
                <Callout tone="danger" title={`${row.lastError.action} failed: ${row.lastError.code}`}>
                  <Text size="xs">{row.lastError.message}</Text>
                </Callout>
              )}
              {row.stack === null ? (
                <Text muted size="xs">Could not read this stack.</Text>
              ) : (
                <Services instance={row.stack} owner={{ workspaceId: id, shared: false, key: id }} disabled={row.busy !== null} />
              )}
              <Text muted size="xs" truncate>
                <Code>{executable}</Code> runs in {row.workspace.path}
              </Text>
            </Stack>
          </Box>
        ) : null}
      </Stack>
    </Box>
  )
}

/** A function, not a component: a component's key would be prefixed to the section's own. */
function sharedSection(repo: RepoView) {
  // The shared instance's commands run in one of the repo's worktrees: any of them reaches it.
  const owner: Owner = { workspaceId: repo.rows[0]?.workspace.id ?? '', shared: true, key: `shared:${repo.key}` }
  const instance = repo.shared
  const title = instance === null || instance.status === 'down' ? 'Shared · down' : `Shared · ${runningCount(instance)} running`
  return (
    <Collapsible
      key={owner.key}
      title={title}
      open={read(sections)[owner.key] ?? false}
      onChange={(next) => update(sections, (prev) => ({ ...prev, [owner.key]: next }))}
    >
      {instance === null ? (
        <Text muted size="xs">Not running.</Text>
      ) : (
        <Stack gap="xs">
          <Row gap="none">
            <Button
              key={`attach:${owner.key}`}
              icon="terminal"
              size="xs"
              variant="ghost"
              tooltip="Open the shared instance's process-compose TUI"
              onPress={() => openTerminal(owner.workspaceId, 'attach', { shared: true })}
            >
              Attach
            </Button>
          </Row>
          <Services instance={instance} owner={owner} disabled />
        </Stack>
      )}
    </Collapsible>
  )
}

function Repo({ repo, v }: { repo: RepoView; v: StackView }) {
  const { shown, folded } = splitRows(repo.rows, v.focusedId)
  const stoppedKey = `stopped:${repo.key}`
  const row = (r: RowView) => (
    <WorktreeRow row={r} focused={r.workspace.id === v.focusedId} executable={v.executable} key={r.workspace.id} />
  )
  return (
    <Stack gap="xs">
      <Text size="xs" weight="semibold" muted>
        {repo.label}
      </Text>
      {repo.kind === 'error' ? (
        <Text size="xs" tone="danger">
          devtrees failed: {repo.message ?? 'unknown error'}
        </Text>
      ) : null}
      {shown.map(row)}
      {folded.length === 0 ? null : (
        <Collapsible
          key={stoppedKey}
          title={`${folded.length} stopped`}
          open={read(sections)[stoppedKey] ?? false}
          onChange={(next) => update(sections, (prev) => ({ ...prev, [stoppedKey]: next }))}
        >
          <Stack gap="xs">{folded.map(row)}</Stack>
        </Collapsible>
      )}
      {sharedSection(repo)}
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

/** Such as `2 running · 5 stopped`. */
function totals(v: StackView): string {
  const rows = v.repos.flatMap((r) => r.rows)
  const running = rows.filter((r) => r.stack !== null && r.stack.status !== 'down').length
  const stopped = rows.filter((r) => r.stack?.status === 'down').length
  return `${running} running · ${stopped} stopped`
}

export default function Panel() {
  const v = read(view)
  const note = read(notice)
  if (v === null) {
    return note === null ? <Skeleton lines={3} label="Loading stacks" /> : <Callout tone="danger" title="No answer from the worker">{note}</Callout>
  }
  const ok = v.kind === 'ok' && v.repos.length > 0
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Text size="xs" muted>
          {ok ? totals(v) : ''}
        </Text>
        <IconButton icon="refresh" label="Refresh" tooltip="Refresh" variant="ghost" size="xs" onPress={() => load(true)} />
      </Row>
      {note === null ? null : <Callout tone="warning">{note}</Callout>}
      {v.kind !== 'ok' ? (
        <Problem v={v} />
      ) : v.repos.length === 0 ? (
        <EmptyState icon="folder" title="No devtrees worktrees" description="No local worktree open in Orca has a devtrees.yaml." />
      ) : (
        <Stack gap="md">
          {v.repos.map((repo) => (
            <Repo repo={repo} v={v} key={repo.key} />
          ))}
        </Stack>
      )}
      {v.focusUnknown ? (
        <Text muted size="xs">
          The orca CLI could not be run, so the focused worktree is not highlighted.
        </Text>
      ) : null}
    </Stack>
  )
}
