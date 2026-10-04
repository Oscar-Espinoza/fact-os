// I07 v2: a shadow classifier. TypeSafe Jev (a System One model: typed answers with probabilities) answers 32 narrow
// questions about a feature's mechanisms (does it alter how an authoritative amount is determined, who may act, how data is
// bound to its store...), plus one per acceptance item. Code composes the answers into four separate outputs: review
// requirements, a workload candidate, an attention priority (a frozen rework scorer) and planning candidates. Shadow mode
// only records them; it never changes a feature, its tier or the queue. Design and evidence: docs/improvements.md I07,
// lessons: docs/jev-lessons.md.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, envVar, withLock, readJson, writeJsonAtomic, loadState } from './state.ts';
import { isRisky } from './profiles.ts';
import type { ClassifierConfig, Feature, Tier } from './types.ts';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
export const SCHEMA = 2;
export const POLICY_VERSION = 'i07-v2.2-shadow';

// ---- the frozen battery ----

interface Question { type: 'noul'; instructions: unknown; criteria?: unknown }
export const BATTERY = JSON.parse(readFileSync(join(HERE, 'classifier-battery.json'), 'utf8')) as
  { version: string; questions: Record<string, Question>; perAcceptance: Record<string, Question> };
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const BATTERY_HASH = sha(JSON.stringify(BATTERY));
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
// The identity of a request: everything that changes Jev's answer (model, battery, the state sent). The projection policy and
// scorer are a separate identity, so changing them re-projects stored answers without a new request.
export const inputHash = (model: string, state: unknown, questions: unknown): string =>
  sha(JSON.stringify({ model, battery: BATTERY_HASH, state, questions }));

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
  return u && u.day === today() ? { ...u, inflight: u.inflight ?? {} } : { day: today(), attempts: 0, inflight: {}, cooldownUntil: u?.cooldownUntil, cooldownReason: u?.cooldownReason };
}
const editUsage = <R>(root: string, fn: (u: Usage) => R): Promise<R> => withLock(root, () => { const u = readUsage(root); const r = fn(u); writeJsonAtomic(usageFile(root), u); return r; });
export const cooldown = (root: string): string | null => {
  const u = readUsage(root);
  return u.cooldownUntil && Date.parse(u.cooldownUntil) > Date.now() ? `cooling down until ${u.cooldownUntil} after ${u.cooldownReason ?? 'rate limiting'}` : null;
};

// ---- one decision: request, retries, validation ----

export interface JevResult { requestedModel: string; resolvedModel: string; answers: Record<string, number>; usage: unknown; attempts: number; elapsedMs: number }
type Ask = { ok: true; result: JevResult } | { ok: false; error: string; status?: number; attempts: number; elapsedMs: number; fatal?: boolean };

// Every expected id present as a finite Noul in [0, 1], and the model that answered is the one requested when a version was
// pinned. Anything else is an error, never a low probability.
export function validateAnswers(questions: Record<string, Question>, body: unknown, requested: string): { ok: true; answers: Record<string, number>; resolved: string } | { ok: false; error: string } {
  const b = body as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown }> } | null;
  if (!b || typeof b !== 'object' || !b.answers || typeof b.answers !== 'object') return { ok: false, error: 'TypeSafe returned no answers object' };
  const resolved = typeof b.model === 'string' ? b.model : '';
  if (!resolved) return { ok: false, error: 'TypeSafe did not report the model that answered' };
  if (/\d/.test(requested) && resolved !== requested) return { ok: false, error: `model mismatch: requested ${requested}, answered by ${resolved}` };
  const answers: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const a = b.answers[id];
    if (!a || a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1)
      return { ok: false, error: `invalid or missing answer for ${id}` };
    answers[id] = a.noul;
  }
  return { ok: true, answers, resolved };
}

// One deadline (cfg.timeoutMs) covers every attempt, response body and backoff. Retries: network errors, 429/529 and 5xx, at most
// cfg.maxRetries; each attempt is reserved against the daily cap first. A Retry-After that does not fit the deadline sets a
// cooldown every later invocation honours. 4xx other than 429 are not retried; 401 is fatal for the batch.
export async function askJev(root: string, cfg: ClassifierConfig, state: unknown, questions: Record<string, Question>, key: string): Promise<Ask> {
  const url = envVar('TYPESAFE_URL') || DEFAULT_URL, start = Date.now(), left = () => cfg.timeoutMs - (Date.now() - start);
  let attempts = 0, last = 'no attempt';
  const fail = (error: string, extra: { status?: number; fatal?: boolean } = {}): Ask => ({ ok: false, error, attempts, elapsedMs: Date.now() - start, ...extra });
  for (let n = 0; n <= cfg.maxRetries; n++) {
    if (left() <= 0) return fail(`deadline ${cfg.timeoutMs} ms reached after ${attempts} attempt(s): ${last}`);
    const reserved = await editUsage(root, (u) => (u.attempts >= cfg.maxRequestsPerDay ? false : (u.attempts++, true)));
    if (!reserved) return fail(`daily request cap ${cfg.maxRequestsPerDay} reached`, { fatal: true });
    attempts++;
    let res: Response, body: unknown;
    try {
      res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, state, questions }), signal: AbortSignal.timeout(Math.max(1, left())) });
      body = await res.json().catch(() => null);
    } catch (e) { last = `request failed (${(e as Error).name})`; continue; }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      const after = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** n;
      if (wait >= left() || n === cfg.maxRetries) {
        if (res.status === 429 || res.status === 529) {
          const until = new Date(Date.now() + Math.max(wait, 60_000)).toISOString();
          await editUsage(root, (u) => { u.cooldownUntil = until; u.cooldownReason = `HTTP ${res.status}`; });
        }
        return fail(`${last}; not retried within the deadline`, { status: res.status });
      }
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) return fail(`HTTP ${res.status}${res.status === 401 ? ' (invalid TypeSafe API key)' : ''}`, { status: res.status, fatal: res.status === 401 });
    const v = validateAnswers(questions, body, cfg.model);
    if (!v.ok) return fail(v.error);
    return { ok: true, result: { requestedModel: cfg.model, resolvedModel: v.resolved, answers: v.answers, usage: (body as { usage?: unknown }).usage ?? null,
      attempts, elapsedMs: Date.now() - start } };
  }
  return fail(`${last} after ${attempts} attempt(s)`);
}

// ---- the frozen rework scorer (attention priority) ----

export interface Scorer { version: string; target: string; battery: string; batteryHash: string; model: string; features: string[]; mean: number[]; scale: number[];
  coef: number[]; intercept: number; code: { keywords: string; uiSurfaces: string[]; packageDepth: number };
  composites: { families: Record<string, string[]>; excludedWithoutFacts: string[]; perItem: string };
  reference: { scores: number[]; tailFraction: number; threshold: number } }

export function loadScorer(file: string): { ok: true; scorer: Scorer; hash: string } | { ok: false; error: string } {
  let s: Scorer;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { ok: false, error: `scorer unreadable: ${(e as Error).message}` }; }
  const n = s?.features?.length;
  const finite = (a: unknown) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (!n || !finite(s.mean) || !finite(s.scale) || !finite(s.coef) || !Number.isFinite(s.intercept) || s.scale.some((x) => x === 0))
    return { ok: false, error: 'scorer coefficients, scaler and features do not line up' };
  if (s.batteryHash && s.battery !== BATTERY.version) return { ok: false, error: `scorer was fitted on battery ${s.battery}, not ${BATTERY.version}` };
  if (!s.reference || !Array.isArray(s.reference.scores) || !Number.isFinite(s.reference.threshold)) return { ok: false, error: 'scorer has no fixed reference' };
  return { ok: true, scorer: s, hash: sha(readFileSync(file, 'utf8')) };
}

const codePoints = (s: string | undefined | null) => [...(s ?? '')].length; // Python len() semantics, so emoji count once
// The code features, extracted exactly as the scorer was trained (Python evaluate2.code_features).
export function codeFeatures(s: Scorer, f: Pick<Feature, 'title' | 'description' | 'acceptance' | 'surface' | 'touches' | 'deps'>): Record<string, number> {
  const acc = f.acceptance || [], touches = f.touches || [];
  const text = [f.title || '', f.description || '', ...acc].join(' ');
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

export interface Assessment {
  reviewRequirements: { axis: string; p: number }[]; reviewUncertain: { axis: string; p: number }[]; mechanisms: { axis: string; p: number }[];
  workloadCandidate: 'investigate' | 'hard' | 'multi' | 'normal'; workloadReasons: string[];
  attention: { score: number; flag: boolean; threshold: number } | { unavailable: string };
  planningCandidates: string[]; candidateTier: Tier; dispositions: string[];
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
  const planning: Record<string, boolean> = {
    newLifecycleCoordination: H('c01_new_lifecycle') && (H('c02_lifecycle_dependency') || H('c06_shared_contract') || H('u02_unresolved_design')),
    newOriginIntegration: H('c03_new_origin_variant') && (H('c01_new_lifecycle') || H('c04_existing_consumers') || H('c06_shared_contract')),
    clientServerContract: H('c07_client_and_server') && H('c06_shared_contract'),
    separateMeasurementWork: H('v02_measurement_deliverable') && H('s14_release_evidence'),
    openDesignAcrossBoundaries: H('u02_unresolved_design') && (H('c01_new_lifecycle') || H('c03_new_origin_variant') || H('c06_shared_contract')),
  };
  let attention: Assessment['attention'] = { unavailable: scorerError ?? 'no scorer configured' };
  if (scorer) {
    const comp = compositeFeatures(scorer, answers), sc = comp && score(scorer, { ...codeFeatures(scorer, f), ...comp });
    attention = sc == null ? { unavailable: 'answers do not fill the scorer vector' } : { score: sc, flag: sc >= scorer.reference.threshold, threshold: scorer.reference.threshold };
  }
  const candidateTier: Tier = workloadCandidate === 'investigate' ? 'investigate' : reviewRequirements.length ? 'risky' : workloadCandidate;
  const dispositions: string[] = [];
  if (f.tier) dispositions.push(`human tier ${f.tier} is authoritative`);
  if (H('u04_quality_only_acceptance')) dispositions.push('needs-scope: an acceptance item is a quality-only judgment');
  const missingDeps = (f.deps || []).filter((d) => !features.some((x) => x.id === d));
  if (missingDeps.length) dispositions.push(`needs-context: unknown dependencies ${missingDeps.join(', ')}`);
  if (H('u03_unverified_external_contract')) dispositions.push('needs-context: relies on an external contract not established in the scope');
  if (reviewUncertain.length) dispositions.push(`review-uncertain: ${reviewUncertain.map((r) => label(r.axis)).join(', ')}`);
  if ((f.risk === 'high' || isRisky(f)) && candidateTier !== 'risky' && candidateTier !== 'investigate') dispositions.push(`protected-conflict: protected feature, candidate ${candidateTier}`);
  if (f.risk === 'normal' && candidateTier === 'risky') dispositions.push('risk-review: explicit risk normal, but a critical review requirement was found');
  if (candidateTier === 'investigate' && reviewRequirements.length) dispositions.push('routing-review: investigate does not carry the risky review; keep the review requirement');
  return { reviewRequirements, reviewUncertain, mechanisms, workloadCandidate, workloadReasons, attention,
    planningCandidates: Object.keys(planning).filter((k) => planning[k]), candidateTier, dispositions };
}

// ---- records ----

export interface ClassifierRecord {
  schema: 2; ts: string; feature: string; purpose: string; battery: string; inputHash: string; policy: string; scorer: string | null; tier: string | null;
  requestedModel: string; resolvedModel?: string; usage?: unknown; attempts: number; elapsedMs: number;
  status: 'assessed' | 'stale' | 'error'; error?: string; answers?: Record<string, number>; assessment?: Assessment;
}
export const recordsFile = (root: string): string => join(paths(root).dir, 'classifier.jsonl');
// v2 records only; v1 records (no schema) stay in the file, unread.
export function readRecords(root: string): ClassifierRecord[] {
  const f = recordsFile(root);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').flatMap((l) => { try { const r = l ? JSON.parse(l) : null; return r?.schema === SCHEMA ? [r as ClassifierRecord] : []; } catch { return []; } });
}
const append = (root: string, r: ClassifierRecord) => appendFileSync(recordsFile(root), JSON.stringify(r) + '\n');

function loadContext(root: string, cfg: ClassifierConfig): { glossary: unknown; scorer: Scorer | null; scorerHash: string | null; scorerError?: string } {
  let glossary: unknown = null;
  if (cfg.glossary) { try { glossary = JSON.parse(readFileSync(resolve(root, cfg.glossary), 'utf8')); } catch { glossary = null; } }
  if (!cfg.scorer) return { glossary, scorer: null, scorerHash: null };
  const s = loadScorer(resolve(root, cfg.scorer));
  return s.ok ? { glossary, scorer: s.scorer, scorerHash: s.hash } : { glossary, scorer: null, scorerHash: null, scorerError: s.error };
}

// ---- classify ----

// Shadow-classify the targets: one Jev request each unless the same input already has validated answers (then it is only
// re-projected when the policy or scorer changed). Single-flight per input across processes; the daily cap counts every
// attempt; a feature edited while its request was out is recorded stale. Never writes features.
export async function classify(root: string, cfg: ClassifierConfig, targets: Feature[], out: (s: string) => void, purpose = 'manual',
  keyOf: () => string | null = typesafeKey): Promise<ClassifierRecord[]> {
  const key = keyOf();
  if (!key) { out('no TypeSafe API key: set TYPESAFE_API_KEY (or put it in fact-os/.env); nothing was classified'); return []; }
  const cool = cooldown(root);
  if (cool) { out(`TypeSafe is ${cool}; nothing was classified`); return []; }
  const ctx = loadContext(root, cfg);
  if (ctx.scorerError) out(`attention score unavailable: ${ctx.scorerError}`);
  const policy = sha(JSON.stringify({ POLICY_VERSION, HI, DIRECT, DIRECT_AXES, MECHANISM_AXES, scorer: ctx.scorerHash }));
  const written: ClassifierRecord[] = [], done = new Set<string>();
  const prior = new Map<string, ClassifierRecord>();
  for (const r of readRecords(root)) if (r.status === 'assessed' && r.answers) prior.set(r.inputHash, r);
  for (const target of targets) {
    if (done.has(target.id)) continue;
    done.add(target.id);
    const { features } = loadState(root), f = features.find((x) => x.id === target.id) ?? target;
    const state = classifierState(f, features, ctx.glossary), questions = questionsFor(f), hash = inputHash(cfg.model, state, questions);
    const base = { schema: 2 as const, ts: new Date().toISOString(), feature: f.id, purpose, battery: BATTERY.version, inputHash: hash, policy,
      scorer: ctx.scorerHash, tier: f.tier ?? null, requestedModel: cfg.model };
    const seen = prior.get(hash);
    if (seen) {
      if (seen.policy === policy) { out(`${f.id}: unchanged since its last assessment; skipped`); continue; }
      const rec: ClassifierRecord = { ...base, resolvedModel: seen.resolvedModel, attempts: 0, elapsedMs: 0, status: 'assessed', answers: seen.answers,
        assessment: assess(f, seen.answers!, features, ctx.scorer, ctx.scorerError) };
      append(root, rec); written.push(rec); out(`${f.id}: re-projected (policy changed) → ${summary(rec.assessment!)}`); continue;
    }
    const lease = await editUsage(root, (u) => {
      const held = u.inflight[hash];
      if (held && Date.parse(held) > Date.now()) return false;
      u.inflight[hash] = new Date(Date.now() + cfg.timeoutMs + 60_000).toISOString();
      return true;
    });
    if (!lease) { out(`${f.id}: already being assessed by another process; skipped`); continue; }
    let r: Ask;
    try { r = await askJev(root, cfg, state, questions, key); }
    finally { await editUsage(root, (u) => { delete u.inflight[hash]; }); }
    if (!r.ok) {
      const rec: ClassifierRecord = { ...base, attempts: r.attempts, elapsedMs: r.elapsedMs, status: 'error', error: r.error };
      append(root, rec); written.push(rec); out(`${f.id}: ${r.error}`);
      if (r.fatal) { out('stopping'); break; }
      continue;
    }
    // The feature may have been edited (or tiered by a person) while the request was out: never join an answer to new scope.
    const now = loadState(root).features, cur = now.find((x) => x.id === f.id);
    const stale = !cur || inputHash(cfg.model, classifierState(cur, now, ctx.glossary), questionsFor(cur)) !== hash || (cur.tier ?? null) !== base.tier;
    const res = r.result;
    const rec: ClassifierRecord = { ...base, resolvedModel: res.resolvedModel, usage: res.usage, attempts: res.attempts, elapsedMs: res.elapsedMs,
      status: stale ? 'stale' : 'assessed', answers: res.answers, ...(stale ? { error: 'the feature changed while it was being assessed' } : { assessment: assess(f, res.answers, features, ctx.scorer, ctx.scorerError) }) };
    append(root, rec); written.push(rec);
    if (!stale) prior.set(hash, rec);
    out(`${f.id}: ${stale ? 'stale (edited during the request)' : summary(rec.assessment!)}`);
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

// The latest assessment of each feature's current input beside what the feature actually took. Stale (the feature changed
// since), errored and never-assessed features are counted, never averaged in. Evidence for a later apply decision, not proof.
export function report(root: string, features: Feature[], cfg: ClassifierConfig | null): string {
  const recs = readRecords(root);
  if (!recs.length) return 'No v2 assessments yet. Run `fact-os classify --all`.';
  const glossary = cfg ? loadContext(root, cfg).glossary : null, model = cfg?.model ?? recs[recs.length - 1]!.requestedModel;
  const latest = new Map<string, ClassifierRecord>();
  for (const r of recs) if (r.status === 'assessed') latest.set(r.feature, r);
  let stale = 0, none = 0;
  const current: [Feature, ClassifierRecord][] = [];
  for (const f of features) {
    const r = latest.get(f.id);
    if (!r) { none++; continue; }
    if (r.inputHash !== inputHash(model, classifierState(f, features, glossary), questionsFor(f))) { stale++; continue; }
    current.push([f, r]);
  }
  const row = (name: string, xs: [Feature, ClassifierRecord][]) => {
    const fin = xs.filter(([f]) => f.status === 'merged' || f.status === 'stuck');
    return [name, String(xs.length), String(xs.filter(([f]) => f.status === 'merged').length), String(xs.filter(([f]) => f.status === 'stuck').length),
      fin.length ? (fin.reduce((t, [f]) => t + (f.attempts || 0), 0) / fin.length).toFixed(2) : '-',
      fin.length ? `$${(fin.reduce((t, [f]) => t + (f.costUsd || 0), 0) / fin.length).toFixed(2)}` : '-'];
  };
  const rows = [['group', 'features', 'merged', 'stuck', 'avg tries*', 'avg cost*']];
  for (const t of ['normal', 'multi', 'hard', 'risky', 'investigate']) { const xs = current.filter(([, r]) => r.assessment!.candidateTier === t); if (xs.length) rows.push(row(`candidate ${t}`, xs)); }
  rows.push(row('attention flag', current.filter(([, r]) => 'flag' in r.assessment!.attention && r.assessment!.attention.flag)));
  rows.push(row('planning candidate', current.filter(([, r]) => r.assessment!.planningCandidates.length > 0)));
  rows.push(row('review uncertain', current.filter(([, r]) => r.assessment!.reviewUncertain.length > 0)));
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join('  ')).join('\n') +
    `\n\n${current.length} features with a current assessment (shadow), ${stale} stale (changed since), ${none} never assessed.` +
    `\n* among merged or stuck features only. Groups overlap; the candidate tier is a lossy summary of the review, workload and planning outputs.`;
}
