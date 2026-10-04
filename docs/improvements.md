# Factory improvements

Measured blind spots and the changes scoped to fix them, one at a time, under the same rules as
[fixing-process.md](fixing-process.md): one active item, one writer, a failing regression before each
fix, fake providers and temporary repositories, named affected tests plus `bun run typecheck`.
The R01–R16 correctness repairs are recorded in [review-backlog.md](review-backlog.md).

## Status

| ID | Status | Item |
|---|---|---|
| — | done (522aa4c) | Prompt notes cut mid-sentence at 400 characters; both ecommerce notes restored |
| — | queued in ecommerce | `F99-43-gate-direct-builder-check`: a fast `pnpm gate --direct` builders run after each step |
| I01 | done | B: report edits to existing tests. C: one inline fix after a gate failure, then a diagnosis |
| I02 | done | Codex for the read-only roles (evaluator, diagnoser), Claude fallback and cooldown |
| I03 | done | Feature tiers set at intake, mapped to role models by the active profile |
| I04 | done | Resume the builder once to commit work it left uncommitted (`commitFixes`) |
| I05 | done | Setup failures spend no attempts: delayed retries, then a sticky launch hold until setup-resume |
| I06 | done | The evaluator sees the on-mock tasks the builder was allowed to mock |
| I07 | v2 shadow done | Jev classifier: 32 narrow questions → review requirements, workload, attention, planning; Sol escalation for unsure cases; shadow only |
| I08 | done | Five stuck features: keep-lines declarations, uncounted environment stops, inherited mock allowance, planning holds, review repair, unpriced Codex cost |
| — | later | Codex as a builder option; a "product intent" review flag |

## Evidence (ecommerce factory, 2026-10-03, read-only)

- The observer's 356 diagnosed failures: setup 118, the feature's own code/tests 112, unknown 43,
  untouched tests 38, conflict loops 20, builder 17, infrastructure 8.
- 184 builder sessions linked from `runs/*-build.json` `session_id` to their Claude transcripts and to the
  next gate outcome: 94% ran tests and 82% tested after their last edit, yet 37% of passes failed the
  gate, at the same rate whether or not the builder tested (62% vs 64% pass). Builders ran their own
  narrower commands (967 `pnpm test`, 1071 typechecks) and read the gate script (104 `cat`, 40 `sed`)
  but executed it about 3 times.
- The gate took a median 29–31 min (46 runs) because its affected-only selection walks every dependent
  package (median 284 of ~323 steps). F99-20/21/22 have since merged and F99-23 is in flight, so these
  times are an upper bound.
- Consequence: a gate failure is found ~30 min after the builder stopped, costs an attempt, and the next
  attempt starts a fresh builder that must re-read the code and the feedback. With `maxAttempts: 2`, a
  feature that fails the gate once gets a single evaluator look with no retry (F07-12 on 2026-10-03).

## I01 — inline gate fix, diagnosis, and test-edit evidence

**Trigger.** The gate fails after a build.
**Today.** `fail()` ends the pass: attempt++, the gate's output tail becomes `lastFeedback`, and the next
pass launches a fresh builder.

### C — one inline fix, then a diagnosis

1. Keep the builder's `session_id` (`parseClaudeOutput` already sees it in the result JSON).
2. On a gate failure in a pass whose builder ran (not a skipped build), and while the pass has inline
   fixes left (`config.gateFixes`, default 1; 0 = today's behaviour), resume that session in the same
   worktree: `claude -p --resume <session_id>` with the same role settings, giving the gate's failure
   tail and the rules (fix the code; change an existing test only if the test itself is wrong, and say
   why in the commit message; commit). It runs under a new run tag (`runTag`), so it is recorded as one
   more builder prompt of the same pass: R10's dashboard and R12's prompt rates already handle that.
   Then the existing commit checks, B, and the gate run again. No attempt is spent.
3. If the gate fails again and `config.diagnoser` is set (`{model, effort}`, default null; Oscar's choice
   is Opus high), a read-only run (`permissionMode: plan`, edits denied) gets the failure, the branch
   diff and B's report, and answers `{fault: "code" | "test" | "environment", evidence, fix}`.
   - `environment`: the pass ends as today but the feedback says so (the observer's infra/setup retry
     rules then apply).
   - `code` or `test`: the builder session is resumed once more with the diagnosis as its brief; a
     `test` diagnosis names the exact test and expected behaviour it may change, and nothing else.
   - A gate failure after that is an ordinary counted failure, with the diagnosis appended to the feedback.
4. Bounds: at most `gateFixes` resumed fixes plus one diagnosis-driven fix per pass, counted per pass
   (not per revalidation-loop iteration). Every run checks `stopped()` first, tracks its child like other
   runs, and adds its cost to `spent`.

### B — evidence of edits to existing tests

After every builder or fix run, compare the branch with the merge base (and, for a fix, with the commit
before the fix) for test files (`TEST_FILE`) that already exist on base. Report removed or rewritten
assertion lines, deleted `it`/`test` blocks, and added `.skip`, `.only`, `.todo` or `.fails`.
Log the report as a `test-edits` event, pass it to the evaluator prompt with the instruction to justify
each edit or reject the feature, and give it to the diagnosis run. B never blocks by itself: legitimate
refactors edit tests, and the evaluator judges with the evidence in hand. New test files are not
reported.

### Consumers to check (lesson 1 from R16: fixtures use the producer's real output)

New events `gate-fix`, `diagnosis` and `test-edits` sit inside a pass and must not end it in
`passesOf`, `builtWhenStopped`, `agentStats` (a resumed fix is not a new launch or a new build), the
dashboard's attempt cards and history, and `conflictTimeline`. The fix run's prompt fingerprint is a
builder fingerprint; R12 credits the final builder prompt of the pass, which is the fix.

### Acceptance

- With `gateFixes: 0` and no `diagnoser`, behaviour, events and attempts are exactly today's
  (existing guard tests unchanged).
- A first gate failure resumes the same session (the fake provider records `--resume <id>`); a fix that
  passes reaches the evaluator in the same pass, attempts unchanged, one `launch`.
- A second failure runs the diagnosis read-only (fake records plan mode; a diagnosis run that edits files
  is refused, like R05's checkout checks); its brief reaches the second resumed fix; a third failure is
  one counted failure whose feedback includes the diagnosis.
- `environment` ends the pass without a further fix.
- A fix that adds `.skip` to an existing test, or deletes an assertion, appears in the `test-edits`
  event and in the evaluator prompt; a brand-new test file does not.
- Stop during a fix or a diagnosis leaves the feature `todo` with no further run; the build reuse rules
  still hold after a resumed fix.
- Dashboard, observer statistics and prompt rates count one pass and one launch, and attribute the
  final builder prompt.
- `bun run typecheck` and the named affected test files pass; README and SPEC describe both settings.

### Defaults taken (change before implementation if needed)

- Implemented with `gateFixes: 0` and `diagnoser: null` as the defaults, so existing projects keep today's
  behaviour until their config turns it on; the ecommerce config is to set `gateFixes: 1` and
  `diagnoser: {model: "opus", effort: "high"}`. Codex can become the diagnoser once a provider exists.
- Worst case per pass becomes three gate runs. F99-43's direct check is meant to make the first
  failure rarer; measure the gate-failure rate before and after both land.

## I02 — Codex for the read-only roles

Oscar's model guidance (2026-10-03): routine review on Sol 6.1 High, deep or adversarial review on Sol 6.1 XHigh,
investigation-heavy debugging on Sol 6.1 High, Opus High as the fallback when Codex is out of credits.

- `provider: "codex"` on the evaluator (role config, a profile entry or a tier entry) or the diagnoser. Builders and
  resolvers stay on Claude: they write code, need the factory's edit restrictions, the activity hook and session resume.
- `codex exec -m <model> -c model_reasoning_effort="<effort>" -s workspace-write` with network (reviews run the database
  suites), no approval prompts, JSONL events (`thread.started`, `turn.completed` usage, `turn.failed`) and `-o` for the
  answer. `item.completed` items of type `error` are warnings and never a failure. The run file keeps the Claude result
  shape (`result`, `session_id`, `provider`, `model`, `usage`), so the dashboard, statistics and prompt review read it as is.
- After every Codex run the worktree is reset to its commit (`codex-cleaned` when something was left).
- A run that cannot answer falls back to `codex.fallback` for that call (`codex-fallback`); limit, quota, credit and login
  errors also cool Codex down (`.fact-os/codex.json`). A malformed verdict is an ordinary evaluator failure (R04, R15),
  not a fallback. Codex costs are not in the USD totals: the CLI reports tokens only.

## I03 — feature tiers

Intake sets `tier`; the active profile maps it to role overrides. Ecommerce's `opus-sonnet` profile, from the same
guidance: normal = Sonnet medium builder and Sol high review; multi = Sonnet high; hard = Opus medium; risky = Opus high
builder and Sol xhigh review; investigate = Opus high (Sol as a builder comes with Codex builders). The keyword heuristic
flagged 16 of 37 open ecommerce features as risky, too broad for a model upgrade, so it stays only for untiered features.

## I04 — commit the work instead of spending an attempt

F99-43 built for 55 minutes and ended with uncommitted changes; "commit your work" counted as a failed attempt (13 in the
ecommerce log, 3 since Oct 1). Agreed with the Codex design partner (Sol 6.1 xhigh, 2026-10-03): a separate `commitFixes`
allowance per pass (default 0, ecommerce 1) so committing never uses up a genuine gate fix; resume only for dirty files or
an unfinished foreman merge, never for "no commits" or lost dependency ancestry; the same check after the initial build and
after every resumed fix; a `commit-fix` event that keeps the pass open, ends build reuse, stays in the build stage for
observer statistics and restarts the dashboard's building timer.

## I06 — the evaluator knows what the build was allowed to mock

F17-10 launched on mock (open mockable task H-C44, a supplier partner API). The builder was told to build against an
isolated mock; the evaluator was not told and blocked it under "a path that only works with a fake". Agreed with the
Codex partner: capture the open mockable tasks by value at the locked launch (not the stale `onMock` flag; a blocker that
turned non-mockable defers the launch) and keep them for the pass; render them by id, title and steps for both builder
and evaluator; give both fake/development rules a narrow exception for exactly those external capabilities; the real
internal routes, jobs, transitions and consumers must still reach the boundary, production must fail explicitly, and
what the real integration needs goes into the verdict's notes. Re-validating a merged on-mock feature when its task closes
is a separate follow-up (a task can close by confirming that no API exists). F17-10's own `in_production` cancellation
defect stays a real blocking finding.

## I05 — setup failures spend no attempts

The largest failure bucket: 44 identical "dev Postgres is not accepting connections" failures within seconds on
2026-10-03, each spending an attempt; 59 "dev:setup failed" on 2026-09-30. Agreed with the Codex partner: only a failed
`prepare` counts as setup (worktree, dependency, commit, keep-lines, provider and gate failures keep their rules); it
spends no attempt, retries after `setupRetryDelaysSec`, then stops as an uncounted stop; three failures in a row across
at least two features open a sticky launch hold, persisted across restarts and separate from a person's pause, released
explicitly once the environment is fixed. The foreman is the only owner of these retries; the observer's retry policy is
unchanged (it never retries setup). Known limit: a deferred prepare that fails after a build loses that build.

## I07 — feature classification with TypeSafe Jev (v2: shadow)

Goal (Oscar, 2026-10-04): a good automatic classification of each feature (how much review it needs, what kind of work it
is, whether it should be split) using Jev, a fast typed-judgment model; throw it away if it is not good. Reusable lessons:
[docs/jev-lessons.md](jev-lessons.md).

**v1 failed.** One six-way "which tier?" Choice with thin context labelled 165 of 226 ecommerce features risky (73%), never
answered hard or investigate, and scored F15-09 (the feature that obviously needed a split) 0.59 for needs-split, beside a
0.55 median. It added nothing over simple code-measured features. Oscar rejected it as a shallow use of the tool.

**v2 (designed with the Codex Sol partner, three rounds).** 32 narrow mechanism Nouls in five families: stakes (s01-s15:
authoritative amounts, financial commitments, financial admission, stock authority, authorization, tenant binding,
sensitive data, destructive data, migration of existing rows, concurrent writers, replay, trusted external facts, provider
protocol, release evidence, untrusted execution), uncertainty (u01-u04), coupling (c01-c07), mitigation (m01-m04) and
verification (v01-v02), plus one "is this acceptance item a deliverable?" Noul per item. The battery is frozen in
`lib/classifier-battery.json` (version i07v2.1). Code composes four separate outputs:

- **review requirements**: direct consequence axes (s01-s09, s12, s15) at >= .9; [.8, .9) is `review-uncertain`; s10, s11,
  s13, s14 are mechanisms attached to an affected effect, never a review floor alone;
- **workload candidate**: investigate (u01), else hard (u02), else multi (c04, or c06 and c07), else normal;
- **attention priority**: a frozen code+Jev ridge-logistic rework scorer (JSON artifact per project, fixed reference
  threshold = top 20% of its held-out scores); an attention flag, never a tier or a review floor;
- **planning candidates**: five structural conjunctions (new lifecycle coordination, new origin integration, client/server
  contract, separate measurement work, open design across boundaries), shown with their reasons, never a split decision.

A compatibility `candidateTier` (investigate, else risky when a review requirement exists, else the workload) is a lossy
summary. Dispositions record a person's tier (authoritative), quality-only acceptance (needs-scope), unknown dependencies or
an unestablished external contract (needs-context), protected-keyword conflicts, explicit `risk: normal` contradicted, and
investigate with a critical review (routing-review). Shadow only: nothing writes features, tiers or the queue.

**Evidence (ecommerce history; mostly retrospective feature text; 184 of 205 labelled features were Opus-built, so this
measures difficulty under that policy, not a Sonnet counterfactual).** Outcome dataset: 226 features, 198 finished with a
known outcome, 34 needed rework (evaluator rejection, log-recorded rejection or builder/commit failure). A family split was
frozen before any v2 answer (dev 120 rows / 20 rework; holdout 78 / 14).

| Holdout, fit on dev, run once | code features only | code + Jev composites (primary) | Jev composites only |
|---|---|---|---|
| rework AUPRC (prevalence .18) | .289 | **.503** | .617 |
| AUROC | .634 | .723 | .729 |
| reworked features caught flagging 20% | 36% | 50% | 57% |
| total-cost Spearman | .390 | **.637** | .633 |

Paired family bootstrap, primary minus code: AUPRC +.20 [+.02, +.38], cost rho +.24 [+.10, +.41]. First-build cost is not
predicted. Semantics: an independent author's fresh blind challenge set (35 matched cases, labels written before any run),
run once on the frozen battery: 241 labelled answers, 76% correct, 22% in the .2-.8 middle band, 2.9% wrong; 28/28
targeted pair contrasts ordered; prompt-injection, missing-facts and epic-boilerplate controls all held. The weakest
question is m01 presentation-only (calls small UI interaction changes presentation); mitigators never subtract stakes, so
this has little effect. Full shadow run on all 226 features: candidate normal 135, multi 12, hard 29, risky 50 (v1: 73%
risky); average cost rises normal $8.8 < multi $13.2 < hard $14.7 < risky $16.6; 62 attention flags; 32 planning
candidates (F15-09 among them; retrospectively 42% of planning candidates needed rework vs 17% overall). Jev spend for the
whole experiment: about $0.40.

**Fixes carried from the c4b8164 review.** F1 key isolation (`childEnv`, 221b07e); F2 strict answer validation (every id,
finite [0, 1], pinned resolved model); F3 every HTTP attempt reserved under the state lock against the daily cap,
single-flight per input, in-batch dedupe; F4 one deadline for all attempts and backoff, Retry-After honoured or turned
into a persisted cooldown; F5/F6 dispositions above; F7 request identity (model, battery, state) separate from policy and
scorer identity, so policy changes re-project stored answers without a request; F8 a feature edited during its request
is recorded stale; F9 requested/resolved model, usage, attempts and elapsed time on every record.

**Second review (f8be7e0, 11 P2 + 3 P3), all fixed:** every subprocess (including git helpers) gets `childEnv()`; the
scorer artifact is checked whole (canonical battery hash, pinned model, glossary hash, extraction structures, reference range)
and a mismatch only makes the score unavailable; claiming an input re-checks published answers, and the answer is published and
the claim released together under the lock; the provider cooldown is checked before every attempt and HTTP-date Retry-After is
honoured; lock waits count against the deadline; a person's tier or explicit risk is part of a separate authority identity, so a
change re-projects locally (no key needed); investigate keeps routing-review for protected work and risk-review for explicit
normal; the report re-projects with today's policy and separates stale, failed and never-attempted features, and never
averages unknown cost; provider usage is allowlisted and the key is redacted from records; extra answers and unpinned models are
rejected; records keep a secret-free input snapshot and the roles in effect; keyword matching folds dotted/dotless i like Python.

**Stability:** two full runs a few hours apart moved only 11 of 8,418 answers by more than .1, but those moves near the .8/.9
thresholds changed 12 of 226 candidate tiers: the review-uncertain band and the escalation stage exist for exactly these cases.

**Escalation (Oscar's design: unsure cases go to an agent; contract agreed with the Codex partner, round 3).** Opt-in
(`config.classifier.escalation.enabled`, or `fact-os classify ... --escalate`), shadow, explicit classify runs only. Selection:
direct review axes in Jev's (.2, .9) band, priority to features with a protection/risk conflict, then review-uncertain, then
answers nearest .5; a person's tier and quality-only scope are not sent; at most `maxQuestions` per feature, the rest stay
unresolved; repository-resolvable context (u03) is asked before ordinary middle-band axes; `maxPerRun` and `maxPerDay` count actual
agent starts, fallback included (defaults 2 and 6). The agent reads an ephemeral snapshot of an allowed manifest of tracked files at
the base commit (no factory state, run history, credential-looking files, symlinks or untracked files): Sol 6.1 high through
`codex exec --sandbox read-only --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --output-schema` (the user's
hooks, MCP servers and plugins are not loaded), falling back once to the
configured Claude fallback (Opus high) only when Codex is unavailable, forced read-only after the merge
(`--restricted --tools Read,Grep,Glob --strict-mcp-config --permission-mode plan`, a $2 cap). One deadline covers both; the
process group is killed and waited for within it; cancellation (SIGINT/SIGTERM) kills the agent and never falls back; a read-only
violation or oversized output never falls back either. Answers must echo the request and cite evidence: a spec quote must occur
exactly in the feature, a repo quote exactly in the cited lines of an allowed manifest file (the parent attaches the blob id);
true/false needs a spec quote. Composition is a separate advisory derivation: an agent true adds a review proposal; an agent
false is recorded as a disagreement and the uncertainty stays (whether a quote really excludes a mechanism cannot be checked
mechanically); unknown stays uncertain; nothing touches a Jev floor, a person's tier or protection. The answer is published
only if the feature's scope, authority, glossary and human tasks are unchanged (else stale), and identities include the fallback
model, so a cached answer is never reused across providers. Answers are
`model_proposal_unadjudicated`, never automatic labels; escalations of features already launched are marked
`retrospectiveCurrentBase`. First real runs: Sol read the repository and cited a migration and the audit package with verified
quotes (102 s, mostly cached input); Opus fallback answered in about 20 s for $0.27. After the third review (d9f3ffe: 14 P2 + 2 P3,
all fixed), a real Sol run on F05-09 with the hardened runner cited checkout, orders and architecture files and recorded one
disagreement (authoritative amount) beside five review proposals, in 138 s. Fourth review (aa9f10d: 10 P2 + 3 P3, all fixed):
a Codex cooldown no longer consumes a start; human task steps and waiting-on facts are sent, bound into identity and compared;
a lease records the agent's process group and start time, so a crashed caller's live agent keeps its claim; the snapshot is
written from blob bytes (no git-archive export attributes); every request is kept under classifier-context/ and linked from its
records; the scorer must declare the anyRework target and the exact ordered features; a glossary that is oversized or looks like
it holds a credential is not used at all; eligibility is rechecked under the reservation lock; an already-aborted signal starts
nothing; the final-message file is watched while the agent runs; publication waits at most until the deadline and journals the
result before releasing the claim; every requested feature gets a journal entry (excluded, cached, deferred, skipped); u03 is
not sent when an open non-mockable human task must supply the fact. A failed evidence check now rejects only that answer (kept
with the offending reference, never composed) instead of discarding the whole response: the first real run lost 2 of 4 answers
to inexact repo quotes; after adding explicit quoting guidance (one short exact line, 1-based line numbers) the next real run
kept 4 of 4 with no rejections, in 86 s. The ecommerce pilot cap is `maxPerDay: 10`. Fifth review (a81698f: 9 P2 + 3 P3, all fixed):
one decoded-value credential check guards the glossary and every escalation request (JSON escapes cannot hide a key; a request
carrying one is neither sent nor kept); reference shapes are validated for the whole response before evidence is checked per
answer; output overflow is a hard kill; human task context is never clipped (an oversized one defers the assessment); a crashed
caller's agent group keeps its claim even after its leader exits; cancellation is re-checked under the publication lock;
eligibility is recomputed at reservation; a result that cannot be published in time is staged and published by the next run;
rejected answers keep the agent's reason and references; the summary keeps completed proposals after cache hits.

**v2.2 (same day, from Oscar's request to dig into the disagreements).** Nine open features where Jev's candidate disagreed with
a person's tier or would upgrade were inspected answer by answer. Two causes: (1) context: house rules live in the codebase, not
in feature text (F07-12's real failure was a missing permission check; the text never says "permission", so "who may act" scored
.16); (2) literal reading: the stakes questions asked whether a feature *alters* a decision while their criteria already counted
*adding* one, so new store-scoped routes scored .6-.7 on store binding. Fixes: battery v2.2 asks "add or alter" in the stakes
questions, and the ecommerce glossary gained a `houseRules` entry (permissions on every staff action, `orders.refund` for financial
actions, store scoping for every route). On the nine cases: F07-12 "who may act" .16 -> .65 (now inside the escalation band), store
binding .51 -> .84; F12-09 "who may act" .36 -> .82; F17-09-C store binding .61 -> .88. Outcome prediction did not change (dev
AUPRC .39 -> .40, holdout .34 -> .33, within noise); the blind set's wrong answers rose 7 -> 11, mostly where the house rule and the
author's label disagree (a refund screen over an existing API). The attention scorer was refit on v2.2 answers with the same recipe
(development evidence only: the v2.1 holdout had been used). All 226 re-classified: normal 129, multi 10, hard 26, risky 61; 90
features have an unsure review answer (was 68), which is what escalation acts on.

**Automatic classification (Oscar, 2026-10-04).** The running observer (`fact-os observe --watch`) now classifies, in the
background on every poll, each open feature whose current text has no assessment (new features from intake, and edited ones), then
escalates their unsure answers to Sol when `escalation.enabled` is on. It never delays an observer pass or a launch, never changes
a tier or a feature, retries a failed input only after an hour, and is quiet when nothing is new. `classifier.auto: false` turns it off.

**Status and stopping point.** Five fresh reviews took the stage from 9 to 16 to 13 to 12 findings, each round narrower
(crash recovery, cancellation timing, credential edge cases). The classifier itself (Jev battery, scorer, projection, report)
converged by the third review. Escalation stays opt-in and disabled by default (`escalation.enabled: false`); further
hardening rounds should follow real use rather than precede it.

**Configuration (ecommerce):** `classifier: {provider: "typesafe", mode: "shadow", glossary: ".shipyard/classifier/glossary.json",
scorer: ".shipyard/classifier/scorer-v2.1.json"}`; key in `TYPESAFE_API_KEY` or fact-os's `.env`. The scorer is fitted to
ecommerce; another project can use the battery with its own glossary, but its attention score is unavailable until it has
its own artifact. Raw experiment data (dataset, answers, labels, partner reports, TypeSafe docs snapshot) is kept privately in
`ecommerce-builder/.shipyard/i07-experiment/`.

**Not done (each needs Oscar):** applying tiers, a launch-time backstop, observer reassessment, split drafting. Prospective
validation: freeze the policy, assess new features before launch, and compare with their outcomes.

## I08 — what five stuck features showed (2026-10-04)

An audit of the five features stuck after three tries (by Claude, and independently by a Codex Sol run that reached the
same per-feature causes) found that most of the 15 counted failures were not the builder's code being wrong:

- **4 of 15 were a protocol mismatch.** Builders declared moved lines as `` dropped: <file>: `line` - reason `` (the form the
  feedback itself suggested); the parser wanted the bare line, so three tries of one feature burned in about 90 seconds.
- **A diagnosed environment fault still spent the last try.** The diagnoser found the gate's receipt fixture timing out behind
  a backlog other suites left in the shared task outbox; the same flake had stopped 7 features 8 times. The fixture fix is an
  ecommerce feature (`F99-45`).
- **The builder and the evaluator disagreed on fakes.** A feature built on dependencies whose external providers are mocked
  (open mockable human tasks on those dependencies) had no mock allowance of its own, so every evaluation blocked on them.
- **A known spec contradiction was retried.** The observer's review had called it a spec error with high confidence before the
  third try; the third builder weakened a test to satisfy both halves.
- **One narrow defect cost a full rebuild.** A single precise blocking finding could have been fixed in the same session.

Changes (designed with the Codex partner, each amended by its review; `/tmp/herd/stuck-design.md` at the time):

1. Keep-lines: a record declares a line when it is the exact line, the line in one leading code span, or the line followed by
   ` - `, ` — ` or a final ` (…)` (never a bare prefix or `;`). The feedback lists copyable records, quotes records that matched
   nothing, and hints where a lost line's token now is (a hint never excuses a loss). Declared drops reach the evaluator.
   `keepFixes` (default 1) resumes the builder's session once per pass before a counted failure.
2. Environment: an `environment` diagnosis reruns the gate on the same build; the same failure again is an uncounted stop that
   holds the build (`envBuild`) and retries after `setupRetryDelaysSec`; one more episode after the last delay is an uncounted
   stuck. The stop is logged with `cause: "environment"` so the observer neither re-classifies nor resets it. Diagnosis no
   longer needs a builder session.
3. Planning hold: a prompt review of the feature's latest failed pass that says `spec-error` (high; medium only when corroborated
   by the outcome) or `prompt-conflict` (high, both sides quoted) holds the launch, but only when every quote is found in the
   saved prompt or outcome, the requirement is quoted from the prompt, no newer launch exists and the spec is the one that pass
   was given. Unverified ones are alerts. An edit of the description, acceptance, dependencies or briefs releases it; so does
   `release <id>`; time never does. It is not a person's pause.
4. Mock allowance: open mockable human tasks of a feature's dependencies (transitively) are captured at launch, with the
   dependency they came through, and shown to every role. Non-mockable ones on dependencies neither block nor grant.
5. `reviewFixes` (default 0, opt-in like `gateFixes`): an actionable rejection (valid verdict, no cheating, concrete failed
   findings or blocking entries) resumes the builder once per pass, then the gate and a fresh evaluator run again.
6. Codex runs are recorded as unpriced (`cost_status`), not $0; totals are labelled reported USD.
