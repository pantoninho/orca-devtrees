// The services panel: every local worktree with a devtrees.yaml, grouped by repo, each with its
// stack and its own Up, Down and Restart. Every read and action goes through the worker
// (src/worker.ts), which posts `stack.changed` after actions, on workspace changes and on its poll.
// An action names the row pressed; the focused worktree only highlights a row.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Collapsible,
  EmptyState,
  Heading,
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

const view = atom<StackView | null>(null)
/** Why the last press did not start, or why the worker failed to answer. */
const notice = atom<string | null>(null)
/**
 * Rows the person opened or closed, by workspace id. Keyed, so it survives a hot reload; a row
 * not in it is open when it is the focused one.
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

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('stack.changed', (next) => set(view, next)))
  void load()
}

const STATUS_TONE = { up: 'success', partial: 'danger', down: 'neutral', unknown: 'warning' } as const
const STATUS_TEXT = { up: 'up', partial: 'degraded', down: 'down', unknown: 'not answering' } as const
const STATE_TONE = { active: 'success', dead: 'danger', done: 'neutral' } as const
const HEALTH_TEXT = { ready: 'healthy', not_ready: 'not ready', unknown: null } as const
const BUSY_TEXT = { up: 'Starting', down: 'Stopping', restart: 'Restarting', 'restart-service': 'Restarting' } as const
const BUSY_WORD = { up: 'starting', down: 'stopping', restart: 'restarting', 'restart-service': 'restarting' } as const

async function openTerminal(workspaceId: string, what: TerminalKind, options: { service?: string; shared?: boolean } = {}) {
  try {
    const answer = await plugin.request('terminal.open', { workspaceId, what, ...options })
    set(notice, answer.started ? null : answer.reason)
  } catch (error) {
    set(notice, (error as Error).message)
  }
}

/** Where a service's buttons run, and whether it belongs to the shared instance. */
interface Owner {
  /** The workspace the commands run in: the row's own, or for the shared instance one row of its repo. */
  workspaceId: string
  shared: boolean
  /** Prefix of the buttons' keys: the row's workspace id, or `shared:<repo key>`. */
  key: string
}

function ServiceRow({ service, owner, disabled }: { service: ServiceView; owner: Owner; disabled: boolean }) {
  const health = HEALTH_TEXT[service.health]
  // Shared services are never restarted from a worktree.
  const canRestart = !owner.shared && service.tier === 'isolated'
  const workspaceId = owner.workspaceId
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs">
      <Row justify="between" align="center">
        <Row gap="xs" align="center" wrap>
          <Text weight="medium">{service.name}</Text>
          <Badge tone={STATE_TONE[service.state]}>{service.state}</Badge>
          {health === null ? null : <Badge tone={service.health === 'ready' ? 'success' : 'warning'}>{health}</Badge>}
          <Badge tone={service.tier === 'shared' ? 'accent' : 'neutral'}>{service.tier}</Badge>
        </Row>
        <Row gap="none" align="center">
          <IconButton
            key={`logs:${owner.key}:${service.name}`}
            icon="file-text"
            label={`Logs ${service.name}`}
            tooltip={`Follow the logs of ${service.name} in a terminal`}
            variant="ghost"
            size="sm"
            onPress={() => openTerminal(workspaceId, 'logs', { service: service.name, shared: owner.shared })}
          />
          {canRestart ? (
            <IconButton
              key={`restart:${owner.key}:${service.name}`}
              icon="refresh"
              label={`Restart ${service.name}`}
              tooltip={`Restart ${service.name}`}
              variant="ghost"
              size="sm"
              disabled={disabled}
              onPress={() => start(workspaceId, 'restart-service', service.name)}
            />
          ) : null}
        </Row>
      </Row>
      {service.ports.length === 0 ? null : (
        <Row gap="sm" wrap>
          {service.ports.map((p) => (
            <Text size="xs" muted key={p.name}>
              {p.name} <Link href={`http://localhost:${p.port}`}>{`localhost:${p.port}`}</Link>
            </Text>
          ))}
        </Row>
      )}
    </Box>
  )
}

function Services({ instance, owner, disabled }: { instance: InstanceView; owner: Owner; disabled: boolean }) {
  if (instance.services.length === 0) {
    return <Text muted size="sm">{instance.status === 'down' ? 'Not running.' : 'No services reported.'}</Text>
  }
  return (
    <Stack gap="xs">
      {instance.services.map((s) => (
        <ServiceRow service={s} owner={owner} disabled={disabled} key={s.name} />
      ))}
    </Stack>
  )
}

/** Such as `feature-x · up`, or `main · starting`. */
function summaryOf(row: RowView, focused: boolean): string {
  const parts: string[] = []
  if (row.workspace.branch !== null && row.workspace.branch !== row.workspace.name) parts.push(row.workspace.branch)
  if (row.busy !== null) parts.push(BUSY_WORD[row.busy.action])
  else if (row.lastError !== null) parts.push(`${row.lastError.action} failed`)
  else if (row.stack === null) parts.push('unknown')
  else if (row.stack.status === 'partial') {
    parts.push(`${row.stack.services.filter((s) => s.state === 'dead').length} dead`)
  } else parts.push(STATUS_TEXT[row.stack.status])
  if (focused) parts.push('focused')
  return parts.join(' · ')
}

function WorktreeRow({ row, focused, executable }: { row: RowView; focused: boolean; executable: string }) {
  const id = row.workspace.id
  const open = read(expanded)[id] ?? focused
  const stack = row.stack
  const busy = row.busy !== null
  const down = stack?.status === 'down'
  return (
    <Box border={focused ? 'accent' : true} radius="md" padding="xs">
      <Collapsible
        key={`row:${id}`}
        title={row.workspace.name}
        description={summaryOf(row, focused)}
        open={open}
        onChange={(next) => update(expanded, (prev) => ({ ...prev, [id]: next }))}
      >
        <Stack gap="sm">
          <Row gap="xs" wrap>
            <Button key={`up:${id}`} icon="play" size="sm" disabled={busy} onPress={() => start(id, 'up')}>
              Up
            </Button>
            <Button key={`down:${id}`} icon="stop" size="sm" variant="outline" disabled={busy || down} onPress={() => start(id, 'down')}>
              Down
            </Button>
            <Button
              key={`restart:${id}`}
              icon="refresh"
              size="sm"
              variant="outline"
              disabled={busy || down}
              onPress={() => start(id, 'restart')}
            >
              Restart
            </Button>
            <Button
              key={`attach:${id}`}
              icon="terminal"
              size="sm"
              variant="ghost"
              tooltip="Open the process-compose TUI in a terminal"
              disabled={stack === null || down}
              onPress={() => openTerminal(id, 'attach')}
            >
              Attach
            </Button>
            <Button
              key={`logs:${id}`}
              icon="file-text"
              size="sm"
              variant="ghost"
              tooltip="Follow the logs of every service in a terminal"
              disabled={stack === null || down}
              onPress={() => openTerminal(id, 'logs')}
            >
              Logs
            </Button>
          </Row>
          {row.busy === null ? null : (
            <Text size="sm" tone="accent">
              {BUSY_TEXT[row.busy.action]}
              {row.busy.service === null ? '' : ` ${row.busy.service}`}, since <RelativeTime at={row.busy.since} />
            </Text>
          )}
          {row.lastError === null ? null : (
            <Callout tone="danger" title={`${row.lastError.action} failed: ${row.lastError.code}`} icon="error">
              <Text size="sm">{row.lastError.message}</Text>
            </Callout>
          )}
          {stack === null ? (
            <Text muted size="sm">Could not read this stack.</Text>
          ) : (
            <Services instance={stack} owner={{ workspaceId: id, shared: false, key: id }} disabled={busy} />
          )}
          <Text muted size="xs">
            Runs <Code>{executable}</Code> in {row.workspace.path}
          </Text>
        </Stack>
      </Collapsible>
    </Box>
  )
}

function Repo({ repo, v }: { repo: RepoView; v: StackView }) {
  // The shared instance's commands run in one of the repo's worktrees: any of them reaches it.
  const owner: Owner = { workspaceId: repo.rows[0]?.workspace.id ?? '', shared: true, key: `shared:${repo.key}` }
  return (
    <Stack gap="sm">
      <Heading level={3}>{repo.label}</Heading>
      {repo.kind === 'error' ? (
        <Callout tone="danger" title="devtrees failed" icon="error">
          <Text size="sm">{repo.message ?? 'Unknown error.'}</Text>
        </Callout>
      ) : null}
      {repo.rows.map((row) => (
        <WorktreeRow row={row} focused={row.workspace.id === v.focusedId} executable={v.executable} key={row.workspace.id} />
      ))}
      <Card title="Shared instance" description="One instance for every worktree of the repo. devtrees down --shared stops it.">
        {repo.shared === null ? (
          <Text muted size="sm">Not running.</Text>
        ) : (
          <Stack gap="sm">
            <Row gap="xs">
              <Button
                key={`attach:${owner.key}`}
                icon="terminal"
                size="sm"
                variant="ghost"
                tooltip="Open the shared instance's process-compose TUI in a terminal"
                onPress={() => openTerminal(owner.workspaceId, 'attach', { shared: true })}
              >
                Attach
              </Button>
            </Row>
            <Services instance={repo.shared} owner={owner} disabled />
          </Stack>
        )}
      </Card>
    </Stack>
  )
}

function Problem({ v }: { v: StackView }) {
  if (v.kind === 'not-installed') {
    return (
      <EmptyState icon="warning" title="devtrees not found" description={`Could not run "${v.executable}". Install devtrees ${MIN_DEVTREES_VERSION} or newer (npm install -g devtrees), or set its path in the plugin settings.`} />
    )
  }
  return (
    <EmptyState icon="warning" title="devtrees is too old" description={`"${v.executable}" does not support ls --services. Upgrade to devtrees ${MIN_DEVTREES_VERSION} or newer: npm install -g devtrees@latest.`} />
  )
}

export default function Panel() {
  const v = read(view)
  const note = read(notice)
  if (v === null) {
    return note === null ? <Skeleton lines={4} label="Loading stacks" /> : <Callout tone="danger" title="No answer from the worker">{note}</Callout>
  }
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>devtrees</Heading>
        <IconButton icon="refresh" label="Refresh" tooltip="Refresh" variant="ghost" size="sm" onPress={() => load(true)} />
      </Row>
      {note === null ? null : <Callout tone="warning">{note}</Callout>}
      {v.kind !== 'ok' ? (
        <Problem v={v} />
      ) : v.repos.length === 0 ? (
        <EmptyState icon="folder" title="No devtrees worktrees" description="No local worktree open in Orca has a devtrees.yaml at its root." />
      ) : (
        <Stack gap="lg">
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
