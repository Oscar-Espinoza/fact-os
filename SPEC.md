# fact-os — spec and done-condition

A small tool with no runtime dependencies that runs a plan → build → evaluate → merge → compound loop over a
project's feature list using headless Claude Code (`claude -p`). One foreman process, N builders in
separate git worktrees, a separate evaluator per feature, a human inbox for what only the owner can do,
and one dashboard across projects.

## Constraints

- TypeScript on Bun >= 1.4, ESM, strict types (`lib/types.ts` holds the shapes below), **zero runtime dependencies**
  (node:* built-ins only, run by Bun). Dev dependencies: `typescript`, `@types/bun`. Tests use `node:test` + `node:assert`
  and run with `bun test`; `bun run typecheck` (`tsc --noEmit`) must be clean.
- Lives in `~/Projects/fact-os`; installed by symlinking `bin/fact-os` to `~/.local/bin/fact-os`.
- It is not a Claude Code plugin. `fact-os init` copies two project skills into the target repo's
  `.claude/skills/` (`intake`, `ship`). Everything else is the CLI.
- It never pushes, never force-deletes branches, never runs `git reset --hard` or `git clean`, never kills
  processes it did not start, and never touches anything outside the project repo, its worktrees dir and
  `~/.local/state/fact-os/`.
- All state files are JSON and written atomically (write temp + rename) under a lock file
  (`.fact-os/.lock`, O_EXCL, stale after its PID is dead). The dashboard and the foreman may write
  concurrently; no write may be lost.

## Files (per project, in the main checkout)

`.fact-os/config.json`
```json
{
  "base": "main",
  "worktreesDir": "../<repo>-worktrees",
  "branchPrefix": "ship/",
  "maxParallel": 3,
  "maxAttempts": 2,
  "budgetUsdPerRun": null,      // null = no cap; a positive number is passed as --max-budget-usd to each claude -p call
  "budgetUsdTotal": null,       // stop launching once costs reported during this `fact-os run` reach it; null = unlimited
  "timeoutMin": null,           // null = no timeout; otherwise per claude/test/postMerge child, and the whole process group is killed
  "builder":   { "model": "opus", "effort": "medium", "permissionMode": "auto" },
  "evaluator": { "model": "opus", "effort": "high",   "permissionMode": "auto" },
  "test": "pnpm test",           // run in the feature worktree after build; exit 0 = pass
  "merge": "auto",              // "auto": foreman merges; "manual": status becomes "ready" and stops there
  "briefFiles": [],             // extra files whose contents are appended to builder AND evaluator prompts
  "lessonsFile": "CLAUDE.md",   // where compounded lessons are appended
  "postMerge": null,            // optional shell command run in the main checkout after a merge
  "prepare": null,              // optional shell command run in the feature worktree before every build (idempotent)
  "refreshBeforeTest": false,   // true: merge the recorded base sha into the feature branch before its test (see Test)
  "maxRefreshes": 5,            // base refreshes after merge conflicts before a feature is stuck
  "mergeHook": null,            // optional shell command run in the main checkout on the staged merge, before its commit (see Pass)
  "groupBy": null               // conflict groups: null = only explicit `group`s; "idPrefix:<n>" = a feature's group defaults to its id's first n chars
}
```
`.fact-os/features.json` — `{ "features": [Feature] }`
```
Feature {
  id: string (slug, unique), title, description,
  acceptance: string[]            // checks the evaluator verifies, each concrete and testable
  surface: "web"|"api"|"ios"|"android"|"desktop"|"any",
  deps: string[]                  // feature ids
  priority: number                // lower = sooner
  branch?: string                 // existing branch to continue/evaluate instead of starting fresh
  group?: string                  // conflict group: never in flight together with another feature of the same group
  status: "todo"|"building"|"testing"|"evaluating"|"ready"|"merged"|"stuck"|"paused"
  issue?: number                  // GitHub issue number (dashboard shows #n, linked when the origin remote is GitHub)
  pausedAt?: ISO string           // set while paused; only a person pauses (CLI or dashboard), never the foreman
  onMock?: boolean                // built while a human task it needs is open
  attempts: number, refreshes?: number /* base refreshes after merge conflicts */, lastFeedback?: string, costUsd?: number, updatedAt: ISO string
  sha?: string                    // evaluated commit, recorded when the feature becomes ready or merged
  parked?: boolean                // ready only because the main checkout was dirty or off base (merge-skipped)
  pid?, pidStart?, foremanPid?    // current child: pid, /proc/<pid>/stat start time, foreman that spawned it
}
```
`.fact-os/human.json` — `{ "tasks": [HumanTask] }`
```
HumanTask { id, title, steps: string[], unblocks: string[] /* feature ids */,
            mockable: boolean, status: "open"|"done", doneAt?, startedAt?, checked?: number[],
            waitingOn?: string /* who the person waits on; status stays open */, waitingSince?: ISO string }
```
`.fact-os/log.jsonl` — one JSON line per event (`{ts, feature, event, detail}`).
`.fact-os/activity.jsonl` — hook events (`{ts, session, feature, tool, summary}`), capped to last 2000 lines.
`.fact-os/runs/<feature>/<attempt>-{build,eval}.json` — raw `claude -p --output-format json` results.
`.fact-os/.foreman` — pid of the running foreman (one per repo).

## Readiness rule (pure function, heavily tested)

A feature is **ready** when: status is `todo`; every dep is `merged` (or `ready` when `merge` is
"manual"); and for every open human task that lists it in `unblocks`, that task is `mockable`
(then the feature is built with `onMock: true`). A feature blocked by an open non-mockable human task
is **waiting-on-human**. Ready features are ordered by priority, then by how many other features
transitively depend on them (more first), then id. Dependency cycles and unknown dep ids are reported
by `fact-os doctor` / at load and those features are never ready.

## Foreman loop — `fact-os run [--watch] [--once] [--max-features N]`

Each tick:
1. Load state. A feature left in `building|testing|evaluating` by a dead foreman becomes `merged` if its
   branch tip is reachable from `base` but not on its first-parent line; is left alone while its recorded
   child is alive (same pid and start time; EPERM = dead; without /proc, dead once its foreman is dead), at
   most `timeoutMin`, after which it becomes `stuck` with feedback "previous child still running (pid N)"
   (the child is not killed, and relaunching would put two processes in one worktree); otherwise goes back
   to `todo` (worktree kept and reused).
2. Under `merge: "auto"`, if any feature is `parked` and the main checkout is now clean and on `base`, merge
   each one's recorded `sha` if its branch still points to it (else back to `todo`), then reload.
   Launch ready features, in readiness order, until `maxParallel` are in flight (a ceiling, not a target). A feature
   whose conflict group (`group`, else per `groupBy`; none when both are unset) already has a feature in flight
   (`building|testing|evaluating`, including a previous foreman's live orphan) is skipped for the next-best ready
   feature of another group, so features touching the same hot files never run at the same time.
3. Per feature (concurrently):
   - **Build.** Create/reuse worktree `<worktreesDir>/<id>` on `<branchPrefix><id>` (or `branch`) from
     `base`. Run `claude -p` in it with the builder prompt: feature, acceptance checks, onMock note,
     previous evaluator feedback, lessons file, briefFiles, and the rule "commit your work; do not
     weaken or delete tests to make them pass; do not stub behavior the acceptance checks require", plus: the builder may
     run parallel subagents on disjoint files; only it commits, and nobody merges, rebases, pulls or switches branches,
     except that the builder completes (resolve, `git add`, `git commit`) a merge the foreman started in its worktree.
     A branch with no commits of its own is first fast-forwarded to `base` (ff-only, clean worktree only).
     Hook settings and deny rules are passed via `--settings` (see Hooks). Afterwards the worktree must be
     clean, with no merge in progress, and the branch must have commits beyond `base` (a merge commit completing a
     base refresh counts), else the attempt fails with "commit your work" (plus `git status --porcelain`, 40 lines); the branch sha is recorded and only that sha is tested,
     evaluated and merged.
   - **Refresh before test** (`refreshBeforeTest: true` only). If the recorded base sha is not an ancestor of the
     branch, a base refresh (below) runs now, before the test. Clean → the pipeline goes on: the new branch tip (the
     foreman's merge commit) becomes the recorded sha that is tested, evaluated (`base...<sha>` still shows only the
     feature's own changes) and merged; this does not count in `refreshes`. Conflicted → the same as the refresh after
     a merge conflict: merge left in progress, `todo` with the conflict feedback, no attempt spent, `refreshes++`
     (at `maxRefreshes`, the merge is aborted and the feature is `stuck`). So the test always runs on "current base + this feature".
   - **Test.** Run `config.test` in the worktree. Failure → feedback = tail of output, attempt++.
   - **Evaluate.** A fresh `claude -p` (never a resumed builder session) gets the acceptance list as read at launch, the
     test output and the diff `base...<sha>` (`--text --no-ext-diff --no-textconv`), built as: `git diff --stat`; files
     matching `evaluatorDiffExclude` pathspecs (generated files, fixtures) listed by name only; then whole files' diffs in
     order while they fit in 150,000 characters, with every file that did not fit listed under "NOT SHOWN" (never a silent
     cut). It must run each test file the feature adds or changes, check one mutation per money/permission/tenant/state
     check in a scratch worktree, and check production wiring (no path that only works with a fake or a development
     setting; every new state has a production writer). It answers with a JSON object
     `{ "pass": boolean, "findings": [{ "check": string, "ok": boolean, "evidence": string }], "cheating": string[],
        "blocking": string[], "notes": string[], "lesson": string|null }` with one finding per acceptance check plus a
     "production wiring" finding. It is told to look for pass-through implementations, tests that cannot fail,
     skipped/deleted tests and hard-coded results (`cheating`), and to list under `blocking` any defect in money, auth,
     tenant isolation or state handling, fake- or dev-only paths, multi-line copies of existing helpers, unchecked
     behaviour changes of existing exports and weakened unrelated tests, even when no acceptance check names them.
     Unparseable output, no findings, or `pass: true` with a failed finding, cheating or a blocking entry counts as a
     fail. `notes` never block; `lesson` is advice for future builders only.
   - **Pass** → `merge: "auto"`: in the main checkout (must be clean and on `base`, else the feature
     becomes `ready` with `parked: true` and a log event explains why; "clean" = no tracked changes outside `.fact-os/`),
     `git merge --no-ff <sha>` (refused if the branch moved since it was recorded; a merge git refuses to
     start leaves the feature `ready` without costing an attempt); on conflict, `git merge --abort`, then a
     **base refresh**: the foreman runs `git merge --no-edit <recorded base sha>` in the feature's worktree
     (which must be clean, else attempt++). Clean → `todo` with feedback "the foreman merged <base> into your
     branch (conflict-free); re-run the tests and fix anything the new base broke". Conflicted → the merge is
     left in progress, `todo` with feedback "the foreman started merging <base> into your branch and it
     conflicts in: <files>. Resolve the conflicts preserving both sides' intent, run the tests, and commit the
     merge (git add + git commit). Do not abort it and do not start another merge or rebase." Neither spends
     an attempt; `refreshes++` instead, and a conflict with `refreshes` already at `maxRefreshes` makes the feature `stuck`
     ("too many base refreshes"). With `mergeHook` set, the merge is `git merge --no-ff --no-commit <sha>` (conflicts
     handled as above); then `mergeHook` runs in the main checkout with env `FACTOS_FEATURE` and `FACTOS_BRANCH`
     (e.g. to assign migration numbers; files it changes and `git add`s become part of the merge commit), and the
     foreman commits with the usual message; that commit is its own (`base` sha re-recorded, no tamper alert). A hook
     exiting non-zero (or a failed commit) → `git merge --abort`, a `merge-hook-failed` event with the output tail, and
     `todo` with that output as feedback, spending no attempt. Otherwise run `postMerge`. Status `merged`. `merge: "manual"` → status `ready`.
   - **Fail** → attempts++, `lastFeedback` = failed findings, cheating and blocking entries; back to `todo`; at
     `maxAttempts` → `stuck`.
   - **Compound.** A non-null `lesson` is appended to `lessonsFile` as one dated bullet under a
     `## fact-os lessons` heading (created if missing), deduplicated by exact text, and committed on
     `base` (that file only) when the main checkout is on `base` and the file had no local edits.
   - **Tamper checks.** If `config.json` changes on disk, or `base` moves other than by the foreman's own
     merges/lesson commits so that it reaches a feature-branch commit, or its new objects
     (`git rev-list --objects <newBase> ^<recordedBase>`) include a non-empty blob that is also in a feature
     branch, log an `alert`, launch and merge nothing more, exit 2. Commits reachable from a `ready` or
     `merged` feature's recorded `sha` do not count, so merging a `ready` branch by hand is fine; nor do commits of
     `base` that reach a feature branch through a base refresh (they are reachable from the recorded base). Other
     `base` moves are logged and re-recorded.
4. Stop conditions: nothing in flight and nothing ready → if `--watch` and some feature is
   waiting-on-human or `paused`, sleep and re-check whenever `human.json`/`features.json` mtime changes (poll 5s), and
   while some feature is `parked`, re-check every poll;
   otherwise exit printing a summary. Also stop launching when `budgetUsdTotal` is reached, or on
   SIGINT/SIGTERM (SIGTERM to each child's process group; in-flight features back to `todo` without
   spending an attempt; a second signal SIGKILLs the groups and exits at once).
   Exit code 0 when all features are `merged`/`ready`, 2 when stopped with stuck, waiting or paused features.

The `claude` binary is `process.env.FACTOS_CLAUDE || "claude"` so tests can substitute a fake.

## Other commands

- `fact-os init [--test "<cmd>"]` — creates `.fact-os/` with default config and empty
  features/human files, copies skills into `.claude/skills/`, adds `.fact-os/runs/`,
  `.fact-os/*.jsonl` and `.fact-os/.lock` to `.git/info/exclude`. Idempotent; never overwrites.
- `fact-os status` — table of features and open human tasks.
- `fact-os done <human-task-id>` — marks a human task done.
- `fact-os pause|resume|retry <feature-id>...` — `pause`: `todo`/`stuck` → `paused` (in-flight features
  belong to the foreman and are refused). `resume`: `paused` → `todo`, with `attempts` reset to 0 when
  they had reached `maxAttempts`. `retry`: `stuck` → `todo` with `attempts` and `refreshes` reset;
  `lastFeedback` is kept so the next build sees it. Each applied action is logged (`paused`,
  `resumed`, `retrying`). A paused feature is never ready, so its dependents wait too; `run --watch`
  keeps waiting while any feature is paused. Exit 1 if any id was refused.
- `fact-os doctor` — validates the files (schema, unknown deps, cycles, duplicate ids) and that
  `claude`, `git` and the test command's first word resolve.
- `fact-os hook` — reads a Claude Code hook JSON payload on stdin; finds the project via
  `git rev-parse --git-common-dir` (works from worktrees) and appends to `activity.jsonl`. The feature
  id comes from `FACTOS_FEATURE` env. Must never exit non-zero or print to stdout (hooks must not
  break the session).
- `fact-os dash [--root DIR] [--port 7420]` — HTTP server on 127.0.0.1 only. Discovers every
  `*/.fact-os/features.json` up to depth 3 under `--root` (default: cwd). The page is `lib/dash.html`
  (inline CSS/JS, no dependencies, light and dark, phone width), polling `GET /api/state` every 2s,
  one project at a time (picker in the header) with four views:
  - **Factory**: intake (ready queue, blocked/waiting/paused counts) → build bays (one per
    `maxParallel`; pixel-art worker building a house as the build progresses; idle bays as empty lots)
    → test bench → inspection (evaluator) → dock (merged/ready), a stuck list with Retry, and a live
    feed of `log.jsonl` events and hook activity.
  - **Board**: every feature grouped by epic (`group`, `groupBy`, or the id up to its first `-`), fixed
    height rows, status filters and search; a row opens a side panel with progress, actions
    (pause/resume/retry), feedback, description, acceptance, deps, dependents, human tasks, details
    and the feature's timeline (`GET /api/feature?project=&id=`).
  - **Project**: `<state dir>/project-view.html` if present, in an iframe with `sandbox="allow-scripts"`
    and served with `Content-Security-Policy: sandbox allow-scripts` (opaque origin: it cannot call
    the API). The dashboard posts `{type: "fact-os-state", project, features: [{id, title, status,
    group}]}` to it on every change. Otherwise an empty state explaining how to add one.
  - **Only you**: every open human task across projects, sorted by number of features it unblocks
    (transitively), with steps and "I did my part" (`POST /api/human/done`), plus "Mark merged" on
    `ready` features in manual-merge projects (`POST /api/feature/merged`).
  Progress is an estimate: building is 0–60%, testing 60–80%, evaluating 80–100%; within a stage it
  moves with elapsed time against the median duration of that stage (build/eval from the last 200
  `runs/*/*-{build,eval}.json` `duration_ms`, test from `testing` → `evaluating` log pairs; 12/5/4 min
  until there is history), capped below the next stage. A stage started at its log event (`launch`,
  `testing`, `evaluating`) after the feature's last launch, else at `updatedAt`.
  `/api/state` projects also carry `repoUrl?` (`https://github.com/<owner>/<repo>` from `.git/config`'s origin) and
  `stats {mergedAt: ISO[] /* merged events, last 48h */, costToday, costYesterday}` (`total_cost_usd` of
  `runs/*/*.json` by mtime, local day). `GET /api/feature` returns `{log, activity, runs}`; `runs` are the last 20
  `{n, role: build|eval, at, ms, cost, turns, model, pass?, findings?, summary}` from `runs/<id>/`.
  `POST /api/human/wait {project, id, who}` (who: 1-200 chars, else 400; 409 if done) sets `waitingOn`/`waitingSince`;
  `/api/human/unwait` clears them; `reopen` and `done` clear them too.
  POST bodies are JSON `{project, id}` (`/api/feature/{pause,resume,retry}` too); `project` must be one
  of the discovered paths (no arbitrary paths). Requests with an `Origin` header other than the dash's
  own origin, or an unexpected `Host` header (DNS rebinding), are rejected.

## Observer — `fact-os observe [--watch] [--agent]`

A second process beside the foreman (one per project, pid in `<state dir>/.observer`). Each pass reads the new
complete lines of `log.jsonl` (byte offset kept in `observer.json`; a shorter log starts over) and:

1. **Diagnoses** every `stuck` and `failed` event. Failing test files are the `*.test|spec.*` paths on failure lines
   of the feedback (`FAIL`, `×`, `✗`, `not ok`, `(fail)`), resolved to repo paths against the feature branch's tree
   (an exact path, or the single file ending in `/<name>`). What the feature changes is `base...<branch>`, or, once
   the branch is gone, its merge commit `M^1...M^2` on base. Causes, first match wins: `infra` (feedback contains an
   infrastructure pattern: out of shared memory, ENOSPC, too many clients, ECONNREFUSED, a terminated or restarting
   database, cannot allocate memory, plus `observer.infraPatterns`); `conflict-loop` (too many base refreshes);
   `setup` (prepare or worktree); `builder` (builder or evaluator run, uncommitted work); for a failed test command,
   `own` when the feature changes a failing test or a file in its directory, else `untouched` (`unknown` when no
   test file is recognized); `own` for an evaluator rejection; otherwise `unknown`.
2. **Sends back** a feature whose latest event is `stuck` with cause `untouched` or `infra` (`observer.retry`), at most
   `maxRetries` times per failure signature (cause + sorted tests, or the infra pattern): under the lock, only if it
   is still `stuck`, `todo` with `attempts`/`refreshes` 0 and `lastFeedback` = a note that the failure was outside the
   feature followed by the original feedback. Logged `observer-retry`. Anything else is "left for a person". A feature that is no longer stuck
   when the observer looks is left alone.
3. **Re-parks** a `ready` feature whose merge never started (`merge-failed`), so an auto-merge foreman retries it
   (`observer-parked`).
4. **Alerts** (logged `observer-alert`, shown for 24h, not repeated within an hour): the foreman is not running while
   features are left; a foreman `alert` event; features parked for over 10 minutes (with the main checkout's
   uncommitted files); a file whose merge conflicts sent 5+ features back in 24h after they passed evaluation (at most
   once a day per file). Such "bounces" (a `refreshed` with conflicts right after `evaluating`, a `lesson` in
   between allowed) are kept 7 days and reported with their files.
5. **Improves** (with an agent, `observer.improve`, at most every `improveEveryHours` (6), while fewer than
   `maxOpenImprovements` (2) of its features are unmerged, and only when the last 24h show something systemic: bounces,
   alerts, recurring tests, or failures outside the features' own code): `claude -p` in **plan mode** (read-only) reads
   the observations and the repository and answers with at most two improvements. Changes inside the repo become
   features in `features.json` (`todo`, ahead of every other feature, ids in the project's style: `<L>99-<nn>-<slug>`
   when every id looks like `<L><dd>-<dd>…`, else `imp-<nn>-<slug>`; logged `observer-improve`), so the foreman builds,
   gates, evaluates and merges them like any feature. Anything outside the repo (machine or database settings, gate
   scripts, the factory's config) becomes an open human task `observer-<time>-<n>`. It never proposes skipping or
   weakening tests or checks, and the observer itself never commits code.
6. **Curates the lessons** (with an agent, at most every `curateEveryHours`): when the lessons section of
   `lessonsFile` grows past `lessonsMaxBytes` (12000), `claude -p` rewrites it into at most that many bytes of bullets
   under 3–8 `### topic` headings, favoring lessons that prevent the recent failure causes. The answer must sit between
   `<lessons>` tags, hold at least 5 bullets, only bullets and topics, and stay within 1.25× the limit; otherwise the
   file is left alone (`observer-lessons` "not curated"). On success the old section is appended to
   `<lessonsFile>.archive.md`, the section is replaced (with a note pointing at the archive), lessons the foreman
   appended meanwhile are kept after it, and a tracked file is committed on base (`fact-os: curate lessons`; skipped
   when the checkout is not on base or the file has uncommitted changes).
7. **Measures the agents** over the last 7 days, per prompt version (a version starts at a lessons curation or when the
   builder's model, effort or briefs change, from `prompt` events): per `launch`, whether the build reached the test
   (setup failures from `prepare`/worktree are counted apart, not against the builder; a conflicting refresh before the
   test is a builder outcome), passed the gate, passed the evaluator, merged or bounced; median build, gate and
   evaluation minutes; build and evaluation cost from the run files by completion time; the evaluator's top rejection
   reasons. The foreman logs a `prompt` event per run (`<role> model= effort= lessons=<sha8> briefs=<sha8>`), saves the
   prompt as `runs/<id>/<tag>-(build|eval).prompt.md`, and tags run files `<attempt>` or `<attempt>.<k>` so a later pass
   of the same attempt never overwrites them.
8. **Reports** to `<state dir>/observer-report.md`: features merged/in progress/to do/stuck/paused, what needs a
   person (alerts, stuck features with their cause, open proposals), the last 24h (failures by cause, tests failing
   in several features, retries, fixes) and the last 15 decisions. Times are local.

`--watch` repeats every `observer.pollSec` (60). `--agent` turns on the agent (opus, high effort) when the config has none.
Config (`observer` in `config.json`, all optional): `pollSec`, `retry` (true), `maxRetries` (1),
`infraPatterns` ([]), `recurring` (2), `agent` (null or `{model, effort, permissionMode}`), `improve` (true), `improveEveryHours` (6),
`maxOpenImprovements` (2), `lessonsMaxBytes` (12000), `curateEveryHours` (4). The foreman ignores the key, but editing `config.json` during a run still halts it.

## Skills copied by init

- `intake/SKILL.md` — interview the user briefly (at most 5 questions), then write `features.json`
  and `human.json` per the schemas above; every feature needs ≥1 concrete acceptance check; anything
  only the user can do (accounts, credentials, contracts, store hosts, legal) becomes a human task
  with exact steps and `unblocks`. Run `fact-os doctor` at the end.
- `ship/SKILL.md` — run `fact-os doctor`, then start `fact-os run --watch` in the background and
  report `fact-os status`; tells the user how to open `fact-os dash`.

## Hooks

The builder and evaluator are launched with
`--settings '{"hooks":{"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"fact-os hook"}]}],"Stop":[...same]}}'`
and env `FACTOS_FEATURE=<id>`; the command is `"<bun>" "<fact-os>/bin/fact-os" hook` so it works
before `fact-os` is on PATH. The same `--settings` carries deny rules for `Edit` under
`<root>/.fact-os/` and `<root>/.git/` and for `git update-ref|push|branch -f|config` (see README,
Threat model). `summary` is the tool name plus the first 120 chars of the
command/file path.

## Done-condition (what "finished" means for this build)

1. `bun test` passes, and each test answers "what realistic bug would this catch". Required coverage:
   readiness rule (deps, manual vs auto merge, mockable vs blocking human tasks, cycles, ordering);
   state transitions incl. attempts → stuck and crash recovery; atomic write + lock (two concurrent
   writers, no lost update); evaluator output parsing (valid, invalid → fail); lessons dedupe;
   dash POST validation (unknown project rejected, foreign Origin rejected, done unblocks).
2. An end-to-end test in a temp git repo with a fake `claude` (a Bun script, `fixtures/fake-claude.ts`, that commits a file and,
   in evaluator mode, returns a scripted verdict) shows: two independent features built in parallel
   and merged; one feature failing evaluation once then passing; one feature blocked by a
   non-mockable human task that `run --watch` waits on and resumes after `fact-os done`; a mockable
   one built `onMock`. The fake is selected via `FACTOS_CLAUDE`.
3. `fact-os dash` serves the page and `/api/state` against that temp repo (tested via fetch).
4. README.md: install, commands, file formats, and the safety limits above. Under 150 lines.
5. No runtime dependencies; total source (excluding tests) aims for under ~1200 lines.
