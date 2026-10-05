// Spec fixes: when a failed pass was the spec's fault, the observer drafts one replacement for one acceptance item (or the
// description) with Opus, a fresh Codex session verifies it against the evidence, and one guarded function applies it — by a
// person (manual mode, the dashboard's Apply) or, in auto mode, without asking when every auto guard passes. Agents only
// propose; this code changes the spec. Applying starts a new cycle through the ordinary build, gate and review: it never marks
// anything ready. Protected changes (risky features, description rewrites, money/auth/tenant/data/privacy/concurrency/test
// wording) are always left to a person.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { claudeArgs, exec, git, holdInputs, parseClaudeOutput, parseCodexEvents } from './foreman.ts';
import type { PromptReview } from './promptreview.ts';
import { riskFamilies } from './profiles.ts';
import { childEnv, envVar, loadConfig, mutate, mutateWithAudit, paths, publishPendingAudit, readControlFile } from './state.ts';
import type { Config, Feature, LogEvent, RoleConfig, SpecFixMode, SpecFixProposal, SpecFixRecord } from './types.ts';

export const FIX_MAX = 1500;           // characters of a replacement
const now = () => new Date().toISOString();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---- draft and verify ----

export interface FixInput { feature: Feature; feedback: string; reviewEvidence: string[]; files: { path: string; text: string }[] }
const numbered = (f: Feature) => (f.acceptance ?? []).map((a, i) => `${i + 1}. ${a}`).join('\n');
const sources = (i: FixInput) => [`## Rejection feedback\n${i.feedback.slice(0, 6000)}`, `## The failure review's evidence\n${i.reviewEvidence.map((e) => `- ${e}`).join('\n')}`,
  ...i.files.map((f) => `## File ${f.path} (from the feature's branch)\n${f.text}`)].join('\n\n');

export function draftPrompt(i: FixInput): string {
  const f = i.feature;
  return [`A feature of a software factory failed, and its failure review concluded the SPEC was wrong (not the code). Decide whether one`,
    'replacement of one acceptance item (or of the description) corrects a mistaken or unreachable requirement, keeping the feature\'s',
    'intent and every other requirement. You are read-only: change nothing. Read the repository if you need to.', '',
    `Feature ${f.id}: ${f.title}`, '', '## Description', f.description || '(none)', '', '## Acceptance', numbered(f), '', sources(i), '',
    'Rules: change exactly one item; never delete or add an item; keep the metric, scope and measurement conditions of a number you change;',
    'do not lower a requirement further than the evidence forces; never weaken a test, a security, money, tenant, privacy or data guarantee.',
    'If the failure was unfinished implementation, a bad measurement or the environment, there is no spec fix.', '',
    'Answer with ONLY a JSON object: {"fix": null | {"target": item number | "description", "old": the exact current text, "new": the',
    'replacement, "why": one or two plain sentences, "evidence": [1-4 {"quote": exact contiguous text, "source": "feedback" | "review" | a',
    'file path above}] that show the old text is mistaken or unreachable}, "reason": one sentence (why no fix, when fix is null)}.'].join('\n');
}

export interface Draft { target: number | 'description'; old: string; new: string; why: string; evidence: { quote: string; source: string }[] }
export function parseDraft(text: string): { fix: Draft | null; reason: string } | { error: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'not a JSON object' };
  let v: Record<string, unknown>;
  try { v = JSON.parse(m[0]); } catch { return { error: 'not JSON' }; }
  const reason = typeof v.reason === 'string' ? v.reason.slice(0, 400) : '';
  if (v.fix === null) return { fix: null, reason: reason || 'no supported correction' };
  const x = v.fix as Record<string, unknown> | undefined;
  if (!x || typeof x !== 'object') return { error: '"fix" must be null or an object' };
  const target = x.target === 'description' ? 'description' : Number.isInteger(x.target) && (x.target as number) > 0 ? x.target as number : null;
  if (target === null) return { error: '"target" must be an item number or "description"' };
  if (typeof x.old !== 'string' || typeof x.new !== 'string' || typeof x.why !== 'string' || !x.why.trim()) return { error: '"old", "new" and a non-empty "why" must be strings' };
  const evidence = (Array.isArray(x.evidence) ? x.evidence : []).flatMap((e) => {
    const q = e as Record<string, unknown>;
    return typeof q?.quote === 'string' && q.quote.trim() && typeof q.source === 'string' ? [{ quote: q.quote.trim().slice(0, 500), source: q.source.slice(0, 200) }] : [];
  }).slice(0, 4);
  return { fix: { target, old: x.old, new: x.new.trim(), why: x.why.trim().slice(0, 600), evidence }, reason };
}

export function verifyPrompt(i: FixInput, d: Draft): string {
  const f = i.feature;
  return ['Verify a proposed correction to a feature spec. You are read-only: change nothing. Another model drafted it after the',
    'feature failed review. Decide whether the evidence shows the OLD requirement was mistaken or unreachable (not merely that one build',
    'missed it, that the implementation is unfinished, or that the measurement conditions were bad), and whether the NEW text keeps the',
    'feature\'s intent without lowering it further than that evidence forces.', '',
    `Feature ${f.id}: ${f.title}`, '', '## Description', f.description || '(none)', '', '## Acceptance', numbered(f), '', sources(i), '',
    `## Proposed change (${d.target === 'description' ? 'the description' : `acceptance item ${d.target}`})`, `OLD: ${d.old}`, `NEW: ${d.new}`, `WHY: ${d.why}`,
    `EVIDENCE: ${d.evidence.map((e) => `"${e.quote}" (${e.source})`).join('; ')}`, '',
    'Answer with ONLY a JSON object: {"agree": boolean, "reason": one or two sentences}.'].join('\n');
}
export function parseVerify(text: string): { agree: boolean; reason: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  // Usable only with a boolean and a real reason: anything less is no verification at all.
  try { const v = m && JSON.parse(m[0]); return v && typeof v.agree === 'boolean' && typeof v.reason === 'string' && v.reason.trim() ? { agree: v.agree, reason: v.reason.trim().slice(0, 600) } : null; } catch { return null; }
}

// ---- guards ----

// Why a draft cannot be a proposal at all (null: it can): the target and old text must be exactly current, the change one real
// rewrite at most twice as long, and every evidence quote found word for word in its stated source.
export function shapeProblem(f: Feature, d: Draft, i: FixInput): string | null {
  const cur = textOf(f, d.target);
  if (cur === undefined) return `acceptance item ${d.target} does not exist`;
  if (cur.trim() !== d.old.trim()) return 'the old text is not the current text';
  if (!d.new || norm(d.new) === norm(d.old)) return 'the replacement is empty or unchanged';
  if (d.new.length > FIX_MAX || d.new.length > 2 * d.old.length) return 'the replacement is too long';
  if (!d.why) return 'no reason given';
  if (!d.evidence.length) return 'no evidence';
  const text = (src: string) => src === 'feedback' ? i.feedback : src === 'review' ? i.reviewEvidence.join('\n') : i.files.find((x) => x.path === src)?.text ?? null;
  for (const e of d.evidence) {
    const t = text(e.source);
    if (t == null) return `evidence source "${e.source}" is not one of the inputs`;
    if (/\.\.\.|…/.test(e.quote) || !norm(t).includes(norm(e.quote))) return `evidence not found verbatim in ${e.source}: "${e.quote.slice(0, 80)}"`;
  }
  return null;
}
const textOf = (f: Feature, target: number | 'description'): string | undefined => target === 'description' ? f.description ?? '' : f.acceptance?.[target - 1];

const SENSITIVE = /\b(money|payments?|pay|refunds?|prices?|pricing|tax(es)?|invoices?|billing|charge[ds]?|currency|auth\w*|log ?in|sessions?|permissions?|roles?|tenants?|tenancy|security|secrets?|credentials?|tokens?|privacy|personal|pii|gdpr|delet\w*|purge|retention|erase|migrations?|schema|concurren\w*|race|locks?|idempoten\w*|transactions?|atomic\w*|state machine|exactly once|at least once|duplicat\w*|consisten\w*)\b/i;
const TESTISH = /\b(tests?|suites?|assert\w*|coverage|skip\w*|xfail|flak\w*)\b/i;
export function protectedReason(f: Feature, d: Pick<Draft, 'target' | 'old' | 'new'>): string | null {
  if (d.target === 'description') return 'it rewrites the description, which can change the whole scope';
  if (f.tier === 'risky' || (f as { risk?: unknown }).risk === 'high' || riskFamilies(`${f.title}\n${f.description ?? ''}`).length) return 'the feature is risky (money, auth, tenancy or similar)';
  const ctx = [f.title, f.description ?? '', ...(f.acceptance ?? []), d.new].join('\n');
  if (SENSITIVE.test(ctx)) return `the feature's requirements mention ${SENSITIVE.exec(ctx)![0]}`;
  if (TESTISH.test(`${d.old}\n${d.new}`)) return 'the requirement is about tests';
  return correctionOnly(d.old, d.new);
}
// Words, numbers and the symbols that carry meaning (comparisons, signs, units like %), in order.
const toks = (s: string) => s.toLowerCase().match(/\d+(?:[.,]\d+)?|[a-z][a-z'-]*|[<>]=?|[=≥≤±%+\-*/]/g) ?? [];
const isNum = (t: string) => /^\d/.test(t);
// Null when `next` is `old` with only its quantities changed: every word, comparison, sign and unit identical and in order, the
// same number of quantities, nothing added or removed. Anything else (an added condition, a reversed comparison, a dropped number)
// needs a person; else why not.
export function correctionOnly(old: string, next: string): string | null {
  const a = toks(old), b = toks(next);
  if (!a.some(isNum)) return 'only a corrected quantity can be applied automatically';
  if (a.length !== b.length) return a.filter(isNum).length !== b.filter(isNum).length ? 'the quantities of the old requirement are not all kept' : 'the replacement adds or removes wording';
  for (let i = 0; i < a.length; i++) {
    if (isNum(a[i]!) !== isNum(b[i]!)) return 'a quantity of the old requirement has no replacement';
    if (!isNum(a[i]!) && a[i] !== b[i]) return `the replacement changes "${a[i]}" to "${b[i]}"`;
  }
  return a.some((t, i) => isNum(t) && t !== b[i]) ? null : 'no quantity changes';
}

// ---- apply, dismiss, undo ----

export const fixId = (f: Feature, d: Draft, inputs: string): string =>
  'S' + createHash('sha256').update(JSON.stringify([f.id, d.target, d.old, d.new, inputs])).digest('hex').slice(0, 8);
// The project's spec-fix mode, validated against its config like the foreman's own read (null: the control file is invalid).
export const specFixMode = (root: string, config?: Config): SpecFixMode | null => {
  let cfg = config; try { cfg ??= loadConfig(root); } catch { return null; }
  const r = readControlFile(root, cfg); return r.ok ? r.control.specFixes ?? 'manual' : null;
};
const readEvents = (root: string, id: string): LogEvent[] => {
  let text = ''; try { text = readFileSync(paths(root).log, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((l) => { if (!l.includes(`"${id}"`)) return []; try { const e = JSON.parse(l) as LogEvent; return e.feature === id ? [e] : []; } catch { return []; } });
};
// The failure a proposal answers is still the feature's latest: no launch since, and (for a held feature) the same hold.
// A hold a spec fix answers: a spec error found by a review or the pre-launch check, or a conflict (or a plan too long: needs-split)
// the planner found before any build.
const specHold = (h: Feature['planningHold']): boolean => h?.cause === 'spec-error' || h?.cause === 'spec-conflict' || h?.cause === 'needs-split';
export function currentFailure(f: Feature, p: Pick<SpecFixProposal, 'review' | 'launch' | 'inputs'>, events: Pick<LogEvent, 'event' | 'ts'>[]): string | null {
  const last = [...events].reverse().find((e) => e.event === 'launch');
  if (p.launch && last && last.ts !== p.launch) return 'the feature was launched again since';
  if (f.status === 'todo' || (f.status === 'paused' && f.planningHold)) {
    if (!specHold(f.planningHold) || f.planningHold!.review !== p.review || f.planningHold!.inputs !== p.inputs) return 'the spec-error hold it answers is gone';
  } else if (f.status !== 'stuck' && f.status !== 'paused') return `the feature is ${f.status}`;
  return null;
}

// The feature branch's current commit (null: no branch). A proposal's evidence was read at the commit it records; when the branch
// moved, that evidence may no longer be the feature's, so the proposal is stale.
export const branchHead = (root: string, config: Config, f: Feature): string | null =>
  git(['rev-parse', '--verify', '--quiet', f.branch || config.branchPrefix + f.id], root).out || null;
export interface ApplyOpts { stopping?: () => boolean }
// Why `by` may not apply proposal `id` to `f` now (null: it may). Everything is rechecked at apply time, under the lock.
export function applyProblem(root: string, config: Config, f: Feature, id: string, by: 'person' | 'auto', events: LogEvent[] = readEvents(root, f.id)): string | null {
  const p = f.specFix;
  if (!p || p.id !== id) return 'no such proposal (it was replaced)';
  if (p.status !== 'proposed') return `the proposal is ${p.status}`;
  if (!['todo', 'stuck', 'paused'].includes(f.status)) return `the feature is ${f.status}; only a queued, stuck or paused feature can change its spec`;
  if (holdInputs(root, config, f) !== p.inputs) return 'the spec or its inputs changed since it was drafted';
  const cur = textOf(f, p.target!);
  if (cur === undefined || cur.trim() !== (p.old ?? '').trim()) return 'the old text is not the current text';
  if (!p.new || p.new.length > FIX_MAX || p.new.length > 2 * (p.old ?? '').length) return 'the replacement is out of bounds';
  const stale = currentFailure(f, p, events);
  if (stale) return stale;
  if (p.sha !== undefined && branchHead(root, config, f) !== p.sha) return "the feature's branch changed since the fix was drafted";
  if (by === 'auto') {
    if (specFixMode(root, config) !== 'auto') return 'spec fixes are not in auto mode (or the control file is invalid)';
    if (f.status === 'paused') return 'a person paused the feature';
    const prot = protectedReason(f, { target: p.target!, old: p.old!, new: p.new! });
    if (prot) return `protected: ${prot}`;
    if (!p.verifier || p.verifier.provider !== 'codex' || p.verifier.agree !== true || !p.verifier.reason) return 'Codex did not verify it';
    if (!countedFailure(events, f.id)) return 'no counted, substantive failure preceded it';
    if ((f.specFixes ?? []).some((r) => r.by === 'auto')) return 'this feature already had its one automatic fix';
  }
  return null;
}

const OBSOLETE = ['rejected', 'envBuild', 'envBuildInputs', 'envFailures', 'envRetryAt', 'setupFailures', 'setupRetryAt', 'stop', 'sha'] as const;
const newCycle = (f: Feature) => {
  Object.assign(f, { attempts: 0, refreshes: 0, updatedAt: now() });
  for (const k of OBSOLETE) delete (f as unknown as Record<string, unknown>)[k];
  if (f.status === 'stuck') f.status = 'todo'; // a pause stays
};
const decide = (f: Feature, inputs: string, what: string) => {
  const d = f.specFixDecisions ??= {}; d[inputs] = what;
  const keys = Object.keys(d); if (keys.length > 20) delete d[keys[0]!];
};

// Applies proposal `id` (one atomic change, logged under the same lock): replaces the text, records it with its provenance,
// starts a new cycle, releases the matching spec-error hold, marks the old feedback as belonging to the earlier requirement,
// and keeps a person's pause. Returns why not, or null.
export async function applySpecFix(root: string, featureId: string, id: string, by: 'person' | 'auto', opts: ApplyOpts = {}): Promise<string | null> {
  const config = loadConfig(root);
  return mutateWithAudit(root, (d, emit) => {
    if (opts.stopping?.()) return 'stopping';
    const f = d.features.find((x) => x.id === featureId);
    if (!f) return 'unknown feature';
    const err = applyProblem(root, config, f, id, by);
    if (err) return err;
    const p = f.specFix!, what = p.target === 'description' ? 'the description' : `acceptance item ${p.target}`;
    if (p.target === 'description') f.description = p.new!; else f.acceptance[(p.target as number) - 1] = p.new!;
    if (specHold(f.planningHold) && f.planningHold!.review === p.review) delete f.planningHold;
    if (f.lastFeedback) f.lastFeedback = `[This feedback was about the earlier requirements: ${what} has since been corrected from "${p.old}" to "${p.new}".]\n${f.lastFeedback}`;
    newCycle(f);
    (f.specFixes ??= []).push({ id, ts: now(), by, target: p.target!, old: p.old!, new: p.new!, why: p.why ?? '', after: holdInputs(root, config, f),
      drafter: p.drafter, ...(p.verifier ? { verifier: p.verifier } : {}), ...(p.evidence ? { evidence: p.evidence } : {}), review: p.review });
    p.status = 'applied'; decide(f, p.inputs, 'applied');
    // Saved with the change and logged under the same lock (mutateWithAudit): no launch can come between, and a failed state
    // write logs nothing.
    emit({ feature: featureId, event: 'acceptance-changed', attemptsReset: true, detail: `spec fix ${id} applied ${by === 'auto' ? 'automatically' : 'by a person'} (${what}; drafted by ` +
      `${p.drafter.model ?? 'the observer'}, ${p.verifier?.agree === true ? `verified by ${p.verifier.model ?? p.verifier.provider}` : 'not verified'}): ${p.why}` });
    emit({ feature: featureId, event: 'spec-fix-applied', detail: `${id} ${by}: ${what}: "${p.old}" → "${p.new}"` });
    return null;
  });
}

export async function dismissSpecFix(root: string, featureId: string, id: string): Promise<string | null> {
  return mutateWithAudit(root, (d, emit) => {
    const f = d.features.find((x) => x.id === featureId);
    if (!f?.specFix || f.specFix.id !== id) return 'no such proposal';
    if (f.specFix.status !== 'proposed') return `the proposal is ${f.specFix.status}`;
    f.specFix.status = 'declined'; f.updatedAt = now(); decide(f, f.specFix.inputs, 'declined');
    emit({ feature: featureId, event: 'spec-fix-declined', detail: `${id} by a person` });
    return null;
  });
}

// Why record `id` cannot be undone now (null: it can): it is the latest fix, not undone, the whole spec is exactly what it left,
// and nobody is building, reviewing or merging the feature.
export function undoProblem(root: string, config: Config, f: Feature, id: string): string | null {
  const last = f.specFixes?.at(-1);
  if (!last || last.id !== id || last.undone) return 'that is not the latest applied spec fix';
  if (!['todo', 'stuck', 'paused'].includes(f.status)) return `the feature is ${f.status}`;
  const cur = textOf(f, last.target);
  if (cur === undefined || cur.trim() !== last.new.trim() || (last.after && holdInputs(root, config, f) !== last.after)) return 'the spec changed since the fix was applied';
  return null;
}
// Restores record `id` (the one the person was shown). A new cycle starts; a pause stays; the one automatic fix stays spent.
export async function undoSpecFix(root: string, featureId: string, id: string): Promise<string | null> {
  const config = loadConfig(root);
  return mutateWithAudit(root, (d, emit) => {
    const f = d.features.find((x) => x.id === featureId);
    if (!f) return 'unknown feature';
    const err = undoProblem(root, config, f, id);
    if (err) return err;
    const last = f.specFixes!.at(-1)!;
    if (last.target === 'description') f.description = last.old; else f.acceptance[(last.target as number) - 1] = last.old;
    last.undone = now();
    newCycle(f);
    emit({ feature: featureId, event: 'acceptance-changed', attemptsReset: true, detail: `spec fix ${id} undone by a person: the earlier text is back` });
    emit({ feature: featureId, event: 'spec-fix-undone', detail: id });
    return null;
  });
}

export type { SpecFixProposal, SpecFixRecord };

// ---- the observer's pass ----


export const DRAFTS_PER_PASS = 2, DRAFTS_PER_DAY = 10, TRIES_PER_SPEC = 2;
export interface SpecFixState { specFixRuns?: string[]; specFixTries?: Record<string, number>; promptReviews?: Record<string, PromptReview> }
interface Io { out: (s: string) => void; children: Set<ChildProcess>; stopping: () => boolean }

// Whether the feature's latest failure was counted and substantive: a validated review rejection or an own-code gate failure
// (never setup, environment, evaluator-run or merge trouble, which are no reason to change a requirement).
export function countedFailure(events: Pick<LogEvent, 'feature' | 'event' | 'detail' | 'stop' | 'failure'>[], id: string): boolean {
  const e = [...events].reverse().find((x) => x.feature === id && (x.event === 'failed' || x.event === 'stuck'));
  return !!e?.stop?.counted && (e.failure ? e.failure === 'review' || e.failure === 'gate-own' : /^(FAILED |BLOCKING:|CHEATING:)/.test(e.detail || ''));
}
// The evidence files the feature's branch committed (tasks/evidence/<short id>/), bounded; never an .env file or a binary.
// Read at `rev` (the feature's commit when the fix was drafted), never the moving branch.
export function evidenceFiles(root: string, rev: string, id: string, budget = 12000): { path: string; text: string }[] {
  const short = /^[A-Z]\d+-\d+(?:-[A-Z])?/.exec(id)?.[0] ?? id, out: { path: string; text: string }[] = [];
  const names = git(['ls-tree', '-r', '--name-only', rev, '--', `tasks/evidence/${short}/`], root).out.split('\n').filter((n) => n && !/(^|\/)\.env/.test(n));
  let used = 0;
  for (const n of names.slice(0, 20)) {
    const t = git(['show', `${rev}:${n}`], root).out;
    if (!t || t.includes('\0')) continue;
    const part = t.slice(0, Math.min(6000, budget - used));
    if (!part) break;
    out.push({ path: n, text: part }); used += part.length;
  }
  return out;
}

// Features whose spec a fix may correct now, each anchored to the failed launch it answers: a queued feature held for a spec
// error with its current inputs, or a stuck one whose latest review came after its last launch and whose spec is still the
// one that launch was given. Inputs already decided (declined, no fix, applied) or proposed are never drafted again.
export function candidates(root: string, config: Config, features: Feature[], byKey: Record<string, PromptReview>, events: Pick<LogEvent, 'feature' | 'event' | 'ts' | 'inputs'>[]):
  { f: Feature; review: PromptReview; key: string; inputs: string; launch: string | undefined }[] {
  return features.flatMap((f) => {
    if (f.status !== 'todo' && f.status !== 'stuck') return [];
    const mine = Object.entries(byKey).filter(([, r]) => r.feature === f.id && r.cause === 'spec-error').sort((a, b) => (a[1].passStart ?? a[1].ts).localeCompare(b[1].passStart ?? b[1].ts)), latest = mine.at(-1);
    const before = !!f.planningHold && (f.planningHold.review.startsWith('precheck:') || f.planningHold.cause === 'spec-conflict' || f.planningHold.cause === 'needs-split'); // held before any build
    if (!latest && !before) return [];
    const inputs = holdInputs(root, config, f); // only for features a spec-error review blamed: it reads the briefs
    if ((f.specFix && f.specFix.inputs === inputs) || f.specFixDecisions?.[inputs]) return [];
    const launch = [...events].reverse().find((e) => e.feature === f.id && e.event === 'launch');
    if (f.status === 'todo' && before) {
      // The pre-launch check against the spec-writing notes (lib/specnotes.ts), or the planner's conflicts (lib/plan.ts, with their
      // file:line quotes): the hold's evidence is the review.
      const h = f.planningHold!;
      return specHold(h) && h.inputs === inputs ? [{ f, review: { ts: h.ts, feature: f.id, tag: '', role: 'builder', model: '', effort: '', notes: '', kind: 'evaluator-rejected', next: '',
        cause: 'spec-error', evidence: h.evidence, confidence: 'high', suggestion: '', target: null, cost: 0 } as PromptReview, key: h.review, inputs, launch: undefined }] : [];
    }
    if (f.status === 'todo') {
      const h = f.planningHold, held = h && byKey[h.review];
      return h?.cause === 'spec-error' && h.inputs === inputs && held ? [{ f, review: held, key: h.review, inputs, launch: launch?.ts }] : [];
    }
    // A stuck feature: only a review of its latest pass (by the pass it judged, not when the review finished) and only while the
    // spec is still the one that pass was launched with. A review that does not say which pass it judged is never used.
    if (!latest) return [];
    const [key, review] = latest;
    if (!launch || review.passStart !== launch.ts || (review.confidence !== 'high' && review.confidence !== 'medium') || (launch.inputs && launch.inputs !== inputs)) return [];
    return [{ f, review, key, inputs, launch: launch.ts }];
  });
}

async function runCodex(cfg: RoleConfig, prompt: string, cwd: string, io: Io): Promise<{ text: string; model: string | null } | null> {
  const d = mkdtempSync(join(tmpdir(), 'fact-os-verify-')), last = join(d, 'last.txt');
  try {
    const args = ['exec', ...(cfg.model ? ['-m', cfg.model] : []), ...(cfg.effort ? ['-c', `model_reasoning_effort="${cfg.effort}"`] : []),
      '-s', 'read-only', '-c', 'approval_policy="never"', '--json', '--color', 'never', '-o', last, '-'];
    const r = await exec(envVar('CODEX') || 'codex', args, { cwd, env: childEnv(), input: prompt, children: io.children, timeoutMin: 15 });
    const text = existsSync(last) ? readFileSync(last, 'utf8').trim() : '';
    return r.code === 0 && text && !parseCodexEvents(r.out).error ? { text, model: cfg.model ?? null } : null;
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// Drafts (Opus), checks and verifies (Codex) at most DRAFTS_PER_PASS fixes, then, in auto mode, applies the eligible ones —
// including proposals drafted earlier in manual mode. Every paid run is reserved (and `save`d) before it starts; retries are
// counted per feature and spec; a proposal is published only while the failure it answers is still current.
export async function specFixPass(root: string, config: Config, drafter: RoleConfig, verifier: RoleConfig | null, state: SpecFixState, events: LogEvent[], io: Io, save: () => void = () => {}): Promise<void> {
  const day = Date.now() - 864e5;
  state.specFixRuns = (state.specFixRuns ?? []).filter((t) => Date.parse(t) > day);
  const tries = state.specFixTries ??= {};
  const reserve = () => { state.specFixRuns!.push(now()); save(); };
  await publishPendingAudit(root); // events a failed append left pending
  const features = (JSON.parse(readFileSync(paths(root).features, 'utf8')) as { features: Feature[] }).features;
  const todo = candidates(root, config, features, state.promptReviews ?? {}, events).filter((c) => (tries[`${c.f.id}:${c.inputs}`] ?? 0) < TRIES_PER_SPEC);
  for (const { f, review, key, inputs, launch } of todo.slice(0, DRAFTS_PER_PASS)) {
    if (io.stopping() || state.specFixRuns.length >= DRAFTS_PER_DAY) break;
    const tk = `${f.id}:${inputs}`;
    tries[tk] = (tries[tk] ?? 0) + 1; reserve(); // a crash mid-run still counts the attempt and the run
    const sha = branchHead(root, config, f);
    const pre = key.startsWith('precheck:'), feedback = pre ? `Pre-launch check against the factory's learned spec-writing rules (no build has run):\n${review.evidence.join('\n')}` : f.lastFeedback ?? '';
    const input: FixInput = { feature: f, feedback, reviewEvidence: review.evidence, files: sha && !pre ? evidenceFiles(root, sha, f.id) : [] };
    const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs(config, { ...drafter, permissionMode: 'plan' }, root), { cwd: root, env: childEnv(), input: draftPrompt(input), children: io.children, timeoutMin: 15 });
    if (io.stopping()) return;
    const c = parseClaudeOutput(r.out), d = c.ok ? parseDraft(c.text) : { error: c.error ?? 'the draft run failed' };
    if ('error' in d) { io.out(`observer: spec fix draft for ${f.id} failed: ${d.error}`); save(); continue; }
    const base = { ts: now(), inputs, review: key, sha, ...(launch ? { launch } : {}), drafter: { model: drafter.model ?? null }, counted: countedFailure(events, f.id) };
    let proposal: SpecFixProposal;
    const bad = d.fix ? shapeProblem(f, d.fix, input) : null;
    if (!d.fix || bad) proposal = { id: `S-none-${inputs.slice(0, 8)}`, status: 'none', reason: d.fix ? `the draft was not usable: ${bad}` : d.reason, ...base };
    else {
      let v: { text: string; model: string | null } | null = null;
      // Verification is a run too: only within the day's budget (without it the proposal stays unverified, for a person).
      if (verifier?.provider === 'codex' && state.specFixRuns.length < DRAFTS_PER_DAY) { reserve(); v = await runCodex(verifier, verifyPrompt(input, d.fix), root, io); }
      if (io.stopping()) return;
      const pv = v ? parseVerify(v.text) : null;
      const prot = protectedReason(f, d.fix);
      proposal = { id: fixId(f, d.fix, inputs), status: 'proposed', ...base, target: d.fix.target, old: d.fix.old, new: d.fix.new, why: d.fix.why, evidence: d.fix.evidence,
        verifier: pv ? { provider: 'codex', model: v!.model, agree: pv.agree, reason: pv.reason } : { provider: verifier?.provider ?? 'none', model: verifier?.model ?? null, agree: null, reason: 'verification did not run or gave no usable answer' },
        ...(prot ? { protectedBy: prot } : {}) };
    }
    const stored = await mutateWithAudit(root, (data, emit) => {
      if (io.stopping()) return false;
      const x = data.features.find((y) => y.id === f.id);
      // Published only while it still answers the latest failure with the same spec.
      if (!x || holdInputs(root, config, x) !== inputs || currentFailure(x, proposal, readEvents(root, f.id)) || branchHead(root, config, x) !== sha || (x.specFix && x.specFix.inputs === inputs)) return false;
      x.specFix = proposal;
      if (proposal.status === 'none') decide(x, inputs, 'none');
      emit({ feature: f.id, event: proposal.status === 'none' ? 'spec-fix-none' : 'spec-fix-proposed', detail: proposal.status === 'none' ? proposal.reason ?? '' :
        `${proposal.id}: ${proposal.target === 'description' ? 'the description' : `acceptance item ${proposal.target}`}: "${proposal.old}" → "${proposal.new}"; ` +
        `Codex ${proposal.verifier?.agree === true ? 'agrees' : proposal.verifier?.agree === false ? `disagrees (${proposal.verifier.reason})` : 'did not verify'}` });
      return true;
    });
    save();
    if (stored) io.out(`observer: spec fix for ${f.id}: ${proposal.status}`);
  }
  // Auto mode: apply every eligible proposal; record why the others stay with a person. Nothing happens once stopping.
  if (io.stopping() || specFixMode(root, config) !== 'auto') return;
  const waiting = (JSON.parse(readFileSync(paths(root).features, 'utf8')) as { features: Feature[] }).features.filter((x) => x.specFix?.status === 'proposed');
  for (const f of waiting) {
    if (io.stopping()) return;
    const err = await applySpecFix(root, f.id, f.specFix!.id, 'auto', { stopping: io.stopping });
    if (!err) { io.out(`observer: applied spec fix ${f.specFix!.id} to ${f.id} automatically`); continue; }
    if (err === 'stopping') return;
    if (f.specFix!.autoBlocked !== err) await mutate(root, 'features', (data) => { const x = data.features.find((y) => y.id === f.id); if (x?.specFix?.id === f.specFix!.id && x.specFix.status === 'proposed') x.specFix.autoBlocked = err; });
  }
}
