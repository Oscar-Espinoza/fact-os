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
import { isRisky } from './profiles.ts';
import { childEnv, envVar, loadConfig, log, mutate, paths, readControlFile } from './state.ts';
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
  if (typeof x.old !== 'string' || typeof x.new !== 'string' || typeof x.why !== 'string') return { error: '"old", "new" and "why" must be strings' };
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
  try { const v = m && JSON.parse(m[0]); return v && typeof v.agree === 'boolean' ? { agree: v.agree, reason: String(v.reason ?? '').slice(0, 600) } : null; } catch { return null; }
}

// ---- guards ----

// Why a draft cannot be a proposal at all (null: it can): the target and old text must be current, the change one real rewrite,
// and every evidence quote found word for word in its stated source.
export function shapeProblem(f: Feature, d: Draft, i: FixInput): string | null {
  const cur = d.target === 'description' ? f.description ?? '' : f.acceptance?.[d.target - 1];
  if (cur === undefined) return `acceptance item ${d.target} does not exist`;
  if (norm(cur) !== norm(d.old)) return 'the old text is not the current text';
  if (!d.new || norm(d.new) === norm(d.old)) return 'the replacement is empty or unchanged';
  if (d.new.length > FIX_MAX || d.new.length > Math.max(2 * d.old.length, d.old.length + 300)) return 'the replacement is too long';
  if (!d.evidence.length) return 'no evidence';
  const text = (src: string) => src === 'feedback' ? i.feedback : src === 'review' ? i.reviewEvidence.join('\n') : i.files.find((x) => x.path === src)?.text ?? null;
  for (const e of d.evidence) {
    const t = text(e.source);
    if (t == null) return `evidence source "${e.source}" is not one of the inputs`;
    if (/\.\.\.|…/.test(e.quote) || !norm(t).includes(norm(e.quote))) return `evidence not found verbatim in ${e.source}: "${e.quote.slice(0, 80)}"`;
  }
  return null;
}

const SENSITIVE = /\b(money|payments?|refunds?|price|pricing|tax|invoice|billing|charge|auth\w*|permissions?|roles?|tenants?|tenancy|security|secrets?|credentials?|privacy|personal data|pii|gdpr|delet\w*|purge|retention|migrations?|concurren\w*|race|locks?|idempoten\w*|transactions?|atomic)\b/i;
const TEST_WEAKENING = /\b(skip|skipped|weaken\w*|disable\w*|remove\w*|delete\w*|omit\w*|xfail|only)\b[^.]{0,40}\btests?\b|\btests?\b[^.]{0,40}\b(skip|skipped|weaken\w*|disable\w*|removed|deleted|omitted)\b/i;
// Why a proposal may only be applied by a person (null: auto may apply it).
export function protectedReason(f: Feature, d: Pick<Draft, 'target' | 'old' | 'new'>): string | null {
  if (d.target === 'description') return 'it rewrites the description, which can change the whole scope';
  if (f.tier === 'risky' || (f as { risk?: unknown }).risk === 'high' || isRisky(f)) return 'the feature is risky (money, auth, tenancy or similar)';
  const ctx = `${d.old}\n${d.new}`;
  if (SENSITIVE.test(ctx)) return `the requirement mentions ${SENSITIVE.exec(ctx)![0]}`;
  if (TEST_WEAKENING.test(d.new) && !TEST_WEAKENING.test(d.old)) return 'the replacement could weaken a test';
  if (!keepsWording(d.old, d.new)) return 'the replacement drops wording of the old requirement (its metric, scope or conditions)';
  return null;
}
// Every word of the old text (numbers aside) is still in the new one: a corrected number keeps its metric, scope and conditions.
export function keepsWording(old: string, next: string): boolean {
  const words = (s: string) => (s.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []);
  const have = new Set(words(next));
  return words(old).every((w) => have.has(w));
}

// ---- apply, dismiss, undo ----

export const fixId = (f: Feature, d: Draft, inputs: string): string =>
  'S' + createHash('sha256').update(JSON.stringify([f.id, d.target, d.old, d.new, inputs])).digest('hex').slice(0, 8);
export const specFixMode = (root: string): SpecFixMode | null => { const r = readControlFile(root); return r.ok ? r.control.specFixes ?? 'manual' : null; };

// Why `by` may not apply proposal `id` to `f` now (null: it may). Everything is rechecked at apply time.
export function applyProblem(root: string, config: Config, f: Feature, id: string, by: 'person' | 'auto'): string | null {
  const p = f.specFix;
  if (!p || p.id !== id) return 'no such proposal (it was replaced)';
  if (p.status !== 'proposed') return `the proposal is ${p.status}`;
  if (!['todo', 'stuck', 'paused'].includes(f.status)) return `the feature is ${f.status}; only a queued, stuck or paused feature can change its spec`;
  if (holdInputs(root, config, f) !== p.inputs) return 'the spec or its inputs changed since it was drafted';
  const cur = p.target === 'description' ? f.description ?? '' : f.acceptance?.[(p.target as number) - 1];
  if (cur === undefined || norm(cur) !== norm(p.old ?? '')) return 'the old text is not the current text';
  if (by === 'auto') {
    if (specFixMode(root) !== 'auto') return 'spec fixes are not in auto mode';
    const prot = protectedReason(f, { target: p.target!, old: p.old!, new: p.new! });
    if (prot) return `protected: ${prot}`;
    if (!p.verifier || p.verifier.provider !== 'codex' || p.verifier.agree !== true) return 'Codex did not verify it';
    if (!p.counted) return 'no counted, substantive failure preceded it';
    if ((f.specFixes ?? []).some((r) => r.by === 'auto')) return 'this feature already had its one automatic fix';
    if (f.status === 'paused') return 'a person paused the feature';
  }
  return null;
}

// Applies proposal `id` (one atomic change): replaces the text, records it, starts a new cycle (fresh tries, no reuse of the
// rejected build, no backoff), releases a matching spec-error hold, and keeps a person's pause. Returns why not, or null.
export async function applySpecFix(root: string, featureId: string, id: string, by: 'person' | 'auto'): Promise<string | null> {
  const config = loadConfig(root);
  const r = await mutate(root, 'features', (d) => {
    const f = d.features.find((x) => x.id === featureId);
    if (!f) return { err: 'unknown feature' };
    const err = applyProblem(root, config, f, id, by);
    if (err) return { err };
    const p = f.specFix!;
    if (p.target === 'description') f.description = p.new!; else f.acceptance[(p.target as number) - 1] = p.new!;
    (f.specFixes ??= []).push({ id, ts: now(), by, target: p.target!, old: p.old!, new: p.new!, why: p.why ?? '' });
    p.status = 'applied';
    Object.assign(f, { attempts: 0, refreshes: 0, updatedAt: now() });
    for (const k of ['rejected', 'envBuild', 'envBuildInputs', 'envFailures', 'envRetryAt', 'setupFailures', 'setupRetryAt', 'stop', 'sha'] as const) delete (f as unknown as Record<string, unknown>)[k];
    if (f.planningHold?.cause === 'spec-error') delete f.planningHold;
    if (f.status === 'stuck') f.status = 'todo';
    return { err: null, p };
  });
  if (r.err) return r.err;
  const p = r.p!, what = p.target === 'description' ? 'the description' : `acceptance item ${p.target}`;
  log(root, featureId, 'acceptance-changed', `spec fix ${id} applied ${by === 'auto' ? 'automatically' : 'by a person'} (${what}; drafted by ${p.drafter.model ?? 'the observer'}, ` +
    `${p.verifier ? `${p.verifier.agree ? 'verified' : 'not verified'} by ${p.verifier.model ?? p.verifier.provider}` : 'not verified'}): ${p.why}`, undefined, { attemptsReset: true });
  log(root, featureId, 'spec-fix-applied', `${id} ${by}: ${what}: "${p.old}" → "${p.new}"`);
  return null;
}

export async function dismissSpecFix(root: string, featureId: string, id: string): Promise<string | null> {
  const r = await mutate(root, 'features', (d) => {
    const f = d.features.find((x) => x.id === featureId);
    if (!f?.specFix || f.specFix.id !== id) return 'no such proposal';
    if (f.specFix.status !== 'proposed') return `the proposal is ${f.specFix.status}`;
    f.specFix.status = 'declined'; f.updatedAt = now(); // its inputs stay: no new draft for this same spec
    return null;
  });
  if (!r) log(root, featureId, 'spec-fix-declined', `${id} by a person`);
  return r;
}

// Restores the latest applied fix while the text is still exactly what it applied, on a feature nobody is building, reviewing
// or merging. A new cycle starts; a pause stays; the feature's one automatic fix stays spent.
export async function undoSpecFix(root: string, featureId: string): Promise<string | null> {
  const r = await mutate(root, 'features', (d) => {
    const f = d.features.find((x) => x.id === featureId);
    if (!f) return { err: 'unknown feature' };
    const last = [...(f.specFixes ?? [])].reverse().find((x) => !x.undone);
    if (!last || last !== f.specFixes!.at(-1)) return { err: 'no applied spec fix to undo' };
    if (!['todo', 'stuck', 'paused'].includes(f.status)) return { err: `the feature is ${f.status}` };
    const cur = last.target === 'description' ? f.description ?? '' : f.acceptance?.[(last.target as number) - 1];
    if (cur === undefined || norm(cur) !== norm(last.new)) return { err: 'the text changed since the fix was applied' };
    if (last.target === 'description') f.description = last.old; else f.acceptance[(last.target as number) - 1] = last.old;
    last.undone = now();
    Object.assign(f, { attempts: 0, refreshes: 0, updatedAt: now() });
    delete f.rejected; delete f.stop; delete f.sha;
    if (f.status === 'stuck') f.status = 'todo';
    return { err: null, last };
  });
  if (r.err) return r.err;
  log(root, featureId, 'acceptance-changed', `spec fix ${r.last!.id} undone by a person: the earlier text is back`, undefined, { attemptsReset: true });
  log(root, featureId, 'spec-fix-undone', `${r.last!.id}`);
  return null;
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
export function evidenceFiles(root: string, branch: string, id: string, budget = 12000): { path: string; text: string }[] {
  const short = /^[A-Z]\d+-\d+(?:-[A-Z])?/.exec(id)?.[0] ?? id, out: { path: string; text: string }[] = [];
  const names = git(['ls-tree', '-r', '--name-only', branch, '--', `tasks/evidence/${short}/`], root).out.split('\n').filter((n) => n && !/(^|\/)\.env/.test(n));
  let used = 0;
  for (const n of names.slice(0, 20)) {
    const t = git(['show', `${branch}:${n}`], root).out;
    if (!t || t.includes('\0')) continue;
    const part = t.slice(0, Math.min(6000, budget - used));
    if (!part) break;
    out.push({ path: n, text: part }); used += part.length;
  }
  return out;
}

// Features whose spec a fix may correct now: a queued feature held for a spec error with its current inputs, or a stuck one
// whose latest review (after its last launch) blamed the spec. Nothing is drafted twice for the same inputs.
export function candidates(root: string, config: Config, features: Feature[], byKey: Record<string, PromptReview>, events: Pick<LogEvent, 'feature' | 'event' | 'ts'>[]): { f: Feature; review: PromptReview; inputs: string }[] {
  return features.flatMap((f) => {
    if (f.status !== 'todo' && f.status !== 'stuck') return [];
    const mine = Object.values(byKey).filter((r) => r.feature === f.id && r.cause === 'spec-error').sort((a, b) => a.ts.localeCompare(b.ts)), review = mine.at(-1);
    if (!review) return [];
    const inputs = holdInputs(root, config, f); // only for features a spec-error review blamed: it reads the briefs
    if (f.specFix && f.specFix.inputs === inputs) return [];
    if (f.status === 'todo' && f.planningHold?.cause === 'spec-error' && f.planningHold.inputs === inputs) return [{ f, review: byKey[f.planningHold.review] ?? review, inputs }]; // the review that placed the hold
    const launch = [...events].reverse().find((e) => e.feature === f.id && e.event === 'launch');
    if (f.status === 'stuck' && (review.confidence === 'high' || review.confidence === 'medium') && (!launch || review.ts > launch.ts)) return [{ f, review, inputs }];
    return [];
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
// including proposals drafted earlier in manual mode. Everything it decides is recorded on the feature, so nothing repeats.
export async function specFixPass(root: string, config: Config, drafter: RoleConfig, verifier: RoleConfig | null, state: SpecFixState, events: LogEvent[], io: Io): Promise<void> {
  const day = Date.now() - 864e5;
  state.specFixRuns = (state.specFixRuns ?? []).filter((t) => Date.parse(t) > day);
  const tries = state.specFixTries ??= {};
  const features = (JSON.parse(readFileSync(paths(root).features, 'utf8')) as { features: Feature[] }).features;
  const todo = candidates(root, config, features, state.promptReviews ?? {}, events).filter((c) => (tries[c.inputs] ?? 0) < TRIES_PER_SPEC);
  for (const { f, review, inputs } of todo.slice(0, DRAFTS_PER_PASS)) {
    if (io.stopping() || state.specFixRuns.length >= DRAFTS_PER_DAY) break;
    state.specFixRuns.push(now());
    const branch = f.branch || config.branchPrefix + f.id, sha = git(['rev-parse', '--verify', '--quiet', branch], root).out || null;
    const input: FixInput = { feature: f, feedback: f.lastFeedback ?? '', reviewEvidence: review.evidence, files: sha ? evidenceFiles(root, branch, f.id) : [] };
    const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs(config, { ...drafter, permissionMode: 'plan' }, root), { cwd: root, env: childEnv(), input: draftPrompt(input), children: io.children, timeoutMin: 15 });
    if (io.stopping()) return;
    const c = parseClaudeOutput(r.out), d = c.ok ? parseDraft(c.text) : { error: c.error ?? 'the draft run failed' };
    if ('error' in d) { tries[inputs] = (tries[inputs] ?? 0) + 1; io.out(`observer: spec fix draft for ${f.id} failed: ${d.error}`); continue; }
    const base = { ts: now(), inputs, review: review.tag, sha, drafter: { model: drafter.model ?? null }, counted: countedFailure(events, f.id) };
    let proposal: SpecFixProposal;
    const bad = d.fix ? shapeProblem(f, d.fix, input) : null;
    if (!d.fix || bad) proposal = { id: `S-none-${inputs.slice(0, 8)}`, status: 'none', reason: d.fix ? `the draft was not usable: ${bad}` : d.reason, ...base };
    else {
      const v = verifier?.provider === 'codex' ? await runCodex(verifier, verifyPrompt(input, d.fix), root, io) : null;
      if (io.stopping()) return;
      const pv = v ? parseVerify(v.text) : null;
      proposal = { id: fixId(f, d.fix, inputs), status: 'proposed', ...base, target: d.fix.target, old: d.fix.old, new: d.fix.new, why: d.fix.why, evidence: d.fix.evidence,
        verifier: pv ? { provider: 'codex', model: v!.model, agree: pv.agree, reason: pv.reason } : { provider: verifier?.provider ?? 'none', model: verifier?.model ?? null, agree: null, reason: 'verification did not run or gave no usable answer' },
        ...(protectedReason(f, d.fix) ? { protectedBy: protectedReason(f, d.fix)! } : {}) };
    }
    const stored = await mutate(root, 'features', (data) => {
      const x = data.features.find((y) => y.id === f.id);
      if (!x || holdInputs(root, config, x) !== inputs) return false; // the spec changed while the agents ran
      x.specFix = proposal; return true;
    });
    if (!stored) continue;
    log(root, f.id, proposal.status === 'none' ? 'spec-fix-none' : 'spec-fix-proposed', proposal.status === 'none' ? proposal.reason ?? '' :
      `${proposal.id}: ${proposal.target === 'description' ? 'the description' : `acceptance item ${proposal.target}`}: "${proposal.old}" → "${proposal.new}"; ` +
      `Codex ${proposal.verifier?.agree === true ? 'agrees' : proposal.verifier?.agree === false ? `disagrees (${proposal.verifier.reason})` : 'did not verify'}`);
    io.out(`observer: spec fix for ${f.id}: ${proposal.status}`);
  }
  // Auto mode: apply every eligible proposal; record why the others stay with a person.
  if (specFixMode(root) !== 'auto') return;
  const now2 = (JSON.parse(readFileSync(paths(root).features, 'utf8')) as { features: Feature[] }).features;
  for (const f of now2.filter((x) => x.specFix?.status === 'proposed')) {
    const err = await applySpecFix(root, f.id, f.specFix!.id, 'auto');
    if (!err) { io.out(`observer: applied spec fix ${f.specFix!.id} to ${f.id} automatically`); continue; }
    if (f.specFix!.autoBlocked !== err) await mutate(root, 'features', (data) => { const x = data.features.find((y) => y.id === f.id); if (x?.specFix?.id === f.specFix!.id) x.specFix.autoBlocked = err; });
  }
}
