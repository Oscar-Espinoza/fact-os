---
name: ship
description: Start Shipyard's foreman on this repo in the background and report status. Use when the user says "ship", "start shipyard", or wants the feature list built.
---

# Ship with Shipyard

1. Run `shipyard doctor`. If it reports problems, fix the state files (or ask the user) and re-run it.
   Do not start the foreman while doctor fails.
2. Make sure the main checkout is on the configured `base` branch with no uncommitted tracked changes;
   otherwise passing features stop at `ready` instead of merging. Tell the user if that is the case.
3. Start the foreman in the background (it keeps running while features wait on the user):
   `mkdir -p .shipyard/runs && nohup shipyard run --watch > .shipyard/runs/foreman.out 2>&1 &`
   Only one foreman runs per repo; if one is already running, do not start another.
4. Run `shipyard status` and report it: what is building, what is next, and every open human task
   with its steps (those are the user's to-do list; `shipyard done <id>` marks one done).
5. Tell the user they can watch everything with `shipyard dash --root ~/Projects` and open
   http://127.0.0.1:7420, where "Only you" lists what needs them.
