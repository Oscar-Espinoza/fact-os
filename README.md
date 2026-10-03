# fact-os

Runs a plan → build → evaluate → merge → compound loop over a project's feature list with headless
Claude Code (`claude -p`): one foreman, up to N builders in separate git worktrees, a fresh evaluator per
feature, a human inbox for what only you can do, and one dashboard across projects.
TypeScript on Bun >= 1.4 (node:* built-ins only), zero runtime dependencies. The contract is [SPEC.md](SPEC.md).

Formerly Shipyard. Projects set up before the rename keep working: their `.shipyard/` dir is used until a
`.fact-os/` dir exists, `SHIPYARD_*` env vars are read when the `FACTOS_*` one is unset, and children get both.
The name itself lives in one constant, `NAME` in `lib/state.ts`.

## Install

```sh
git clone https://github.com/Oscar-Espinoza/fact-os ~/Projects/fact-os
cd ~/Projects/fact-os && bun install   # dev deps only: typescript, @types/bun
ln -s ~/Projects/fact-os/bin/fact-os ~/.local/bin/fact-os
cd ~/Projects/myapp && fact-os init --test "pnpm test"   # then run the intake skill in Claude Code
```

Tests: `bun test` (`node:test` style; the end-to-end tests use `fixtures/fake-claude.ts` via `FACTOS_CLAUDE`, never the real
`claude`). Types: `bun run typecheck` (`tsc --noEmit`, strict; the shapes are in `lib/types.ts`). `bin/fact-os` only
imports `lib/cli.ts`, since tsc skips extensionless files.

## Commands

| Command | What it does |
|---|---|
| `fact-os init [--test "<cmd>"]` | Creates `.fact-os/` (config, empty features/human), copies `intake` and `ship` skills into `.claude/skills/`, adds runtime files to `.git/info/exclude`. Idempotent, never overwrites. |
| `fact-os run [--watch] [--once] [--max-features N]` | The foreman loop. `--watch` keeps waiting (polls `features.json`/`human.json` mtimes every 5s) while features are blocked on you. `--once` launches one batch and exits when it finishes. Exit 0 when every feature is `merged`/`ready`, 2 otherwise. |
| `fact-os status` | Feature table (status, attempts, cost, deps, next/onMock/waiting) and open human tasks. |
| `fact-os done <task-id>` | Marks a human task done; a watching foreman picks it up. |
| `fact-os pause\|resume\|retry <id>...` | Pause `todo`/`stuck` features (they and their dependents never launch; `run --watch` keeps waiting), resume paused ones (fresh attempts if they had run out), retry stuck ones (attempts reset, last feedback kept). |
| `fact-os pause-all` / `resume-all` | Stop / restart launching new features for the whole project (`control.json`). Nothing running is interrupted; parked merges still merge; `run --watch` keeps waiting while paused, while a foreman without `--watch` exits once its work in flight drains. Says when no foreman is running (it applies when one starts). |
| `fact-os lanes <n\|default>` | How many features may be in flight (0–32; `default` = `config.maxParallel`), changed during a run without a restart: more lanes launch at once, fewer let the running ones finish. Prints the resulting state. The dashboard header has the same controls. |
| `fact-os profile [<name\|default>]` | Model profile for new launches: `opus` (default: each role's own config) or `fable-sonnet` (Sonnet builds and resolves, Fable evaluates and runs the observer's improver and curation; the builder goes from medium to high effort on risky features), plus any in `config.profiles`. A running feature keeps the profile it started with. Without a name, prints the active profile and its role → model/effort table, and how many open features count as risky (a `risk: "high"` tag, a keyword such as payment, refund, auth, tenant, migration or lock in the title, or two such keyword families in the description). The dashboard header has a "Mode" switch for it. |
| `fact-os doctor` | Validates the files (schema, duplicate ids, unknown deps, cycles) and that `claude`, `git` and the test command resolve. Exit 1 on problems. |
| `fact-os dash [--root DIR] [--port 7420]` | Dashboard on `127.0.0.1` for every `.fact-os/features.json` up to depth 3 under `--root` (worktrees skipped). Views: Factory (intake → build bays with pixel-art workers and estimated progress → test → inspection → dock, stuck list, live feed), Board (features by epic, filters, detail panel with pause/resume/retry), Project (your own `project-view.html`, sandboxed) and Only you. Refreshes every 2s. |
| `fact-os observe [--watch] [--agent]` | Watches the factory beside the foreman: sorts every stuck feature by cause (a test it does not change, infrastructure, its own code, setup, conflicts), sends back the ones stuck for a reason outside them with a note for the next build, re-parks merges that never started, tracks finished features sent back by merge conflicts, raises alerts, and writes `observer-report.md` (also the dashboard's Observer view). `--agent` also acts on it: a read-only improver turns recurring causes of lost work into improvement features the factory builds and checks like any other, plus human tasks for what lies outside the repo, and the lessons builders read are curated under 12 KB (full history archived). It also reviews each failed pass once (read-only) to say whether the prompt or the model was at fault, and keeps short per-model notes (`prompt-notes/<model>-<role>.md`) that the foreman appends to that model's prompts; changes to a role's own prompt text become a task for you. See SPEC.md. |
| `fact-os hook` | Internal: Claude Code hook that appends a line to `activity.jsonl`. Never prints, never exits non-zero. |

Per feature the foreman: creates/reuses worktree `<worktreesDir>/<id>` on `<branchPrefix><id>` (or `branch`)
from `base` → runs the builder → fails the attempt with "commit your work" if the worktree is dirty or the
branch has no commits beyond `base` → records the branch sha → runs `config.test` in the worktree → runs a
fresh evaluator with the diff `base...<sha>` (`--text --no-ext-diff --no-textconv`), the acceptance checks
read at launch and the test output → merges that sha with `git merge --no-ff` (auto; refused if the branch
moved meanwhile) or stops at `ready` (manual) → appends the evaluator's lesson to `lessonsFile`. Failures increment `attempts` and
feed back into the next build prompt; at `maxAttempts` the feature is `stuck`.
Acceptance checks are copied under the state lock when a feature enters `building`, so pending
edits apply at launch. Builders, resolvers and inline reevaluations keep that launch's checks.
Each new launch, including retries, reads current checks; editable feature JSON is trusted across
launches regardless of who edited it. Saved prompts retain the checks used for earlier passes.

## Files (`.fact-os/` in the main checkout)

- `config.json` — `base`, `worktreesDir` (`../<repo>-worktrees`), `branchPrefix` (`ship/`), `maxParallel` (3),
  `maxAttempts` (2), `budgetUsdPerRun` (null = no cap; a positive number is passed as `--max-budget-usd`; hitting it gives the feedback
  "budget exhausted"), `budgetUsdTotal` (null = unlimited; stop launching once the cost reported **during the current
  `fact-os run`** reaches it — earlier runs' `costUsd` do not count; `null` = unlimited), `timeoutMin` (null = no timeout;
  per `claude`/test/`prepare` (null; a shell command run in the feature worktree before every build, e.g. install and provision databases; must be idempotent; a failure fails the attempt) and `postMerge` (it gets `FACTOS_FEATURE` and `FACTOS_BRANCH`) child), `builder`/`evaluator` `{model, effort, permissionMode}`,
  `test`, `merge` (`auto`|`manual`), `briefFiles` (appended to builder and evaluator prompts), `lessonsFile`
  (`CLAUDE.md`), `postMerge` (shell command run in the main checkout after a merge, or null), `refreshBeforeTest`
  (false; true merges the current `base` into the feature branch after the build and before the test, so two features
  that pass alone can't break `base` together — see below), `maxRefreshes` (5), `groupBy` (null; `"idPrefix:<n>"` puts
  each feature in the conflict group named by its id's first n chars, e.g. `"idPrefix:3"`: `F05-02-x` → `F05`; a
  feature's own `group` wins; two features of one group are never in flight together: the foreman launches the
  next-best ready feature of another group instead, so `maxParallel` is a ceiling, not a target), `restoreFrom` (null;
  a ref with `{id}`, e.g. `"archive/task/{id}"`: a feature branch with no commits of its own, new or recreated from
  `base`, is moved to that ref when it holds work `base` lacks, so work saved by a cleanup is not lost; logged as
  `restored`), `profiles` (extra model profiles, `{name: {builder|resolver|evaluator|observer|curator: {model?, effort?,
  effortHigh?}}}`; see SPEC.md "Model profiles"), `mergeHook` (null;
  a shell command run in the main checkout on the staged `git merge --no-ff --no-commit`, with
  `FACTOS_FEATURE`/`FACTOS_BRANCH`, e.g. to renumber migrations: what it `git add`s joins the merge commit; a
  non-zero exit aborts the merge and sends the feature back to `todo` with the hook's output as feedback, costing no attempt),
  and the merge process (all off by default; see [docs/merge-process.md](docs/merge-process.md)): `claims` (null; `{hot, minScore,
  days}`: never run two features that change one hot file — listed, or scored from the log's merge conflicts — judged from
  each feature's `touches`, branch diff and uncommitted edits; `dir/` claims include hot descendants, and only a hot
  overlap blocks, so cold siblings can run concurrently), `conflictBrief` (false; a conflicting refresh's feedback
  names both sides: this feature, the features merged into `base` that touched each conflicting file with their
  acceptance checks, and the diff3 hunks; resolutions must keep every line either side added or declare it as
  `dropped: <file>: <line>` in a commit message) and `resolver` (null; `{model, effort, permissionMode}`: a separate
  resolver run resolves the conflict at once, in the same pass, then the test and a fresh evaluator run again).
- `features.json` — `{features: [{id, title, description, acceptance[], surface, deps[], priority, branch?, group?, touches?, risk?,
  status, onMock?, attempts, refreshes?, parked?, lastFeedback?, costUsd?, pid?, pidStart?, foremanPid?, updatedAt}]}` (its current
  child: pid, start time from `/proc/<pid>/stat`, and the foreman that spawned it); status is
  `todo|building|testing|evaluating|ready|merged|stuck|paused`. `risk: "high"` gives the builder its profile's
  `effortHigh`; `"normal"` never; without it, a word like payment, refund, auth, tenant, migration or lock in the title, or
  two such keyword families in the description, decide.
- `human.json` — `{tasks: [{id, title, steps[], unblocks[], mockable, status: open|done, doneAt?}]}`.
- `log.jsonl` (`{ts, feature, event, detail}`), `activity.jsonl` (hook events, last 2000 lines),
  `runs/<feature>/<tag>-{build,eval,resolve}.json` (raw `claude -p` output), `.lock`,
  `.foreman` / `.observer` (PID on the first line, invocation token on the second).
- `prompt-notes/<model>-<role>.md` — short per-model advice the observer learns from reviewed failures (config `observer.promptReview`:
  `enabled`, `maxPerPass` (6), `notesMaxBytes` (3000)); the foreman appends it under `## Notes for <model> as <role>`. Deleting a file drops its notes for good: the reviews behind it are marked as used and are not applied again. Reviews are throttled (`everyMinutes` 30, `maxPerDay` 24) and run on each profile's `curator` role; the report shows what they cost.
- `control.json` — `{paused, maxParallel: 0–32|null, profile: name|null, updatedAt, by}`, written by `pause-all`/`resume-all`/`lanes`/`profile` and the
  dashboard and re-read by the foreman every tick: the launch limit is 0 while paused, else `maxParallel`, else the config's,
  counted against features in flight including a previous foreman's live children. Not `config.json`, so it never trips the
  tamper halt. An invalid file never lifts a pause: the foreman keeps its last good control (paused if it started with it),
  `doctor` and the dashboard flag it, and any control command rewrites it. An unknown `profile` makes the file invalid too.
  `bun scripts/replay-conflicts.ts <repo>` replays a project's real merge conflicts against the merge process, read-only.

Config loads validate known field shapes and operational ranges; `doctor` reports the same
errors. Numeric strings and malformed nested objects cannot bypass limits. Missing fields
and supported partial configs keep their existing defaults. Use null for no timeout;
non-null timeouts must be positive and fit the native timer range. Budget/count/throttle
zeros retain their documented meanings; config `maxParallel: 0` still gives one lane.

**Readiness:** a `todo` feature is ready when every dep is `merged` in either merge mode and
every open human task that unblocks it is `mockable` (it is then built `onMock`). An open non-mockable task
makes it *waiting-on-human*. Ready features run by priority, then number of transitive dependents, then id.
Features in cycles, with unknown deps or duplicate ids are reported and never run.
In manual mode, merge the recorded evaluated commit into `base`, then use the dashboard's
"Mark merged"; acknowledgment verifies ancestry. Unmerged `ready` features hold their dependents,
and `run --watch` waits for acknowledgment. Independent manual features can still build and finish
at `ready`. Reused dependent branches import missing dependency commits before setup/build; conflicts
go to their builder. Squash/cherry-pick merges need separate reconciliation and cannot be acknowledged.

The observer checkpoints curation/improver throttles before attempting a provider call.
Apply errors are reported and do not bypass the interval on the next poll; a failed
checkpoint prevents launch. A stop before launch consumes no interval.

The dashboard shows the current attempt as failures + 1 while running or ready/merged.
Recorded runs retain full tags, resolver output and finding evidence; expanded logs keep
original agent text and validation errors. Saved verdict validity uses the foreman parser
and is separate from the feature’s recorded pipeline status.

**Evaluator verdict:** `{pass, findings: [{check, ok, evidence}], cheating: [], blocking: [], notes: [], lesson}`.
Parsing requires a JSON object, boolean `pass` and nonempty `findings`. Every finding must
have nonempty string `check`/`evidence` and boolean `ok`; malformed entries reject the whole
verdict. Present `cheating`/`blocking`/`notes` must be arrays of nonempty strings, and
`lesson` must be a string or null. Legacy omissions of those four optional fields remain
supported; lists default to empty and lesson to null. Bare, fenced and prose-wrapped JSON
remain supported; a parsed array/string root cannot be unwrapped into a passing verdict.
Malformed output fails with field/index feedback and cannot write a lesson.
A valid `pass: true` with a failed finding or nonempty `cheating`/`blocking` also counts as a fail.

The evaluator must run the feature's changed test files, mutate one guard per money/auth/tenant/state check, and check
production wiring; its diff lists any file it could not include instead of cutting silently (`evaluatorDiffExclude` lists
generated paths by name only).

## Safety limits

- Never pushes, never force-deletes branches, never runs `git reset --hard` or `git clean`, never deletes
  worktrees. Only touches the repo, its worktrees dir and `~/.local/state/fact-os/`.
- Only kills processes it started. Each child runs in its own process group; on timeout or SIGINT/SIGTERM
  the whole group gets SIGTERM and in-flight features go back to `todo` without spending an attempt; a
  second Ctrl-C SIGKILLs the groups and exits at once. The observer uses the same signal
  sequence: no later review, notes, curation or improver starts, and canceled agent output
  is not applied. Completed paid reviews are retained for the next pass. One foreman per repo (`.fact-os/.foreman`).
  Features left in flight by a dead foreman are marked `merged` if their branch is already merged into
  `base`, left alone while their recorded child is alive (same pid and start time; `EPERM` counts as dead;
  without `/proc`, dead once its foreman is dead) for at most `timeoutMin`; a child still running after that
  is not killed and its feature becomes `stuck` ("previous child still running (pid N)"), so two processes
  never write one worktree. The rest go back to `todo` (worktree reused).
- Merges only when the main checkout is on `base` with no tracked changes outside `.fact-os/`; otherwise
  the feature stays `ready` and `log.jsonl` says why, as it does when git refuses to start the merge. Under
  `merge: "auto"` a feature parked that way (`parked: true`) is merged on a later tick once the checkout is
  clean and on `base`, if its branch still points to the evaluated `sha` (else it goes back to `todo`);
  `run --watch` polls for that.
- Builders never merge, rebase, pull or switch branches. A conflicting merge is aborted (`git merge --abort`)
  and the foreman itself merges `base` into the feature's (clean) worktree: if that is clean the next build
  re-runs the tests on top; if it conflicts, the merge is left in progress and the next build resolves and
  commits it (that merge commit counts as the builder's commit), or, with `resolver` set, a resolver run does it in the
  same pass; either way the resolution is tested and evaluated before it can merge. Neither costs an attempt; they are counted
  in `refreshes`, and after `maxRefreshes` (5) the feature is `stuck` ("too many base refreshes"). With `refreshBeforeTest: true` the
  same refresh runs before the test whenever `base` has commits the branch lacks: a clean merge goes straight on to
  test, evaluate (diff still `base...sha`) and merge that merge commit, without counting as a refresh; a conflict
  goes back to `todo` exactly as above. Immediately before an automatic merge, the foreman checks again that the
  evaluated commit contains current `base`. If another feature merged during its test or evaluation, it refreshes,
  tests and evaluates again, reusing the build after a clean refresh and keeping the earlier run files. A stale
  parked feature goes back through that same validation queue before merging. Passing automatic lessons
  are saved with the evaluated commit and appended only after it merges. Parking cannot move base
  through its own lesson; restarts retain pending advice, and superseding validation discards it.
  Already-landed evaluated commits recover without another provider call. Manual-ready and failing
  verdict lessons keep their immediate behavior. Lesson write errors retain merged status and pending
  delivery for a later pass; they never send merged code back to the builder.
- Tamper checks: if `config.json` changes on disk during a run, or `base` moves other than by fact-os's
  own merges and lesson commits so that it now reaches a commit of a feature branch (`branchPrefix*` or a
  feature's `branch`), or carries a (non-empty) blob that is also in one, the foreman logs an `alert`,
  launches and merges nothing more, and exits 2. Commits reachable from the evaluated `sha` recorded for a
  `ready` or `merged` feature don't count, so you can merge a `ready` branch by hand mid-run. Any other
  move of `base` (your own commits) logs a `base-moved` notice, is re-recorded, and the run continues.
  `claude` gets `--settings` deny rules (see Threat model).
- Lessons are committed on `base` (only that file) when the main checkout is on `base` and the lessons
  file had no local edits; otherwise they are appended uncommitted.
  Observer curation shares a checkout lock with foreman operations, released while its agent runs.
  Before applying, it rechecks base, Git operation state, tracking and file cleanliness; intervening
  content changes are accepted only through foreman's whole-file append hashes. Other changes leave
  lessons, archive and index untouched. Recognized appends survive; unrelated staged files stay staged.
  A busy checkout defers curation after 30 seconds; failed commits are reported with the local rewrite
  and archive retained. Upgrade foreman and observer together; arbitrary editors do not honor this lock.
- State files are written atomically (temp + rename) under a populated `.lock/`
  directory, published atomically with a unique PID/owner marker. Recovery and
  release remove only that owner's marker; they cannot remove a successor's lock.
  Dead-owner and empty directories recover automatically; unknown contents time out.
  This requires local-filesystem atomic directory rename semantics.
  Before upgrading from the PID-file lock format, stop all old foreman, observer,
  dashboard and CLI writers. With the new code, rerun `fact-os init` in existing
  projects to add staging-directory ignores, then restart writers. A leftover legacy
  `.lock` file is refused with an error: remove it only after those writers have stopped.
  Mixed versions must not run together. A crash before publication can leave harmless
  `.lock.*` staging directories; these are ignored by new `init` runs and can be removed
  when all writers are stopped. PID reuse can conservatively delay stale-lock recovery.
- Supervisor claims and releases also use the state lock. Only one foreman and one
  observer may run per project, including calls from the same process; the two roles
  can run together. Markers are published atomically and cleanup compares the full
  invocation token, so a rejected startup cannot delete the winner's ownership.
  Failed startup removes its marker and signal listeners. Plain-PID legacy supervisor
  markers still block live owners and recover when their PID is dead.
- The dashboard binds to 127.0.0.1, accepts POSTs only for discovered project paths (exact match), and
  rejects any `Origin` other than its own and any unexpected `Host` (DNS rebinding).

## Permission mode

Default `permissionMode` is `auto` for both roles. `claude --help` (2.1.283) lists
`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. With `-p` nobody answers
prompts: `manual`/`acceptEdits` would block or deny the Bash calls a builder needs (tests, `git commit`),
`dontAsk` denies anything not pre-allowed, `plan` cannot edit. `auto` works headless with a classifier
guarding each step; it may deny steps mid-build and it can be disabled by settings. `bypassPermissions` runs a full build with no classifier, giving the agent
your user's full rights contained only by working in a worktree; set it in `config.json` only if you
accept that.

## Threat model

fact-os is not a sandbox. Builders and evaluators run as your user; under `auto` a classifier screens each
step, and with `bypassPermissions` they can do anything you can.
- `--settings` deny rules (they hold even under `bypassPermissions`) cover `Edit` (every file-writing tool)
  under `//<root>/.fact-os/**` and `//<root>/.git/**` (so `.git/hooks` and `.git/config` too), plus the
  Bash prefixes `git update-ref`, `git push`, `git branch -f` and `git config`. They are prefix rules:
  other Bash commands (`sh -c`, `echo > .git/hooks/…`, `git -C . branch -f`, …) can still write
  `.fact-os/features.json`, `.git/hooks`, `.git/config`, or move `base`.
- Moves of `base` are caught by the tamper check at launch and merge time when `base` then reaches a
  feature-branch commit or carries one of a feature branch's blobs (e.g. `git commit-tree` of the branch's
  tree, or `git -C <root> commit` of its files). A commit whose content differs from every feature branch
  (e.g. rewritten by hand) is not caught.
- For real repos, keep the default `permissionMode: "auto"` (the classifier) as a guard.

## Claude output

`claude -p --output-format json` prints one object; fact-os reads `result` (text), `is_error` and
`total_cost_usd` (falling back to `cost_usd`), and `structured_output` if present. Field names were checked
against the installed 2.1.283 binary, not by running a prompt. Hooks are passed with `--settings` as
`"<bun>" "<fact-os>/bin/fact-os" hook` so they work before `fact-os` is on PATH.

## License

MIT
