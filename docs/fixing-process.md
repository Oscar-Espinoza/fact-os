# Sequential repair process

The [review backlog](review-backlog.md) is the durable record of the 2026-10-02 review.
Use it to resume work without depending on chat history. The original review found 12 confirmed
issues; a second Claude review added four scoped follow-ups. Future architecture
ideas and unresolved concerns are recorded separately.

## Working rules

1. Have exactly one active issue and one application-code writer. Work directly on one
   change at a time; do not run the factory against this repository to repair itself.
   Read the backlog's handoff, applicable AGENTS.md instructions, README.md and relevant
   SPEC.md sections before starting. Preserve unrelated changes.
2. Recheck the issue against current code and its callers. Record the chosen behavior,
   affected modules and acceptance checks before editing. Do not expand a correctness
   fix into an unrelated refactor. For each material acceptance claim, record its
   regression or code evidence and explicitly identify missing coverage. Include
   parked/pending states and failures after side effects when relevant.
3. For a correctness bug, add a focused regression that demonstrates the failure before
   the fix. Use fake providers and temporary repositories; do not use live accounts,
   provider calls, databases or infrastructure.
4. Implement the smallest coherent fix, update its documented contract, then run the
   named affected test files and `bun run typecheck`. Never run bare `pnpm test`.
   Broaden testing only for affected connections or unresolved failures.
5. Review the diff and callers. Record the exact validation commands/results, changed
   files, remaining limits and next issue. Mark an issue verified only when its
   acceptance checks pass. Stop repeating successful checks without new evidence.
6. Finish this issue before starting the next. A separate commit per issue is useful
   when commits are authorized; recording a fix does not authorize a commit, deployment,
   live-factory restart, extension installation or external publication.

Statuses: **open**, **active**, **verified**, **blocked**. `verified` means fixed and
checked locally, not committed or deployed. Record a concrete reason for `blocked`.

## Resuming

Read the handoff in `review-backlog.md`, inspect `git status --short`, and review any
uncommitted diff. Continue the active issue; otherwise select the first open issue in
the queue. Revalidate evidence as files change: source references from the original
review identify symbols and may move as fixes land.

## Order

Start with aggregate merge validation, then repair state locking and supervisor
ownership. Tighten verdict parsing and checkout mutation before lower-priority
scheduling, cancellation and reporting defects. Refactoring and new provider support
come after these correctness fixes, only when separately scoped.
