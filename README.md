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
  worktree of the same repo, so the removed worktree's instance does not keep running. It never
  prunes other repos.
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
| devtrees executable        | `devtrees` | Name or absolute path of the devtrees CLI. A name is looked up on your login PATH. |
| orca executable            | `orca`     | Name or absolute path of the orca CLI, used to find the focused worktree. A name is looked up on your login PATH. |
| Refresh interval (seconds) | `15`       | How often to re-read the stack, to catch changes made outside the panel. `0` turns it off. |

## Access it asks for

- **trusted-worker**: a Node process that runs CLIs with your user account's access:
  - `devtrees` in your worktrees;
  - `orca terminal list --json`, to find which worktree the focused terminals are in;
  - `git rev-parse --git-common-dir` in each local worktree, to know which repo it belongs to.
- `workspace:read`: the focused workspace's name, branch and terminal ids, the list of
  workspaces, and the `workspace.removed` event, to prune.
- `settings:own`: the three settings above.

## Which worktree it acts on

Orca tells plugins the focused workspace's name, branch and terminal ids, but not its path.
Two workspaces in different repos can share a name and a branch, such as `main` on `main`. The
plugin finds the path this way:

1. It matches the focused terminals against `orca terminal list --json`, which gives each
   terminal's worktree path. It uses the match only if every focused terminal is in the same
   worktree.
2. If no terminal matches (no terminals are open, or the orca CLI fails), it looks for a
   workspace with the same name and branch, and uses it only if exactly one matches.
3. Otherwise it picks nothing. The panel lists the candidates, Up, Down and Restart are off,
   the status bar item is hidden, and the worker refuses actions until you pick one.

It resolves again on every focus change and before every action. A pick lasts until focus
moves. When the focused workspace has no terminals, a focus change looks the same as a move to
another workspace with the same name and branch, so the pick is dropped on any change; pick
again, or open a terminal there.

## How it prunes

The worker keeps the git common dir of each local worktree it sees: at start, on focus changes
and on each refresh. When Orca removes a worktree, it looks up that worktree's repo and runs
`devtrees prune` from one other worktree of the same repo that is open in Orca, preferring one
with a `devtrees.yaml`. If it never saw the removed worktree (for example, the worker restarted
after it was created), or no other worktree of that repo is open, it logs this and prunes
nothing. Run `devtrees prune` yourself in that case.

## How it reads the stack

The worker runs `devtrees ls --services --json` in the focused worktree when focus changes, after
each of the panel's actions, and on the refresh interval. The interval catches changes made in
a terminal or by an agent; each read is one short CLI run, and it is skipped while an action
runs. Actions run in their own process group, so they finish even when Orca restarts the
worker. The stack itself is unaffected by the worker: devtrees always starts process-compose
detached.

## Development

```sh
orca plugin test . --json     # unit tests, over stubbed devtrees, orca and git CLIs (src/fake-runner.ts)
orca plugin check . --json    # renders each panel state in src/panel.check.ts
npx tsc -p .                  # type check (Orca strips types without checking them)
```

## License

MIT
