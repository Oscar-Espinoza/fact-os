# Shipyard — spec and done-condition

A small, dependency-free tool that runs a plan → build → evaluate → merge → compound loop over a
project's feature list using headless Claude Code (`claude -p`). One foreman process, N builders in
separate git worktrees, a separate evaluator per feature, a human inbox for what only the owner can do,
and one dashboard across projects.

## Constraints

- Node >= 22, ESM, **no npm dependencies** (node:* built-ins only). Tests use `node:test`.
- Lives in `~/Projects/shipyard`; installed by symlinking `bin/shipyard` to `~/.local/bin/shipyard`.
- It is not a Claude Code plugin. `shipyard init` copies two project skills into the target repo's
  `.claude/skills/` (`intake`, `ship`). Everything else is the CLI.
- It never pushes, never force-deletes branches, never runs `git reset --hard` or `git clean`, never kills
  processes it did not start, and never touches anything outside the project repo, its worktrees dir and
  `~/.local/state/shipyard/`.
- All state files are JSON and written atomically (write temp + rename) under a lock file
  (`.shipyard/.lock`, O_EXCL, stale after its PID is dead). The dashboard and the foreman may write
  concurrently; no write may be lost.

## Files (per project, in the main checkout)

`.shipyard/config.json`
```json
{
  "base": "main",
  "worktreesDir": "../<repo>-worktrees",
  "branchPrefix": "ship/",
  "maxParallel": 3,
  "maxAttempts": 2,
  "budgetUsdPerRun": 15,        // passed as --max-budget-usd to each claude -p call
  "budgetUsdTotal": 100,        // stop launching once costs reported during this `shipyard run` reach it; null = unlimited
  "timeoutMin": 60,             // per claude/test/postMerge child; the whole process group is killed
  "builder":   { "model": "opus", "effort": "medium", "permissionMode": "bypassPermissions" },
  "evaluator": { "model": "opus", "effort": "high",   "permissionMode": "bypassPermissions" },
  "test": "npm test",           // run in the feature worktree after build; exit 0 = pass
  "merge": "auto",              // "auto": foreman merges; "manual": status becomes "ready" and stops there
  "briefFiles": [],             // extra files whose contents are appended to builder AND evaluator prompts
  "lessonsFile": "CLAUDE.md",   // where compounded lessons are appended
  "postMerge": null             // optional shell command run in the main checkout after a merge
}
```
`.shipyard/features.json` — `{ "features": [Feature] }`
```
Feature {
  id: string (slug, unique), title, description,
  acceptance: string[]            // checks the evaluator verifies, each concrete and testable
  surface: "web"|"api"|"ios"|"android"|"desktop"|"any",
  deps: string[]                  // feature ids
  priority: number                // lower = sooner
  branch?: string                 // existing branch to continue/evaluate instead of starting fresh
  status: "todo"|"building"|"testing"|"evaluating"|"ready"|"merged"|"stuck"
  onMock?: boolean                // built while a human task it needs is open
  attempts: number, lastFeedback?: string, costUsd?: number, updatedAt: ISO string
  sha?: string                    // evaluated commit, recorded when the feature becomes ready or merged
  pid?, pidStart?, foremanPid?    // current child: pid, /proc/<pid>/stat start time, foreman that spawned it
}
```
`.shipyard/human.json` — `{ "tasks": [HumanTask] }`
```
HumanTask { id, title, steps: string[], unblocks: string[] /* feature ids */,
            mockable: boolean, status: "open"|"done", doneAt? }
```
`.shipyard/log.jsonl` — one JSON line per event (`{ts, feature, event, detail}`).
`.shipyard/activity.jsonl` — hook events (`{ts, session, feature, tool, summary}`), capped to last 2000 lines.
`.shipyard/runs/<feature>/<attempt>-{build,eval}.json` — raw `claude -p --output-format json` results.
`.shipyard/.foreman` — pid of the running foreman (one per repo).

## Readiness rule (pure function, heavily tested)

A feature is **ready** when: status is `todo`; every dep is `merged` (or `ready` when `merge` is
"manual"); and for every open human task that lists it in `unblocks`, that task is `mockable`
(then the feature is built with `onMock: true`). A feature blocked by an open non-mockable human task
is **waiting-on-human**. Ready features are ordered by priority, then by how many other features
transitively depend on them (more first), then id. Dependency cycles and unknown dep ids are reported
by `shipyard doctor` / at load and those features are never ready.

## Foreman loop — `shipyard run [--watch] [--once] [--max-features N]`

Each tick:
1. Load state. A feature left in `building|testing|evaluating` by a dead foreman becomes `merged` if its
   branch tip is reachable from `base` but not on its first-parent line; is left alone while its recorded
   child is alive (same pid and start time; EPERM = dead; without /proc, dead once its foreman is dead), at
   most `timeoutMin`; otherwise goes back to `todo` (worktree kept and reused; the child is not killed).
2. Launch ready features until `maxParallel` are in flight.
3. Per feature (concurrently):
   - **Build.** Create/reuse worktree `<worktreesDir>/<id>` on `<branchPrefix><id>` (or `branch`) from
     `base`. Run `claude -p` in it with the builder prompt: feature, acceptance checks, onMock note,
     previous evaluator feedback, lessons file, briefFiles, and the rule "commit your work; do not
     weaken or delete tests to make them pass; do not stub behavior the acceptance checks require".
     Hook settings and deny rules are passed via `--settings` (see Hooks). Afterwards the worktree must be
     clean and the branch must have commits beyond `base`, else the attempt fails with "commit your work"
     (plus `git status --porcelain`, 40 lines); the branch sha is recorded and only that sha is tested,
     evaluated and merged.
   - **Test.** Run `config.test` in the worktree. Failure → feedback = tail of output, attempt++.
   - **Evaluate.** A fresh `claude -p` (never a resumed builder session) gets the diff
     `base...<sha>` (`--text --no-ext-diff --no-textconv`), the acceptance list as read at launch and
     the test output, and must answer with a JSON object
     `{ "pass": boolean, "findings": [{ "check": string, "ok": boolean, "evidence": string }],
        "cheating": string[], "lesson": string|null }`. It is told explicitly to look for
     pass-through implementations, tests that cannot fail, skipped/deleted tests, and hard-coded
     results. Unparseable output, no findings, or `pass: true` with a failed finding or cheating counts as a fail.
   - **Pass** → `merge: "auto"`: in the main checkout (must be clean and on `base`, else the feature
     becomes `ready` and a log event explains why; "clean" = no tracked changes outside `.shipyard/`),
     `git merge --no-ff <sha>` (refused if the branch moved since it was recorded; a merge git refuses to
     start leaves the feature `ready` without costing an attempt); on conflict,
     `git merge --abort`, status `todo` with feedback "rebase on <base>", attempt++. Then run
     `postMerge`. Status `merged`. `merge: "manual"` → status `ready`.
   - **Fail** → attempts++, `lastFeedback` = failed findings + cheating; back to `todo`; at
     `maxAttempts` → `stuck`.
   - **Compound.** A non-null `lesson` is appended to `lessonsFile` as one dated bullet under a
     `## Shipyard lessons` heading (created if missing), deduplicated by exact text, and committed on
     `base` (that file only) when the main checkout is on `base` and the file had no local edits.
   - **Tamper checks.** If `config.json` changes on disk, or `base` moves other than by the foreman's own
     merges/lesson commits so that it reaches a feature-branch commit, or its new objects
     (`git rev-list --objects <newBase> ^<recordedBase>`) include a non-empty blob that is also in a feature
     branch, log an `alert`, launch and merge nothing more, exit 2. Commits reachable from a `ready` or
     `merged` feature's recorded `sha` do not count, so merging a `ready` branch by hand is fine. Other
     `base` moves are logged and re-recorded.
4. Stop conditions: nothing in flight and nothing ready → if `--watch` and some feature is
   waiting-on-human, sleep and re-check whenever `human.json`/`features.json` mtime changes (poll 5s);
   otherwise exit printing a summary. Also stop launching when `budgetUsdTotal` is reached, or on
   SIGINT/SIGTERM (SIGTERM to each child's process group; in-flight features back to `todo` without
   spending an attempt; a second signal SIGKILLs the groups and exits at once).
   Exit code 0 when all features are `merged`/`ready`, 2 when stopped with stuck or waiting features.

The `claude` binary is `process.env.SHIPYARD_CLAUDE || "claude"` so tests can substitute a fake.

## Other commands

- `shipyard init [--test "<cmd>"]` — creates `.shipyard/` with default config and empty
  features/human files, copies skills into `.claude/skills/`, adds `.shipyard/runs/`,
  `.shipyard/*.jsonl` and `.shipyard/.lock` to `.git/info/exclude`. Idempotent; never overwrites.
- `shipyard status` — table of features and open human tasks.
- `shipyard done <human-task-id>` — marks a human task done.
- `shipyard doctor` — validates the files (schema, unknown deps, cycles, duplicate ids) and that
  `claude`, `git` and the test command's first word resolve.
- `shipyard hook` — reads a Claude Code hook JSON payload on stdin; finds the project via
  `git rev-parse --git-common-dir` (works from worktrees) and appends to `activity.jsonl`. The feature
  id comes from `SHIPYARD_FEATURE` env. Must never exit non-zero or print to stdout (hooks must not
  break the session).
- `shipyard dash [--root DIR] [--port 7420]` — HTTP server on 127.0.0.1 only. Discovers every
  `*/.shipyard/features.json` up to depth 3 under `--root` (default: cwd). One HTML page (inline
  CSS/JS, light and dark) with two views:
  - **Agents**: per project, features grouped by status, onMock badges, last 20 activity lines;
    refreshes every 2s via `GET /api/state`.
  - **Only you**: every open human task across projects, sorted by number of features it unblocks
    (transitively), with steps and buttons "I did my part" (`POST /api/human/done`) and
    "Mark done" on `ready` features in manual-merge projects (`POST /api/feature/merged`).
  POST bodies are JSON `{project, id}`; `project` must be one of the discovered paths (no arbitrary
  paths). Requests with an `Origin` header other than the dash's own origin, or an unexpected `Host`
  header (DNS rebinding), are rejected.

## Skills copied by init

- `intake/SKILL.md` — interview the user briefly (at most 5 questions), then write `features.json`
  and `human.json` per the schemas above; every feature needs ≥1 concrete acceptance check; anything
  only the user can do (accounts, credentials, contracts, store hosts, legal) becomes a human task
  with exact steps and `unblocks`. Run `shipyard doctor` at the end.
- `ship/SKILL.md` — run `shipyard doctor`, then start `shipyard run --watch` in the background and
  report `shipyard status`; tells the user how to open `shipyard dash`.

## Hooks

The builder and evaluator are launched with
`--settings '{"hooks":{"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"shipyard hook"}]}],"Stop":[...same]}}'`
and env `SHIPYARD_FEATURE=<id>`; the command is `"<node>" "<shipyard>/bin/shipyard" hook` so it works
before `shipyard` is on PATH. The same `--settings` carries deny rules for `Edit` under
`<root>/.shipyard/` and `<root>/.git/` and for `git update-ref|push|branch -f|config` (see README,
Threat model). `summary` is the tool name plus the first 120 chars of the
command/file path.

## Done-condition (what "finished" means for this build)

1. `node --test` passes, and each test answers "what realistic bug would this catch". Required coverage:
   readiness rule (deps, manual vs auto merge, mockable vs blocking human tasks, cycles, ordering);
   state transitions incl. attempts → stuck and crash recovery; atomic write + lock (two concurrent
   writers, no lost update); evaluator output parsing (valid, invalid → fail); lessons dedupe;
   dash POST validation (unknown project rejected, foreign Origin rejected, done unblocks).
2. An end-to-end test in a temp git repo with a fake `claude` (a node script that commits a file and,
   in evaluator mode, returns a scripted verdict) shows: two independent features built in parallel
   and merged; one feature failing evaluation once then passing; one feature blocked by a
   non-mockable human task that `run --watch` waits on and resumes after `shipyard done`; a mockable
   one built `onMock`. The fake is selected via `SHIPYARD_CLAUDE`.
3. `shipyard dash` serves the page and `/api/state` against that temp repo (tested via fetch).
4. README.md: install, commands, file formats, and the safety limits above. Under 150 lines.
5. No npm dependencies; total source (excluding tests) aims for under ~1200 lines.
