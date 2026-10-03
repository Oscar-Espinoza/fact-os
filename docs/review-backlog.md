# Review backlog — 2026-10-02

Process: [fixing-process.md](fixing-process.md). One active issue at a time.

## Handoff

- Active: **none**. R15 is verified locally; all 16 queued review repairs are now verified.
  Root remained the only application-code writer; Claude and Sol reviewed read-only.
  Prior repairs retain their recorded scope; all changes remain uncommitted.
- Next: **none queued**. Architecture ideas and unresolved concerns, including the existing
  valid-verdict observer classification disagreement, require separately scoped work.
- Second opinion: [Claude factory review](second-review-2026-10-02.md), requested by
  Oscar through Herdr. Findings were independently checked; no application edits were
  made during that exchange. Existing verified rows describe their original scope,
  not a claim that the new follow-ups are fixed.
- Working tree at intake: existing untracked `lib/dash.legacy.html`; preserve it.
- Baseline review: 199 distinct tests in 13 named files and strict typechecking passed.
  Focused reproductions nevertheless confirmed the issues below.
- No commits, deployments, extension installs, live provider calls or live-factory
  restarts are authorized by this repair process.
- Root/nested repository AGENTS.md and `execution/parallel-waves.md` were absent at
  review. User working agreements, `/home/oscar/AGENTS.md`, README.md, SPEC.md and
  applicable merge-process documents were used; no lean-phase override was found.

## Queue

| ID | Severity | Status | Issue |
|---|---|---|---|
| R01 | High | verified | Parallel and parked merges bypass aggregate validation |
| R02 | High | verified | Stale-lock takeover permits concurrent state writers |
| R03 | High | verified | Singleton foreman acquisition is not atomic |
| R04 | High | verified | Malformed evaluator verdicts discard blocking defects |
| R05 | High | verified | Lesson curation overwrites/commits after checkout changes |
| R06 | Medium | verified | Manual-mode dependents lack unmerged dependency code |
| R07 | Medium | verified | Pending acceptance edits use the startup snapshot |
| R08 | Medium | verified | Invalid config bypasses lane and attempt limits |
| R09 | Medium | verified | Observer launches agents after cancellation |
| R10 | Medium | verified | Dashboard attempt/pass/evidence contracts drift |
| R13 | Medium | verified | Paid observer-stage throttles are lost after apply errors |
| R14 | Low–Medium | verified | Parked passing lessons self-invalidate evaluation |
| R11 | Medium | verified | Directory claims miss concrete hot descendants |
| R12 | Low | verified | Prompt rates mix pass and invocation counts |
| R16 | Low | verified | Uncounted stuck events distort dashboard attempt identity |
| R15 | Low–Medium | verified | Malformed negative verdicts lose diagnostic context |

## R01 — aggregate merge validation

- Evidence: `lib/foreman.ts`, pipeline refresh-before-test and final `merge()`.
- Trigger: two features test/evaluate against the same base, then merge cleanly while
  their combined behavior fails the configured test; parked merges have the same gap.
- Consequence: `main` can fail its gate while both features are recorded as merged,
  even with `refreshBeforeTest: true`.
- Decision: keep the existing opt-in setting. Under serialized merge handling, require
  the evaluated SHA to contain current base. If stale, refresh and repeat the test and
  fresh evaluation before merging. Reuse the existing build on a clean refresh; retain
  original run artifacts and count real gate failures, not the refresh, as attempts.
- Scope: foreman, feature SHA contract, observer revalidation event consumption,
  guard/statistics regression tests, README/SPEC.
- Acceptance: incompatible concurrent features cannot both merge; compatible concurrent
  features get fresh validation without another builder; stale parked features follow
  the same rule; evaluator lessons cannot create a self-invalidating evaluation loop;
  existing resolver, parked-merge, interruption and opt-out behavior remains covered.
- Result: fixed locally. Active stale merges repeat validation with distinct run tags;
  stale parked merges re-enter the queue with their build SHA retained. Passing lessons
  are written after the automatic merge decision. Observer statistics preserve the
  revalidated launch and its eventual merge without a false conflict bounce, including
  a resolver continuation followed by another clean revalidation.
- Changed: `lib/foreman.ts`, `lib/types.ts`, `lib/observe.ts`, `test/guards.test.ts`,
  `test/observe.test.ts`, README.md and SPEC.md. No commit or deployment.
- Regression evidence: four new guard regressions failed on the original implementation
  and passed after the fix. Independent read-only Sol review identified the observer
  integration gap; its new statistics regression, including the mixed resolver case,
  also failed before each focused correction.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/foreman.test.ts test/guards.test.ts test/merge-process.test.ts test/e2e.test.ts test/control.test.ts test/observe.test.ts test/promptreview.test.ts`
    — 135 passed, 0 failed.
  - After the statistics fix,
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/observe.test.ts test/dash.test.ts`
    — 51 passed, 0 failed (157 distinct cases across both validation groups).
  - `bun run typecheck` and `git diff --check` passed.
- Limits: protection remains opt-in with `refreshBeforeTest: true`; no live-factory
  settings were changed. It assumes the intended single supervisor (R03 remains open)
  and does not validate arbitrary content edits by trusted merge/post-merge hooks.

- Second-review correction: the parked/ready lesson path still self-invalidates an
  otherwise accepted evaluation. The aggregate safety guard works, but this part of
  the no-self-invalidation acceptance statement was not covered. R14 now fixes and
  tests the parked/pending lesson lifecycle.

## R02 — state-lock mutual exclusion

- Evidence: `lib/state.ts`, `withLock()` stale rename/restore and unconditional release.
- Trigger: a live successor replaces the stale lock before takeover; recovery renames
  it away and a third writer enters before restoration.
- Consequence: simultaneous read-modify-write callbacks can lose state updates.
- Recommendation: adopt a takeover protocol that preserves exclusion and verifies
  ownership on release; do not rely on renaming a possibly live successor away.
- Decision: atomically publish a populated lock directory containing a unique owner
  token. Recovery and release remove only that token, then attempt to remove the
  empty directory; a live successor's populated directory cannot be removed.
  Legacy regular-file locks fail closed with upgrade guidance. Stop all old writers
  before upgrading; no mixed-version guarantee or automatic legacy-marker deletion.
- Scope: state locking, lock regressions, init's temporary-lock ignore pattern and
  README/SPEC lock contract. No running factory processes or project locks touched.
- Acceptance: a deterministic three-participant regression never overlaps callbacks;
  ordinary concurrency, dead/empty directory locks, replacement races, legacy refusal
  and timeout behavior pass. Release cannot remove a different owner's token.
- Result: fixed locally. Ownership is published as a populated directory; stale
  recovery and release unlink only the unique token and use nonrecursive directory
  removal. Contention paths yield and enforce the deadline; unknown contents are
  preserved. Init excludes unpublished staging directories.
- Changed: `lib/state.ts`, `lib/cli.ts`, `test/state.test.ts`,
  `test/fixtures/state-lock-race.ts`, README.md and SPEC.md. R01 edits and the
  existing untracked legacy dashboard were preserved. No commit or deployment.
- Regression evidence: the three-participant test failed before the fix with
  `thirdEntered: true` while the live successor still held the lock. It now passes.
  A second deterministic race publishes the successor between token unlink and
  directory removal; neither contender enters. Dead-process recovery, simultaneous
  writers, same-process async callers, exceptions, late release, malformed markers
  and legacy-file refusal are covered. Independent read-only Sol high review found
  no remaining concrete defect after the added unlink/rmdir race and contract docs.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/state.test.ts test/control.test.ts test/actions.test.ts test/dash.test.ts test/foreman.test.ts test/guards.test.ts test/observe.test.ts test/e2e.test.ts`
    — 154 passed, 0 failed; log: `/tmp/fact-os-r02-validation.log`.
  - After adding the unlink/rmdir case,
    `bun test test/state.test.ts --test-name-pattern 'three participants|successor publication'`
    — 2 passed, 0 failed (155 distinct cases across both validation groups).
  - `bun run typecheck` and `git diff --check` passed.
- Limits: requires cooperating writers on a local filesystem with atomic directory
  rename; no network-filesystem validation. Mixed old/new processes are unsupported.
  Stop all old writers before upgrading, remove a leftover legacy PID file only
  after they have stopped, rerun `fact-os init` in existing projects for staging
  ignores, then restart with new code. This upgrade was not performed on any live
  factory. Crashes before publication may leave harmless staging artifacts; PID
  reuse conservatively delays recovery. Supervisor acquisition is still R03.

## R03 — supervisor ownership

- Evidence: `lib/foreman.ts`, `run()` reads/checks PID then overwrites `.foreman`.
  `lib/observe.ts`, `observe()` has the analogous acquisition pattern.
- Trigger: simultaneous starts both read absent/dead ownership before either writes.
- Consequence: duplicate supervisors can schedule the same worktree and bypass each
  other's operation queues. Foreman race was reproduced; inspect observer equivalence.
- Recommendation: exclusive ownership acquisition with safe stale-owner handling and
  cleanup spanning startup failures; use the corrected R02 primitive where appropriate.
- Decision: serialize claim and release under the R02 state lock, reject every live
  PID (including the current process), and publish PID plus an invocation token
  atomically. Keep PID on the first line for existing parseInt-based readers; compare
  the entire marker at release. Foreman and observer own separate markers and can
  run together. Scope cleanup over startup, loop, summary and signal listeners.
- Scope: shared state ownership helper, foreman/observer entry points, supervisor
  regressions, init temporary-marker ignores and README/SPEC ownership contract.
- Acceptance: exactly one simultaneous start succeeds; losers cannot remove the
  winner's marker; stale ownership and startup errors recover safely. Same-process
  duplicates reject; different supervisor roles can coexist; replaced markers survive
  late cleanup; no signal listeners or markers remain after failed startup.
- Result: fixed locally with shared `withSupervisor()` ownership around both public
  entry points. Claims/releases are serialized by `withLock()`, markers publish
  atomically, all live PIDs reject, and cleanup compares the full invocation marker.
  Foreman cleanup now includes startup and summary; signal registration is inside
  listener cleanup for both roles. Invalid PID text is preserved and refused.
- Changed: `lib/state.ts`, `lib/foreman.ts`, `lib/observe.ts`, `lib/cli.ts`,
  `test/supervisor.test.ts`, `test/fixtures/supervisor-race.ts`, README.md and SPEC.md.
  Prior repairs and unrelated changes were preserved. No commit or deployment.
- Regression evidence: multiprocess tests pause both initial ownership reads before
  publication. Both foreman and observer tests failed before the fix with two owners.
  With the fix the second reader waits outside acquisition, rejects the live winner,
  and leaves its marker intact. The 13 focused cases also cover same-process rejection,
  dead/empty legacy recovery, replacement preservation, invalid PID text, startup
  failure/listener cleanup, restart after correction and independent supervisor roles.
- Review: independent read-only Sol high review found no remaining concrete R03 defect.
  Root checked actual CLI, dashboard, observer and test-reap PID consumers: all read
  the PID with `parseInt`, so the token's second line preserves their runtime contract.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/supervisor.test.ts test/state.test.ts test/foreman.test.ts test/guards.test.ts test/observe.test.ts test/control.test.ts test/dash.test.ts test/e2e.test.ts`
    — 163 passed, 0 failed; log: `/tmp/fact-os-r03-validation.log`.
  - After moving signal registration inside cleanup and adding empty legacy recovery,
    `bun test test/supervisor.test.ts` — 13 passed, 0 failed (same 163 distinct cases).
  - `bun run typecheck` and `git diff --check` passed.
- Limits: inherits R02's cooperating-writer/local-filesystem and stop-before-upgrade
  requirements; no live-factory restart or provider compatibility calls. External
  consumers must read the marker's first line as PID. PID reuse conservatively delays
  recovery; force-kill can leave dead markers and ignored temporary artifacts for
  recovery on a later start. Existing observer cancellation remains R09.

## R04 — fail closed on malformed verdicts

- Evidence: `lib/foreman.ts`, `parseVerdict()` and pipeline verdict caller.
- Trigger: `{pass:true, findings:[{ok:true}], blocking:"tenant isolation broken",
  cheating:"hardcoded checkout"}` is accepted with empty blocking/cheating arrays.
- Consequence: invalid evaluator output can authorize an unsafe merge.
- Recommendation: validate present list fields and finding check/ok/evidence; preserve
  intentionally supported omitted legacy fields without accepting wrong types.
- Decision: require a JSON object, boolean pass and a nonempty findings array, with
  every finding an object containing nonempty check/evidence strings and boolean ok.
  Optional cheating/blocking/notes default to empty arrays only when omitted; present
  values must be arrays of nonempty strings. Omitted/null lesson stays null; strings
  trim as before and empty lessons stay null; other types fail. Reject a successfully
  parsed non-object root instead of extracting a passing object from inside it.
  Keep bare JSON, prose and fenced JSON support. Give field/index-specific feedback;
  malformed verdicts cannot compound lessons. Unknown extra fields remain permitted.
- Scope: parser, focused unit/pipeline regressions, prompt-review attribution for the
  parser's new field errors, and README/SPEC verdict contract.
- Acceptance: malformed positive verdicts fail; valid bare/fenced outputs and intended
  legacy output still parse; callers receive useful failure feedback.
- Separate enhancement: expected acceptance coverage needs an explicit caller contract,
  rather than being silently included in the parser fix.
- Result: fixed locally. The parser rejects malformed findings and present auxiliary
  fields with field/index-specific errors instead of filtering or coercing them.
  Parsed non-object roots are authoritative, legacy omissions remain supported, and
  malformed output returns a failed verdict with no lesson. Prompt review recognizes
  new schema errors as evaluator failures; valid defect rejections retain builder
  attribution and valid failure lessons remain supported.
- Changed: `lib/foreman.ts`, `lib/promptreview.ts`, `test/foreman.test.ts`,
  `test/guards.test.ts`, `test/promptreview.test.ts`, README.md and SPEC.md.
  Prior repairs and unrelated changes were preserved. No commit or deployment.
- Regression evidence: six new cases failed before the parser fix (four schema/root
  tests and two pipeline scenarios); the compatibility case already passed. Pipeline
  tests prove a malformed blocking field cannot merge or compound a lesson, and a
  malformed finding gives useful retry feedback before a valid legacy verdict merges.
  Matrices cover positive and negative malformed verdicts. Independent Sol review
  identified an attribution integration gap; root reproduced it with actual
  parser → feedback → pass consumers, then fixed it and verified legacy attribution.
- Review: read-only Sol medium contract investigation and Sol high verification;
  after root's focused correction, no remaining concrete R04 defect was found.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/foreman.test.ts test/guards.test.ts test/merge-process.test.ts test/e2e.test.ts test/observe.test.ts test/promptreview.test.ts test/dash.test.ts`
    — 142 passed, 0 failed; log: `/tmp/fact-os-r04-validation.log`.
  - After attribution correction,
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/promptreview.test.ts test/observe.test.ts`
    — 45 passed, 0 failed (143 distinct cases across both groups);
    log: `/tmp/fact-os-r04-attribution-validation.log`.
  - `bun run typecheck` and `git diff --check` passed.
- Limits: schema validation cannot prove factual evidence or complete acceptance
  coverage. Bare/fenced/prose support remains heuristic for otherwise unparseable
  wrapper text. Dashboard historical projection still reads raw provider output and
  may show raw pass:true for a schema-rejected verdict; tracked with R10. Raw artifacts
  are retained for diagnosis. No real-provider or live-factory calls were performed.

## R05 — safe lesson curation

- Evidence: `lib/observe.ts`, `curateLessons()` safety check before awaiting an agent,
  followed by unconditional rewrite/commit after return.
- Trigger: checkout branch or lessons content changes during the wait.
- Consequence: wrong-branch commits, inclusion of user edits, or restoration of stale
  edited/deleted rules. Wrong-branch/user-edit commit was reproduced with a fake agent.
- Recommendation: coordinate main-checkout writes across observer and foreman and
  recheck branch/content immediately before mutation; distinguish permitted appends.
- Decision: share a separate checkout lock between foreman serialized operations and
  observer snapshot/apply, never held during the curator call. Recheck base branch,
  Git operation state, tracked status and tracked-file cleanliness on apply. Require
  exact whole-file identity, allowing only a continuous chain of foreman append
  hashes recorded on existing lesson events. Preserve those appends; refuse other
  changes without writing the archive, lessons or a commit. Untracked lessons remain
  uncommitted. Keep unrelated staged paths untouched and report commit failures.
- Scope: state lock reuse, foreman checkout/lesson events, observer curation,
  init ignores, affected regression tests and README/SPEC. Root is the sole writer.
- Acceptance: branch switches and intervening edits cause safe refusal; recognized
  foreman appends survive; no unrelated files or user edits are committed.
- Result: fixed locally. Foreman and observer now use the same checkout ownership
  protocol on a separate lock path, including asynchronous merge hooks/post-merge
  commands. Curation rechecks safety and full-file append provenance before touching
  lessons/archive/index. Original rules cannot be restored after intervening edits or
  deletions. Foreman appends survive on tracked and untracked files; tracked curation
  commits only the lessons path. Changed content with invalid/missing proofs or
  replaced/truncated proof logs refuses. A bounded checkout-lock timeout defers
  curation without failing the observer.
  Commit failures explicitly report that the local rewrite/archive remain.
- Changed: `lib/state.ts`, `lib/types.ts`, `lib/foreman.ts`, `lib/observe.ts`,
  `lib/cli.ts`, `test/curation.test.ts`, `test/state.test.ts`, README.md and SPEC.md.
  No commit, deployment, factory restart or extension change.
- Regression evidence: 13 of the initial 15 curation cases failed before the fix;
  the two successful baseline cases preserved real foreman appends. The final 24
  curation cases cover branch/content/tracking changes, Git operation state, mixed
  user edits and real appends, missing/invalid proofs, replaced/truncated logs,
  unrelated staging, archive/commit failures, merge-hook coordination and a real
  30-second timeout. Checkout/state lock independence is separately covered.
- Review: read-only Sol medium producer/caller investigation and Sol high design
  and implementation verification. Root verified the concrete callers and ran all
  checks. No remaining concrete R05 defect was identified.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/curation.test.ts`
    — initial reproduction: 2 passed, 13 failed; after the application fix: 15 passed.
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/curation.test.ts test/state.test.ts test/supervisor.test.ts test/foreman.test.ts test/guards.test.ts test/merge-process.test.ts test/e2e.test.ts test/observe.test.ts`
    — 158 passed, 1 test-fixture failure: after correctly asserting archive EISDIR,
    the helper tried reading a log that did not yet exist. Initialize the fixture's
    empty log; no application correction was needed. Log: `/tmp/fact-os-r05-validation.log`.
  - Rerun the changed fixture plus all curation cases, including the added timeout:
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/curation.test.ts`
    — 24 passed, 0 failed; log: `/tmp/fact-os-r05-curation-final.log`.
    **160 distinct cases passed** across the final validation groups.
  - `bun run typecheck` and `git diff --check` passed.
- Limits: arbitrary external editors/Git commands can ignore the checkout lock and
  race the final critical section. Upgrade cooperating foreman/observer processes
  together; older lesson events lack append proofs and concurrent legacy writes fail
  closed when detected. Proof logs are trusted local, append-only records; no claim
  of protection against deliberate forged logs. Curation cannot prove semantic rule
  quality. Failed commits retain local curated content/archive, and archive/file write
  failures propagate without success logging; multi-file crash atomicity is unchanged.
  A curator invocation counts toward the configured interval even if apply refuses.
  Observer cancellation remains R09. No real providers or live-factory checkouts were used.

## R06 — manual dependencies

- Evidence: `lib/ready.ts`, `analyze()` accepts ready dependencies; foreman creates
  dependent worktrees from base, which lacks their code.
- Trigger: A is ready/unmerged; B depends on A and launches from base.
- Consequence: missing dependency behavior causes failures or duplicate implementation.
- Recommendation: require actual merged dependencies or explicitly compose evaluated
  dependency SHAs. Choose and document one contract before implementation.
- Decision: dependencies must be `merged` in both modes. Manual mode requires merging
  the evaluated commit into configured base, then acknowledging it; the dashboard
  verifies commit ancestry before changing state. A watching foreman waits when todo
  dependents need ready manual features acknowledged. Reused dependent branches must
  import missing dependency commits before the builder, using existing base-refresh
  and conflict handling. No branch stacking or automatic manual-merge reconciliation.
- Scope: shared readiness, foreman dependency import/watch, dashboard acknowledgment,
  manual-workflow wording, focused unit/integration tests and README/SPEC.
- Acceptance: a dependent sees dependency code before it builds; readiness, CLI and
  dashboard agree; independent manual features remain usable.
- Result: fixed locally. Shared readiness now requires merged dependencies in both
  modes. Manual acknowledgment is checkout-locked and verifies the recorded commit
  exists on configured base before updating status; refusals preserve metadata/log.
  Fast-forward and non-fast-forward hand merges qualify, and branch movement cannot
  substitute a different commit. Watching foremen wait for acknowledgment when todo
  dependents need it; independent manual features still finish ready.
  Reused/restored branches import missing dependency commits before setup/build.
  Conflicts stay with the same builder; preparation is deferred until resolution,
  then the prepared tree must be committed, clean and contain the required ancestry
  before gates. A pending merge may satisfy dependencies across its two parents.
  Observer/pass statistics and dashboard conflict history recognize this same-pass
  flow, preserving earlier failure feedback and the configured refresh bound.
- Changed: `lib/ready.ts`, `lib/foreman.ts`, `lib/dash.ts`, `lib/observe.ts`,
  `lib/promptreview.ts`, `lib/dash/you.js`, `lib/dash/detail.js`,
  `test/ready.test.ts`, `test/guards.test.ts`, `test/dash.test.ts`, README.md,
  SPEC.md and bundled `skills/ship/SKILL.md` workflow wording. No skill was invoked,
  installed or enabled; no commit, deployment or live-factory restart.
- Regression evidence: all four initial readiness/CLI/dashboard/watch/reused-branch
  regressions failed before the fix. Root verified the metadata-only acknowledgment
  bypass in its actual caller; a medium Sol reviewer also reproduced it in isolated
  Git. Independent high Sol review found the new-prefix timeline gap and preparation
  ordering gap; root added failing reproductions before each focused correction.
  Final cases cover real ff/no-ff merges, missing/invalid/unmerged/blob SHAs, moved
  branches, independent manual features, watch resumption, clean/conflicting imports,
  legacy dependencies, pending-parent union/refusal, maxRefreshes, aborted imports,
  falsely merged metadata, and deferred preparation failures/dirty trees/lost ancestry.
- Review: two read-only Sol medium reviewers covered pipeline and surfaces; Sol high
  reviewed reused-branch design and verified implementation/connections. Root reviewed
  the callers, reproduced significant candidates and resolved them with code evidence.
  No remaining concrete R06 defect was identified.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/ready.test.ts test/guards.test.ts --test-name-pattern 'both merge modes|manual dependencies|merged dependencies reach'`
    — before: 4 failed; after: 4 passed.
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/ready.test.ts test/guards.test.ts test/dash.test.ts test/merge-process.test.ts test/observe.test.ts test/promptreview.test.ts test/e2e.test.ts`
    — 140 passed, 0 failed; `/tmp/fact-os-r06-validation.log`.
  - After connection corrections,
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/guards.test.ts test/dash.test.ts --test-name-pattern 'dependenc|conflictTimeline|prepare'`
    — 20 passed, 0 failed; `/tmp/fact-os-r06-connections-final.log`.
  - Final changed pipeline/surface connections:
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/foreman.test.ts test/guards.test.ts test/dash.test.ts test/merge-process.test.ts`
    — 109 passed, 1 existing prompt-wording assertion failed: the expanded pending
    merge permission had replaced "started" with "assigned". Preserve the original
    permission phrase and explicitly add assigned merges; behavior checks had passed.
    `/tmp/fact-os-r06-final-affected.log`.
  - After wording correction,
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/guards.test.ts --test-name-pattern 'conflicted base refresh is left|pending dependency merge'`
    — 3 passed; `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/foreman.test.ts`
    — 22 passed. **168 distinct cases passed** across final validation groups.
  - `bun run typecheck`, `git diff --check`, and parsing both changed dashboard JS
    files with Bun/`new Function` passed. No browser session was needed for text-only UI changes.
- Limits: commit ancestry proves inclusion, not unchanged dependency semantics after
  edits/reverts; the gate/evaluator still validate behavior. Legacy merged records
  without SHA use current base and remain trusted metadata. Squash/cherry-pick
  equivalents cannot be acknowledged; no automatic hand-merge reconciliation or
  stacking unmerged branches was added. External Git/state writers ignoring the
  factory locks can still race checks. The readiness mode argument remains accepted
  for caller compatibility, but no longer changes dependency completion policy.
  Pending acceptance snapshots remain R07. Checks used fake providers/temp repositories
  only; no live calls, accounts, databases, infrastructure or checkout upgrades.

## R07 — acceptance at launch

- Evidence: `lib/foreman.ts`, startup acceptance map and launch snapshot.
- Trigger: edit a waiting feature's checks before its launch in a running foreman.
- Consequence: builders/evaluators use old checks and may accept obsolete behavior.
- Recommendation: snapshot at actual launch and retain it during the pass.
- Decision: capture a copied acceptance list inside the same state-locked mutation
  that claims `todo` → `building`, preserving the pre-transition SHA for build reuse.
  Each new launch (automatic failure retry, queued refresh, human retry/resume or
  recovery) reads current checks; inline resolver/revalidation keeps its launch
  snapshot. This deliberately replaces the old test's across-retry startup freeze.
  Direct JSON edits have no human/agent provenance, so edits apply at the next launch
  regardless of author; mid-launch edits must not weaken evaluation or its own-feature
  conflict brief. Existing feedback remains historical context.
- Scope: foreman launch/refresh, focused guard regressions, README/SPEC and tracking.
- Acceptance: pre-launch edits apply, mid-pass edits cannot weaken checks, and retry
  semantics are explicit and tested.
- Result: locked launch now returns a copied current feature before clearing disk SHA.
  A missing feature or one no longer `todo` is skipped before logging/counting/claims.
  Every refresh caller passes its launch feature into the own-feature conflict brief;
  live refresh counters/feedback and other merged-feature metadata remain on disk.
  Retries recapture checks, while inline resolver and aggregate evaluation retain them.
- Files changed for R07: `lib/foreman.ts`, `test/guards.test.ts`,
  `test/fixtures/acceptance-launch.ts`, README.md, SPEC.md and this backlog.
- Validation (fake providers and disposable Git repositories only):
  - Before repair, `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test
    test/guards.test.ts --test-name-pattern 'acceptance:'`: all five regressions failed,
    confirming automatic-retry freeze, pending edit, stale scheduling read, lost pause
    and resolver brief leakage (`/tmp/fact-os-r07-before.log`).
  - Same command after repair: **5 passed, 0 failed**
    (`/tmp/fact-os-r07-focused.log`). Added a human retry regression and strengthened
    compatible parallel revalidation to edit checks and require the slower feature's
    two evaluations to retain the same list. Expanded pattern
    `'acceptance:|compatible parallel features'`: **8 passed, 0 failed**
    (`/tmp/fact-os-r07-expanded.log`; it also matches "incompatible").
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test
    test/guards.test.ts test/foreman.test.ts test/merge-process.test.ts
    test/control.test.ts test/profiles.test.ts test/e2e.test.ts`:
    **126 distinct tests passed, 0 failed**, including interrupted/parked build reuse,
    dependency import, manual mode, resolver, claims and live launch controls
    (`/tmp/fact-os-r07-validation.log`). `bun run typecheck` and
    `git diff --check` passed.
  - Root verified state mutation/launch callers, all three refresh callers and SHA
    reuse. Independent Sol reviewers checked pipeline/callers and documentation;
    high-effort Sol independently verified atomic capture, all refresh callers, SHA
    reuse and the retry contract; no concrete remaining R07 defect was found.
- Limits/coverage: no actor provenance or protection against acceptance edits across
  launches; arbitrary file writers do not honor the lock. Existing feedback can quote
  an earlier contract, and other merged-feature checks in briefs remain current
  metadata. Recovery/queued-refresh acceptance edits were traced through the shared
  launch path, with existing recovery/refresh behavior tested; those specific edit
  scenarios do not have separate regressions. No live providers, factories, browser,
  accounts, databases, deployment, commit or extension installation was needed/run.
  Evaluator acceptance coverage still is not enforced by the verdict parser.

## R08 — runtime config validation

- Evidence: `lib/state.ts`, `loadConfig()`/`effectiveLimit()`; `lib/cli.ts`, doctor;
  foreman lane comparisons and `applyFailure()`.
- Trigger: `maxParallel:"oops"` and `maxAttempts:"oops"` pass doctor.
- Consequence: NaN bypasses launch limits; invalid attempt limits can retry forever.
- Recommendation: shared runtime validation at the config boundary, reused by doctor,
  checking finite integer limits and other operational shapes/ranges.
- Decision: validate supplied known fields in `loadConfig()` before defaults/casts/path
  substitution; return all field-specific problems, reused by doctor through loading.
  Reject non-object roots, wrong shapes/coerced strings and nonfinite/out-of-range
  limits; reuse existing profile validation. Preserve shallow role replacement,
  partial observer/claims defaults, unknown extra fields and provider-specific strings.
  `maxParallel` remains a safe integer ≥0 (0 still means effective 1; no new cap 32),
  attempts ≥1, refreshes/count limits ≥0. Budgets permit finite 0/null; timeout is
  null or positive minutes within the native timer range. Zero observer throttles
  remain supported. This changes malformed legacy configs from silent fallback to
  explicit refusal; no application/provider or feature-state schema refactor.
- Scope: state config boundary, doctor config checks, focused config/guard/dashboard
  regressions, foreman state-only reads preserving its config snapshot,
  README/SPEC/type contract comments and tracking.
- Acceptance: invalid config cannot launch work and doctor reports specific errors;
  valid defaults/partial supported config and runtime controls still work.
- Result: `loadConfig()` validates every current known config field before casting,
  applying defaults or replacing `<repo>`. Doctor-only config rules were removed;
  existing profile diagnostics are shared at runtime. Malformed configs cannot launch
  providers or mutate feature state; dashboard exposes the error and refuses controls.
  Low-level pause/lanes recovery remains available without valid config.
- Integration correction: root reproduced a stricter-validation ownership gap on a
  control wake while a builder was live: later `load(root)` threw and released the
  foreman marker early. `loadState()` now reads mutable feature/human state separately;
  foreman validates config before startup state reads and retains that config snapshot
  throughout. All later foreman reads use state only. Shape-invalid and malformed-JSON
  config edits trip the existing raw-text tamper halt, retain ownership/signal handlers,
  reject a second foreman and drain existing work before releasing ownership. No new
  child-cancellation policy or observer cancellation fix is included (R09 remains next).
- Files changed for R08: `lib/state.ts`, `lib/cli.ts`, `lib/foreman.ts`, `lib/types.ts`,
  `test/config.test.ts`, `test/guards.test.ts`, README.md, SPEC.md and this backlog.
- Validation (fake providers and disposable Git repositories only):
  - Before repair, `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test
    test/config.test.ts` recorded **1 pass, 9 failures**
    (`/tmp/fact-os-r08-before.log`). Eight failures demonstrated missing validation;
    the ninth was an incorrect dashboard fixture call and is excluded as bug evidence.
    Corrected it to an explicit temporary root and ephemeral port. Corrected the
    accepted timer-boundary example to leave 1 ms headroom because floating-point
    multiplication rounded the exact quotient above the supported range. Temporary
    worktrees from the initial run repro were removed; future fixtures keep them
    inside the disposable root. Focused final config checks: **10 passed, 0 failed**
    (`/tmp/fact-os-r08-focused-final.log`).
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test
    test/config.test.ts test/control.test.ts test/profiles.test.ts test/dash.test.ts
    test/observe.test.ts test/actions.test.ts test/e2e.test.ts test/guards.test.ts
    test/merge-process.test.ts`: **172 passed, 0 failed**
    (`/tmp/fact-os-r08-validation.log`).
  - Ownership-gap repro: named guard pattern `'invalid config during a live run'`
    failed with an owned child still alive after marker removal
    (`/tmp/fact-os-r08-shutdown-before.log`). After state/config separation, the
    retention guard plus existing config-tamper guard passed
    (`/tmp/fact-os-r08-shutdown-final.log`). Expanded retention coverage to invalid
    shape and malformed JSON, with second-foreman refusal and no later feature launch.
  - Final affected validation after that correction:
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test
    test/config.test.ts test/guards.test.ts test/foreman.test.ts test/control.test.ts
    test/merge-process.test.ts test/supervisor.test.ts test/state.test.ts`:
    **156 passed, 0 failed** (`/tmp/fact-os-r08-final-validation.log`). The final
    groups plus the unchanged consumer groups from the broader run cover
    **226 distinct passing tests**. Strict `bun run typecheck` and `git diff --check`
    passed after the final code/test changes.
  - Root traced callers and verified the ownership repro. Independent medium-effort
    Sol reviewed consumers/nested-default compatibility; high-effort Sol verified
    validation coverage, then independently confirmed the ownership gap and correction.
    No concrete remaining R08 defect found.
- Limits/coverage: this validates current known shapes/ranges, not provider value
  allowlists, shell-command semantics, Git-ref existence or filesystem permissions.
  Unknown extra fields remain permitted; unsupported `groupBy` strings retain their
  warning/ignore behavior. Feature/human schemas are still trusted at runtime and
  checked by doctor; this repair does not change that separate boundary. No live
  provider calls, accounts, factories, browser UI, unrelated databases, deployment,
  commits or extension installations were needed/run. No required check was blocked.

## R09 — cancellation before agent launch

- Evidence: `lib/observe.ts`, `observeOnce()` curation/improver calls and signal cleanup;
  `lib/promptreview.ts`, notes group iterations.
- Trigger: stop during prompt review, then curation/improvement remains eligible.
- Consequence: new children start after cancellation; shutdown can wait indefinitely
  and a second signal can leave those process groups behind.
- Recommendation: cancellation checks before every provider launch and final cleanup
  for all owned children, including ones created during the cancellation window.
- Decision: check cancellation at every observer provider launch, including after checkout
  lock waits and within parallel review/notes groups. Keep completed review evidence/cost,
  but do not apply canceled notes, lessons or improver proposals. First signal stops launches
  and SIGTERMs owned groups; second signal SIGKILLs them before exiting. Final cleanup
  kills and drains any still-owned children before releasing normal supervisor ownership.
- Scope: observer, prompt review, focused cancellation regressions, README/SPEC. Root
  remains the sole application writer; reviewers are read-only.
- Acceptance: stopping already true makes no calls; stopping during each stage prevents
  subsequent calls; forced shutdown leaves no test-owned children.
- Result: fixed locally. Curation and improvement receive the existing cancellation
  callback, check immediately before provider launch and after provider completion, and
  recheck inside checkout/state mutation locks. Notes check every group and return before
  archive/write/fallback/consumed flags when their curator was canceled. Template proposals
  likewise recheck under the state lock and leave unused reviews unfiled. Review calls
  check individually as well as per batch; started paid results/costs remain recorded and
  stopped failures do not consume retry attempts. Throttle timestamps advance only when
  the first call of a new batch actually starts; curation/improver timestamps likewise
  require a launch. Already-completed changes remain; cancellation is not a rollback.
- Shutdown: first signal sets stopping and SIGTERMs currently owned groups; second signal
  SIGKILLs them before exit 130. Normal/exceptional finalization attaches close listeners
  before killing remaining groups and drains them while retaining ownership/listeners.
  Forced immediate exit can leave a stale marker, recovered by existing supervisor logic.
- Changed: `lib/observe.ts`, `lib/promptreview.ts`, new `test/cancellation.test.ts`,
  README.md, SPEC.md and this backlog. Existing R01–R08 repairs and untracked legacy
  dashboard preserved. No commit, deployment or live-factory restart.
- Regression evidence: the eight initial corrected tests all failed before the fix;
  they now pass. They exercise already-stopped observers, review/notes/lessons/improver
  cancellation with later stages eligible, cancellation during snapshot-lock waits,
  per-call cancellation and resistant-provider/descendant forced shutdown. The first
  fixture run omitted the explicit lessonsFile setting; it was corrected before using
  results as evidence. Six additional checks cover completed parallel review accounting
  and next-batch refusal, advancing an expired throttle, canceled template/state and
  lessons/application locks, canceled improver application, and final cleanup after a
  review callback failure leaves another owned review running. Cleanup fixtures isolate
  supervisor processes and assert groups drained before marker removal/listener cleanup.
- Independent verification: two read-only GPT-6.1 Sol medium reviewers traced observer
  and notes boundaries; root independently confirmed their evidence and added regressions.
  Sol high reviewed ownership/cleanup and the final patch. A timestamp regression found
  during intermediate implementation was corrected before final validation; no remaining
  concrete R09 defect was identified within the scoped ownership contract.
- Validation (2026-10-02):
  - Before: `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/cancellation.test.ts`
    — 0 passed, 8 failed after fixture correction (`/tmp/fact-os-r09-before-corrected.log`).
  - Final: `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/cancellation.test.ts test/observe.test.ts test/promptreview.test.ts test/curation.test.ts test/supervisor.test.ts test/profiles.test.ts`
    — 105 passed, 0 failed across six files, including 14 new cancellation tests
    (`/tmp/fact-os-r09-validation.log`).
  - `bun run typecheck` and `git diff --check` passed. No required check was blocked.
- Limits: first signal may wait for a TERM-resistant provider when timeoutMin is null;
  second signal provides forced shutdown. Ownership tracks groups until ChildProcess
  close; daemonized/new-session descendants and children whose parent already closed
  with redirected stdio are outside this guarantee. Direct observeOnce callers own
  their cancellation callback and child termination. Checks used disposable Git repos,
  scripted fake providers and owned subprocesses only; no live provider calls, accounts,
  stores, unrelated databases, infrastructure, browser UI or extension changes.

## R10 — dashboard pass identity

- Evidence: `lib/dash/detail.js`, current attempt/run selection; `lib/dash.ts`, run tag
  parsing and finding projection; check board/factory callers as well.
- Trigger: first running attempt has zero failures; second successful attempt has one;
  refreshes produce tags such as `1.2`; verdict findings supply `evidence`.
- Consequence: attempt 0, incorrect success number, earliest refresh output selected,
  and missing evaluator evidence.
- Recommendation: preserve full pass tags/evidence and centralize attempt display.
- Additional connection verified during R04: raw provider `pass: true` can remain in
  dashboard history after the foreman rejects the verdict's schema. Align displayed
  validation outcome with the parser while keeping original provider text available.
- Decision: share a browser attempt-number helper (failures + 1 for in-flight/ready/merged),
  preserve full artifact tags and resolver runs, sort by recorded completion time with
  numeric tag tie-breaking, select latest role outputs and show every retained run in
  the log. Parse provider output/verdicts using the foreman parsers, preserve evidence
  and original text, and display rejection reasons. Verdict validity is distinct from
  pipeline success: old raw files do not reliably record exit/timeout outcomes.
- Scope: dashboard server/core/detail/board/factory, served API and actual-script render
  regressions, README/SPEC. Root sole writer; preserve earlier repairs.
- Acceptance: first build is attempt 1, second success is attempt 2, refreshed runs
  remain distinguishable and show the correct output/evidence in served UI contracts.
- Result: fixed locally. The API carries `n` (integer attempt prefix), full string `tag`,
  build/eval/resolve role, completion time, complete provider `text`, summary and normalized
  evaluation `pass/findings/error`. It reuses parseClaudeOutput/parseVerdict and reports
  malformed roots/entries/lists, contradictions and provider errors without dropping
  original text. Structured/prose/fenced output follows the same parser. Finding evidence
  reaches escaped HTML; resolver outputs and every retained refreshed run stay inspectable.
  Chronological ordering survives attempt resets; numeric suffixes break mtime ties, so
  `1.10` follows `1.2`, never decimal parsing or lexical selection.
- Browser connections: core's attemptNumber is used by detail, board and factory; core
  loads before these registered views. Detail selects latest retained role outputs, sums
  retained artifact time/cost for each numeric attempt and labels the expanded history
  as spanning refreshes and earlier retry cycles. Current counted failures are associated
  from the tail of the failure log; zero-count fresh retries do not inherit historical
  failure labels. Current failure events take precedence over an old evaluator output
  after a counter reset. Inspection explicitly shows a rejected saved verdict even when
  legacy feature state remains ready/merged; projection does not rewrite feature state.
- Changed: `lib/dash.ts`, `lib/dash/core.js`, `lib/dash/detail.js`, `lib/dash/board.js`,
  `lib/dash/factory.js`, `test/dash.test.ts`, new `test/dash-history.test.ts`, README.md,
  SPEC.md and this backlog. Earlier repairs and untracked legacy dashboard preserved.
  Existing dashboard fixtures were updated from obsolete note-only findings to the
  producer's required evidence contract. No commits, deployments or factory restarts.
- Regression evidence: five new API/served-script tests all failed before changes
  (`/tmp/fact-os-r10-before.log`). They cover full tags/resolvers/chronology, strict
  verdict validity/raw output, first/second attempt labels across all three views,
  refreshed evidence and fresh human retry. Two additional regressions confirmed the
  old-evaluation/new-builder failure mislabel and legacy merged/invalid verdict display
  before correction (`/tmp/fact-os-r10-verification-before.log`). Intermediate test
  corrections supplied the fake DOM's factory child selectors and expected the actual
  numeric HTML quote entities; those were fixture issues, not application defects.
- Independent verification: two read-only GPT-6.1 Sol medium reviewers traced producer,
  API and browser contracts. Root verified candidates against code/callers and failing
  regressions. Sol high identified the additional retry/failure precedence defect and
  verified the final correction; no remaining concrete R10 defect was identified.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/dash-history.test.ts test/dash.test.ts test/config.test.ts test/foreman.test.ts test/profiles.test.ts test/actions.test.ts`
    — 77 passed, 0 failed across six named files, including seven new regressions
    (`/tmp/fact-os-r10-validation.log`).
  - `bun run typecheck`, `node --check lib/dash/core.js`, `node --check lib/dash/board.js`,
    `node --check lib/dash/factory.js`, `node --check lib/dash/detail.js` and
    `git diff --check` passed. No required check was blocked.
- Limits/coverage: feature history retains 20 run artifacts, 60 feature events and 40
  activity entries. Completion ordering relies on mtimes; manually altered files,
  incomplete logs and counters cannot establish exact historical cycle identity.
  Raw output was saved before some exit/timeout checks, so normalized verdict validity
  cannot prove historical process/pipeline success; feature state and failure events
  remain separate evidence. Numeric attempt buckets intentionally include old cycles'
  retained artifacts and their costs; exact generation accounting needs persisted
  event/run identities, not heuristics that discard reused builds. Complete provider
  text can enlarge local history responses. Served API and actual registered scripts,
  markup and click callbacks were tested using temporary fixtures and a minimal DOM;
  browser layout/accessibility/device rendering was not exercised. No browser/extension
  installs, live providers/accounts/stores/databases/infrastructure or publication.

- Second-review correction: uncounted `stuck` events (refresh exhaustion/orphan
  recovery) were not covered by the attempt tests. See open R16 for zero-attempt
  display and counted/uncounted failure association.

## R11 — directory claims

- Evidence: `lib/merge.ts`, `claimBlock()`/`hotTest()`.
- Trigger: candidate `src/`, held `src/hot.ts`, hot config `src/hot.ts` returns no blocker.
- Consequence: optional claims permit concurrent edits to a protected file.
- Recommendation: test hotness on concrete intersections and scored descendants.
- Acceptance: directory/file matching works in both directions, scored and explicitly
  hot descendants block, cold/disjoint paths do not; default claims remain off.
- Decision: compute the narrower file/directory intersection before testing hotness.
  Directory predicates recognize explicitly listed or scored hot descendants in that
  intersection; concrete cold siblings stay cold. Preserve minScore zero behavior,
  holder order and deterministic candidate/held path ordering; report the narrower
  blocker. Builder hints enumerate protected intersections inside held directories;
  they remain advisory and do not label every descendant hot. At zero threshold,
  hints list held paths rather than every known scored/listed path.
  Scope: merge helpers, actual-helper/foreman regressions, documented claims contract.
  No new Git reads, scheduling transactions, prediction agents or default changes.
- Result: directory/file claims now block in either direction, and nested/equal
  directory claims recognize listed or threshold-scored descendants. A protected
  sibling outside the actual intersection does not serialize cold work. Wait messages
  report the narrower shared path. Default-off behavior and the legacy zero threshold
  are preserved. Foreman uses shared path helpers for precise builder hints without
  adding Git reads or expanding scheduling scope.
- Regression-first evidence: before the application change, all nine new helper tests
  failed; the initial six foreman cases had five failures and one pass (default off).
  After the change, those 15 focused cases passed. Final tests also cover a listed hot
  ancestor directory, slash boundaries, empty-score zero-threshold directory overlap,
  and a seventh foreman case for zero-threshold gating and held-path-only hints.
- Acceptance evidence:
  - `test/merge.test.ts`: actual hotTest/claimBlock with listed/scored concrete paths,
    both directory/file directions, nested/equal directories, listed prefixes above
    and beneath the intersection, cold/disjoint paths, score thresholds, zero with no
    known paths, deterministic sorted/deduplicated paths and preserved holder order.
  - `test/merge-process.test.ts`: real CLI/temporary Git with fake builders and a
    deterministic launch barrier. Event ordering proves protected work waits for its
    holder to merge while unrelated/cold work launches concurrently; prompts contain
    protected descendants, or actual held paths at zero; disabled claims have no hints.
    Each feature builds once and merges. Existing history/branch-diff claims and
    resolver/keep-lines scenarios are included in the affected suite validation.
  - Callers checked: foreman tick snapshot, claim gate, held updates and builder prompt;
    `scripts/replay-conflicts.ts` uses hotScores and its own concrete-path simulation,
    not hotTest/claimBlock, so its historical estimates do not validate directory claims.
- Changed: `lib/merge.ts`, claims gate/hints in `lib/foreman.ts`, `test/merge.test.ts`,
  `test/merge-process.test.ts`, README.md, SPEC.md, `docs/merge-process.md` and tracking docs.
- Limits: claims remain launch-only snapshots of known paths, not prediction of future
  edits. The separately recorded mid-tick metadata/readiness concern is not fixed here.
  Paths must be repo-relative with `/` separators and trailing `/` for directories;
  no glob support or normalization was added. No live factory/provider, replay rerun,
  browser layout, or database checks were required or performed for this scope.
- Validation:
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/merge.test.ts
    test/merge-process.test.ts test/guards.test.ts test/control.test.ts test/foreman.test.ts`
    — **167 pass, 0 fail** across five named files (79.64s); fixtures override providers
    with fakes. All 16 final R11 cases are included.
  - `bun run typecheck` and `git diff --check` passed. Earlier focused run of the
    initial 15 R11 cases passed after the fix; no unrelated full suite was run.
  - Claude approved final code through the existing Herdr tab after rerunning the
    two merge suites (**39 pass, 0 fail**, overlapping validation) and direct helper
    calls. Sol high independently reviewed helpers, actual launch/hint callers and
    tests read-only with no concrete defect. Root checked the code and caller evidence;
    neither verification required another application writer.
- Status: verified locally; no commit, deployment or live-factory restart.

## R12 — prompt rate units

- Evidence: `lib/promptreview.ts`, `promptRates()`.
- Trigger: a successful pass evaluates twice around conflict resolution, while failures
  count only the last responsible prompt.
- Consequence: successes and failures use different denominators, understating failure
  rates and misleading notes-version comparisons.
- Recommendation: use one counting unit, per pass or per invocation, consistently.
- Acceptance: repeated role prompts, mixed model/notes versions and failed passes have
  consistent counts and labels in report/dashboard projections.
- Decision: use one outcome per launch-defined pass and role. Successful passes credit
  only the final prompt of each role, at its final model/notes bucket; reviewable failures
  retain one bad outcome for the final prompt of the attributed role. Superseded prompts,
  unprompted roles and interrupted/infrastructure-only outcomes receive no counts.
  Keep existing pass classification, review attribution, persisted numeric shape and
  five-pass/15-point comparison threshold. Document this attribution in report/dashboard;
  observer recomputes the rates from events on its next pass. Mark the counting format and
  hide legacy rate totals/trends until that regeneration, while retaining reviews/notes/cost;
  aggregates cannot be converted without logs. `since` is the earliest contributing final
  prompt timestamp, not the first encountered completed pass. Scope excludes provider-call
  success metrics, model causal claims and unrelated observer/UI refactors.
- Result: repeated successful evaluations/resolvers no longer inflate samples or
  credit superseded model/notes buckets. Failures retain the final responsible-role
  sample. Completion ordering cannot misdate a contributing notes version. The shared
  summary/API, Markdown report and served Observer UI use the same pass totals and
  explain attribution; reviewed failed passes and paid review runs have distinct labels.
  Old cached rates/trends are withheld as pending until the observer replaces array
  and marker together, without discarding reviews, notes or cost.
- Regression-first evidence: the first eight tests in `test/prompt-rates.test.ts`
  produced **1 pass, 7 fail** before application changes, then **8 pass, 0 fail** after.
  An initial fixture using invalid `observer.agent: false` was corrected to valid
  `null` before accepting the failure evidence; the final failure was the actual
  missing pending-rate contract, not config rejection.
- Acceptance evidence:
  - Actual passesOf→promptRates traces for clean revalidation, repeated inline resolvers,
    mixed model/notes versions, builder/evaluator/resolver failure attribution (including
    resolver keep-check), skipped builders, interrupted/incomplete/infra outcomes and
    terminal merge/lesson events without a launch. Superseded prompts receive no credit.
  - Repeated invocations cannot satisfy the five-pass trend threshold; earliest final
    prompt timestamps determine bucket ordering despite out-of-order completion.
  - Legacy summary preserves notes/cost while hiding totals. Temporary Git with no
    agent exercises actual observeOnce persistence, saved cache marker, `/api/state`,
    actual served `observer.js` registered renderer in a VM, and Markdown output:
    two successful evaluator passes plus one attributed failure show **1 of 3 (33%)**
    everywhere after regeneration; pending text disappears and old totals are absent.
  - A final focused policy regression distinguishes excluded parking/merge refusals
    from an evaluated conflict bounce, and verifies an out-of-pass later merge adds
    no duplicate credit. Existing prompt-review, observer, dashboard and throttle
    suites verify affected connections and normal single-prompt behavior.
- Validation:
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/prompt-rates.test.ts
    test/promptreview.test.ts test/observe.test.ts test/dash.test.ts test/observer-throttle.test.ts`
    — **89 pass, 0 fail**, five named files (5.25s). Existing fixtures use fake providers.
  - After adding only the policy regression, `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false
    bun test test/prompt-rates.test.ts -t 'R12: existing parked'` — **1 pass, 0 fail,
    8 filtered**. Combined validation covers **90 distinct tests**, including all nine R12
    regressions. `bun run typecheck` and `git diff --check` passed after final edits.
  - Claude final read-only review through the existing Herdr tab found no concrete
    problem and passed **23 overlapping tests** in the prompt-rate/prompt-review files.
    Sol high checked final code/callers/cache contract and documentation independently;
    root verified the evidence and resolved the parked-policy disagreement as below.
- Changed: `lib/promptreview.ts`, `lib/observe.ts`, `lib/dash/observer.js`, new
  `test/prompt-rates.test.ts`, marked cache fixtures in `test/promptreview.test.ts` and
  `test/dash.test.ts`, README.md, SPEC.md and tracking docs. Foreman producers unchanged.
- Limits: attribution is an existing heuristic, not a causal model/notes experiment or
  provider-invocation success metric. Parked/infra/other outcomes remain excluded. Saved
  pre-upgrade Markdown stays unchanged until the observer rewrites it; logs must still
  be available for reconstruction. Mixed old/new observer binaries are not a supported
  cache-upgrade guarantee. Real browser layout and live factory/provider/DB checks were
  not run; the UI check covers registered rendering and counts, not layout. No full suite.
- Review decision: Claude proposed treating parked `merge-skipped`/`merge-failed` as
  successes. Root and Sol high verified foreman call sites: although normal parking follows
  validated evaluation, `merge-skipped` also includes tampering, and `merge-failed` is an
  infrastructure refusal. Crediting these changes outcome policy and nextResult wording,
  rather than fixing units. Keep these outcomes excluded and document that existing limit;
  a future policy change requires its own scoped decision. Review keys/failure attribution
  remain unchanged. Superseded model/notes buckets disappearing is intentional.
- Status: verified locally; no commit, deployment or live-factory restart.

## R13 — persist paid observer-stage throttles

- Origin: Claude D1, confirmed by root reproduction and read-only Sol high verification.
- Evidence: `lib/observe.ts:434`, `:441`, `:503`, `:537`, `:590`.
- Trigger: a provider call finishes, then curation apply or an improver mutation throws.
  The stage timestamp remains only in memory and final state persistence is skipped.
- Consequence: the watching observer can launch another paid call at the next poll,
  bypassing its configured hours throttle. The scratch curation test reproduced two
  calls in consecutive passes, with no persisted lessonsAt; root independently ran it.
- Recommendation: contain/report phase errors using the existing step mechanism so
  state is persisted; decide whether launch-time timestamp checkpoints also belong in
  this bounded fix. Keep apply errors visible, preserve cancellation and do not start
  a throttle when no provider launch occurs.
- Acceptance: failed curation application preserves lessons/no false success and the
  next in-interval pass does not relaunch; post-provider improver mutation failures
  retain their throttle too; already-stopped cases still launch nothing.
- Decision: contain curation/improver errors through the existing step wrapper and
  persist each launch throttle synchronously before exec. Prepare arguments and check
  cancellation first; a failed checkpoint prevents launch and restores the in-memory
  timestamp. Cover apply errors, later report failure, checkpoint refusal and no-launch
  cancellation. Scope: observer, focused tests and Observer contract documentation.
- Result: fixed locally. Both stages checkpoint their throttle before attempting
  spawn. Checkpoint errors restore missing/previous timestamps and refuse launch.
  Apply errors are reported through observer-error and do not end the pass; partial
  queued-feature IDs survive an ordinary later human-task application failure.
- Changed: lib/observe.ts, new test/observer-throttle.test.ts, test/curation.test.ts,
  README.md, SPEC.md and review tracking documents. No commit/deployment/live restart.
- Regression evidence: initial 10 cases produced 6 failures and 4 passes before the
  implementation. All 13 final new cases pass, including expired-timestamp rollback
  and independent improver continuation after a curation failure. Real filesystem
  EISDIR faults and blocked fake providers exercise the actual stage callers.
- Acceptance mapping:
  - archive application error: unchanged lessons, no false success, visible error,
    report written and no repeated call in the next poll;
  - improver human mutation error: created feature and its bookkeeping retained,
    no agent notes/success claim, timestamp retained and next poll launches nothing;
  - pre-completion on-disk checkpoint: asserted while each provider is still blocked;
  - missing/expired checkpoint failure: zero calls, old value restored, later healthy
    pass eligible; pre-launch stopping consumes neither a call nor timestamp;
  - snapshot checkout timeout consumes no timestamp; apply timeout retains one;
    report failure and existing cancellation/group-cleanup tests retain protection.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/observer-throttle.test.ts test/curation.test.ts test/cancellation.test.ts test/observe.test.ts test/promptreview.test.ts test/supervisor.test.ts`
    — 110 passed, 0 failed across six named files (68.94s).
  - `bun run typecheck` and `git diff --check` passed.
  - Read-only Sol high final-code verification found no actionable R13 defect.
    Claude reviewed design and final code through Herdr, identified the rollback
    pitfall/acceptance gaps, and approved the bounded fix after 52 tests passed in
    observer-throttle, curation and cancellation (overlapping the root validation).
- Limits: conservative attempted-spawn accounting includes failed spawns and a
  crash between checkpoint and spawn. No fsync/power-loss or network-filesystem
  guarantee, live-provider validation, or atomic transaction across proposal/state
  files; abrupt failure can still lose partial-proposal provenance. These tests do
  not add or change prompt-review throttle behavior.
- Details: [second review](second-review-2026-10-02.md). Verified locally.

## R14 — defer parked passing lessons

- Origin: Claude D2; root verified callers and scratch evidence, Sol high corroborated.
- Evidence: `lib/foreman.ts:646`, `:737`, `:755`, `:761`.
- Trigger: aggregate validation is enabled, unrelated tracked edits park a passing
  automatic merge, and the clean lessons file still commits that evaluator's lesson.
- Consequence: base moves because of the parked feature's own lesson. After cleanup,
  it pays for another gate/evaluation; a later failed revalidation can leave a lesson
  from the superseded pass already promoted. Reproduced: two evaluations, one builder.
  The aggregate guard remains effective; this is a missed R01 cost/timing acceptance.
- Recommendation: defer parked automatic lessons until actual merge, with durable
  association to the accepted evaluation. Preserve deliberate manual-ready behavior
  and avoid duplicate/lost/stale lessons. Do not bypass gates on lessons-only diffs.
- Acceptance: parking cannot move base through its own passing lesson; unparked merge
  writes the accepted lesson once; failed/superseded evaluation does not promote it.
- Decision: persist evaluated SHA plus SHA-associated pending lesson before an
  automatic merge. Shared merge/recovery delivery requires recorded merged status,
  matching SHA and ancestry on base, all under checkout serialization; clear only
  after successful append/dedup. Clear superseded lessons on launch, revalidation,
  refresh/failure, branch movement and hook failure. Preserve manual/negative behavior.
  Test parked restarts, stale/replaced/null lessons, failed gates/evaluations/hooks,
  merge refusal/reparking, already-landed recovery and ordinary delivery retries.
  Scope: foreman, Feature contract, fake-provider Git regressions and README/SPEC.
- Result: fixed locally. Automatic passing SHA/pending advice is stored before merge
  and never appended for ready/parked features. Merge, parked retry and subsequent
  merged-state reconciliation use one delivery helper with matching SHA/base ancestry
  checks. Already-landed parked commits recover without another provider. Ordinary
  delivery errors retain merged status and advice for a later pass; counted failures
  clear accepted SHA so their next attempt rebuilds. Manual/negative lessons stay immediate.
- Changed: lib/foreman.ts, lib/types.ts, test/guards.test.ts, README.md, SPEC.md and
  review tracking documents. No commit, deployment or live-factory restart.
- Regression evidence: the first 13 cases failed 11/passed 2 before implementation.
  Twenty final R14 cases pass. A read-only Sol candidate exposed the saved-SHA retry
  risk; root rejected its index.lock fixture after Git actually produced MERGE_HEAD
  and an unspent conflict. The corrected merge.ff=only/base-advance regression fails
  in an isolated source copy with only counted-failure SHA clearing removed, then
  passes on final code with two builder calls. A final deterministic evaluator barrier
  replaces the original timing assumption. An initial test harness used the wrong
  agentStats shape; it was corrected to the actual era-array contract.
- Acceptance mapping (actual CLI, temporary Git repos and fake providers):
  - unchanged parked base/tracked lessons, retained receipt, repeated dirty passes,
    clean restart with one builder/evaluator, merge-before-lesson order and no duplicate;
  - stale aggregate evaluation replacing advice, including null lesson, failed gate
    or evaluator, and valid fresh negative advice without the old passing lesson;
  - moved branch rebuild and failed merge hook discard old pending advice;
  - merge-never-started receipt survives actual observer reparking and later merge;
  - already-landed ready/evaluating/merged states deliver with no provider;
  - real postMerge SIGKILL retains accepted SHA/receipt; startup recovers/delivers;
  - mismatched/non-ancestor receipts refuse and remain available for inspection;
  - append-before-clear retry deduplicates, and an EISDIR lessons write failure keeps
    code merged, later delivers once, and preserves ordinary observer stage counts;
  - manual-ready/valid negative lessons remain immediate; counted refresh failure
    clears saved acceptance and the next attempt runs its builder.
- Validation (2026-10-02):
  - `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/guards.test.ts test/foreman.test.ts test/merge-process.test.ts test/observe.test.ts test/curation.test.ts test/control.test.ts`
    — 191 passed, 0 failed across six named files (145.43s).
  - After the final fixture barrier and refusal/dedup assertions,
    `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false bun test test/guards.test.ts -t 'R14:'`
    — 20 passed, 0 failed (overlapping the six-file validation; 6.70s).
  - `bun run typecheck` and `git diff --check` passed.
  - Read-only Sol high checked lifecycle, counted-failure correction and docs;
    read-only Claude reviewed design/final code through Herdr and independently
    reran 20 overlapping R14 cases successfully. No remaining actionable R14 defect.
- Limits: Git merge, lesson append and receipt clear are separate operations, not
  transactional exactly-once delivery. Ordinary retries deduplicate normalized text;
  crash plus intervening curation can remove that proof and allow repetition. No
  fsync/power-loss/network-filesystem guarantee or live-provider validation. Legacy
  ready records without a receipt cannot recover advice from the new field. Delivery
  reconciliation runs in auto mode; config switches can retain advice until a later
  auto pass/launch. Hand-merged parked branches subsequently moved/deleted still use
  the existing rebuild path, and persistent write failures can repeat lesson-error
  events on subsequent ticks. PostMerge is not replayed for an already-landed recovery;
  recovery event statistics retain their existing historical limitations.
- Details: [second review](second-review-2026-10-02.md). Verified locally.

## R15 — preserve malformed negative-verdict diagnostic context

- Origin: Claude D3; root directly confirmed parser/feedback behavior.
- Category: diagnostic improvement; the strict fail-closed verdict rule is correct.
- Evidence: `lib/foreman.ts:34`, `:47`, `:57`, `:73`, `:634`.
- Trigger: an evaluator reports a defect but another field is malformed, for example
  empty findings with a blocking string, or notes supplied as a string.
- Consequence: the builder receives only the schema error, missing useful defect
  context and potentially wasting a limited attempt. Original artifacts remain saved.
- Recommendation: bounded, clearly labeled raw-output diagnostic context on parser
  rejection; do not relax validation, trust partial fields as valid findings, or emit
  a lesson from an invalid verdict.
- Acceptance: useful bounded context reaches feedback while malformed verdicts always
  fail and produce no lesson; valid verdict behavior remains unchanged.
- Decision: on JSON/root/schema rejection only, keep an optional diagnostic excerpt
  of the original evaluator text, at most 2,000 characters with both ends and an explicit
  truncation marker. Keep the schema error first and label raw context as unvalidated,
  diagnostic-only output. Valid verdicts and contradictions keep their existing behavior;
  rejected fields remain empty and lesson null. Full artifacts are unchanged.
  Observer schema-error classification and test extraction must ignore raw claims so
  quoted infrastructure/conflict/test text cannot trigger retries or trusted diagnoses.
  The excerpt stays below prompt review's 4,000-character outcome tail limit.
- Acceptance evidence:
  - Parser regressions retain actual defect context from malformed negative/positive
    verdicts and JSON/root rejection (including prose/fences), while pass stays false,
    every validated list stays empty and lesson stays null. Empty output invents no
    context; exact/over-limit cases verify the 2,000-character cap, both ends and marker.
    Passing, valid negative and contradictory verdicts retain their prior fields/feedback.
  - Actual fake-provider retry flows for both malformed negative and positive verdicts
    pass the labeled defect into the second builder prompt; the counted failure remains
    recorded even when a later valid verdict merges. No invalid lesson is written/logged.
  - Plain-text/JSON quoted infrastructure, refresh-limit and failure-file claims cannot
    establish observer control evidence. An actual observer pass leaves the schema-stuck
    feature stuck at its existing failure count. Genuine test-gate/provider-process
    infrastructure failures keep their existing classification. Prompt review attributes
    malformed output to the evaluator and retains its schema header plus excerpt under
    the existing 4,000-character outcome limit.
  - Served API history rejects malformed structured output, retains the complete original
    text and emits the bounded error context. Actual served JS/expanded log renders that
    context and original output. The browser VM checks markup/contracts, not layout.
- Validation (test commands prefixed with
  `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false`; test fixtures use local fakes):
  - `bun test test/foreman.test.ts test/guards.test.ts test/observe.test.ts
    test/promptreview.test.ts test/dash-history.test.ts -t 'R15:'` — before the fix:
    2 passed, 10 failed, 170 filtered; afterward: **12 passed**, 0 failed, 170 filtered.
  - `bun test test/foreman.test.ts test/guards.test.ts test/observe.test.ts
    test/promptreview.test.ts test/dash-history.test.ts` — **182 passed**, 0 failed
    across five named files, including the 12 R15 regressions. Counts overlap the focused
    run; they are not added together.
  - `bun run typecheck` and `git diff --check` passed after code changes; final diff
    checks passed after contract/closure updates. No full suite or bare `pnpm test` ran.
- Review: Sol medium separately mapped parser/lesson and dashboard/observer connections;
  root independently confirmed their classifier and reviewer-tail candidates. Sol high
  reviewed final code/callers and found no actionable scoped defect. Claude reviewed the
  approach and final code, approved R15, and requested no further tests. Root retained
  narrow schema-prefix precedence, excluding provider failures; the separate valid-negative
  classifier disagreement below is unchanged. No new runtime module or refactor was needed.
  Sol high also reviewed final contracts/closure records without a material blocker.
- Changed here: `lib/foreman.ts`, `lib/types.ts`, `lib/observe.ts`; `test/foreman.test.ts`,
  `test/guards.test.ts`, `test/observe.test.ts`, `test/promptreview.test.ts`,
  `test/dash-history.test.ts`; README.md, SPEC.md and review records. Existing repairs and
  untracked files remain intact; no commit, deployment or live-factory restart occurred.
- Limits: excerpts omit middle content when over limit and count JavaScript string units
  (a cut can split a Unicode surrogate pair). Diagnostic text remains unvalidated advice,
  not a security boundary. Full output remains in artifacts. Provider-process rejection
  context and existing valid-negative observer policies are not changed. No full suite,
  real providers, browser layout, databases, crash injection or infrastructure was tested.
- Result: **verified** locally. All original/second-review queued repairs are now verified;
  architecture and policy follow-ups remain separately scoped.

## R16 — distinguish uncounted stuck events

- Origin: Claude D4; root confirmed the zero display and actual foreman callers.
- Evidence: `lib/foreman.ts:98`, `:698`; `lib/dash/core.js:32`, `lib/dash/detail.js:43`.
- Trigger: refresh exhaustion or overdue-child recovery sets stuck without increasing
  attempts. The dashboard treats the counted failure total as executed-try identity.
- Consequence: first-try stops show zero/all tries unstarted; an uncounted stop can
  replace an older counted failure in the failure-card association. No recovery or
  agent-launch safety failure was established. This is a missed R10 state.
- Recommendation: explicit counted/uncounted stop and attempt identity consumed by
  the dashboard; preserve old histories with a limited fallback, not invented exact
  associations. Do not charge an attempt merely to repair display.
- Acceptance: uncounted first-try stops display an executed try; later uncounted stops
  cannot overwrite the earlier counted try's actual failure label.
- Decision: add optional stop metadata `{attempt, counted}` on the feature and
  failed/stuck log event. Counted failures use the incremented failure count; refresh
  exhaustion/overdue-child stops use failures + 1 without charging an attempt. Derive
  and log stops within the existing mutation, clear current metadata at launch/reset/
  resume/recovered todo or merge, and preserve it while paused. Keep log()'s existing
  fifth lesson-append proof argument compatible. No new recovery/scheduling semantics.
  Dashboard consumers share stop identity, show an uncounted stopped card/reason rather
  than a counted failure, and avoid treating every stuck state as retry exhaustion.
  Legacy fallback recognizes the two existing uncounted reason formats; insufficient
  historical evidence stays unnumbered rather than borrowing an old evaluator result.
- Additional connected defects confirmed from Claude's final review and Sol/root code
  evidence: `conflictTimeline()` checked an unprefixed refresh-limit reason that the
  foreman never emits; its API test repeated that incorrect fixture. Exhausted conflicts
  remained open or resolved-then-stuck instead of closing at exhaustion. Observer
  send-back also left the timeline's stuck annotation until a later launch. The exact
  refresh-limit reason now closes that row as failed; observer-retry clears the existing
  annotation like human retries. An overdue-child or counted merge stop stays retryable.
- Acceptance evidence:
  - Actual counted failures replace old stop metadata with the post-increment number.
    Refresh exhaustion and overdue recovery publish uncounted stop identity at zero
    and nonzero prior failures, without consuming a failure. The dependency-import
    regression explicitly verifies try 1 can stop before any builder call.
  - Recovery to todo/merged, locked launch, successful human resume/retry and observer
    reset clear current metadata; pause and an alive orphan preserve it. Human resume
    records both reset and preserved-counter cases; retry/observer reset mark true.
  - Served dashboard/API cases verify first-try stops across detail/board/factory,
    preserve a counted evaluator failure before an uncounted later stop, and retain
    stopped reasons instead of borrowing artifact verdicts. Explicit metadata supports
    a truncated 60-event response; incomplete legacy histories stay unassociated.
    Exact legacy reasons do not misclassify counted merge failures. Retry/resume cases
    verify reset boundaries and retained raw history. Browser checks execute served JS
    in a VM with a minimal DOM; this is contract/render-string coverage, not layout.
  - Actual API and direct timeline cases verify correct exhaustion outcomes/timestamps,
    legacy and metadata events, overdue/counting controls, and observer send-back before
    a fresh launch. Foreman lesson-append proof compatibility passes for tracked and
    untracked files with unrelated staging preserved.
- Validation (all test commands used `FACTOS_CLAUDE=/bin/false SHIPYARD_CLAUDE=/bin/false`;
  fixtures override those only with local fake providers/temporary repositories):
  - Before the stop fix: `bun test test/attempt-stop.test.ts test/dash-history.test.ts
    -t 'R16:'` — 0 passed, 10 failed, 7 filtered. Final `bun test
    test/attempt-stop.test.ts test/dash-history.test.ts test/guards.test.ts -t 'R16:'`
    — 18 passed, 0 failed, 91 filtered.
  - `bun test test/attempt-stop.test.ts test/dash-history.test.ts test/actions.test.ts
    test/foreman.test.ts test/guards.test.ts test/observe.test.ts test/state.test.ts`
    — 182 passed, 0 failed across seven files.
  - `bun test test/curation.test.ts -t 'curation preserves actual foreman appends'`
    — 2 passed, 0 failed, 23 filtered.
  - `bun test test/guards.test.ts -t 'dependency import conflicts honor maxRefreshes
    before spending a builder call'` — 1 passed, 0 failed, 86 filtered after its
    stop-identity assertions were strengthened; already counted in the broad 182.
  - Before the timeline correction: `bun test test/dash.test.ts -t 'R16:|state carries
    the merge conflict timeline'` — 0 passed, 3 failed, 22 filtered. Final
    `bun test test/dash.test.ts test/dash-history.test.ts` — 41 passed, 0 failed.
    This adds 25 dashboard cases to the prior 182; total **209 distinct passing
    cases**, including 20 named R16 regressions and the two curation compatibility cases.
  - `bun run typecheck` and `git diff --check` passed after final edits.
- Review: root checked producers, lifecycle actions, reset/event consumers and served
  dashboard callers. Sol high found no concrete stop-identity defect; Claude approved
  that code and passed 27 overlapping cases, then identified the timeline bug above.
  Sol/root independently confirmed both timeline connections before correcting them.
  Claude approved the final timeline correction; Sol high checked final code, callers
  and closure documents with no concrete blocker. See the second-review follow-up.
- Changed here: `lib/types.ts`, `lib/state.ts`, `lib/foreman.ts`, `lib/actions.ts`,
  `lib/observe.ts`, `lib/dash.ts`, `lib/dash/core.js`, `lib/dash/detail.js`,
  `lib/dash/factory.js`; `test/attempt-stop.test.ts`, `test/dash-history.test.ts`,
  `test/guards.test.ts`, `test/dash.test.ts`; README.md, SPEC.md and review records.
  Previous repairs and existing untracked files remain intact; no commit/deploy.
- Limits: state and log remain separate writes; a crash between reset state and its
  event can obscure numbering. No durable cycle/generation IDs were introduced.
  Retained artifacts group by numeric prefix across refreshes/earlier cycles as R10
  documents. Only two exact historical uncounted reasons are inferred; arbitrary
  legacy reasons and missing/reset-truncated history cannot establish exact identities.
  No full suite, real-provider calls, live-factory replay, browser layout, database,
  crash injection or deployment was performed. Failure charging/recovery policy and
  observer diagnosis/prompt classification are unchanged.
- Result: **verified** locally. Next: **R15 — malformed negative verdict context**.


## Follow-up architecture, not queued correctness fixes

- Share subprocess/provider/Git boundaries instead of importing them from the foreman
  coordinator; add a Codex adapter when Codex support is separately scoped.
- Share structured event/pass decoding where consumers currently infer log text.
- Consider transactional owned work and explicit recovery outcomes, informed by
  [OpenRig architecture](https://openrig.dev/docs/architecture),
  [coordination](https://openrig.dev/docs/coordination) and
  [continuity](https://openrig.dev/docs/continuity). Documentation comparison only;
  OpenRig was not independently audited.
- Ecommerce F99 features in `merge-process.features.json` are proposals for that other
  application, not already implemented factory capabilities.

## Unresolved concerns and review limits

- Existing valid-verdict classification disagreement (Claude candidate; independently
  confirmed by root/Sol code evidence in `lib/observe.ts` `classify()` and the `passesOf()`
  callback): valid `FAILED ... ECONNREFUSED` feedback can diagnose as infra and grant the
  configured bounded observer retry, while prompt attribution treats it as own/evaluator
  rejection. Blocking-only feedback without an infra pattern diagnoses unknown because
  the classifier omits `BLOCKING:`, while prompt attribution recognizes it. Neither path
  accepts or merges a rejected verdict. R15 preserves this prior policy; investigate a
  consistent distinction between code rejection and genuine provider-process failures
  before changing valid-verdict retry semantics. No separate correction was implemented.
- Crash windows between observer queue mutations and bookkeeping may duplicate proposal
  steps or lose improvement provenance/cap accounting; investigate before claiming bugs.
- Intake/ship artifacts hardcode `.fact-os`; inspect legacy `.shipyard` expectations.
- Replay tooling has ecommerce-specific/main-branch assumptions; generic applicability
  was not established.
- No real-provider compatibility/permission tests, full browser rendering, live-factory
  replay or crash injection were performed in the baseline review.
