# orca-devtrees

An [Orca](https://github.com/stablyai/orca) plugin for [devtrees](https://github.com/pantoninho/devtrees),
which runs a process-compose stack per git worktree without port collisions.

## What it does

- **Services panel** in the right sidebar, listing every local worktree open in Orca that has
  a `devtrees.yaml`, grouped by repo (named after Orca's project on Orca 1.4.256 and newer,
  otherwise after the main checkout's folder):
  - one row per worktree: its name, branch and the stack's status;
  - a row opens to show each service's name, state, health and tier (isolated or shared), and
    its ports as `localhost` links that open in the browser;
  - Up, Down and Restart on each row, and Restart for each isolated service;
  - Attach (`devtrees attach`) and Logs (`devtrees logs -f --all`) on each row, and Logs
    (`devtrees logs -f <service>`) for each service, each opening an Orca terminal in that
    row's worktree;
  - each repo's shared instance, in its own section, with Attach (`devtrees attach --shared`)
    and Logs for each shared service (`devtrees logs -f --shared <service>`).
- **Auto-prune.** When Orca removes a worktree, the plugin runs `devtrees prune` from another
  worktree of the same repo, so the removed worktree's instance does not keep running. It never
  prunes other repos.
- **Status bar item** for the focused worktree, such as `devtrees: up · web :41230`. It is
  hidden unless the plugin knows for certain which row is focused. Pressing it toggles the
  Ports sidebar.

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
| orca executable            | `orca`     | Name or absolute path of the orca CLI, used to find the focused worktree to highlight it. A name is looked up on your login PATH. |
| Refresh interval (seconds) | `15`       | How often to re-read the stack, to catch changes made outside the panel. `0` turns it off. |

## Access it asks for

- **trusted-worker**: a Node process that runs CLIs with your user account's access:
  - `devtrees` in your worktrees;
  - `orca terminal list --json`, to find which worktree the focused terminals are in;
  - `git rev-parse --git-common-dir` in each local worktree, to know which repo it belongs to.
- `workspace:read`: the list of workspaces, to find the rows; the focused workspace's name,
  branch and terminal ids, to highlight its row; and the `workspace.removed` event, to prune.
- `settings:own`: the three settings above.
- `terminal:send`: to open the Attach and Logs terminals with `terminal.create`. Orca
  describes this capability as "Type and run commands in your terminals, local and SSH", which
  is broader than what the plugin does: it only opens new terminals in local worktrees, running
  `devtrees attach` or `devtrees logs`. It never types into an existing terminal.

## Which worktree it acts on

The one on the row you pressed. Each action carries that row's Orca workspace id; the worker
looks the id up in `workspace.list` again and runs devtrees in that workspace's path. It
refuses the action if the workspace is gone, is not local, or has no `devtrees.yaml`. Rows
have their own busy state, so a long `up` on one row does not hold up the others.

Focus is only used to highlight a row. Orca tells plugins the focused workspace's name, branch
and terminal ids, but not its path, and two workspaces in different repos can share a name and
a branch, such as `main` on `main`. The plugin looks for the focused row this way:

1. It matches the focused terminals against `orca terminal list --json`, which gives each
   terminal's worktree path. It uses the match only if every focused terminal is in the same
   worktree.
2. If no terminal matches (no terminals are open, or the orca CLI fails), it looks for a
   workspace with the same name and branch, and uses it only if exactly one matches.
3. Otherwise nothing is highlighted and the status bar item is hidden. Nothing else changes.

The highlighted row is opened by default. A row you open or close stays that way, also across
a hot reload of the panel.

## How it prunes

The worker keeps the git common dir of each local worktree it sees, at start and on each
refresh, and groups the rows by it. When Orca removes a worktree, it looks up that worktree's
repo and runs `devtrees prune` from one other worktree of the same repo that is open in Orca,
preferring one with a `devtrees.yaml`. If it never saw the removed worktree (for example, the
worker restarted after it was created), or no other worktree of that repo is open, it logs this
and prunes nothing. Run `devtrees prune` yourself in that case.

## How it reads the stack

`devtrees ls --services --json` lists every instance of a repo from any of its worktrees, so
the worker runs it once per repo, in one of that repo's rows, and matches the instances to the
rows by worktree id. It reads when the panel opens, on each focus change, after each action
(only the action's repo), and on the refresh interval. The interval catches changes made in a
terminal or by an agent; a repo with a running action is skipped until the action ends.
Actions run in their own process group, so they finish even when Orca restarts the
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
