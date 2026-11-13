// The services panel: the focused worktree's devtrees stack, with Up, Down and Restart.
// Every read and action goes through the worker (src/worker.ts), which posts `stack.changed`
// after its own actions, on workspace changes and when its poll sees a change.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  IconButton,
  Link,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Skeleton,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import { MIN_DEVTREES_VERSION } from './devtrees'
import type { InstanceView, ServiceView, StackAction, StackView, WorkspaceRef } from './protocol'

const view = atom<StackView | null>(null)
/** Why the last press did not start, or why the worker failed to answer. */
const notice = atom<string | null>(null)

async function load(refresh = false): Promise<void> {
  try {
    set(view, await plugin.request('stack.get', { refresh }))
    set(notice, null)
  } catch (error) {
    set(notice, (error as Error).message)
  }
}

async function start(action: StackAction, service?: string): Promise<void> {
  try {
    const answer = await plugin.request('stack.action', service ? { action, service } : { action })
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
const FOUND_BY = { terminals: 'found by its terminals', name: 'found by name and branch', pick: 'picked by you' } as const
const BUSY_TEXT = { up: 'Starting', down: 'Stopping', restart: 'Restarting', 'restart-service': 'Restarting' } as const

function ServiceRow({ service, canRestart, disabled }: { service: ServiceView; canRestart: boolean; disabled: boolean }) {
  const health = HEALTH_TEXT[service.health]
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs" key={service.name}>
      <Row justify="between" align="center">
        <Row gap="xs" align="center" wrap>
          <Text weight="medium">{service.name}</Text>
          <Badge tone={STATE_TONE[service.state]}>{service.state}</Badge>
          {health === null ? null : <Badge tone={service.health === 'ready' ? 'success' : 'warning'}>{health}</Badge>}
          <Badge tone={service.tier === 'shared' ? 'accent' : 'neutral'}>{service.tier}</Badge>
        </Row>
        {canRestart ? (
          <IconButton
            icon="refresh"
            label={`Restart ${service.name}`}
            tooltip={`Restart ${service.name}`}
            variant="ghost"
            size="sm"
            disabled={disabled}
            onPress={() => start('restart-service', service.name)}
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

function Services({ instance, own, disabled }: { instance: InstanceView; own: boolean; disabled: boolean }) {
  if (instance.services.length === 0) {
    return <Text muted size="sm">{instance.status === 'down' ? 'Not running.' : 'No services reported.'}</Text>
  }
  return (
    <Stack gap="xs">
      {instance.services.map((s) => (
        <ServiceRow service={s} canRestart={own && s.tier === 'isolated'} disabled={disabled} key={s.name} />
      ))}
    </Stack>
  )
}

/** Such as `orca-devtrees / main (main) - /work/app/main`; the project needs Orca 1.4.256 or newer. */
function labelOf(c: WorkspaceRef): string {
  const name = c.project === null ? c.name : `${c.project} / ${c.name}`
  const branch = c.branch === null || c.branch === c.name ? '' : ` (${c.branch})`
  return `${name}${branch} - ${c.path}`
}

function Picker({ v }: { v: StackView }) {
  return (
    <Select
      label="Worktree"
      value={v.workspace?.id}
      placeholder="Pick the worktree you are in"
      options={v.candidates.map((c) => ({ value: c.id, label: labelOf(c) }))}
      onChange={async (workspaceId) => set(view, await plugin.request('workspace.pick', { workspaceId }))}
    />
  )
}

function Empty({ v }: { v: StackView }) {
  if (v.kind === 'unresolved') {
    return (
      <Callout tone="warning" title="Which worktree?" icon="warning">
        <Text size="sm">{v.message ?? 'Pick the worktree you are in.'}</Text>
      </Callout>
    )
  }
  if (v.kind === 'no-workspace') {
    return <EmptyState icon="folder" title="No worktree focused" description="Open a local worktree to see its stack." />
  }
  if (v.kind === 'no-config') {
    return (
      <EmptyState icon="file" title="No devtrees.yaml" description="This worktree has no devtrees.yaml at its root, so devtrees does not run a stack here." />
    )
  }
  if (v.kind === 'not-installed') {
    return (
      <EmptyState icon="warning" title="devtrees not found" description={`Could not run "${v.executable}". Install devtrees ${MIN_DEVTREES_VERSION} or newer (npm install -g devtrees), or set its path in the plugin settings.`} />
    )
  }
  if (v.kind === 'too-old') {
    return (
      <EmptyState icon="warning" title="devtrees is too old" description={`"${v.executable}" does not support ls --services. Upgrade to devtrees ${MIN_DEVTREES_VERSION} or newer: npm install -g devtrees@latest.`} />
    )
  }
  return (
    <Callout tone="danger" title="devtrees failed" icon="error">
      <Text size="sm">{v.message ?? 'Unknown error.'}</Text>
    </Callout>
  )
}

export default function Panel() {
  const v = read(view)
  const note = read(notice)
  if (v === null) {
    return note === null ? <Skeleton lines={4} label="Loading stack" /> : <Callout tone="danger" title="No answer from the worker">{note}</Callout>
  }
  const stack = v.stack
  const busy = v.busy !== null
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>{v.workspace?.name ?? 'devtrees'}</Heading>
        <Row gap="xs" align="center">
          {stack ? <Badge tone={STATUS_TONE[stack.status]}>{STATUS_TEXT[stack.status]}</Badge> : null}
          <IconButton icon="refresh" label="Refresh" tooltip="Refresh" variant="ghost" size="sm" onPress={() => load(true)} />
        </Row>
      </Row>
      {v.candidates.length > 0 ? <Picker v={v} /> : null}
      {note === null ? null : <Callout tone="warning">{note}</Callout>}
      {v.kind !== 'ok' || stack === null ? (
        <Empty v={v} />
      ) : (
        <Stack gap="md">
          <Row gap="xs" wrap>
            <Button icon="play" size="sm" disabled={busy} onPress={() => start('up')}>Up</Button>
            <Button icon="stop" size="sm" variant="outline" disabled={busy || stack.status === 'down'} onPress={() => start('down')}>
              Down
            </Button>
            <Button icon="refresh" size="sm" variant="outline" disabled={busy || stack.status === 'down'} onPress={() => start('restart')}>
              Restart
            </Button>
          </Row>
          {v.busy === null ? null : (
            <Text size="sm" tone="accent">
              {BUSY_TEXT[v.busy.action]}
              {v.busy.service === null ? '' : ` ${v.busy.service}`}, since <RelativeTime at={v.busy.since} />
            </Text>
          )}
          {v.lastError === null ? null : (
            <Callout tone="danger" title={`${v.lastError.action} failed: ${v.lastError.code}`} icon="error">
              <Text size="sm">{v.lastError.message}</Text>
            </Callout>
          )}
          <Card title="This worktree" description={stack.id}>
            <Services instance={stack} own disabled={busy} />
          </Card>
          <Card title="Shared instance" description="One instance for every worktree of the repo. devtrees down --shared stops it.">
            {v.shared === null ? <Text muted size="sm">Not running.</Text> : <Services instance={v.shared} own={false} disabled />}
          </Card>
          <Text muted size="xs">
            Runs <Code>{v.executable}</Code> in {v.workspace?.path ?? ''}
            {v.resolvedBy === null ? '' : ` (${FOUND_BY[v.resolvedBy]})`}
          </Text>
        </Stack>
      )}
    </Stack>
  )
}
