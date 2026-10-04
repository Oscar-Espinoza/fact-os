// I07 phase 1: a shadow classifier. TypeSafe Jev (a System One model: typed answers with probabilities) judges each feature's
// tier and whether it should be split. Shadow mode only records the answers and what would happen; it never changes a
// feature. The calibrated thresholds, apply mode, the launch backstop and split drafting come after a benchmark
// (docs/improvements.md I07).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, envVar } from './state.ts';
import { isRisky } from './profiles.ts';
import { TIERS, type ClassifierConfig, type Feature, type Tier } from './types.ts';

export const RUBRIC_VERSION = 'i07-v1';
// The six answers: the five tiers, and an abstention when the spec is too thin to route (never persisted as a tier).
export const CLASSIFIER_CHOICES = [...TIERS, 'insufficient_info'] as const;
export type ClassifierChoice = (typeof CLASSIFIER_CHOICES)[number];
const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';

// The questions, agreed with the Codex design partner. Each is independent: needsSplit cannot see the tier answer.
export const QUESTIONS = {
  tier: {
    type: 'choice',
    instructions: 'Choose the primary builder/reviewer routing need for the change this feature describes. Routine authorized API ' +
      'permission checks do not by themselves make a feature risky. When categories overlap, choose investigate if the root cause or ' +
      'approach must be found first, otherwise risky if money, authorization, tenant isolation, migrations, concurrency or critical state ' +
      'transitions change, otherwise hard if the plan will likely change inside the code, otherwise multi if it spans several files or ' +
      'packages, otherwise normal. Choose insufficient_info when the scope, acceptance or boundaries are too incomplete to judge.',
    criteria: {
      normal: 'A clear, well-specified bounded change in one area.',
      multi: 'Several files or packages with moderate complexity and understood boundaries.',
      hard: 'The implementation plan will likely change after inspecting the code; not mainly an unknown root cause.',
      risky: 'Changes money, authorization or tenant isolation, migrations, concurrency, critical state transitions, or a large refactor needing adversarial review.',
      investigate: 'The root cause or correct approach is unknown and needs an investigation first.',
      insufficient_info: 'Scope, acceptance or boundary context is too incomplete to choose a tier reliably.',
    },
  },
  needsSplit: {
    type: 'noul',
    instructions: 'Does this scope contain two or more separately verifiable implementation outcomes whose separation would materially ' +
      'reduce coupling or delivery risk for a single builder and evaluator pass? Judge from this state alone; a split must keep every ' +
      'intermediate state safe and each piece independently verifiable.',
    criteria: {
      true: 'At least two coherent outcomes with an explicit dependency boundary and independently bounded verification; several coupled state machines or distinct production consumers make one pass fragile.',
      false: 'One bounded outcome or transactional invariant; separating it would only create scaffolding, unsafe intermediate behaviour or pieces that cannot be verified alone. Many files alone are not enough.',
    },
  },
} as const;

// What the classifier sees: the feature as intake wrote it, and its dependencies in brief. No repository access.
export function classifierState(f: Feature, features: Feature[]): Record<string, unknown> {
  const byId = new Map(features.map((x) => [x.id, x]));
  return {
    feature: { id: f.id, title: f.title, description: f.description, acceptance: f.acceptance, surface: f.surface,
      touches: f.touches ?? [], touchesKnown: Array.isArray(f.touches) && f.touches.length > 0 },
    dependencies: (f.deps || []).map((id) => ({ id, title: byId.get(id)?.title ?? null, status: byId.get(id)?.status ?? 'unknown' })),
  };
}
export const inputHash = (state: unknown): string =>
  createHash('sha256').update(JSON.stringify({ rubric: RUBRIC_VERSION, questions: QUESTIONS, state })).digest('hex').slice(0, 16);

// The key: TYPESAFE_API_KEY, else fact-os's own .env (beside lib/). Never logged or written anywhere.
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
export function typesafeKey(envFile = join(HERE, '..', '.env')): string | null {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim() || null;
  }
  return null;
}

export interface JevAnswer { model: string; tier: ClassifierChoice; probabilities: Record<string, number>; confidence: number; needsSplit: number }
// One request; retries only rate limits, overload and network errors, a bounded number of times. Errors never throw.
export async function askJev(cfg: ClassifierConfig, state: unknown, key: string): Promise<{ ok: true; answer: JevAnswer } | { ok: false; error: string; status?: number }> {
  const url = envVar('TYPESAFE_URL') || DEFAULT_URL;
  let last = 'no attempt';
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, state, questions: QUESTIONS }), signal: AbortSignal.timeout(cfg.timeoutMs) });
    } catch (e) { last = `request failed: ${(e as Error).message}`; continue; }
    if (res.status === 429 || res.status === 529) { last = `HTTP ${res.status}`; continue; }
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}${res.status === 401 ? ' (invalid TypeSafe API key)' : ''}` };
    const body = await res.json().catch(() => null) as { model?: unknown; answers?: Record<string, Record<string, unknown>> } | null;
    const t = body?.answers?.tier, s = body?.answers?.needsSplit;
    if (!t || t.type !== 'choice' || !(CLASSIFIER_CHOICES as readonly string[]).includes(t.choice as string) || typeof t.confidence !== 'number' ||
      !t.probabilities || typeof t.probabilities !== 'object' || !s || s.type !== 'noul' || typeof s.noul !== 'number')
      return { ok: false, error: 'unexpected answer shape from TypeSafe' };
    return { ok: true, answer: { model: typeof body!.model === 'string' ? body!.model : cfg.model, tier: t.choice as ClassifierChoice,
      probabilities: t.probabilities as Record<string, number>, confidence: t.confidence, needsSplit: s.noul } };
  }
  return { ok: false, error: last };
}

// What apply mode would do, recorded in shadow mode. A person's tier is never touched. Abstaining keeps today's routing.
// Protected features (risk "high", or risk keywords) only take a risky or investigate answer: never downgrade them on a
// model's word. Confidence is TypeSafe's (concentration of the six-way distribution), against provisional thresholds.
export function decide(f: Feature, a: JevAnswer, cfg: ClassifierConfig): { decision: 'would-apply' | 'abstain' | 'skip'; reason: string; tier?: Tier } {
  if (f.tier) return { decision: 'skip', reason: `a person set tier ${f.tier}` };
  if (a.tier === 'insufficient_info') return { decision: 'abstain', reason: 'insufficient information to choose a tier' };
  const isProtected = f.risk === 'high' || isRisky(f);
  if (isProtected && a.tier !== 'risky' && a.tier !== 'investigate') return { decision: 'abstain', reason: `risk conflict: protected feature, answer ${a.tier}` };
  const min = isProtected ? cfg.minRiskConfidence : cfg.minConfidence;
  if (a.confidence < min) return { decision: 'abstain', reason: `confidence ${a.confidence.toFixed(2)} below ${min}` };
  return { decision: 'would-apply', reason: `confidence ${a.confidence.toFixed(2)}`, tier: a.tier };
}

export interface ClassifierRecord { ts: string; feature: string; hash: string; rubric: string; model: string; mode: 'shadow'; purpose: string;
  tier?: ClassifierChoice; probabilities?: Record<string, number>; confidence?: number; needsSplit?: number;
  decision: 'would-apply' | 'abstain' | 'skip' | 'error'; reason: string }
export const recordsFile = (root: string): string => join(paths(root).dir, 'classifier.jsonl');
export function readRecords(root: string): ClassifierRecord[] {
  const f = recordsFile(root);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l) as ClassifierRecord] : []; } catch { return []; } });
}
const requestsToday = (root: string): number => {
  const day = new Date().toISOString().slice(0, 10);
  return readRecords(root).filter((r) => r.ts.startsWith(day) && r.decision !== 'skip').length;
};

// Classify the given features in shadow mode: one Jev request each (unless a person already set the tier, or the same input
// was already classified), within the daily request cap. Returns the records written.
export async function classify(root: string, cfg: ClassifierConfig, targets: Feature[], features: Feature[], out: (s: string) => void, purpose = 'manual', keyOf: () => string | null = typesafeKey): Promise<ClassifierRecord[]> {
  const key = keyOf();
  if (!key) { out('no TypeSafe API key: set TYPESAFE_API_KEY (or put it in fact-os/.env); nothing was classified'); return []; }
  const seen = new Set(readRecords(root).filter((r) => r.decision !== 'error').map((r) => `${r.feature}:${r.hash}`));
  const written: ClassifierRecord[] = [];
  let used = requestsToday(root);
  for (const f of targets) {
    const state = classifierState(f, features), hash = inputHash(state);
    const base = { ts: new Date().toISOString(), feature: f.id, hash, rubric: RUBRIC_VERSION, model: cfg.model, mode: 'shadow' as const, purpose };
    let rec: ClassifierRecord;
    if (f.tier) rec = { ...base, decision: 'skip', reason: `a person set tier ${f.tier}` };
    else if (seen.has(`${f.id}:${hash}`)) { out(`${f.id}: unchanged since its last classification; skipped`); continue; }
    else if (used >= cfg.maxRequestsPerDay) { out(`daily request cap ${cfg.maxRequestsPerDay} reached; stopping`); break; }
    else {
      used++;
      const r = await askJev(cfg, state, key);
      if (!r.ok) rec = { ...base, decision: 'error', reason: r.error };
      else { const d = decide(f, r.answer, cfg); rec = { ...base, model: r.answer.model, tier: r.answer.tier, probabilities: r.answer.probabilities,
        confidence: r.answer.confidence, needsSplit: r.answer.needsSplit, decision: d.decision, reason: d.reason }; }
      if (!r.ok && r.status === 401) { appendFileSync(recordsFile(root), JSON.stringify(rec) + '\n'); written.push(rec); out(`${f.id}: ${rec.reason}; stopping`); break; }
    }
    appendFileSync(recordsFile(root), JSON.stringify(rec) + '\n');
    written.push(rec);
    out(`${f.id}: ${rec.tier ?? '-'}${rec.confidence != null ? ` (${rec.confidence.toFixed(2)})` : ''}${rec.needsSplit != null ? ` split ${rec.needsSplit.toFixed(2)}` : ''} → ${rec.decision}: ${rec.reason}`);
  }
  return written;
}

// The latest shadow answer per feature beside what actually happened, by predicted tier: how many, how many merged or
// stuck, average attempts and cost. Evidence to judge before any apply mode, not proof of accuracy.
export function report(root: string, features: Feature[]): string {
  const latest = new Map<string, ClassifierRecord>();
  for (const r of readRecords(root)) if (r.tier) latest.set(r.feature, r);
  if (!latest.size) return 'No shadow classifications yet. Run `fact-os classify --all`.';
  const byId = new Map(features.map((f) => [f.id, f]));
  const groups = new Map<string, { n: number; merged: number; stuck: number; attempts: number; cost: number; split: number; abstain: number }>();
  for (const r of latest.values()) {
    const f = byId.get(r.feature); if (!f) continue;
    const g = groups.get(r.tier!) ?? { n: 0, merged: 0, stuck: 0, attempts: 0, cost: 0, split: 0, abstain: 0 };
    g.n++; if (f.status === 'merged') g.merged++; if (f.status === 'stuck') g.stuck++;
    g.attempts += f.attempts || 0; g.cost += f.costUsd || 0; if ((r.needsSplit ?? 0) >= 0.8) g.split++; if (r.decision === 'abstain') g.abstain++;
    groups.set(r.tier!, g);
  }
  const rows = [['predicted', 'features', 'merged', 'stuck', 'avg tries', 'avg cost', 'split>=0.8', 'abstained']];
  for (const t of CLASSIFIER_CHOICES) { const g = groups.get(t); if (g) rows.push([t, String(g.n), String(g.merged), String(g.stuck),
    (g.attempts / g.n).toFixed(2), `$${(g.cost / g.n).toFixed(2)}`, String(g.split), String(g.abstain)]); }
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')).join('\n') +
    `\n\n${latest.size} features classified (latest answer each, shadow mode). Tries and cost are what the features actually took.`;
}
