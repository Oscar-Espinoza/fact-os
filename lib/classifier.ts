// I07 v2: a shadow classifier. TypeSafe Jev (a System One model: typed answers with probabilities) answers 32 narrow
// questions about a feature's mechanisms (does it alter how an authoritative amount is determined, who may act, how data is
// bound to its store...), plus one per acceptance item. Code composes the answers into four separate outputs: review
// requirements, a workload candidate, an attention priority (a frozen rework scorer) and planning candidates. Shadow mode
// only records them; it never changes a feature, its tier or the queue. Design and evidence: docs/improvements.md I07,
// lessons: docs/jev-lessons.md.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, envVar, withLock, readJson, writeJsonAtomic, loadState } from './state.ts';
import { isRisky } from './profiles.ts';
import type { ClassifierConfig, Feature, RoleConfig, Tier } from './types.ts';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
export const SCHEMA = 2;
export const POLICY_VERSION = 'i07-v2.3-shadow';
// The scorer was fitted on answers from this exact model; aliases can move, so v2 only runs pinned versions.
export const PINNED_MODEL = /^jev-\d+\.\d+\.\d+$/;

// ---- the frozen battery ----

interface Question { type: 'noul'; instructions: unknown; criteria?: unknown }
export const BATTERY = JSON.parse(readFileSync(join(HERE, 'classifier-battery.json'), 'utf8')) as
  { version: string; questions: Record<string, Question>; perAcceptance: Record<string, Question> };
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 16);
// Canonical JSON (sorted keys), so a hash names the meaning, not the file's formatting or wrapper metadata.
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);
export const BATTERY_HASH = sha(canonical({ questions: BATTERY.questions, perAcceptance: BATTERY.perAcceptance }));
const PER_ITEM = Object.keys(BATTERY.perAcceptance)[0]!; // a01_deliverable

export function questionsFor(f: Pick<Feature, 'acceptance'>): Record<string, Question> {
  const q: Record<string, Question> = { ...BATTERY.questions };
  (f.acceptance || []).forEach((_, i) => { q[`${PER_ITEM}_${i}`] = JSON.parse(JSON.stringify(BATTERY.perAcceptance[PER_ITEM]).replaceAll('{i}', String(i))); });
  return q;
}

// What Jev sees: the feature as written, its dependencies in brief, and the project's codebase glossary. Missing touches stay
// missing (null), never an empty list. No repository excerpts are sent yet, so evidence-dependent questions are not used.
export function classifierState(f: Feature, features: Feature[], glossary: unknown): Record<string, unknown> {
  const byId = new Map(features.map((x) => [x.id, x]));
  const touchesMissing = !f.touches || f.touches.length === 0;
  return {
    feature: { id: f.id, title: f.title, description: f.description, acceptance: f.acceptance || [], surface: f.surface ?? null,
      touches: touchesMissing ? null : f.touches, touchesMissing },
    dependencies: (f.deps || []).map((id) => ({ id, title: byId.get(id)?.title ?? null })),
    ...(glossary ? { codebase: glossary } : {}),
    repoFacts: { status: 'not_supplied', note: 'No repository excerpts are supplied; judge only from the feature text, dependencies and codebase glossary.' },
  };
}
// The identity of a request: everything that changes Jev's answer (model, battery, the state sent). The projection policy, the
// scorer and the feature's authority (a person's tier, explicit risk) are separate identities: changing them re-projects stored
// answers without a new request.
export const inputHash = (model: string, state: unknown, questions: unknown): string =>
  sha(JSON.stringify({ model, battery: BATTERY_HASH, state, questions }));
export const authorityOf = (f: Pick<Feature, 'tier' | 'risk'>) => ({ tier: f.tier ?? null, risk: f.risk ?? null });
const sameAuthority = (a: { tier: unknown; risk: unknown } | undefined, b: { tier: unknown; risk: unknown }) => !!a && a.tier === b.tier && a.risk === b.risk;

// ---- the key ----

// TYPESAFE_API_KEY, else fact-os's own .env (beside lib/). Never logged, recorded or passed to child processes (childEnv).
export function typesafeKey(envFile = join(HERE, '..', '.env')): string | null {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim() || null;
  }
  return null;
}

// ---- usage ledger: every real HTTP attempt is reserved under the state lock before it is sent ----

interface Usage { day: string; attempts: number; inflight: Record<string, string>; cooldownUntil?: string; cooldownReason?: string }
const usageFile = (root: string) => join(paths(root).dir, 'classifier-usage.json');
const today = () => new Date().toISOString().slice(0, 10);
function readUsage(root: string): Usage {
  const u = readJson(usageFile(root), null) as Usage | null;
  return u && u.day === today() ? { ...u, inflight: u.inflight ?? {} } : { day: today(), attempts: 0, inflight: u?.inflight ?? {}, cooldownUntil: u?.cooldownUntil, cooldownReason: u?.cooldownReason };
}
const editUsage = <R>(root: string, fn: (u: Usage) => R, timeoutMs?: number): Promise<R> =>
  withLock(root, () => { const u = readUsage(root); const r = fn(u); writeJsonAtomic(usageFile(root), u); return r; }, timeoutMs ? { timeoutMs } : {});
const coolingNow = (u: Usage): string | null =>
  u.cooldownUntil && Date.parse(u.cooldownUntil) > Date.now() ? `cooling down until ${u.cooldownUntil} after ${u.cooldownReason ?? 'rate limiting'}` : null;
export const cooldown = (root: string): string | null => coolingNow(readUsage(root));
// Retry-After as delta seconds or an HTTP date; NaN when absent or unreadable.
export function retryAfterMs(h: string | null, now = Date.now()): number {
  if (!h) return NaN;
  if (/^\d+$/.test(h.trim())) return Number(h) * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : NaN;
}

// ---- one decision: request, retries, validation ----

export interface JevResult { requestedModel: string; resolvedModel: string; answers: Record<string, number>; usage: Usage_ | null; attempts: number; elapsedMs: number }
type Usage_ = { input_tokens?: number; output_tokens?: number };
type Ask = { ok: true; result: JevResult } | { ok: false; error: string; status?: number; attempts: number; elapsedMs: number; fatal?: boolean };

// Exactly the expected ids, each a finite Noul in [0, 1], answered by exactly the requested (pinned) model. Anything else is an
// error with a fixed label, never a low probability, and never a provider string copied into a record.
export function validateAnswers(questions: Record<string, Question>, body: unknown, requested: string): { ok: true; answers: Record<string, number>; resolved: string; usage: Usage_ | null } | { ok: false; error: string } {
  const b = body as { model?: unknown; answers?: unknown; usage?: unknown } | null;
  if (!b || typeof b !== 'object' || !b.answers || typeof b.answers !== 'object' || Array.isArray(b.answers)) return { ok: false, error: 'TypeSafe returned no answers object' };
  if (typeof b.model !== 'string' || !b.model) return { ok: false, error: 'TypeSafe did not report the model that answered' };
  if (b.model !== requested) return { ok: false, error: `answered by a different model than the pinned ${requested}` };
  const got = b.answers as Record<string, { type?: unknown; noul?: unknown }>, ids = Object.keys(questions);
  if (Object.keys(got).some((k) => !Object.hasOwn(questions, k))) return { ok: false, error: 'TypeSafe returned answers to questions that were not asked' };
  const answers: Record<string, number> = {};
  for (const id of ids) {
    const a = got[id];
    if (!a || typeof a !== 'object' || a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1)
      return { ok: false, error: `invalid or missing answer for ${id}` };
    answers[id] = a.noul;
  }
  // Usage is provider metadata: keep only known, finite, non-negative token counts.
  const u = b.usage && typeof b.usage === 'object' ? b.usage as Record<string, unknown> : null, usage: Usage_ = {};
  for (const k of ['input_tokens', 'output_tokens'] as const) if (u && Number.isSafeInteger(u[k]) && (u[k] as number) >= 0) usage[k] = u[k] as number;
  return { ok: true, answers, resolved: b.model, usage: Object.keys(usage).length ? usage : null };
}

// One deadline (cfg.timeoutMs) covers every attempt, lock wait, response body and backoff. Before each attempt, under the state
// lock (waiting at most the time left): the provider cooldown is checked and the attempt is reserved against the daily cap.
// Retries: network errors, 429/529 and 5xx, at most cfg.maxRetries. A Retry-After (seconds or HTTP date) that does not fit
// the deadline becomes a persisted cooldown (never shortened) and stops the batch. 4xx other than 429 are not retried; 401 is
// fatal for the batch.
export async function askJev(root: string, cfg: ClassifierConfig, state: unknown, questions: Record<string, Question>, key: string, start = Date.now()): Promise<Ask> {
  const url = envVar('TYPESAFE_URL') || DEFAULT_URL, left = () => cfg.timeoutMs - (Date.now() - start);
  let attempts = 0, last = 'no attempt';
  const fail = (error: string, extra: { status?: number; fatal?: boolean } = {}): Ask => ({ ok: false, error, attempts, elapsedMs: Date.now() - start, ...extra });
  for (let n = 0; n <= cfg.maxRetries; n++) {
    if (left() <= 0) return fail(`deadline ${cfg.timeoutMs} ms reached after ${attempts} attempt(s): ${last}`);
    let gate: string | null;
    try {
      gate = await editUsage(root, (u) => {
        if (left() <= 0) return 'deadline';
        const cool = coolingNow(u); if (cool) return cool;
        if (u.attempts >= cfg.maxRequestsPerDay) return 'cap';
        u.attempts++; return null;
      }, Math.max(1, left()));
    } catch { return fail(`deadline ${cfg.timeoutMs} ms reached waiting for the state lock`); }
    if (gate === 'deadline') return fail(`deadline ${cfg.timeoutMs} ms reached waiting for the state lock`);
    if (gate === 'cap') return fail(`daily request cap ${cfg.maxRequestsPerDay} reached`, { fatal: true });
    if (gate) return fail(`TypeSafe is ${gate}`, { fatal: true });
    attempts++;
    let res: Response, body: unknown;
    try {
      res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, state, questions }), signal: AbortSignal.timeout(Math.max(1, left())) });
      body = await res.json().catch(() => null);
    } catch (e) { last = `request failed (${(e as Error).name})`; continue; }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      const after = retryAfterMs(res.headers.get('retry-after'));
      const wait = Number.isFinite(after) ? after : 500 * 2 ** n;
      if (wait >= left() || n === cfg.maxRetries) {
        if (res.status === 429 || res.status === 529) {
          const until = Date.now() + Math.max(wait, 60_000), status = res.status;
          await editUsage(root, (u) => { if (!u.cooldownUntil || Date.parse(u.cooldownUntil) < until) { u.cooldownUntil = new Date(until).toISOString(); u.cooldownReason = `HTTP ${status}`; } });
          return fail(`${last}; not retried within the deadline; cooling down`, { status: res.status, fatal: true });
        }
        return fail(`${last}; not retried within the deadline`, { status: res.status });
      }
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) return fail(`HTTP ${res.status}${res.status === 401 ? ' (invalid TypeSafe API key)' : ''}`, { status: res.status, fatal: res.status === 401 });
    const v = validateAnswers(questions, body, cfg.model);
    if (!v.ok) return fail(v.error);
    return { ok: true, result: { requestedModel: cfg.model, resolvedModel: v.resolved, answers: v.answers, usage: v.usage, attempts, elapsedMs: Date.now() - start } };
  }
  return fail(`${last} after ${attempts} attempt(s)`);
}

// ---- the frozen rework scorer (attention priority) ----

export interface Scorer { version: string; target: string; battery: string; batteryHash: string; model: string; glossaryHash: string | null; features: string[];
  mean: number[]; scale: number[]; coef: number[]; intercept: number; code: { keywords: string; uiSurfaces: string[]; packageDepth: number };
  composites: { families: Record<string, string[]>; excludedWithoutFacts: string[]; perItem: string };
  reference: { scores: number[]; tailFraction: number; threshold: number } }
// The extraction contracts this code implements; an artifact naming another one is not scored.
export const SUPPORTED_SCORERS = ['i07-v2.1-rework-devfit', 'i07-v2.2-rework-devfit'];
// The exact ordered feature vector and target each supported contract was fitted on.
const CONTRACT_FEATURES = ['acc_chars', 'coupling_max', 'coupling_mean', 'deliverables_expected', 'desc_chars', 'kw_hits', 'mitigation_max', 'mitigation_mean', 'n_acceptance',
  'n_deps', 'n_packages', 'n_touches', 'stakes_max', 'stakes_mean', 'surface_ui', 'touches_missing', 'uncertainty_max', 'uncertainty_mean', 'verification_max', 'verification_mean'];
const FROZEN_FAMILIES: Record<string, string> = { stakes: 's', uncertainty: 'u', coupling: 'c', mitigation: 'm', verification: 'v' };
const FROZEN_EXCLUDED = ['m03_existing_writer_delegation', 'm04_verified_extension_seam'];
// numpy.quantile(scores, q, method='higher'): the smallest sorted value at or above position q * (n - 1).
export const quantileHigher = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(q * (s.length - 1))]!; };
export const CODE_FEATURES = ['n_acceptance', 'acc_chars', 'desc_chars', 'touches_missing', 'n_touches', 'n_packages', 'n_deps', 'kw_hits', 'surface_ui'];

// The whole artifact is checked against this run: battery meaning, pinned model, glossary, extraction structures, coefficients
// and reference. Any mismatch makes the attention score unavailable (the paid answers are still kept).
export function loadScorer(file: string, expect: { model: string; glossaryHash: string | null }): { ok: true; scorer: Scorer; hash: string } | { ok: false; error: string } {
  let raw: string, s: Scorer;
  try { raw = readFileSync(file, 'utf8'); s = JSON.parse(raw); } catch (e) { return { ok: false, error: `scorer unreadable: ${(e as Error).message}` }; }
  const fail = (why: string) => ({ ok: false as const, error: `scorer rejected: ${why}` });
  if (!s || typeof s !== 'object') return fail('not an object');
  if (!SUPPORTED_SCORERS.includes(s.version)) return fail(`unsupported extraction contract ${String(s.version)}`);
  if (s.batteryHash !== BATTERY_HASH) return fail(`fitted on a different question battery (${String(s.batteryHash)}, this is ${BATTERY_HASH})`);
  if (s.model !== expect.model) return fail(`fitted on ${String(s.model)} answers, this run asks ${expect.model}`);
  if ((s.glossaryHash ?? null) !== expect.glossaryHash) return fail('fitted with a different codebase glossary');
  const n = Array.isArray(s.features) ? s.features.length : 0;
  const finite = (a: unknown) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (!n || !finite(s.mean) || !finite(s.scale) || !finite(s.coef) || !Number.isFinite(s.intercept) || s.scale.some((x) => x <= 0)) return fail('coefficients, scaler and features do not line up');
  const c = s.code, k = s.composites;
  if (!c || typeof c.keywords !== 'string' || !Array.isArray(c.uiSurfaces) || !Number.isSafeInteger(c.packageDepth) || c.packageDepth < 1) return fail('code extraction settings missing');
  try { new RegExp(c.keywords, 'g'); } catch { return fail('keyword pattern does not compile'); }
  if (!k || !k.families || typeof k.families !== 'object' || !Array.isArray(k.excludedWithoutFacts) || k.perItem !== PER_ITEM) return fail('composite settings missing');
  const names = new Set(CODE_FEATURES.concat(['deliverables_expected']));
  if (Object.keys(k.families).sort().join() !== Object.keys(FROZEN_FAMILIES).sort().join()) return fail('families differ from the frozen extraction');
  for (const [fam, prefix] of Object.entries(FROZEN_FAMILIES)) {
    // As exported: each family's questions by prefix, minus the evidence-dependent ones (also excluded at scoring time).
    const want = Object.keys(BATTERY.questions).filter((q) => q.startsWith(prefix) && !FROZEN_EXCLUDED.includes(q)), ids = k.families[fam];
    if (!Array.isArray(ids) || ids.length !== want.length || want.some((q) => !ids.includes(q))) return fail(`family ${fam} differs from the frozen extraction`);
    names.add(`${fam}_max`); names.add(`${fam}_mean`);
  }
  if ([...k.excludedWithoutFacts].sort().join() !== FROZEN_EXCLUDED.join()) return fail('evidence-dependent exclusions differ from the frozen extraction');
  if (s.features.some((f) => !names.has(f))) return fail('feature names do not match the extraction');
  if (s.features.join() !== CONTRACT_FEATURES.join()) return fail('feature order or membership differs from the supported contract');
  const t = (s as unknown as { targetContract?: { id?: unknown; positive?: unknown } }).targetContract;
  if (!t || t.id !== 'anyRework' || t.positive !== 'rework') return fail('target contract is not {id: "anyRework", positive: "rework"}');
  const r = s.reference;
  if (!r || !Array.isArray(r.scores) || !r.scores.length || r.scores.some((x) => typeof x !== 'number' || !(x >= 0 && x <= 1)) || typeof r.threshold !== 'number' || !(r.threshold >= 0 && r.threshold <= 1))
    return fail('reference scores or threshold out of range');
  if (typeof r.tailFraction !== 'number' || !(r.tailFraction > 0 && r.tailFraction < 1)) return fail('reference tail fraction missing');
  if (Math.abs(quantileHigher(r.scores, 1 - r.tailFraction) - r.threshold) > 1e-12) return fail('threshold is not the reference quantile');
  return { ok: true, scorer: s, hash: sha(raw) };
}

const codePoints = (s: string | undefined | null) => [...(s ?? '')].length; // Python len() semantics, so emoji count once
// Python's re.IGNORECASE also matches these non-ASCII letters to ASCII keywords; JavaScript's /i does not.
const pyFold = (s: string) => s.replace(/[İı]/g, 'i').replace(/ſ/g, 's').replace(/K/g, 'k');
// The code features, extracted exactly as the scorer was trained (Python evaluate2.code_features).
export function codeFeatures(s: Scorer, f: Pick<Feature, 'title' | 'description' | 'acceptance' | 'surface' | 'touches' | 'deps'>): Record<string, number> {
  const acc = f.acceptance || [], touches = f.touches || [];
  const text = pyFold([f.title || '', f.description || '', ...acc].join(' '));
  return {
    n_acceptance: acc.length, acc_chars: acc.reduce((t, a) => t + codePoints(a), 0), desc_chars: codePoints(f.description),
    touches_missing: touches.length === 0 ? 1 : 0, n_touches: touches.length,
    n_packages: new Set(touches.map((t) => t.split('/').slice(0, s.code.packageDepth).join('/'))).size,
    n_deps: (f.deps || []).length, kw_hits: (text.match(new RegExp(s.code.keywords, 'gi')) || []).length,
    surface_ui: s.code.uiSurfaces.includes(f.surface ?? '') ? 1 : 0,
  };
}
export function compositeFeatures(s: Scorer, answers: Record<string, number>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [fam, ids] of Object.entries(s.composites.families)) {
    const v = ids.filter((q) => !s.composites.excludedWithoutFacts.includes(q)).map((q) => answers[q]);
    if (v.some((x) => x === undefined)) return null; // missing evidence: no score from a partly filled vector
    if (v.length) { out[`${fam}_max`] = Math.max(...(v as number[])); out[`${fam}_mean`] = (v as number[]).reduce((a, b) => a + b, 0) / v.length; }
  }
  out.deliverables_expected = Object.entries(answers).filter(([q]) => q.startsWith(`${s.composites.perItem}_`)).reduce((t, [, p]) => t + p, 0);
  return out;
}
export function score(s: Scorer, vector: Record<string, number>): number | null {
  let z = s.intercept;
  for (const [i, k] of s.features.entries()) {
    const x = vector[k];
    if (x === undefined || !Number.isFinite(x)) return null;
    z += s.coef[i]! * (x - s.mean[i]!) / s.scale[i]!;
  }
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

// ---- projection: four separate outputs plus a lossy compatibility tier ----

export const HI = 0.8, DIRECT = 0.9;
// Consequences that need deliberate review whatever their historical failure rate (money, stock, access, ownership,
// sensitive/destructive/migrated data, trusted external facts, untrusted execution).
export const DIRECT_AXES = ['s01_authoritative_amount', 's02_funds_effect', 's03_money_state_admission', 's04_stock_authority', 's05_authorization',
  's06_tenant_binding', 's07_sensitive_data', 's08_irreversible_data', 's09_existing_data_migration', 's12_external_fact_trust', 's15_untrusted_execution'];
// Mechanisms whose review attaches to an affected durable effect: flagged, never a review floor by themselves.
export const MECHANISM_AXES = ['s10_concurrent_writers', 's11_replay_effect', 's13_provider_protocol', 's14_release_evidence'];
const label = (q: string) => q.replace(/^[a-z]\d+_/, '').replaceAll('_', ' ');
const PLANNING: Record<string, { need: string[]; any: string[]; why: string }> = {
  newLifecycleCoordination: { need: ['c01_new_lifecycle'], any: ['c02_lifecycle_dependency', 'c06_shared_contract', 'u02_unresolved_design'], why: 'a new lifecycle that coordinates with other state, contracts or open design' },
  newOriginIntegration: { need: ['c03_new_origin_variant'], any: ['c01_new_lifecycle', 'c04_existing_consumers', 'c06_shared_contract'], why: 'a new origin of a shared entity that existing consumers or contracts must handle' },
  clientServerContract: { need: ['c07_client_and_server', 'c06_shared_contract'], any: [], why: 'client and server changes across a shared contract' },
  separateMeasurementWork: { need: ['v02_measurement_deliverable', 's14_release_evidence'], any: [], why: 'a measured evidence artifact beside a change to verification machinery' },
  openDesignAcrossBoundaries: { need: ['u02_unresolved_design'], any: ['c01_new_lifecycle', 'c03_new_origin_variant', 'c06_shared_contract'], why: 'an undecided design that crosses lifecycle, origin or contract boundaries' },
};
export const ATTENTION_TARGET = 'historical mixed rework (evaluator rejection or builder/commit failure); uncalibrated for new features';

export interface Assessment {
  reviewRequirements: { axis: string; p: number }[]; reviewUncertain: { axis: string; p: number }[]; mechanisms: { axis: string; p: number }[];
  workloadCandidate: 'investigate' | 'hard' | 'multi' | 'normal'; workloadReasons: string[];
  attention: { score: number; flag: boolean; threshold: number; percentile: number; target: string } | { unavailable: string };
  planningCandidates: string[]; planningReasons: Record<string, string>; candidateTier: Tier; dispositions: string[];
}
export function assess(f: Feature, answers: Record<string, number>, features: Feature[], scorer: Scorer | null, scorerError?: string): Assessment {
  const H = (q: string) => (answers[q] ?? 0) >= HI;
  const reviewRequirements = DIRECT_AXES.filter((q) => answers[q]! >= DIRECT).map((axis) => ({ axis, p: answers[axis]! }));
  const reviewUncertain = DIRECT_AXES.filter((q) => answers[q]! >= HI && answers[q]! < DIRECT).map((axis) => ({ axis, p: answers[axis]! }));
  const mechanisms = MECHANISM_AXES.filter(H).map((axis) => ({ axis, p: answers[axis]! }));
  const workloadCandidate = H('u01_unknown_root_cause') ? 'investigate' : H('u02_unresolved_design') ? 'hard'
    : H('c04_existing_consumers') || (H('c06_shared_contract') && H('c07_client_and_server')) ? 'multi' : 'normal';
  const workloadReasons = workloadCandidate === 'investigate' ? ['unknown root cause'] : workloadCandidate === 'hard' ? ['unresolved design']
    : workloadCandidate === 'multi' ? [H('c04_existing_consumers') ? 'existing consumers must handle it' : 'client and server contract'] : [];
  const planningReasons: Record<string, string> = {};
  for (const [name, p] of Object.entries(PLANNING))
    if (p.need.every(H) && (!p.any.length || p.any.some(H)))
      planningReasons[name] = `${p.why} (${[...p.need, ...p.any.filter(H)].map((q) => `${label(q)} ${answers[q]!.toFixed(2)}`).join(', ')})`;
  let attention: Assessment['attention'] = { unavailable: scorerError ?? 'no scorer configured' };
  if (scorer) {
    try {
      const comp = compositeFeatures(scorer, answers), sc = comp && score(scorer, { ...codeFeatures(scorer, f), ...comp });
      attention = sc == null ? { unavailable: 'answers do not fill the scorer vector' } : { score: sc, flag: sc >= scorer.reference.threshold, threshold: scorer.reference.threshold,
        percentile: scorer.reference.scores.filter((x) => x <= sc).length / scorer.reference.scores.length, target: ATTENTION_TARGET };
    } catch { attention = { unavailable: 'the scorer could not score this feature' }; }
  }
  const candidateTier: Tier = workloadCandidate === 'investigate' ? 'investigate' : reviewRequirements.length ? 'risky' : workloadCandidate;
  const isProtected = f.risk === 'high' || isRisky(f);
  const dispositions: string[] = [];
  if (f.tier) dispositions.push(`human tier ${f.tier} is authoritative`);
  if (H('u04_quality_only_acceptance')) dispositions.push('needs-scope: an acceptance item is a quality-only judgment');
  const missingDeps = (f.deps || []).filter((d) => !features.some((x) => x.id === d));
  if (missingDeps.length) dispositions.push(`needs-context: unknown dependencies ${missingDeps.join(', ')}`);
  if (H('u03_unverified_external_contract')) dispositions.push('needs-context: relies on an external contract not established in the scope');
  if (reviewUncertain.length) dispositions.push(`review-uncertain: ${reviewUncertain.map((r) => label(r.axis)).join(', ')}`);
  if (isProtected && candidateTier !== 'risky' && candidateTier !== 'investigate') dispositions.push(`protected-conflict: protected feature, candidate ${candidateTier}`);
  if (f.risk === 'normal' && reviewRequirements.length) dispositions.push('risk-review: explicit risk normal, but a critical review requirement was found');
  if (candidateTier === 'investigate' && (reviewRequirements.length || isProtected))
    dispositions.push('routing-review: investigate does not carry the risky review; keep the review requirement');
  return { reviewRequirements, reviewUncertain, mechanisms, workloadCandidate, workloadReasons, attention,
    planningCandidates: Object.keys(planningReasons), planningReasons, candidateTier, dispositions };
}

// ---- records ----

export type Roles = { builder: Pick<RoleConfig, 'provider' | 'model' | 'effort'>; evaluator: Pick<RoleConfig, 'provider' | 'model' | 'effort'> };
export interface ClassifierRecord {
  schema: 2; ts: string; feature: string; purpose: string; battery: string; inputHash: string; policy: string; scorer: string | null;
  tier: string | null; authority: { tier: string | null; risk: string | null }; requestedModel: string; resolvedModel?: string; usage?: unknown;
  attempts: number; elapsedMs: number; status: 'assessed' | 'stale' | 'error'; error?: string; answers?: Record<string, number>; assessment?: Assessment;
  input?: unknown; roles?: Roles | null;
}
export const recordsFile = (root: string): string => join(paths(root).dir, 'classifier.jsonl');
// v2 Jev records only; v1 records (no schema) and escalation records (lib/escalation.ts) share the file.
export function readRecords(root: string): ClassifierRecord[] {
  const f = recordsFile(root);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { const r = l ? JSON.parse(l) : null; return r?.schema === SCHEMA && !r.kind ? [r as ClassifierRecord] : []; } catch { return []; } });
}

interface Context { glossary: unknown; glossaryHash: string | null; scorer: Scorer | null; scorerHash: string | null; scorerError?: string; policy: string }
// The glossary is sent to providers and kept on disk, so it must be small and must not look like it carries a credential; one that
// fails either check is not used at all (never silently redacted, so what is kept is exactly what was sent).
export const MAX_GLOSSARY = 16 * 1024;
const CREDENTIAL = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|password|token)\s*["']?\s*[:=]\s*["']?[^\s"']{8,})/i;
const CREDENTIAL_KEY = /^(api[_-]?key|secret|password|token|authorization|private[_-]?key)$/i;
// Does any decoded key or string value (after JSON parsing, so escapes cannot hide it) look like a credential or contain the
// active TypeSafe key? Used for everything fact-os sends to a provider or keeps on disk as context.
export function credentialIn(value: unknown, key = typesafeKey()): boolean {
  const seen = (s: string) => CREDENTIAL.test(s) || (!!key && s.includes(key));
  const walk = (v: unknown): boolean => typeof v === 'string' ? seen(v)
    : Array.isArray(v) ? v.some(walk)
    : v && typeof v === 'object' ? Object.entries(v).some(([k, x]) => seen(k) || (CREDENTIAL_KEY.test(k) && typeof x === 'string' && x.length >= 8) || walk(x)) : false;
  return walk(value);
}
export function loadContext(root: string, cfg: ClassifierConfig): Context & { glossaryError?: string } {
  let glossary: unknown = null, glossaryHash: string | null = null, glossaryError: string | undefined;
  if (cfg.glossary) {
    try {
      const raw = readFileSync(resolve(root, cfg.glossary));
      if (raw.length > MAX_GLOSSARY) glossaryError = `glossary larger than ${MAX_GLOSSARY} bytes; not used`;
      else { const parsed = JSON.parse(raw.toString('utf8'));
        if (credentialIn(parsed)) glossaryError = 'glossary looks like it contains a credential; not used'; else { glossary = parsed; glossaryHash = sha(raw); } }
    } catch { glossary = null; glossaryError = 'glossary unreadable; not used'; }
  }
  let scorer: Scorer | null = null, scorerHash: string | null = null, scorerError: string | undefined;
  if (cfg.scorer) { const s = loadScorer(resolve(root, cfg.scorer), { model: cfg.model, glossaryHash }); if (s.ok) { scorer = s.scorer; scorerHash = s.hash; } else scorerError = s.error; }
  const policy = sha(JSON.stringify({ POLICY_VERSION, HI, DIRECT, DIRECT_AXES, MECHANISM_AXES, PLANNING, scorer: scorerHash, scorerError: scorerError ?? null }));
  return { glossary, glossaryHash, scorer, scorerHash, scorerError, policy, ...(glossaryError ? { glossaryError } : {}) };
}
// A bounded, secret-free copy of what was asked: the state sent, with the glossary replaced by its hash. The glossary itself is
// kept once per content under classifier-context/, so every recorded input can be reconstructed.
const inputSnapshot = (state: Record<string, unknown>, ctx: Context) => { const { codebase: _, ...rest } = state; return { ...rest, glossaryHash: ctx.glossaryHash }; };
function keepGlossary(root: string, ctx: Context) {
  if (!ctx.glossaryHash) return;
  const file = join(paths(root).dir, 'classifier-context', `${ctx.glossaryHash}.json`);
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeJsonAtomic(file, ctx.glossary); }
}

// ---- classify ----

// Shadow-classify the targets. Validated answers for the same request are reused: re-projected locally when the policy, scorer
// or the feature's authority changed (no key or provider needed), skipped otherwise. A new request is single-flight per input
// across processes (the claim re-checks published answers), and the answer is published and the claim released together after
// re-checking the feature's scope and authority under the state lock (stale if they changed). Never writes features.
export async function classify(root: string, cfg: ClassifierConfig, targets: Feature[], out: (s: string) => void, purpose = 'manual',
  keyOf: () => string | null = typesafeKey, rolesOf: (f: Feature) => Roles | null = () => null): Promise<ClassifierRecord[]> {
  const ctx = loadContext(root, cfg);
  if (ctx.scorerError) out(`attention score unavailable: ${ctx.scorerError}`);
  if (ctx.glossaryError) out(ctx.glossaryError);
  keepGlossary(root, ctx);
  const written: ClassifierRecord[] = [], done = new Set<string>();
  let key: string | null | undefined, stop = false;
  const redact = (s: string) => (key ? s.replaceAll(key, '[redacted]') : s);
  const append = (r: ClassifierRecord) => { appendFileSync(recordsFile(root), redact(JSON.stringify(r)) + '\n'); written.push(r); };
  const validated = (hash: string) => { let best: ClassifierRecord | undefined; for (const r of readRecords(root)) if (r.status === 'assessed' && r.answers && r.inputHash === hash) best = r; return best; };
  for (const target of targets) {
    if (stop) break;
    if (done.has(target.id)) continue;
    done.add(target.id);
    const { features } = loadState(root), f = features.find((x) => x.id === target.id) ?? target;
    const state = classifierState(f, features, ctx.glossary), questions = questionsFor(f), hash = inputHash(cfg.model, state, questions), authority = authorityOf(f);
    const base = { schema: 2 as const, ts: new Date().toISOString(), feature: f.id, purpose, battery: BATTERY.version, inputHash: hash, policy: ctx.policy,
      scorer: ctx.scorerHash, tier: authority.tier, authority, requestedModel: cfg.model, input: inputSnapshot(state, ctx), roles: rolesOf(f) };
    const seen = validated(hash);
    if (seen) {
      if (seen.policy === ctx.policy && sameAuthority(seen.authority, authority) && JSON.stringify(seen.roles ?? null) === JSON.stringify(base.roles ?? null)) {
        out(`${f.id}: unchanged since its last assessment; skipped`); continue;
      }
      const rec: ClassifierRecord = { ...base, resolvedModel: seen.resolvedModel, attempts: 0, elapsedMs: 0, status: 'assessed', answers: seen.answers,
        assessment: assess(f, seen.answers!, features, ctx.scorer, ctx.scorerError) };
      append(rec); out(`${f.id}: re-projected locally → ${summary(rec.assessment!)}`); continue;
    }
    if (key === undefined) {
      key = keyOf();
      if (!key) out('no TypeSafe API key: set TYPESAFE_API_KEY (or put it in fact-os/.env); features that need a request were not classified');
    }
    if (!key) continue;
    const cool = cooldown(root);
    if (cool) { out(`TypeSafe is ${cool}; stopping`); break; }
    // Claim the input: no live claim by another process, and no answer it already published since this loop began. The decision
    // deadline starts now, so waiting for the lock counts against it.
    const started = Date.now();
    let claim: string | null;
    try {
      claim = await editUsage(root, (u) => {
        if (validated(hash)) return 'published';
        const held = u.inflight[hash];
        if (held && Date.parse(held) > Date.now()) return 'held';
        if (Date.now() - started >= cfg.timeoutMs) return 'deadline';
        u.inflight[hash] = new Date(Date.now() + cfg.timeoutMs + 60_000).toISOString();
        return null;
      }, cfg.timeoutMs);
    } catch { claim = 'deadline'; }
    if (claim === 'published') { out(`${f.id}: assessed meanwhile by another process; skipped`); continue; }
    if (claim === 'held') { out(`${f.id}: already being assessed by another process; skipped`); continue; }
    if (claim === 'deadline') { out(`${f.id}: deadline ${cfg.timeoutMs} ms reached waiting for the state lock; not requested`); continue; }
    let r: Ask;
    try { r = await askJev(root, cfg, state, questions, key, started); }
    catch (e) { await editUsage(root, (u) => { delete u.inflight[hash]; }); throw e; }
    // Publish and release together, after re-checking the feature's scope and authority (never across the request).
    const rec = await withLock(root, () => {
      const u = readUsage(root); delete u.inflight[hash]; writeJsonAtomic(usageFile(root), u);
      if (!r.ok) { const e: ClassifierRecord = { ...base, attempts: r.attempts, elapsedMs: r.elapsedMs, status: 'error', error: r.error }; append(e); return e; }
      const now = loadState(root).features, cur = now.find((x) => x.id === f.id);
      const stale = !cur || inputHash(cfg.model, classifierState(cur, now, ctx.glossary), questionsFor(cur)) !== hash || !sameAuthority(authorityOf(cur), authority);
      const res = r.result;
      const x: ClassifierRecord = { ...base, resolvedModel: res.resolvedModel, usage: res.usage, attempts: res.attempts, elapsedMs: res.elapsedMs,
        status: stale ? 'stale' : 'assessed', answers: res.answers,
        ...(stale ? { error: 'the feature changed while it was being assessed' } : { assessment: assess(f, res.answers, features, ctx.scorer, ctx.scorerError) }) };
      append(x); return x;
    });
    if (!r.ok) { out(`${f.id}: ${r.error}`); if (r.fatal) { out('stopping'); stop = true; } continue; }
    out(`${f.id}: ${rec.status === 'stale' ? 'stale (edited during the request)' : summary(rec.assessment!)}`);
  }
  return written;
}

export function summary(a: Assessment): string {
  const att = 'score' in a.attention ? `attention ${a.attention.score.toFixed(2)}${a.attention.flag ? ' FLAG' : ''}` : 'attention n/a';
  return [`candidate ${a.candidateTier}`, a.reviewRequirements.length ? `review: ${a.reviewRequirements.map((r) => label(r.axis)).join(', ')}` : null,
    `workload ${a.workloadCandidate}`, att, a.planningCandidates.length ? `planning: ${a.planningCandidates.join(', ')}` : null,
    ...a.dispositions].filter(Boolean).join(' | ');
}

// ---- report ----

// Each feature's state: current (validated answers for its current input, re-projected with today's policy, scorer and the
// feature's current authority), stale (answers exist only for an older input, or the latest attempt went stale), error (only
// failed attempts) or never attempted. Costs average only known values, and say how many were missing.
export function report(root: string, features: Feature[], cfg: ClassifierConfig): string {
  const recs = readRecords(root);
  if (!recs.length) return 'No v2 assessments yet. Run `fact-os classify --all`.';
  const ctx = loadContext(root, cfg);
  const byFeature = new Map<string, ClassifierRecord[]>();
  for (const r of recs) (byFeature.get(r.feature) ?? byFeature.set(r.feature, []).get(r.feature)!).push(r);
  const counts = { stale: 0, error: 0, never: 0 };
  const current: [Feature, Assessment][] = [];
  for (const f of features) {
    const rs = byFeature.get(f.id);
    if (!rs) { counts.never++; continue; }
    const hash = inputHash(cfg.model, classifierState(f, features, ctx.glossary), questionsFor(f));
    const usable = [...rs].reverse().find((r) => r.status === 'assessed' && r.answers && r.inputHash === hash);
    if (usable) { current.push([f, assess(f, usable.answers!, features, ctx.scorer, ctx.scorerError)]); continue; }
    if (rs.some((r) => r.status === 'stale' || (r.status === 'assessed' && r.inputHash !== hash))) counts.stale++; else counts.error++;
  }
  const row = (name: string, xs: [Feature, Assessment][]) => {
    const fin = xs.filter(([f]) => f.status === 'merged' || f.status === 'stuck'), known = fin.filter(([f]) => typeof f.costUsd === 'number');
    return [name, String(xs.length), String(xs.filter(([f]) => f.status === 'merged').length), String(xs.filter(([f]) => f.status === 'stuck').length),
      fin.length ? (fin.reduce((t, [f]) => t + (f.attempts || 0), 0) / fin.length).toFixed(2) : '-',
      known.length ? `$${(known.reduce((t, [f]) => t + f.costUsd!, 0) / known.length).toFixed(2)}${known.length < fin.length ? ` (${fin.length - known.length} unknown)` : ''}` : 'unknown'];
  };
  const rows = [['group', 'features', 'merged', 'stuck', 'avg tries*', 'avg cost*']];
  for (const t of ['normal', 'multi', 'hard', 'risky', 'investigate']) { const xs = current.filter(([, a]) => a.candidateTier === t); if (xs.length) rows.push(row(`candidate ${t}`, xs)); }
  const scored = current.filter(([, a]) => 'score' in a.attention);
  rows.push(row('attention flag', scored.filter(([, a]) => 'flag' in a.attention && a.attention.flag)));
  rows.push(row('planning candidate', current.filter(([, a]) => a.planningCandidates.length > 0)));
  rows.push(row('review uncertain', current.filter(([, a]) => a.reviewUncertain.length > 0)));
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')).join('\n') +
    `\n\n${current.length} current (re-projected with today's policy, scorer and authority), ${counts.stale} stale (scope changed since), ` +
    `${counts.error} with only failed attempts, ${counts.never} never attempted. Attention score available for ${scored.length} of ${current.length}` +
    `${ctx.scorerError ? ` (${ctx.scorerError})` : ''}.` +
    `\n* among merged or stuck features only. Groups overlap; the candidate tier is a lossy summary of the review, workload and planning outputs.`;
}
