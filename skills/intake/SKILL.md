---
name: intake
description: Interview the user briefly and write Shipyard's .shipyard/features.json and .shipyard/human.json. Use when the user wants to plan features for Shipyard, "intake", or set up the feature list before `shipyard run`.
---

# Shipyard intake

Turn what the user wants built into Shipyard's feature list and human inbox.

1. Read what already exists: `.shipyard/config.json`, `.shipyard/features.json`, `.shipyard/human.json`,
   the README and the code layout. Keep existing features (never reset their `status`/`attempts`).
2. Ask **at most 5** short questions, in one message, only about what you cannot infer: scope of the
   first release, target surfaces, external services and accounts, what "done" looks like, priorities.
3. Write `.shipyard/features.json` as `{ "features": [Feature] }`:
   - `id` (short slug, unique), `title`, `description` (enough for a builder with no other context),
   - `acceptance`: at least one check per feature, each concrete and testable by an independent
     evaluator reading the diff and running commands ("POST /api/cart returns 201 and the item
     appears in GET /api/cart", not "cart works"),
   - `surface`: `web` | `api` | `ios` | `android` | `desktop` | `any`,
   - `deps`: ids that must merge first; `priority`: lower = sooner,
   - `status: "todo"`, `attempts: 0`, `updatedAt`: now (ISO). Optional `branch` to continue an existing branch.
   Prefer small features that one agent can finish in one session.
4. Write `.shipyard/human.json` as `{ "tasks": [HumanTask] }`. Anything only the user can do becomes a
   task: creating accounts, obtaining credentials or API keys, signing contracts, store/host setup,
   legal and compliance decisions, DNS. Each task has `id`, `title`, exact numbered `steps` the user
   can follow without guessing, `unblocks` (feature ids), `mockable` (true when a builder can make
   progress against a fake until the task is done), `status: "open"`.
   Never ask the user to paste secrets into chat or into these files.
5. Run `shipyard doctor` and fix every problem it reports. Then show the user a short summary:
   features in priority order and the human tasks, with what each unblocks.
