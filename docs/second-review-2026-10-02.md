# Second review — Claude factory

Oscar requested a second opinion from the existing Claude agent in Herdr's
`claude-factory` tab (`w2:t5H`, pane `w2:p6F`). Codex sent the R01–R10 repair
history, rationale, instructions, validation and known limits. Claude reviewed
read-only with its current Opus model/high effort and two read-only reviewers.
No repository application code was changed during this exchange.

The repairs mostly hold. Claude found three additional correctness/reporting
defects and one diagnostic improvement. Codex checked the actual code/callers,
independently reproduced the curation throttle loss and dashboard zero attempt,
and verified the malformed-feedback behavior. A read-only Sol high reviewer also
corroborated the throttle and parked-lesson findings and rejected a lessons-only
validation exemption. These findings do not negate the
main locking, merge-validation, parsing or cancellation protections.

## Confirmed follow-ups

### R13 — persist paid observer-stage throttles (Medium)

- Evidence: `lib/observe.ts:434`, `:441`, `:503`, `:537`, `:590`.
- Trigger: curation returns a valid answer, then applying it throws (for example,
  the archive path is a directory). `lessonsAt` was changed only in memory; the
  final observer-state write is never reached. A later improver mutation failure
  can similarly lose `improveAt`.
- Consequence: a watching observer can pay for the same agent stage every poll,
  bypassing the configured interval. The curation reproduction made two calls
  in two consecutive passes with the four-hour throttle configured.
- Recommendation: persist the launched-stage timestamp before applying its
  result; preserve propagation/reporting of filesystem errors. Checkpointing
  before provider launch also protects abrupt failure during the call, provided
  failure to checkpoint prevents the paid call. Do not mark unstarted stages as
  attempted or weaken cancellation checks.
- Acceptance: an apply failure leaves lessons unchanged and emits no false
  success, but the next pass within the interval does not relaunch. Cover the
  corresponding improver mutation failure and zero-call cancellation behavior.

### R14 — defer parked passing lessons (Low–Medium)

- Evidence: `lib/foreman.ts:646`, `:737`, `:755`, `:761`.
- Trigger: `refreshBeforeTest: true`, unrelated tracked checkout edits park a
  passing feature, and its clean tracked lessons file can still be committed.
  The passing lesson is written because `ready` includes parked auto merges.
- Consequence: its own lesson moves base, causing another test/evaluation when
  parking ends. Claude reproduced two evaluations and one builder call. A lesson
  may also be promoted from an evaluation whose later revalidation is rejected.
- Recommendation: defer the parked lesson until the evaluated feature actually
  merges, retaining it durably through parking/revalidation. Keep the intentional
  manual-mode lesson contract separate and avoid duplicate/lost lessons.
- Acceptance: parking alone cannot self-invalidate the feature through a lesson;
  successful unparked merge writes its lesson once; failed/stale revalidation does
  not promote a superseded passing lesson. This closes an R01 acceptance gap.
- Do not bypass aggregate validation merely because changed paths look like
  lessons: `lessonsFile` is configurable and can affect actual behavior.

### R16 — distinguish uncounted stuck events (Low)

- Evidence: `lib/foreman.ts:98`, `:698`; `lib/dash/core.js:32`;
  `lib/dash/detail.js:43`.
- Trigger: refresh exhaustion or an overdue recovered child sets `stuck` without
  incrementing the failed-attempt counter.
- Consequence: the first executed try can display as zero/all tries unstarted;
  slicing the last N stuck/failed events can replace an earlier counted failure
  with an uncounted stop reason. This is a missed R10 state, not an agent-launch
  or recovery safety defect.
- Recommendation: preserve counted-failure versus uncounted-stop identity in
  events/state and consume it consistently. Do not spend an attempt merely to
  repair the display. Keep old histories readable with an explicit limited
  fallback rather than fabricating exact identities.
- Acceptance: zero-failure refresh/recovery stops display an executed try, and
  an uncounted stop cannot overwrite the previous try's actual failure label.

## Diagnostic improvement

### R15 — preserve context from malformed negative verdicts (Low–Medium)

- Evidence: `lib/foreman.ts:34`, `:47`, `:57`, `:73`, `:634`.
- Trigger: an evaluator reports a real defect but another field is malformed,
  such as empty findings with a blocking message or a string-valued notes list.
- Observed behavior: strict parsing correctly rejects the entire verdict, but
  builder feedback includes only the schema error, omitting the reported defect.
  Original text is retained in run artifacts/dashboard, so it is not destroyed.
- Consequence: the next builder can lack useful diagnostic context and waste an
  attempt. This is not an unsafe passing verdict; R04's fail-closed rule is sound.
- Recommendation: retain a bounded, clearly identified original-output excerpt
  as diagnostic feedback while still rejecting the whole malformed verdict.
  Avoid treating partial fields as validated findings or allowing a pass/lesson.
- Acceptance: malformed output remains rejected, with useful bounded context in
  feedback and no lesson emission; valid verdict behavior remains unchanged.

## Recommendations and unresolved candidates

- Fix R13/R14 first, then continue R11/R12; leave R15/R16 separately scoped.
- Keep one application writer, fake providers and failing regressions. Record
  which regression or code evidence supports each material acceptance claim,
  and explicitly list gaps. Include failures after side effects and parked states.
- Aggregate validation remains opt-in, as recorded since R01. Enabling it in a
  live ecommerce configuration is a separate operational change, not performed.
- Further revalidation-cost limits may help under a rapidly advancing base, but
  must preserve aggregate checks and distinguish a safe yield from a failed
  feature. No cap or lessons-only exemption was approved or implemented.
- Launch rechecks status under lock but readiness/claims were computed earlier
  (`lib/foreman.ts:837`, `:857`, `:871`). Mid-tick dependency/touches edits need
  focused investigation; do not silently expand R11's directory fix into this.
- R12 should cover repeated evaluation during clean revalidation as well as
  resolver continuation; both share the prompt-rate counting-unit problem.
- Claude also suggested skipped-build statistics and external lessons-file
  compatibility concerns. These were not independently reproduced; keep them
  unresolved until focused investigation establishes the intended contract.

## Validation and coverage

Claude reported 171 passing tests in guards/state/supervisor/config/curation/
cancellation/dash-history/foreman, plus 83 passes in curation/observe/promptreview/
cancellation from its reviewer. These groups overlap; do not add the counts.
It also reproduced the parked lesson and curation throttle cases in scratch repos.

Codex independently ran the curation scratch reproduction (one test passed by
asserting the current defect: two calls, no persisted timestamp), invoked the
actual dashboard core helper in a VM (uncounted stuck -> zero), and called the
actual verdict parser/feedback formatter (only schema error returned). No broad
suite was repeated. Code/callers corroborate the parked-lesson consequence.

Scratch evidence lives under
`/tmp/claude-1000/-home-oscar-Projects-fact-os/f897cd67-a93e-4fbf-88d9-9583dc68c249/scratchpad/`;
the durable trigger/acceptance descriptions above remain if temporary files vanish.

Claude checked locks, dependency imports, curation proofs, cancellation and
dashboard/API connections. Limits: no new crash injection, network filesystems,
real providers, browser layout/devices, full `you.js`, or independent documentation/
skill-wording audit. No live factories, accounts, databases, installs, commits,
deployments or publication. Finding verification is not a claim these follow-ups
are fixed.


## R13 implementation follow-up

After Oscar authorized fixes, root implemented R13 as the sole application writer;
Claude reviewed the approach and final code through the existing Herdr tab; Sol high
also checked final code read-only. Claude approved the bounded fix after rerunning
52 tests in three affected files (overlapping the root validation). Curation/improver stages now persist a conservative throttle
checkpoint before attempting spawn, restore the previous timestamp and refuse launch
if checkpointing fails, and contain/report application errors. Claude's rollback
warning and additional acceptance suggestions were incorporated. The focused six-file
validation passed 110 tests; strict typechecking and diff checks passed. See the
[backlog](review-backlog.md#r13--persist-paid-observer-stage-throttles) for acceptance
coverage and limits. At that handoff R14–R16 remained open; no commits or live restart occurred.


## R14 implementation follow-up

Root implemented SHA-associated pending automatic lessons, shared post-merge delivery
and startup reconciliation. Parking appends nothing; superseding validation discards
old advice, and counted failures clear saved acceptance so retries rebuild. Ordinary
write errors retain merged code and pending delivery. Claude and Sol reviewed the
implementation read-only; Claude approved final code and reran 20 overlapping cases.
Root independently corrected an invalid reviewer-proposed failure fixture using actual
Git evidence, verified the counted-failure correction, and made the final fixture
synchronize evaluator completion deterministically. Six affected suites passed 191
tests, then all 20 R14 cases passed after the final fixture refinements; typechecking
and diff checks passed. The [backlog](review-backlog.md#r14--defer-parked-passing-lessons)
records acceptance evidence, crash/curation and legacy limits. R11 is next; R12/R15/R16
remain open. No commit, deployment or live-factory restart occurred.


## R11 implementation follow-up

Root repaired directory claims by testing hotness at the narrower shared path, with
listed/scored descendant visibility for directories and precise builder hints.
Cold siblings still launch concurrently; zero-threshold and default-off behavior
remain intact. Claude's approach review identified zero-threshold and hint pitfalls;
root incorporated them and added deterministic CLI/temp-Git regressions before
changing the application. All nine initial helper cases failed before the fix, and
five of six initial integration cases failed. Final validation passed 167 tests in
five named files, including 16 R11 cases; strict typechecking and diff checks passed.
Claude approved final code and passed 39 overlapping tests in the two merge suites;
Sol high independently verified helpers/callers/tests read-only and found no concrete
defect. The [backlog](review-backlog.md#r11--directory-claims) records contracts,
acceptance evidence and remaining launch-snapshot/path limitations. Replay's own
concrete-path simulation was inspected but is not directory-claims validation.
R12 is next, then R16/R15. No commit, deployment or live-factory restart occurred.


## R12 implementation follow-up

Root standardized prompt-rate counts on launch-defined passes: one successful outcome
per role's final model/notes prompt, or one failure for the responsible role's final
prompt. Bucket chronology uses the earliest contributing final prompt. Observer cache
metadata identifies this unit; old rates/trends remain pending until regenerated,
while reviews/notes/cost stay visible. Report/API and served UI share these counts and
explain attribution. Eight initial regressions produced one pass/seven failures before
the fix and all passed afterward; five named suites passed 89 tests. A later focused
policy case passed too, totaling 90 distinct checked tests. Typechecking/diff checks
passed. Claude reviewed final code read-only and passed 23 overlapping tests; Sol high
verified code/callers/docs without a concrete defect.

Claude's proposed parked-success expansion was independently checked by root and Sol:
merge-skipped also includes tampering, merge-failed is an infrastructure refusal, and
next-result wording assumes ordinary evaluation/conflict endings. Existing exclusions
remain in this counting-unit fix; the policy difference and upgrade/coverage limits are
recorded in the [backlog](review-backlog.md#r12--prompt-rate-units). R16 is next, then
R15. No commit, deployment or live-factory restart occurred.

## R16 implementation follow-up

Root added counted/uncounted stop identity to feature state and failed/stuck events,
without charging refresh-limit or overdue-child stops as failures. Launch/reset and
recovery transitions clear current identity; pause/alive recovery preserve it. Human
resume records whether numbering resets, and retry/observer reset mark the boundary.
Shared dashboard attempt calculation and detail association keep uncounted stops
separate from prior counted failures; truncated explicit history remains useful while
ambiguous legacy records stay unassociated. Lesson-append proofs remain compatible.

Ten initial regressions failed before the fix. Eighteen focused R16 cases and 182
cases across seven named suites passed afterward. Claude approved the stop-identity
code and passed 27 overlapping cases, then found the conflict timeline's refresh-limit
recognition still used a message the foreman never emitted. Root and Sol independently
confirmed this plus an omitted observer-retry annotation reset. A corrected API fixture
and two new regressions failed before the focused timeline corrections; 41 dashboard
and history tests passed afterward. Two actual foreman/curation compatibility cases
passed, and the preprovider dependency-import test passed with stronger stop assertions.
Together these checks cover 209 distinct cases, including 20 named R16 regressions.
Strict typechecking and diff checks passed. Claude approved the final timeline
correction; Sol high reviewed final code and records with no concrete blocker.
Exact commands, acceptance evidence and limits are in the
[backlog](review-backlog.md#r16--distinguish-uncounted-stuck-events).

State/log writes remain separate and no durable generation IDs were added; retained
artifacts still group numeric prefixes across older cycles. Browser VM coverage does
not establish layout or live-provider behavior. R16 is verified locally; R15 remains
open and is next. No commit, deployment or live-factory restart occurred.

## R15 implementation follow-up — 2026-10-03

Root preserved labeled, unvalidated original-output context on JSON/root/schema rejection
only, capped at 2,000 JavaScript string characters with head/tail and truncation marker.
Malformed verdicts still fail with empty validated fields and no lesson; valid verdicts,
contradictions and provider-process failure feedback keep their previous behavior.
The observer treats the parser-owned schema header as authoritative before scanning
infrastructure/conflicts or failing-test names. This prevents the new raw context from
triggering an automatic retry. The smaller excerpt retains its header under prompt
review's existing outcome limit; dashboard history still retains full original output.

The focused 12-case run produced 2 passes/10 failures before the fix and 12 passes after.
Five named suites passed 182 cases, including those regressions. Typechecking and diff
checks passed. Sol medium mapped distinct producer/consumer connections; root verified
the significant candidates. Sol high found no scoped final-code defect. Claude approved
the approach and final code read-only, including provider-failure exclusion from the
schema guard. Sol high reviewed final contracts/closure records without a material blocker.
Exact commands, acceptance evidence and limits are in the
[backlog](review-backlog.md#r15--preserve-malformed-negative-verdict-diagnostic-context).

Claude also identified the preexisting disagreement between observer diagnosis and
prompt attribution for valid negative verdicts quoting infrastructure errors or using
only blocking feedback. Root/Sol confirmed the code paths; it grants at most configured
extra retries and does not allow a rejected verdict to merge. It remains a separately
recorded classification-policy concern; R15 does not change valid-verdict retry semantics.
Excerpt truncation can omit middle context or split a Unicode surrogate pair; full
artifacts remain available. No real-provider, browser layout, database or crash tests ran.

R15 is verified locally, completing all 16 queued review repairs. Changes remain
uncommitted; architecture/policy work is separately scoped. No deployment or live-factory
restart occurred.
