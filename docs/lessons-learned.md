# Lessons from the first factory repairs

Written jointly by Claude, the read-only reviewer in Oscar's `claude-factory`
tab, and Codex, the repair writer and commit-series coordinator. Claude supplied
the review lessons; Codex integrated them with the implementation and history
reconstruction lessons. Oscar authorized the commit split on 2026-10-03.

## Why these repairs came first

The initial review compared documented behavior with actual entry points,
callers, state transitions and log consumers. The baseline passed 199 tests in
13 named files and strict typechecking, yet focused reproductions confirmed
12 defects. Some could merge incompatible parallel features, lose concurrent
state updates, run duplicate supervisors, accept malformed verdicts or commit
intervening checkout changes during lesson curation.

Those are concrete risks for the ecommerce builder and future projects using
this factory. Correctness at these boundaries deserved attention before adding
providers or broad architectural abstractions. A second independent review
found four follow-ups, including gaps in paths the original repairs were meant
to cover. The [review backlog](review-backlog.md) records each R01–R16 repair,
its decisions, evidence and limits; the [second review](second-review-2026-10-02.md)
records how the additional findings were checked.

## Why the work was sequential

One active issue and one application-code writer kept the uncommitted tree
stable. Read-only reviewers could investigate separate connections without
competing to edit the same foreman, observer or dashboard files. Codex checked
reviewer findings against actual producers and callers before applying changes.
Disagreement was resolved with code and focused reproductions.

Each correctness repair used a focused failing reproduction and a scoped fix,
followed by named affected tests and typechecking. Fake providers and temporary
Git repositories exercised the flows without paid calls or live infrastructure.
Passing counts alone were insufficient: the existing baseline was green while
the defects were present. Integration checks mattered because a locally correct
producer can still disagree with a consumer about attempts, verdicts or lessons.

Reviewers caught concrete omissions: observer attribution after aggregate
revalidation, prompt-review handling of rejected verdicts, dependency import
ordering, supervisor ownership release, dashboard retry precedence, stale lesson
identity and the actual conflict message format. The process is documented in
[fixing-process.md](fixing-process.md).

## Lessons to carry into the next project

1. **Use the producer's real output in fixtures.** A conflict test supplied
   `too many base refreshes (5)`, while the foreman writes
   `merge conflict with main: too many base refreshes (5)`. The shortened fixture
   passed while the real timeline failed. Call the producer where practical or
   share the contract; include real message forms when maintaining legacy text
   consumers.
2. **Map material acceptance claims to evidence.** R01 intended to prevent
   evaluator lessons from causing their own feature to be evaluated again.
   The parked path still did this until R14. Trace normal, parked, pending,
   retry and post-side-effect failure paths. Name missing coverage instead of
   marking a broad claim verified because nearby tests pass.
3. **Give persisted fields an owner and lifecycle.** For `sha`, `pendingLesson`
   and `stop`, identify where each is set, retained, cleared and validated.
   Bind derived data to the identity it describes: a pending lesson belongs to
   the evaluated commit, so a later evaluation cannot accidentally promote it.
4. **Checkpoint paid work before launching it.** R13 records the throttle
   before the provider call and prevents launch if checkpointing fails.
   Applying an answer can fail after payment; a later observer poll must not
   repeat that call immediately because only an in-memory timestamp changed.
   Contain individual stage failures and preserve cancellation checks.
5. **Fail closed while retaining bounded diagnostics.** R15 rejects malformed
   verdicts while retaining a labelled excerpt for the next builder and human
   review. Invalid evidence cannot authorize a merge, but discarding all useful
   context wastes retries. Keep excerpts bounded and reject their authority.
6. **Classify machine markers before arbitrary text.** Check the producer's
   anchored rejection prefix before scanning evidence for strings such as
   `ECONNREFUSED`. Provider text can contain those strings without describing a
   retryable transport failure. The separate valid-negative-verdict
   classification disagreement remains unresolved and needs its own scope.
7. **Make concurrency rules explicit.** Publish populated lock directories
   with owner tokens; do not move a lock a live holder might still own. Acquire
   checkout locks before state locks. Avoid calling `serial()` from inside
   `serial()`, which waits on itself. Protect the complete operation through
   cleanup, not just the moment a child starts.
8. **Use structured evidence where text guesses drift.** `stop`,
   `attemptsReset` and `lessonAppend` give consumers information they previously
   inferred incorrectly. Broader structured-event work remains a future
   architecture idea; these repairs do not implement that whole system.
9. **Change structure to solve an observed problem.** Trace entry point →
   business decision → storage/event → UI before extracting abstractions.
   Clear owners and meaningful interfaces help when they remove duplicated
   rules or inconsistent consumers. A new layer alone is not evidence of an
   improvement. Existing boundaries need contract checks as well as unit tests.
10. **Record limits alongside successes.** Local verification does not imply
    production validation. This work did not exercise real providers, process
    crash injection, browser layout or an upgrade of the live factory.

## Why the commits were reconstructed this way

The repairs were originally authorized as edits and local checks; commits were
not authorized until Oscar's later decision. That left changes from several
items sharing lines in the same files. Next time, when authorized, commit each
verified issue on a local branch before starting the next. Otherwise preserve
a per-issue patch and handoff so review history remains recoverable.

For this split, Codex preserved an immutable snapshot and reconstructed one
commit per repair on `review-repairs-2026-10-03`, in repair order:
R01–R10, R13, R14, R11, R12, R16, R15. Shared lines evolve with the latest
applicable item. Intermediate trees are checked with `bun run typecheck` in a
throwaway worktree, preserving the complete repair tree in the main workspace.
Typechecking verifies that the historical contracts compile; the named final
tests verify the combined behavior. They are different checks.
Typechecking does not check documentation or browser JavaScript: documentation
ownership needs a content review against each commit's code, and changed browser
scripts need their own `node --check` validation.

Draft reconstructions were preserved on separate local branches while ownership
was being checked; temporary branches and worktrees are removed after acceptance.
The accepted series preserves the original
repair file contents byte for byte, adds this joint document, and includes a
final documentation commit for the durable process and review records.
`lib/dash.legacy.html` and `.dashboard/` remain outside the commit series.
The original `main` history is preserved; no push, deployment or live-factory
restart is part of this work.

The backlog and second-review document retain their historical validation and
pre-commit handoff wording from the captured repair tree. This document records
the later commit authorization and split; the historical repair notes are not
instructions to discard the branch or repeat completed repairs. Future work
starts by checking the branch, working-tree status and the unresolved concerns,
not by assuming that every earlier acceptance claim had complete coverage.
