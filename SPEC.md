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
- All state files are JSON and written atomically (write temp + rename) under a lock
  directory (`.fact-os/.lock`). A staging directory already containing a unique
  `owner-<pid>-<uuid>` marker is atomically renamed into place; a populated live lock
  cannot be replaced. Recovery unlinks only the dead owner's exact marker, then
  nonrecursively removes the empty directory. Release follows the same ownership rule.
  Empty directories recover immediately, unknown contents time out, and every failed
  acquisition yields with a bounded timeout. The dashboard and foreman may write
  concurrently; no write may be lost. Local atomic directory rename is required.
  Legacy PID-file locks fail closed: stop all old writers before upgrading, remove any
  leftover legacy file only after stopping them, rerun `init` to update existing
  projects' staging-directory ignores, and restart with the new code.
  Mixed versions are unsupported. Unpublished `.lock.*` staging directories left by
  a crash are harmless (ignored by `init`); clean them only with all writers stopped.
  PID reuse delays recovery conservatively rather than risking a live owner's lock.

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
  "groupBy": null,              // conflict groups: null = only explicit `group`s; "idPrefix:<n>" = a feature's group defaults to its id's first n chars
  "restoreFrom": null,          // null or a ref with "{id}": earlier work for a branch with none (see Build)
  "claims": null,               // file claims (see Launch): null = off; {hot: [paths or "dir/"], minScore: 3, days: 7}
  "conflictBrief": false,       // true: a conflicting refresh's feedback carries both sides' context; resolutions are keep-checked
  "resolver": null,             // null = the builder resolves conflicts on its next build; {model, effort, permissionMode} = a resolver run, same pass
  "profiles": {}                // extra model profiles (see Model profiles); optional
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
  touches?: string[]              // files (or "dir/" prefixes) it is expected to change: claimed while it runs (see Launch)
  risk?: "high"|"normal"          // "high": the builder gets its model profile's effortHigh; "normal": never; absent: keywords decide (see Model profiles)
  conflict?: {ours, theirs, files} // a conflicted base refresh whose committed resolution is not keep-checked yet (foreman-owned)
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
`.fact-os/runs/<feature>/<tag>-{build,eval,resolve}.json` — raw `claude -p --output-format json` results (tag: see Observer 7).
`.fact-os/prompt-notes/<model>-<role>.md` (+ `.archive.md`) — per-model prompt notes (see Observer 8), git-ignored by `init`.
`.fact-os/.foreman` / `.fact-os/.observer` — running supervisor ownership:
PID on the first line, unique invocation token on the second. Claim and release
are serialized by the state lock; atomic marker publication rejects every live PID,
including same-process calls. Foreman and observer own separate markers and may run
together. Release compares the full marker and runs on startup/loop/summary errors;
installed signal listeners are removed on failed startup. Existing plain-PID markers
are supported; dead PIDs and empty old markers recover, invalid PID text fails closed.
Temporary `.foreman.*.tmp` / `.observer.*.tmp` files are ignored by `init`; crashes
before publication may leave harmless artifacts. PID reuse can delay recovery.
`.fact-os/control.json` — a person's runtime limits on new launches (CLI `pause-all`/`resume-all`/`lanes`/`profile`, or the dashboard):
```
Control { paused: boolean, maxParallel: number|null /* integer 0–32; null = config.maxParallel */,
          profile: string|null /* model profile for new launches; null = "opus" */, updatedAt: ISO, by: "dashboard"|"cli" }
```
A missing file (or a missing field) means not paused, the config's lanes and the opus profile. A file that exists but is not
JSON, not an object, has a wrong `paused`/`maxParallel`, a `profile` that is neither a string nor null, or a profile name the
config does not know is **invalid**, never read as the defaults (see Launch limit); `fact-os doctor`
reports it and any control command rewrites it. Written atomically under the lock. It is not `config.json`, so changing it
during a run never trips the tamper halt.

## Model profiles (`lib/profiles.ts`, pure)

A profile names the model and effort per role: `builder`, `resolver`, `evaluator`, `observer` (the observer's improver) and
`curator` (its lessons curation). Two ways to run the factory are built in:
- **`opus`** (the main mode, reserved): each role's own config (`builder`, `evaluator`, `resolver ?? builder`, the observer's
  `agent`). `null` in `control.json` means opus; `"opus"` (file, CLI, API) is read and stored as `null`. `default` is only a
  CLI alias (`fact-os profile default`): the API answers 400 to it, and in the file it is an unknown name (invalid).
- **`fable-sonnet`**: Fable thinks, Sonnet writes the code.
  ```json
  "fable-sonnet": {
    "builder":   { "model": "sonnet", "effort": "medium", "effortHigh": "high" },
    "resolver":  { "model": "sonnet", "effort": "high" },
    "evaluator": { "model": "fable",  "effort": "high" },
    "observer":  { "model": "fable",  "effort": "high" },
    "curator":   { "model": "fable",  "effort": "medium" }
  }
  ```
`config.profiles` (`{name: {role: {model?, effort?, effortHigh?}}}`) adds profiles; one with a built-in's name replaces it
whole. `opus`/`default` can't be redefined. A role a profile doesn't name falls back to its config; an entry overrides only
the fields it has; `permissionMode` always comes from the role config. Model names pass through to `claude --model`.
**Risk:** the builder's effort is the entry's `effortHigh` (when it has one) for a risky feature: `risk: "high"`; any other
`risk` value is not risky; untagged, a keyword in the **title**, or keywords of **at least two distinct families** in the
description (long descriptions mention a migration or a payment in passing; one family there is not enough). Families
(`RISK_KEYWORDS`, case-insensitive whole words with their inflections): money; payment; refund (refundable); price/pricing;
invoice; tax; permission; auth (auth/authn/authz, oauth, (un/re)authenticate(d), (un)authorize(d)/authorization(s); never
"author"); token, only in its auth senses (JWT, API key, access/refresh/auth/bearer/API/session/CSRF/ID token; never
"design tokens"); tenant/tenancy; RLS; migration/migrate; concurrency/concurrent; lock/locking/deadlock (never "block",
"clock", a lock file: "bun.lock", "pnpm-lock.yaml", "lockfile", "lock file", nor a hyphen-preceded "-lock"); race/race
condition (never "trace", "brace"); state machine. Login, checkout and pay are deliberately not keywords. `fact-os profile`
and `doctor` print how many not-merged features would escalate. Opus never escalates. The active profile applies to new launches only (see Launch limit).

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
   each one's recorded `sha` if its branch still points to it (else back to `todo`), then reload. With
   `refreshBeforeTest: true`, a SHA that lacks current base is instead queued as `todo`, retaining its evaluated
   SHA so the next launch can reuse the clean build and repeat refresh/test/evaluation before merging.
   **Launch limit:** `control.json` is re-read every tick; the limit is 0 while `paused`, else `control.maxParallel`, else
   `config.maxParallel` (at least 1). The in-flight count it is checked against is this foreman's own launches plus live
   children of a previous foreman (step 1's orphans), for either limit, so the count matches what the dashboard and CLI
   show; while an orphan holds a lane the foreman polls for it to end. The limit only gates new launches: nothing in flight
   is interrupted (a lower limit waits for the count to drop below it; a feature that falls back to `todo` mid-pipeline is a
   new launch, so it waits too), parked merges above still merge while paused, and a `control.json` change wakes the loop
   even with every lane busy, so more lanes or a resume launch at once. An invalid `control.json` keeps the last good
   control read in this run, or, with none yet (invalid at startup), is treated as paused; it is logged `control-invalid`
   once per bad content. The first read is logged `control` "at start: …" only when it is not the default; later changes
   as `control` (old → new, with the launch limit); ready features held by a person's limit are logged `paused-launch`
   once per limit and held set.
   **Model profile:** the profile in `control.json` (validated against the config: an unknown name makes the file invalid,
   and the last good control, profile included, is kept) is snapshotted when a feature launches; every `claude -p` of that
   pass (builder, resolver, evaluator) uses it, so a pass started under one profile finishes under it and a switch only
   reaches new launches. A change (and a non-opus profile at start) is logged as `control`, e.g. "running, lanes default,
   profile opus → running, lanes default, profile fable-sonnet". A foreman restarted after a switch may evaluate (or resume
   after the build) a branch that was built under the old profile: the profile is per pass, not recorded per branch.
   Launch ready features, in readiness order, until the launch limit is in flight (a ceiling, not a target). A feature
   whose conflict group (`group`, else per `groupBy`; none when both are unset) already has a feature in flight
   (`building|testing|evaluating`, including a previous foreman's live orphan) is skipped for the next-best ready
   feature of another group, so features touching the same hot files never run at the same time.
   **Claims** (`claims` set): a ready feature is also skipped while a feature in flight holds one of its hot files. A file
   is hot when it matches `claims.hot` (a path, or a prefix ending in "/") or when its conflicting refreshes in `log.jsonl`
   over the last `claims.days` score at least `claims.minScore` (1 per `refreshed` with "conflicts in:", 2 when it came right
   after `evaluating`, a `lesson` in between allowed). A feature's files are its `touches`, the committed diff
   `base...<branch>` when the branch exists, and its worktree's uncommitted edits (`git status`; while a base refresh is in
   progress only unmerged files and unstaged edits, not base's staged changes). Only features in flight hold claims, so a
   claim never waits on anything that is not running; a skip is logged once per reason as `claim-wait` ("<file> is claimed
   by <id>"), and the builder of a launched feature is told which hot files others in flight hold.
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
   - **Resume.** If the feature's previous pass ended with `interrupted` after its `testing <sha>` event (the foreman was
     stopped once the build was done) and the branch is still exactly at that sha with a clean worktree and no merge in
     progress, the builder is skipped (`build-skipped` event) and the pass goes on to the refresh and the test.
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
     start leaves the feature `ready` without costing an attempt). With `refreshBeforeTest: true`, immediately
     before merging, inside the serialized checkout operation, current base must be an ancestor of the evaluated
     SHA. Otherwise log `revalidate` and repeat refresh/test/fresh evaluation without another builder after a
     clean refresh. Earlier evaluation files/prompts are retained under distinct run tags. Conflicts use the
     existing resolution path; a refresh alone spends no attempt, while a failing aggregate gate does.
     On conflict, `git merge --abort`, then a
     **base refresh**: the foreman runs `git merge --no-edit <recorded base sha>` in the feature's worktree
     (which must be clean, else attempt++). Clean → `todo` with feedback "the foreman merged <base> into your
     branch (conflict-free); re-run the tests and fix anything the new base broke". Conflicted → the merge is
     left in progress, `todo` with feedback "the foreman started merging <base> into your branch and it
     conflicts in: <files>. Resolve the conflicts preserving both sides' intent, run the tests, and commit the
     merge (git add + git commit). Do not abort it and do not start another merge or rebase." (With `conflictBrief` or
     `resolver`, see **Resolving a conflict**.) Neither spends
     an attempt; `refreshes++` instead, and a conflict with `refreshes` already at `maxRefreshes` makes the feature `stuck`
     ("too many base refreshes"). With `mergeHook` set, the merge is `git merge --no-ff --no-commit <sha>` (conflicts
     handled as above); then `mergeHook` runs in the main checkout with env `FACTOS_FEATURE` and `FACTOS_BRANCH`
     (e.g. to assign migration numbers; files it changes and `git add`s become part of the merge commit), and the
     foreman commits with the usual message; that commit is its own (`base` sha re-recorded, no tamper alert). A hook
     exiting non-zero (or a failed commit) → `git merge --abort`, a `merge-hook-failed` event with the output tail, and
     `todo` with that output as feedback, spending no attempt. Otherwise run `postMerge`. Status `merged`. `merge: "manual"` → status `ready`.
   - **Resolving a conflict** (`conflictBrief: true` or `resolver` set; both off = as above). The refresh merges with
     `merge.conflictStyle=diff3`, records `conflict: {ours: <branch tip before the merge>, theirs: <base sha>, files}` on the
     feature, and builds the **both-sides brief**: this feature (description, acceptance), every commit on base's first-parent
     line since `git merge-base ours theirs` that touches a conflicting file (the foreman's `<NAME>: merge <id>: <title>` merges,
     also the pre-rename `shipyard:` prefix, with that feature's description and acceptance from `features.json`; other commits
     by subject), and each conflicting file's conflict blocks with 3 lines of context (4000 chars a file, 16000 in all). The
     conflict feedback gains "keep every line either side added; list any line you must drop or change in a commit message as
     `dropped: <file>: <line>`" plus the brief.
     Without a resolver the feature goes back to `todo` as above and the builder resolves. With `resolver` set and a pipeline
     waiting (a refresh before the test, or a merge bounce), the feature stays in flight (same slot, same claims; status
     `building` while it resolves): a
     **resolver** run (`claude -p` with the `resolver` role config, prompt "You are the merge resolver…": the brief, keep
     both behaviours, keep every line or declare it, change nothing else, run quick checks, `git add` + `git commit`, never
     abort or start another merge) finishes the merge in the worktree. It fails when the run fails, the merge is left
     uncommitted, the worktree is dirty, or the tip does not contain both `ours` and `theirs`; then the feature goes back to
     `todo` with the conflict feedback plus "A resolver run tried first: <why>" (`resolve-failed`), and the builder finishes.
     The **keep-lines check** runs on every committed resolution (the resolver's at once, the builder's after its build, before
     the refresh-before-test and the test). Per conflicting file, over trimmed non-blank non-comment lines (comments: `//`,
     `/*`, `*`, `#`, `<!--`, `-- `): the tip must hold at least base + (ours − base) + (theirs − base) copies of each line
     either side added (a line with a letter or digit added by both sides: base + max of the two); a short line is
     *changed*, not lost, when the tip has a new line (one neither side had) of the same shape (digits as #, no trailing
     `,`/`;`), ≥ 85% alike (character-bigram Dice) or holding all its words (3+), each new line excusing at most one line of
     each side; lines listed as `dropped: <file>: <line>` in a first-parent
     commit message since `ours` are excused. Lost lines → the resolver's resolution: `todo` with the lost lines as feedback
     (`resolve-failed`, no attempt spent, `conflict` kept so the builder's fix is checked); the builder's: a failed attempt
     with that feedback (`keep-check` event). A tip that no longer contains the merge clears `conflict`; with both keys
     off a pending `conflict` is ignored. A good resolution
     clears `conflict` (`resolved` / `keep-check ok`), and the pass goes on: refresh-before-test check again, **test**, a
     fresh **evaluator** told that this pass resolved a conflict and which features on base (with their acceptance checks)
     and which changed lines to verify too, then the merge. A resolution therefore never reaches base without the test and
     the evaluator; repeated bounces are bounded by `maxRefreshes`. Resolver run files are `<tag>-resolve.json` with a new
     pass tag.
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
4. Stop conditions: nothing in flight and nothing ready (or ready features held by a launch limit of 0: paused or lanes 0) →
   if `--watch` and some feature is waiting-on-human or `paused`, or ready features are held by that limit, sleep and re-check
   whenever `human.json`/`features.json`/`control.json` mtime changes (poll 5s), and
   while some feature is `parked`, re-check every poll;
   otherwise exit printing a summary. Also stop launching when `budgetUsdTotal` is reached, or on
   SIGINT/SIGTERM (SIGTERM to each child's process group; in-flight features back to `todo` without
   spending an attempt; a second signal SIGKILLs the groups and exits at once).
   Exit code 0 when all features are `merged`/`ready`, 2 when stopped with stuck, waiting or paused features.

The `claude` binary is `process.env.FACTOS_CLAUDE || "claude"` so tests can substitute a fake.

## Other commands

- `fact-os init [--test "<cmd>"]` — creates `.fact-os/` with default config and empty
  features/human files, copies skills into `.claude/skills/`, adds `.fact-os/runs/`,
  `.fact-os/*.jsonl`, `.fact-os/.lock`, `.fact-os/.lock.*`, `.fact-os/control.json` and the other runtime files to `.git/info/exclude`.
  Idempotent; never overwrites.
- `fact-os status` — table of features and open human tasks.
- `fact-os done <human-task-id>` — marks a human task done.
- `fact-os pause|resume|retry <feature-id>...` — `pause`: `todo`/`stuck` → `paused` (in-flight features
  belong to the foreman and are refused). `resume`: `paused` → `todo`, with `attempts` reset to 0 when
  they had reached `maxAttempts`. `retry`: `stuck` → `todo` with `attempts` and `refreshes` reset;
  `lastFeedback` is kept so the next build sees it. Each applied action is logged (`paused`,
  `resumed`, `retrying`). A paused feature is never ready, so its dependents wait too; `run --watch`
  keeps waiting while any feature is paused. Exit 1 if any id was refused.
- `fact-os pause-all|resume-all` and `fact-os lanes <n|default>` — write `control.json` (`by: "cli"`): stop or restart
  launching new features, or set how many may be in flight (0–32; `default` = `config.maxParallel`). Nothing running is
  interrupted. Each prints the resulting state (paused or the launch limit, lanes and default, how many run, and "no foreman
  running; applies when one starts" when no foreman runs); bad input exits 1 with a message; an invalid file is rewritten
  with a note. Without `--watch`, a paused foreman exits (2) once its work in flight drains. Per-feature `pause`/`resume`
  are unchanged.
- `fact-os profile [<name|default>]` — writes `profile` to `control.json` (`by: "cli"`; `default`/`opus` = null) and prints
  the lanes line plus the profile's role → model/effort table ("builder sonnet medium (high when risky)"); an unknown name
  exits 1 listing the valid ones. Without a name it prints the active profile and its table, or "profile unknown: <why>"
  when `control.json` is invalid. The observer and curator rows say "(observe --agent)" when `observer.agent` is not set
  (they show what `--agent` would use). Both forms end with "risky: N of M open features would get the builder's
  effortHigh". New launches only. Any control command that rewrites an invalid file (an unknown profile included) says so.
- `fact-os status` ends with the model profile ("unknown" while the file is invalid); `fact-os doctor` prints it when the
  control file is valid, and the risky count when there are no problems.
- `fact-os doctor` — validates the files (schema, unknown deps, cycles, duplicate ids, a feature `risk` other than
  high/normal, `config.profiles`: an object of objects with known roles, non-empty string `model`/`effort`/`effortHigh`
  (`effortHigh` on the builder only), no `opus`/`default`; an invalid `control.json`, including an unknown profile) and that
  `claude`, `git` and the test command's first word resolve.
- `fact-os hook` — reads a Claude Code hook JSON payload on stdin; finds the project via
  `git rev-parse --git-common-dir` (works from worktrees) and appends to `activity.jsonl`. The feature
  id comes from `FACTOS_FEATURE` env. Must never exit non-zero or print to stdout (hooks must not
  break the session).
- `fact-os dash [--root DIR] [--port 7420]` — HTTP server on 127.0.0.1 only. Discovers every
  `*/.fact-os/features.json` up to depth 3 under `--root` (default: cwd). The page is `lib/dash.html`
  (inline CSS/JS, no dependencies, light and dark, phone width), polling `GET /api/state` every 2s,
  one project at a time (picker in the header; next to the foreman status, the **controls**: the mode switch "Mode: Opus" /
  "Mode: Fable + Sonnet" (other config profiles by name; highlighted when not opus; a click switches to the next profile;
  its tooltip lists role → model, effort, the builder's "high when risky", the observer rows' "(observe --agent)" when no
  observer agent is configured, and says it applies to new launches; while `control.json` is invalid it reads "Mode: ?", is
  disabled, and its tooltip says why and to fix the file or rewrite it with pause, the lanes or the CLI), "− 6 of 8 lanes +" (running of
  allowed, "(default n)" when the lanes differ from config; − disabled at 0, + at 32) and "Pause new work" / "Resume", real
  buttons with labels and visible focus, each confirmed by a toast; lowering below the number running says "N running will
  finish; no new ones start until fewer than M are running"; the header stays on one line from 901px, two rows below) with
  these views:
  - **Factory**: while paused (or at lanes 0) a banner "Paused: no new features start. N still running will finish." with
    Resume; intake (ready queue, blocked/waiting/paused counts) → build bays (one per allowed lane; pixel-art worker building a house as the build progresses; idle bays as empty lots)
    → test bench → inspection (evaluator) → dock (merged/ready), a stuck list with Retry, and a live
    feed of `log.jsonl` events and hook activity.
  - **Board**: every feature grouped by epic (`group`, `groupBy`, or the id up to its first `-`), fixed
    height rows, status filters and search; a row opens a side panel with progress, actions
    (pause/resume/retry), feedback, description, acceptance, deps, dependents, human tasks, details
    and the feature's timeline (`GET /api/feature?project=&id=`).
  - **Observer**: what the observer saw and did, one section at a time behind a sticky sub-navigation (Needs you ·
    Health · Failures · Merge conflicts · Stuck · Observer actions · Agents; the last one is remembered in
    localStorage, each tab carries a count). Every section opens with one plain-language answer computed from the
    data. A search box filters every section except Health and Agents by feature id, title or file name (tab counts
    show the matches; the box keeps its focus through the 2s refresh, and so does keyboard focus on a re-rendered
    link or summary). Causes, decisions and actions are shown in plain words, times are relative with the local time
    on hover, long evidence sits in `<details>`, status is a pill with a word (never colour alone). Repeated alerts
    are grouped (newest, with how often). **Merge conflicts** (`conflicts24h` in the observer summary, from
    `log.jsonl`, plus `titles`: feature id → title for filtering) lists the files that conflict most, then the
    features with conflicts, most first, each expandable to one entry per conflict that started in the last 24h:
    when, files (short names, full list in details), who handled it and the outcome with its duration. Per feature in
    log order: a `refreshed` "conflicts in: …" opens an entry; `resolved` = the resolver handled it (`resolving` alone
    = the resolver is still working), `resolve-failed` = the builder (note kept), a `launch` with no resolver result =
    the builder; a `keep-check` not "ok…" adds a note. Outcome: the next `merged` = *merged*; another conflict =
    *conflicted again* (that one opens its own entry; at merge time this is a bounce, not a failure); `stuck` "too many
    base refreshes" = *gave up* (`failed`); any other `stuck` is not final (a retry picks it up again): until a `launch`
    or `retrying` clears it, a resolved entry reads *resolved, then stuck* (duration up to the stuck). Otherwise
    *resolved* once resolved (the view adds the feature's current status), else *still open*; the duration of these
    runs to now. **Agents** shows each rate with its counts, a short label of what changed per prompt version (a
    version with fewer than 5 builds is not judged), and marks a rate that moved 5+ points against the previous
    version, when each side has at least 5 runs behind that rate, with an arrow and the word better or worse
    (bounced: lower is better). Under it, **Prompts by model** (`prompts` in the observer summary: `{reviewed, invalid, cost, runs24h,
    rows: [{model, role, reviewed, causes, suggestions, notes, versions}]}` from `promptReviews`, `promptRates` and the notes
    files; Observer 8) has one card per model and role in plain words: why its failed runs failed (the prompt left
    something out, could be read two ways, contradicted itself; the model got it wrong; infrastructure; the spec was wrong),
    what would have helped most and where it belongs, the notes sent with its prompts (in a `<details>`) and how many
    passes failed per notes version, against the version before, and what the reviews have cost so far.
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
  `/api/state` projects carry `control {paused, maxParallel, effective /* the launch limit now; null when invalid */, configMax,
  updatedAt?, by?, invalid? /* why control.json is invalid: the header and Factory view warn instead of showing defaults */}`
  and `inFlight` (features building, testing or evaluating). `control` also carries `profile` (the active profile; null =
  opus, and null while the file is invalid), `roles` (its table: `[{role, model, effort, effortHigh?, fromProfile}]` for
  builder, resolver, evaluator, observer, curator; the observer rows use `observer.agent`, else what `--agent` would use) and
  `profiles` (`[{name, label, roles}]`, opus first; labels "Opus", "Fable + Sonnet", else the name) and `observerAgent`
  (whether `observer.agent` is set).
  `POST /api/control/pause {project}`, `/api/control/resume {project}`, `/api/control/lanes {project, maxParallel: 0–32 | null}`
  and `/api/control/profile {project, profile: <known name> | "opus" | null}` write `control.json` (`by: "dashboard"`; 400 on an
  invalid `maxParallel` or an unknown profile) and answer the new `control`.
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
   The agent's model and effort come from the active model profile (`control.json`, re-read every pass; an invalid file
   keeps the last good profile): its `observer` entry for the improver and its `curator` entry for the curation, else
   `observer.agent`; a profile never turns the agent on, and the improver always runs in plan mode.
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
   builder's model, effort, briefs or profile change: each `launch` is keyed by its own pass's builder `prompt`, the first one
   of that feature after the launch, so a pass still in prepare at a switch stays in its own version; versions change in
   launch order; a risky prompt is keyed with its `effortBase`, so it neither splits nor skips a version; a launch with no
   builder prompt stays in the version in force): per `launch`, whether the build reached the test
   (setup failures from `prepare`/worktree are counted apart, not against the builder; a conflicting refresh before the
   test is a builder outcome), passed the gate, passed the evaluator, merged or bounced; median build, gate and
   evaluation minutes; build and evaluation cost from the run files by completion time (resolver runs count as build); the
   evaluator's top rejection reasons. A resolver run (`resolving`) continues the pass that hit the conflict, in that launch's
   version (`resolves`; a merge after it counts in `merged` and `resolvedMerged`; its gate and evaluation are not counted
   again). A clean `revalidate` also continues the launch: initial stage counts/timings stay counted once,
   repeated validation costs still count, and the eventual merge is recorded without a conflict bounce or
   resolver count. The foreman logs a `prompt` event per run (`<role> model= effort= lessons=<sha8> briefs=<sha8>`, with the model and
   effort actually passed, then ` notes=<sha8>` when the prompt carries per-model notes (item 8: a notes change starts a new prompt
   version), ` profile=<name>` under a non-opus profile and ` risk=high effortBase=<effort>` when the builder got effortHigh), saves the
   prompt as `runs/<id>/<tag>-(build|eval|resolve).prompt.md`, and tags run files `<attempt>` or `<attempt>.<k>` so a later pass
   of the same attempt never overwrites them.
8. **Reviews failed passes and keeps per-model prompt notes** (with an agent and `observer.promptReview.enabled`, default true;
   `lib/promptreview.ts`, `lib/notes.ts`). Was it the prompt or the model? A *pass* is one `launch` up to its end event
   (`merged`, `ready`, `failed`, `stuck`, `resolve-failed`, `interrupted`, `merge-skipped`, `merge-hook-failed`, a `refreshed` that is not a
   clean refresh before the test or a conflict a resolver run takes over, …); its `prompt` events say which role ran with which
   model, effort and notes. A pass is *reviewable* when it ended in: an evaluator rejection (`FAILED`/`CHEATING`/`BLOCKING`
   feedback), a test-gate failure on the feature's **own** tests (classification `own`; a test it does not change, infrastructure,
   setup and conflict loops are never reviewed; infrastructure patterns are only looked for in a gate failure's output, so an
   evaluator rejection that quotes `ECONNREFUSED` is still reviewed), a failed keep-lines check (a builder's; a resolver's own
   `resolve-failed keep-check:` is a keep-check failure of the *resolver*), `resolve-failed`, a builder failure or "commit your
   work", or an evaluator run that gave no valid verdict. Each observer pass takes the newest reviewable passes (ended in
   the last 48h, not reviewed yet, three at a time) and runs `claude -p` in **plan mode** (read-only) with the **`curator`**
   role of the active profile (else `observer.agent`; the cheaper of the two observer roles), cut off after at most 20 minutes
   (`min(timeoutMin ?? 20, 20)`, whatever the builder's timeout). It gets the saved prompt
   (`runs/<id>/<tag>-<role>.prompt.md`, found by role and write time; the middle is cut over 22 KB), the model and effort,
   the outcome (the failure text, last 4000 characters), `git diff --stat base...branch` as of now (the prompt says so) and how
   the feature's next pass went. Throttled: a batch starts at most every `everyMinutes` (30), takes at most `maxPerPass` (6)
   reviews, and at most `maxPerDay` (24) review runs start in any 24 hours (`promptReviewAt`, `promptReviewRuns` in
   `observer.json`); the cost of every review run is summed in `promptReviewCost` and shown in the report and the dashboard.
   The reviews are saved to `observer.json` as soon as the batch ends, and a failing review, notes or template-task step is logged
   (`observer-error`) without ending the pass; the `--watch` loop likewise reports a pass that throws and goes on. On a stop
   signal no further batch starts and notes are not updated.
   It answers with a JSON object `{cause, evidence, confidence, suggestion, target}`: exactly one cause of
   `prompt-missing-info` (context the model needed was not in the prompt), `prompt-ambiguous` (two readings, the model took
   the other), `prompt-conflict` (instructions or an acceptance check contradicted each other or were impossible),
   `model-limitation` (the prompt was clear and complete), `environment` (infrastructure, a flaky test, a merge conflict) or
   `spec-error`; one to four evidence quotes; `confidence` low/medium/high; and, for the three `prompt-*` causes, a concrete
   `suggestion` for that model and a `target`: `template` (the role's fixed prompt text), `briefs` or `lessons`. An answer that
   is not that is kept as an invalid review (`error`), never retried: **a pass is reviewed once** (key `<feature>/<tag>` of its
   first saved prompt, in `observer.json` under `promptReviews`, kept 14 days). If the agent run itself fails (crash, timeout,
   budget), nothing is recorded and the pass is asked about again, at most twice in all (`promptReviewTries`; a run killed by the
   observer's own stop does not count). Logged `observer-review`.
   - **Notes.** A `prompt-*` review whose target is `briefs` or `lessons` is *eligible* when its confidence is high or
     another review has the same cause, model and role (a recurrence). Each model and role's eligible, not yet used
     suggestions are merged (duplicates dropped, ignoring case and punctuation) into `<state dir>/prompt-notes/<model>-<role>.md`:
     bullets, at most `notesMaxBytes` (3000). When the merge outgrows the cap the **curator** role's agent rewrites the notes
     shorter (answer between `<notes>` tags, bullets only, within the cap, as lessons are curated); if it cannot, the oldest
     bullets go. What is replaced or dropped is appended to `<model>-<role>.archive.md`. Logged `observer-notes`. The foreman reads
     the file at every launch and appends `## Notes for <model> as <role>` (and the bullets) to the end of that role's prompt
     (builder, evaluator or resolver); other models and roles get nothing. The notes' sha8 is in the prompt fingerprint
     (`notes=`), so item 7's agent stats split by notes version.
   - **Template changes stay manual.** An eligible review with target `template` (any model in that role counts for the
     recurrence) is never applied: it becomes one open human task "Prompt template change suggested for <role>"
     (`observer-prompt-<role>-<time>`) with each suggestion, its model, confidence and evidence; later ones join the open
     task, and its first step's count ("found N failed … passes") follows. Logged `observer-proposal`.
   - **Rates by notes version.** `observer.json` keeps `promptRates` (last 7 days): per model, role and notes version, the
     passes that ended well (`merged`, `ready`, or passed evaluation and bounced) and the reviewable ones that ended badly.
     A version counts as better or worse than the one before only with at least 5 passes on each side and a failure rate 15
     points apart.
9. **Reports** to `<state dir>/observer-report.md`: features merged/in progress/to do/stuck/paused, what needs a
   person (alerts, stuck features with their cause, open proposals), the last 24h (failures by cause, tests failing
   in several features, retries, fixes), **Why runs failed, by model** (per model and role: the reviews' causes of the
   last 7 days, the suggestions made most often, the notes in force and the results by notes version, with the verdict
   against the version before; the review cost so far), the agents per prompt version and the last 15 decisions. Times are local.

`--watch` repeats every `observer.pollSec` (60). `--agent` turns on the agent (opus, high effort) when the config has none.
Config (`observer` in `config.json`, all optional): `pollSec`, `retry` (true), `maxRetries` (1),
`infraPatterns` ([]), `recurring` (2), `agent` (null or `{model, effort, permissionMode}`), `improve` (true), `improveEveryHours` (6),
`maxOpenImprovements` (2), `lessonsMaxBytes` (12000), `curateEveryHours` (4),
`promptReview` (`{enabled: true, maxPerPass: 6, notesMaxBytes: 3000, everyMinutes: 30, maxPerDay: 24}`; the keys not given keep
their defaults; `enabled` only matters with an agent). Both the reviews and the notes tidying use each profile's `curator` role
(fable medium in `fable-sonnet`): no profile entry of its own. The foreman ignores the key, but editing `config.json` during a run still halts it.

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
6. The merge process (`docs/merge-process.md`): unit tests for hot-file scoring, claims, the keep-lines check (both entries
   kept, a union merge's shared closer caught, renumbered keys and moved `;` as changes, declared drops) and the brief on a
   real git conflict; end-to-end with the fake (`resolve:<flag>` scripts the resolver): a bounce resolved in the same pass
   with both sides' context then tested and evaluated again; a pre-test conflict resolved inline; a dropped line sent back
   and never merged; a declared drop merged; a resolver failure handed to the builder; `conflictBrief` alone; claims keeping
   two features on one hot file apart (declared and from history + branch diff). Everything is off by default.
7. Prompt review (Observer 8): unit tests for which passes are reviewed (kinds, own tests only, newest first, the cap, once per
   pass), the answer parser (each cause, an invalid answer), eligibility, note merging and the cap, notes in the prompt and the
   fingerprint (and agent stats splitting by notes); observer tests with a scripted agent (read-only reviews, once per pass, notes,
   one template task, the profile's observer role, tidying or archiving oversized notes); and end to end with the fake claude: a
   failed pass is reviewed once, the notes file appears, the next build prompt of that model carries it and another model's does not.
