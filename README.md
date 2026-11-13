# orca-devtrees

An [Orca](https://github.com/stablyai/orca) plugin for [devtrees](https://github.com/pantoninho/devtrees),
which runs a process-compose stack per git worktree without port collisions.

## What it does

- **Services panel** in the right sidebar, for the focused worktree:
  - each service's name, state, health and tier (isolated or shared);
  - its ports, as `localhost` links that open in the browser;
  - Up, Down and Restart for the stack, and Restart for each isolated service;
  - the shared instance, in its own section.
- **Auto-prune.** When Orca removes a worktree, the plugin runs `devtrees prune` from another
  worktree of the same repo, so the removed worktree's instance does not keep running.
- **Status bar item**, such as `devtrees: up · web :41230`. It is hidden when the focused
  worktree has no `devtrees.yaml`. Pressing it toggles the Ports sidebar.

Restart for the whole stack runs `devtrees down`, then `devtrees up` with the namespaces the
stack had booted. devtrees has no whole-stack restart in place.

## Requirements

- Orca 1.4.248 or newer.
- devtrees 0.1.0 or newer (`npm install -g devtrees`). Older versions lack `ls --services`
  and `restart`; the panel says so and asks for an upgrade.
- Local worktrees. Workspaces on SSH hosts are not supported.

## Install

In Orca, open Settings, then Plugins, and install from the Git URL
`https://github.com/pantoninho/orca-devtrees`. To try a local checkout:

```sh
orca plugin dev load /path/to/orca-devtrees
```

## Settings

| Setting                    | Default    | Meaning                                                                    |
| -------------------------- | ---------- | -------------------------------------------------------------------------- |
| devtrees executable        | `devtrees` | Name or absolute path of the CLI. A name is looked up on your login PATH.  |
| Refresh interval (seconds) | `15`       | How often to re-read the stack, to catch changes made outside the panel. `0` turns it off. |

## Access it asks for

- **trusted-worker**: a Node process that runs the `devtrees` CLI in your worktrees, with your
  user account's access.
- `workspace:read`: the focused workspace and the list of workspaces, to find the worktree's
  path, and the `workspace.removed` event, to prune.
- `settings:own`: the two settings above.

## How it reads the stack

The worker runs `devtrees ls --services --json` in the focused worktree when it changes, after
each of the panel's actions, and on the refresh interval. The interval catches changes made in
a terminal or by an agent; each read is one short CLI run, and it is skipped while an action
runs. Actions run in their own process group, so they finish even when Orca restarts the
worker. The stack itself is unaffected by the worker: devtrees always starts process-compose
detached.

## Development

```sh
orca plugin test . --json     # unit tests, over a stubbed devtrees CLI (src/fake-runner.ts)
orca plugin check . --json    # renders each panel state in src/panel.check.ts
npx tsc -p .                  # type check (Orca strips types without checking them)
```

## License

MIT
