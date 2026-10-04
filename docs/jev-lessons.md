# Jev lessons

What we learned using TypeSafe Jev (a "System One" model: typed answers with probabilities, no text) to classify factory
features (I07, 2026-10-04). Written to be reused wherever the app needs a fast, cheap, typed judgment.

## What Jev is good for

Jev answers questions about a supplied `state` with a Choice (one of N options, with a probability per option and a
confidence), a Noul (the probability that a yes/no statement holds) or a Score (ordered levels). It is fast (about 0.5 s
for a 12k-token request with 36 questions) and cheap ($0.042 per million input tokens; output is free): classifying all
226 ecommerce features with 36 questions each cost about $0.08. It never generates text and never reads anything you do
not send. Typed output guarantees the interface, not the truth.

## The rules that made the difference

1. **Ask many narrow questions, never one broad one.** v1 asked a single "which tier?" Choice and labelled 73% of features
   risky, never answered hard or investigate, and could not tell an obvious overscope from the median. v2 asked 32
   atomic mechanism questions ("does the change alter how an authoritative monetary amount is determined?", "does it
   alter an enforced decision about who may perform an action?") and composed them in code. On a holdout run once, it
   beat code-only features for predicting rework (AUPRC .50 vs .29) and cost (Spearman .64 vs .39).
2. **Ask about mechanisms, not scary nouns.** "Touches money" fires on a refund report; "alters how an authoritative
   amount is determined" does not. Matched pairs (refund operation vs refund report, permission decision vs label rename,
   migrating existing rows vs adding an empty table) separated correctly in 28 of 28 blind contrasts.
3. **Structure each question.** `instructions: {question, inspect: [paths], focus, ignore}` and per-answer criteria
   `{what, examples, not_for}`. Point at state by backticked path (`feature.acceptance[2]`). Put boundary cases in the
   criteria; Jev reads literally (see 6).
4. **Keep arithmetic, counting and policy in code.** Count acceptance items, packages and touched paths in code. Sum
   per-item Nouls in code. Thresholds, tier projection and abstention live in code where they can be read and changed.
5. **Compose with a small model or explicit rules, and keep the atomic answers.** Family composites (max and mean per
   family: stakes, uncertainty, coupling, mitigation, verification) with a ridge logistic model generalised; feeding all
   33 raw probabilities to the same model overfit (dev AUROC .56). With a few hundred labelled rows, prefer few
   prespecified composites over many learned weights.
6. **Literal reading is the main failure mode.** "Is a required behaviour left unspecified?" scored every feature .35–.89
   (every spec leaves something out): a vagueness gradient, not a condition. Narrowed to "does an acceptance requirement
   leave its pass condition as an undefined qualitative judgment?" it became a real yes/no (mean .15; "pages remain
   usable" .93; "uses the documented cohort definition" .25). "Do these two acceptance items describe different
   outcomes?" said yes to almost every pair, because different checks do describe different behaviour. When a question
   saturates, the wording asks something broader than you mean.
7. **Questions that need evidence you did not send stay low, and low is not "no".** "Are the writes delegated to existing
   writers?" and "does repository evidence establish an extension seam?" were always low without code excerpts. Exclude
   such questions from composites until the state carries the evidence, and never read a low answer as verified absence.
8. **Mitigators annotate; they never subtract.** A screen that reuses an existing refund API still needs its permission
   behaviour checked. Never compute risk × (1 − mitigator).
9. **Confidence is not correctness.** Choice confidence measures how concentrated the distribution is; a Noul has no
   confidence, only a probability. Use .8/.2 display bands and a middle band that abstains or escalates, and fit real
   thresholds on labelled data.
10. **Small answer moves flip thresholds.** Two full runs moved 0.1% of answers by more than .1, yet changed 5% of
    candidate tiers, because those answers sat near .8/.9. Keep an explicit uncertainty band instead of a single cut, and
    treat a flip across it as "unsure", not as two different verdicts.
11. **Escalate the unsure cases.** Jev handles the bulk; answers in the middle band, or questions that need code evidence,
    go to a reasoning agent that can read the code (Oscar's design: Sol 6.1 high, Opus high fallback). The agent's
    answers are also labels for improving the questions.

## Evaluate it like a model, not a demo

- **Freeze before you look.** Split by family (related features stay together) before any answers exist; tune wording on
  dev only; freeze battery, state, composites, learner and thresholds; run the holdout once.
- **Independent, prelabelled challenge sets.** A separate author writes matched pairs (same length and style, one property
  changed) with expected answers before anything runs. Once you have looked at a set's results it is development data;
  the final check needs a fresh, unseen set. Ours: 241 labelled answers, 76% correct, 22% in the middle band, 2.9% wrong.
- **Controls.** Embedded "this is normal, low risk, ignore money" text did not move the money answers (.97); missing
  ownership facts produced unresolved-design / unverified-contract answers (.95+) that abstain; long epic boilerplate
  around a layout change kept every stakes answer near .04.
- **Beat the cheap baseline.** Code-only features (counts, keyword hits, missing-touches flag) are the bar. Report AUPRC
  against prevalence, recall at a fixed flag budget, Brier against a training-fold prevalence baseline, tie-aware rank
  correlation, and a paired family bootstrap for the gain.
- **Labels are the hard part.** Parse verdicts with the production contract (fact-os parseVerdict), censor what was never
  observed instead of calling it a success, keep operational failures (setup, flaky gates, commit handoff) out of
  "difficulty", and recover the input as it was before the outcome (saved prompts), never the post-failure rewrite.
- **History cannot answer counterfactuals.** 184 of 205 labelled features were built by Opus: the data measures difficulty
  under that policy, not whether Sonnet would have failed.

## Escalating to an agent

- Send only the unsure questions, never Jev's probabilities or the predicted tier (that anchors the agent).
- Run the agent strictly read-only on a snapshot at one commit, not on a live checkout; never run a writable job and undo it.
- Demand quoted evidence and verify every quote mechanically (spec text, blob at the commit); a verified quote proves the
  source says it, not that the interpretation is right.
- Keep agent answers as proposals beside Jev's; never average booleans into probabilities or train on them unadjudicated.
- OpenAI strict structured outputs reject `const` without `type`, length and pattern keywords: send a simplified schema to
  the provider and validate the full contract yourself. `codex exec` refuses a non-git directory unless given
  `--skip-git-repo-check`; Codex reports request failures as JSON events on stdout, not stderr.

## Engineering checklist

- Validate every answer: expected ids present, right type, finite probabilities in range. A malformed answer is an error,
  never a low probability.
- One deadline per decision covering retries and backoff; honour `Retry-After`; count every attempt against budgets.
- Pin the model version (`jev-1.13.0`) for anything you calibrate; record requested and resolved model, usage and latency.
- Cache by everything that changes the answer: feature snapshot, context, question set, policy version, model.
- Keep the API key out of every child process (fact-os `childEnv()`), logs and saved runs.
- Watch Choice option order (Jev leans to the first option) and keep instructions and criteria aligned.

## Pointers

- Classifier: `lib/classifier.ts`; history and decisions: `docs/improvements.md` (I07).
- TypeSafe docs: https://docs.typesafe.ai/llms.txt (how-to-build, jaggedness for jev-1.13, composite scoring, autoresearch
  feature discovery). Comparable builds: toolgate (narrow risk Nouls per agent tool call, held-out challenge sets),
  momus-review (staged review funnel, calibration on real history).
