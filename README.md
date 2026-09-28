# Shipyard

Runs a plan → build → evaluate → merge → compound loop over a project's feature list with headless
Claude Code (`claude -p`): one foreman, up to N builders in separate git worktrees, a fresh evaluator per
feature, a human inbox for what only you can do, and one dashboard across projects.
Node >= 22, no npm dependencies. The contract is [SPEC.md](SPEC.md).

## Install

```sh
ln -s ~/Projects/shipyard/bin/shipyard ~/.local/bin/shipyard
cd ~/Projects/myapp && shipyard init --test "pnpm test"   # then run the intake skill in Claude Code
```

Tests: `node --test` (the end-to-end test uses `fixtures/fake-claude.js` via `SHIPYARD_CLAUDE`, never the real `claude`).

## Commands

| Command | What it does |
|---|---|
| `shipyard init [--test "<cmd>"]` | Creates `.shipyard/` (config, empty features/human), copies `intake` and `ship` skills into `.claude/skills/`, adds runtime files to `.git/info/exclude`. Idempotent, never overwrites. |
| `shipyard run [--watch] [--once] [--max-features N]` | The foreman loop. `--watch` keeps waiting (polls `features.json`/`human.json` mtimes every 5s) while features are blocked on you. `--once` launches one batch and exits when it finishes. Exit 0 when every feature is `merged`/`ready`, 2 otherwise. |
| `shipyard status` | Feature table (status, attempts, cost, deps, next/onMock/waiting) and open human tasks. |
| `shipyard done <task-id>` | Marks a human task done; a watching foreman picks it up. |
| `shipyard doctor` | Validates the files (schema, duplicate ids, unknown deps, cycles) and that `claude`, `git` and the test command resolve. Exit 1 on problems. |
| `shipyard dash [--root DIR] [--port 7420]` | Dashboard on `127.0.0.1` for every `.shipyard/features.json` up to depth 3 under `--root` (worktrees skipped). "Agents" and "Only you" views; refreshes every 2s. |
| `shipyard hook` | Internal: Claude Code hook that appends a line to `activity.jsonl`. Never prints, never exits non-zero. |

Per feature the foreman: creates/reuses worktree `<worktreesDir>/<id>` on `<branchPrefix><id>` (or `branch`)
from `base` → runs the builder → fails the attempt with "commit your work" if the worktree is dirty or the
branch has no commits beyond `base` → records the branch sha → runs `config.test` in the worktree → runs a
fresh evaluator with the diff `base...<sha>` (`--text --no-ext-diff --no-textconv`), the acceptance checks
read at launch and the test output → merges that sha with `git merge --no-ff` (auto; refused if the branch
moved meanwhile) or stops at `ready` (manual) → appends the evaluator's lesson to `lessonsFile`. Failures increment `attempts` and
feed back into the next build prompt; at `maxAttempts` the feature is `stuck`.

## Files (`.shipyard/` in the main checkout)

- `config.json` — `base`, `worktreesDir` (`../<repo>-worktrees`), `branchPrefix` (`ship/`), `maxParallel` (3),
  `maxAttempts` (2), `budgetUsdPerRun` (15, passed as `--max-budget-usd`; hitting it gives the feedback
  "budget exhausted"), `budgetUsdTotal` (100; stop launching once the cost reported **during the current
  `shipyard run`** reaches it — earlier runs' `costUsd` do not count; `null` = unlimited), `timeoutMin` (60,
  per `claude`/test/`postMerge` child), `builder`/`evaluator` `{model, effort, permissionMode}`,
  `test`, `merge` (`auto`|`manual`), `briefFiles` (appended to builder and evaluator prompts), `lessonsFile`
  (`CLAUDE.md`), `postMerge` (shell command run in the main checkout after a merge, or null).
- `features.json` — `{features: [{id, title, description, acceptance[], surface, deps[], priority, branch?,
  status, onMock?, attempts, lastFeedback?, costUsd?, pid?, pidStart?, foremanPid?, updatedAt}]}` (its current
  child: pid, start time from `/proc/<pid>/stat`, and the foreman that spawned it); status is
  `todo|building|testing|evaluating|ready|merged|stuck`.
- `human.json` — `{tasks: [{id, title, steps[], unblocks[], mockable, status: open|done, doneAt?}]}`.
- `log.jsonl` (`{ts, feature, event, detail}`), `activity.jsonl` (hook events, last 2000 lines),
  `runs/<feature>/<attempt>-{build,eval}.json` (raw `claude -p` output), `.lock`, `.foreman` (foreman pid).

**Readiness:** a `todo` feature is ready when every dep is `merged` (or `ready` under manual merge) and
every open human task that unblocks it is `mockable` (it is then built `onMock`). An open non-mockable task
makes it *waiting-on-human*. Ready features run by priority, then number of transitive dependents, then id.
Features in cycles, with unknown deps or duplicate ids are reported and never run.

**Evaluator verdict:** `{pass, findings: [{check, ok, evidence}], cheating: [], lesson}`. Output that is not
such an object, `pass: true` with a failed finding, non-empty `cheating`, or no findings all count as a fail.

## Safety limits

- Never pushes, never force-deletes branches, never runs `git reset --hard` or `git clean`, never deletes
  worktrees. Only touches the repo, its worktrees dir and `~/.local/state/shipyard/`.
- Only kills processes it started. Each child runs in its own process group; on timeout or SIGINT/SIGTERM
  the whole group gets SIGTERM and in-flight features go back to `todo` without spending an attempt; a
  second Ctrl-C SIGKILLs the groups and exits at once. One foreman per repo (`.shipyard/.foreman`).
  Features left in flight by a dead foreman are marked `merged` if their branch is already merged into
  `base`, left alone while their recorded child is alive (same pid and start time; `EPERM` counts as dead;
  without `/proc`, dead once its foreman is dead) for at most `timeoutMin`, and otherwise go back to `todo`
  (worktree reused; a still-running child is not killed).
- Merges only when the main checkout is on `base` with no tracked changes outside `.shipyard/`; otherwise
  the feature stays `ready` and `log.jsonl` says why, as it does when git refuses to start the merge. A
  conflicting merge is aborted (`git merge --abort`) and costs an attempt.
- Tamper checks: if `base` moves other than by Shipyard's own merges and lesson commits, or `config.json`
  changes on disk during a run, the foreman logs an `alert`, launches and merges nothing more, and exits 2.
  `claude` gets `--settings` deny rules for `Edit` under `<root>/.shipyard/` and `<root>/.git/` and for
  `git update-ref`/`git push` (deny rules apply even under `bypassPermissions`).
- Lessons are committed on `base` (only that file) when the main checkout is on `base` and the lessons
  file had no local edits; otherwise they are appended uncommitted.
- State files are written atomically (temp + rename) under an `O_EXCL` lock that is stale once its pid is
  dead, so the dashboard, `shipyard done`, hooks and the foreman can write concurrently.
- The dashboard binds to 127.0.0.1, accepts POSTs only for discovered project paths (exact match), and
  rejects any `Origin` other than its own and any unexpected `Host` (DNS rebinding).

## Permission mode

Default `permissionMode` is `bypassPermissions` for both roles. `claude --help` (2.1.283) lists
`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. With `-p` nobody answers
prompts: `manual`/`acceptEdits` would block or deny the Bash calls a builder needs (tests, `git commit`),
`dontAsk` denies anything not pre-allowed, `plan` cannot edit. `auto` works headless but a classifier may
deny steps mid-build and it can be disabled by settings. `bypassPermissions` is the one mode that runs a
full build unattended. It gives the agent your user's full rights, contained only by working in a
worktree; switch to `auto` in `config.json` if you prefer the classifier's guard rails.

## Claude output

`claude -p --output-format json` prints one object; Shipyard reads `result` (text), `is_error` and
`total_cost_usd` (falling back to `cost_usd`), and `structured_output` if present. Field names were checked
against the installed 2.1.283 binary, not by running a prompt. Hooks are passed with `--settings` as
`"<node>" "<shipyard>/bin/shipyard" hook` so they work before `shipyard` is on PATH.
