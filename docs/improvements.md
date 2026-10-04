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
| I05 | next | Setup failures: bounded delayed retries without spending attempts, then a launch hold |
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
