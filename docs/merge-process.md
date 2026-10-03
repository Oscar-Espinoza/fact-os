# Merge process

How fact-os keeps parallel features from undoing each other at merge time: **file claims** keep two features
that change one hot file from running together, a **both-sides resolution** gives whoever resolves a conflict the
context of both sides and resolves it in the same pass, a **keep-lines check** refuses a resolution that silently
drops what either side added, and **structural fixes** in the project remove the hot files themselves. Pieces 1
and 2 live in fact-os (`lib/merge.ts`, `lib/foreman.ts`); piece 3 is a list of ready-to-queue features for
ecommerce-builder ([merge-process.features.json](merge-process.features.json)). Everything is off by default.

## The problem (ecommerce-builder, 2026-09-28 to 10-01)

Per feature the foreman builds, merges current base into the branch (`refreshBeforeTest`), runs the gate (about
33 min), runs a fresh evaluator and merges with `git merge --no-ff`. When the refresh or the final merge conflicts,
the feature went back to `todo` with "resolve the conflicts…" and the same builder ran again with no idea what the
other side was, then the full gate and evaluator again. The factory log shows 1,106 launches, 569 conflicting
refreshes across 116 features (some 18 to 23 times), and 168 merges. Conflicts per file are in the brief and in the
replay below; `packages/platform/src/provisioning.ts` alone was in 479 of them. A union merge driver for it was
tried and reverted: it dropped shared closing lines in 14 of 20 replayed conflicts and twice left main unparseable.
Rule kept from that: **no automatic textual resolution reaches base without the gate and the evaluator, and every
resolver idea is checked against replayed real conflicts.**

## Design

```
launch ──► claims: does a running feature hold one of my hot files? ── yes ──► wait (claim-wait), try the next one
  │ no
build ──► keep-lines check of a resolution the builder committed (if one is pending)
  │
refresh before test ── conflict ──► both-sides brief ──► resolver (same pass) ──► keep-lines check ─┐
  │ clean / current                     │ (no resolver: back to todo, builder gets the brief)       │ fail: todo,
test ──► evaluate (told what the resolution must not break) ──► merge                               │ builder fixes
  ▲                                                                    │ conflict (bounce)          │
  └──────────────── resolver (same pass) ◄── both-sides brief ◄────────┘                            │
```

### 1. File claims (`claims`)

- **Hot files** come from history: every `refreshed` event with "conflicts in: …" in the last `claims.days` (7)
  scores 1 per file, 2 when it came right after `evaluating` (a bounce: gated, evaluated work sent back). A file
  scoring `claims.minScore` (3) or more is hot, and so is anything matching `claims.hot` (paths, or prefixes ending
  in `/`). Once a structural fix lands the file stops conflicting and cools off by itself.
- **What a feature changes** (deterministic, no agent): its declared `touches` (new optional feature field: paths or
  `dir/` prefixes, for intake or a person to fill), the committed diff `base...<branch>` when its branch exists (every
  re-run after a bounce, which is where the 18–23 rounds came from), and its worktree's uncommitted edits (`git status`:
  a builder "declares" a file the moment it edits it; during an in-progress base refresh only unmerged files and
  unstaged edits count, not base's staged changes).
- **Rule**, at launch only, after the group check: a ready feature is skipped for the next-best one while a feature
  in flight holds one of its hot files. Only features in flight hold claims, so nothing ever waits on a feature that
  is not running, and with nothing in flight nothing waits. Each skip is logged once per reason (`claim-wait`,
  "<file> is claimed by <id>"). A launched builder is told which hot files others in flight are changing ("keep your
  edits there small and additive; do not skip a change the feature needs").
- **Directories** use repository-relative paths with `/` separators and a trailing `/`; `src` stays
  an exact path. Check the narrower shared file/directory for hotness, including listed or scored
  hot descendants. For example, `src/` versus `src/a/hot.ts` blocks when that file is hot, but
  `src/` versus `src/b/cold.ts` does not block merely because `src/a/hot.ts` is hot. Wait messages
  name the shared path. Builder hints list protected intersections inside held directories, not
  every descendant. With `minScore: 0`, any shared path blocks and hints list held paths themselves.
  Candidate/held paths are sorted and deduplicated; holders retain their given order. Claims use
  known paths at launch time, so undeclared later edits and metadata changes after that snapshot
  can still conflict. Claims remain off by default.
- Cost: one `git diff --name-only` and one `git status` per feature in flight, only on ticks that launch, plus one
  read of `log.jsonl` when it changed.

### 2. Both-sides resolution (`conflictBrief`, `resolver`)

When a refresh conflicts (before the test, or after a bounce at the final merge) and either key is on:

- The foreman merges with `merge.conflictStyle=diff3` (markers show the common ancestor too) and records
  `conflict: {ours, theirs, files}` on the feature.
- The **brief**: this feature's description and acceptance checks; every commit on base's first-parent line since
  `git merge-base ours theirs` that touches a conflicting file, named by the foreman's `merge <id>: <title>` subject
  (also the old `shipyard:` prefix) with that feature's description and acceptance checks from `features.json`
  (other commits by subject); and each file's conflict blocks with 3 lines of context (capped at 4,000 characters a
  file, 16,000 in all). The instruction: keep both behaviours; keep every line either side added, or list it in a
  commit message as `dropped: <file>: <line>` with the reason.
- **`conflictBrief: true`, no resolver**: the feature goes back to `todo` as before; the builder's feedback now carries
  the brief.
- **`resolver` set** (a role config like `builder`): the feature stays in flight, keeping its slot and its claims, and a
  separate **resolver** run (`claude -p`, prompt "You are the merge resolver…", the brief, the project's brief files)
  finishes the merge right there. It fails if the run fails, leaves the merge uncommitted or the worktree dirty, or
  the tip does not contain both sides; then the feature goes back to `todo` with the brief plus "A resolver run tried
  first: <why>", and the builder finishes (`resolve-failed`). On success the pass goes on: the refresh-before-test check
  again (base may have moved meanwhile), the **gate**, a **fresh evaluator** that is told this pass resolved a conflict
  and which features on base it must not break (with their acceptance checks and any lines the resolution changed),
  and the merge. Another bounce loops; `maxRefreshes` bounds it. Resolver runs are saved as `<tag>-resolve.json` under
  a new pass tag and counted with build costs by the observer.
- **Keep-lines check** (cheap, no agent, `checkLines` in `lib/merge.ts`), on every committed resolution: the resolver's
  at once, the builder's right after its build. Per conflicting file, over trimmed, non-blank, non-comment lines, the
  result must hold at least `base + (ours − base) + (theirs − base)` copies of each line either side added (both sides
  added the same meaningful line, e.g. an import: `base + max`). Punctuation-only lines count too, so the union
  driver's lost `],` is caught. A short line is **changed**, not lost, when the result has a new line of the same shape
  (digits as `#`, no trailing `,`/`;`), at least 85% alike, or holding all its words (3+), one new line excusing one
  line per side: a migration key renumbered because both sides took the number, a moved `;`, two edits of one line
  combined. Lines declared `dropped:` are excused. Lost lines: from the resolver → `todo` with the lost lines as
  feedback, no attempt spent, the check stays pending for the builder; from the builder → a failed attempt with that
  feedback. Changed lines are passed to the evaluator.

Why a separate resolver and not just richer builder feedback: the builder role carries the whole feature brief,
lessons and the habit of re-doing the feature; a resolver gets one narrow job, its own model and effort (it can be
cheaper or stronger than the builder), and runs **in the same pass**, so a bounced feature does not give up its slot
and its claims, wait for a slot again, or re-run a build. Both share the same brief, so turning on `conflictBrief`
first and `resolver` later is a safe ladder.

### 3. Structural fixes (ecommerce-builder; not implemented here)

Ready to queue in [merge-process.features.json](merge-process.features.json), each with evidence and acceptance checks
an independent evaluator can verify. F99-01 (split the per-migration grant registry out of provisioning.ts) is already
in flight and is not duplicated.

| id | what | evidence (conflicting refreshes, since 09-30 in brackets) |
|---|---|---|
| F99-12-sorted-contract-registries | Sort OpenAPI paths and schemas, the fixtures manifest and the generator's outputs; a test keeps them sorted | manifest/fixture-types 130 (63), runtime-schemas 115 (58), openapi 114 (55), server-operations 97 (51); replayed: sorting separates 122/144 openapi and 98/127 manifest conflicts |
| F99-13-contract-changes-per-file | One file per contract change note instead of appending to CONTRACTS.md | 78 (17); sorting would leave 19/72, a file per change leaves none |
| F99-14-regenerate-generated-files | `pnpm regen` (+ `--check`), `merge=binary` on generated dirs, "regenerate, never hand-merge" | generated files 26–130 each; one replayed resolution dropped ten of F15-07's own manifest/fixture-type entries |
| F99-15-split-audit-route-inventory | Per-module audit inventory and per-module reviewed pins (F99-01's pattern) | plugin.db.test.ts 80 (24), inventory.ts 33 (11); sorting would separate only about half |
| F99-16-split-merchant-openapi-per-module | Per-module OpenAPI fragments; **queued paused**, only if F99-12 leaves 5+ conflicts a day | openapi 114 (55); sorting leaves about 15% |

Not queued: tests that pin counts were fixed by F99-10 (validation.test.ts 134 → 2, contracts.test.ts 91 → 2,
provisioning.test.ts 70 → 2 conflicts after it merged), and `apps/api/src/app.ts` has had none since 09-30.

## Alternatives rejected

- **Any automatic textual merge into base** (union or custom merge drivers, "take both sides" scripts). The union driver
  broke main twice. A resolution always goes through the gate and the evaluator; the keep-lines check only rejects.
- **A planning agent that predicts each feature's files** before launch: costs a run per launch, is not deterministic,
  and the replay shows a low ceiling (perfect prediction keeps 49% of file conflicts apart vs 43% from what the foreman
  can see, while making 93% of launches wait). Declared `touches` stay available for a person or intake.
- **Predicting from similar merged features** (same epic, or keywords): measured on the 168 merges, an epic-majority
  rule predicted provisioning.ts with 65% precision and 74% recall against a 57% base rate, and keywords ("migration",
  "table", "API") did worse. Not worth the complexity.
- **Claiming every file a feature touches**: almost every feature shares some file with another; only hot files cost
  anything when they conflict.
- **Claims that block or pause running features**: a feature in flight is never stopped; claims only decide launches.
- **Rebasing branches, or the builder resolving its own conflicts with the old feedback**: rebases rewrite what was
  evaluated; the old feedback gave no context of the other side (the replay found a builder resolution that dropped the
  feature's own fixture entries).
- **A per-file holder limit (e.g. two features per hot file)**: would make claims tunable, but it no longer guarantees
  the two never conflict; left out to keep the rule simple.

## Verification

- **Unit** (`test/merge.test.ts`): hot-file scoring (window, bounce weight, lesson in between), claim matching (hot vs
  cold, dir prefixes on either side), the keep-lines check (both entries kept in any order or indentation; the union
  driver's shared closer caught; one side's deletion respected; the same import added twice; renumbered keys, moved
  `;`, rewrapped comments and combined one-line edits as changes; renumbering one entry does not excuse dropping
  another), declared drops, hunk extraction, and on a real git conflict: the brief names the feature merge that touched
  the file with its acceptance checks and skips the one that did not, `featureFiles` sees committed, uncommitted and
  declared files but not base's staged files during a merge, and `keepCheck` accepts a declared drop.
- **End to end** (`test/merge-process.test.ts`, fake claude, real git conflicts): a bounce resolved in the same pass with
  both sides' context, then the gate and a second fresh evaluation that is told what to protect, then merged with both
  entries on main and its own run files; a conflict before the test resolved inline and never tested in its
  conflicted state; a resolver that drops the other side's line sent back and the line never merged; a declared drop
  merged; a resolver that leaves the merge unfinished handing it to the builder, whose resolution is checked;
  `conflictBrief` alone; claims keeping two features on one hot file apart while a third runs beside them, with the
  hot file declared, and with it scored from the log and known from a re-run's branch diff. All earlier tests
  pass unchanged (defaults keep today's behaviour).
- **Replay** (`bun scripts/replay-conflicts.ts <repo> [--json out] [--only claims]`, read-only: `git show`, `git log`,
  `git merge-file` on temp files and the state dir's log; never a checkout).

### Replay on ecommerce-builder (since the first foreman merge, 2026-09-28)

Resolver context: 720 "merge main into <branch>" commits; 576 conflict when replayed, in 2,400 file conflicts. The brief
names a feature (with description and acceptance checks) behind base's side for 2,394 of 2,400 (100%); the other 6
came only from non-feature commits, which the brief names by subject. Median feature text per brief: 3.6 KB.

Keep-lines check on what builders actually committed: 154 of 2,400 resolutions (6%) would have been sent back or
needed a `dropped:` line; 878 more pass with changed lines reported to the evaluator; none kept conflict markers; 4
did not parse. A sample of 22 flagged ones: 8 rewrote count pins or version hashes (deliberate; count pins are gone
since F99-10), about 4 were reformatting (a JSON array collapsed onto one line), about 10 rewrote code during the
resolution, where a declaration and the evaluator's attention are what we want; and it includes a confirmed real loss
(a2b72d482c5e dropped ten of F15-07's own manifest and fixture-type entries; a later pass needed commit 1a0e87266 to
restore them). On the same conflicts, the reverted union driver's output does not parse in 1,080 of 2,037 checkable
files, and the check flags 873 of those (81%).

Claims (hot = 3+ in the 7 days before; the replay cannot model the knock-on effects of waiting, so read it as an
estimate):

| scenario | conflicting refreshes avoided | file conflicts kept apart | launches that would wait (median wait) |
|---|---|---|---|
| all hot files, files known as the foreman knows them | 254/569 (45%) | 959/2,214 (43%) | 870/1,106 (79%, 32 min) |
| same, with perfect `touches` | 291/569 (51%) | 1,094/2,214 (49%) | 1,024/1,106 (93%, 38 min) |
| after F99-01 (provisioning.ts gone) | 146/400 (37%) | 674/1,735 (39%) | 860/1,106 (78%, 32 min) |
| after F99-01 and regenerated contract files | 127/371 (34%) | 421/1,194 (35%) | 860/1,106 (78%, 31 min) |
| claiming only provisioning.ts | 110/569 (19%) | 285/2,214 (13%) | 799/1,106 (72%, 29 min) |

The hot files here are each touched by about half of all features (provisioning.ts 57%, manifest.json 57%, the
merchant OpenAPI 51%, the audit pin 48%), so claiming them makes most launches wait about half an hour: in this
project claims trade throughput for fewer conflicts, while the resolver makes a conflict cheap without waiting. Claims
pay off for a hot file few features touch.

## Rollout on the live factory

The foreman reads `config.json` once and halts if it changes during a run, and it runs from the main fact-os checkout.

1. Review this branch (`merge-process` in `~/Projects/fact-os-merge`), merge it into fact-os `main` yourself, and
   restart the foreman at a quiet point (`fact-os run --watch` loads the code at start; the observer and dashboard too).
2. Stop the foreman, add to `.shipyard/config.json`:
   ```json
   "conflictBrief": true,
   "resolver": { "model": "opus", "effort": "medium", "permissionMode": "auto" }
   ```
   and start it again. Watch `log.jsonl` for `resolving` / `resolved` / `resolve-failed` / `keep-check`, and the
   observer's bounces and its agents table (merges "after a resolver"): a resolved bounce costs one resolver run plus
   the gate and an evaluation instead of a builder run, a wait for a slot, the gate and an evaluation. To go back,
   remove the keys (a pending `conflict` record is then ignored).
3. Queue F99-12 to F99-15 (and F99-16 paused) from `docs/merge-process.features.json` into `.shipyard/features.json`.
4. Claims: leave `claims` at `null` for now. Revisit after F99-01, F99-12 and F99-14 merge, using
   `bun scripts/replay-conflicts.ts ~/Projects/ecommerce-builder --only claims`; if a file still conflicts often but few
   features touch it, turn on `"claims": { "hot": ["<that file>"], "minScore": 1000 }` (listed files only), or
   `"claims": {}` for the scored defaults (`minScore` 3, `days` 7).

## Decisions for Oscar

- Merge `merge-process` into fact-os main, and when to restart the factory on it.
- Turn on the resolver (recommended) and with which model and effort (default above: the builder's role config).
- Whether a builder's keep-lines failure should keep spending an attempt (today: yes, like a failed test; a resolver's
  failure never does).
- Claims: off for now (recommended, numbers above), or on with a short listed hot set.
- Queue F99-12 to F99-15 now, and F99-16 only if sorting is not enough. A later fact-os option worth considering:
  run a project command (e.g. `pnpm regen`) right after a conflicted refresh, so conflicts in generated files never
  reach the resolver.
