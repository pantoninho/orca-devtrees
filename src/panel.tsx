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
import type { InstanceView, RepoView, RowView, ServiceView, StackAction, StackView } from './protocol'

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

function ServiceRow({
  service,
  workspaceId,
  disabled
}: {
  service: ServiceView
  /** The row whose stack this is; null for the shared instance, which is never restarted here. */
  workspaceId: string | null
  disabled: boolean
}) {
  const health = HEALTH_TEXT[service.health]
  const canRestart = service.tier === 'isolated'
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs">
      <Row justify="between" align="center">
        <Row gap="xs" align="center" wrap>
          <Text weight="medium">{service.name}</Text>
          <Badge tone={STATE_TONE[service.state]}>{service.state}</Badge>
          {health === null ? null : <Badge tone={service.health === 'ready' ? 'success' : 'warning'}>{health}</Badge>}
          <Badge tone={service.tier === 'shared' ? 'accent' : 'neutral'}>{service.tier}</Badge>
        </Row>
        {canRestart && workspaceId !== null ? (
          <IconButton
            key={`restart:${workspaceId}:${service.name}`}
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

function Services({ instance, workspaceId, disabled }: { instance: InstanceView; workspaceId: string | null; disabled: boolean }) {
  if (instance.services.length === 0) {
    return <Text muted size="sm">{instance.status === 'down' ? 'Not running.' : 'No services reported.'}</Text>
  }
  return (
    <Stack gap="xs">
      {instance.services.map((s) => (
        <ServiceRow service={s} workspaceId={workspaceId} disabled={disabled} key={s.name} />
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
            <Services instance={stack} workspaceId={id} disabled={busy} />
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
          <Services instance={repo.shared} workspaceId={null} disabled />
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
