// I07 v2: the shadow classifier against a local fake TypeSafe server (no real provider calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, classify, classifierState, codeFeatures, compositeFeatures, cooldown, loadScorer, questionsFor, readRecords, report, retryAfterMs, score,
  typesafeKey, validateAnswers, BATTERY, DIRECT_AXES, type Scorer } from '../lib/classifier.ts';
import { CLASSIFIER_DEFAULTS, ESCALATION_DEFAULTS, DEFAULT_CONFIG, childEnv, loadConfig, withLock, writeJsonAtomic } from '../lib/state.ts';
import type { ClassifierConfig, Feature } from '../lib/types.ts';

// Never reach the real TypeSafe API from a test: every request goes to a dead local port unless a fake server replaces it,
// and the key never comes from fact-os's own .env (which may hold a real key).
process.env.FACTOS_TYPESAFE_URL = 'http://127.0.0.1:9/never-real';
const fakeKey = () => 'test-key', noKey = () => null;
const MODEL = 'jev-1.13.0';

const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id} works`],
  surface: 'api', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
const cfg = (o: Partial<ClassifierConfig> = {}): ClassifierConfig => ({ ...CLASSIFIER_DEFAULTS, timeoutMs: 3000, maxRetries: 1, ...o });
const ids = (f: Feature) => Object.keys(questionsFor(f));
// A valid answer body for feature f: every question low unless overridden.
const body = (f: Feature, over: Record<string, number> = {}, model = MODEL) => ({ model, usage: { input_tokens: 100 },
  answers: Object.fromEntries(ids(f).map((q) => [q, { type: 'noul', noul: over[q] ?? 0.05 }])) as Record<string, { type: string; noul: number }> });
const probs = (f: Feature, over: Record<string, number> = {}) => Object.fromEntries(Object.entries(body(f, over).answers).map(([q, a]) => [q, a.noul]));

// A reply: a JSON body, an HTTP status, or a raw response {status, headers, raw}.
type Raw = { status: number; headers?: Record<string, string>; raw?: string };
type Reply = object | number | Raw;
function fakeTypesafe(t: { after: (fn: () => void) => void }, replies: Reply[], onRequest?: () => void) {
  const seen: { auth: string | null; body: any }[] = [];
  const server = Bun.serve({ port: 0, fetch: async (req) => {
    seen.push({ auth: req.headers.get('authorization'), body: await req.json() });
    onRequest?.();
    const r = replies.shift() ?? 500;
    if (typeof r === 'number') return new Response('{}', { status: r });
    if ('status' in r && !('answers' in r)) return new Response((r as Raw).raw ?? '{}', { status: (r as Raw).status, headers: (r as Raw).headers });
    return Response.json(r);
  } });
  const prev = process.env.FACTOS_TYPESAFE_URL;
  process.env.FACTOS_TYPESAFE_URL = `http://127.0.0.1:${server.port}/v1/systemone`;
  t.after(() => { server.stop(true); process.env.FACTOS_TYPESAFE_URL = prev ?? 'http://127.0.0.1:9/never-real'; });
  return seen;
}
const writeFeatures = (root: string, features: Feature[]) => writeJsonAtomic(join(root, '.fact-os', 'features.json'), { features });
function project(t: { after: (fn: () => void) => void }, features: Feature[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-classifier-'));
  mkdirSync(join(root, '.fact-os')); mkdirSync(join(root, '.git'));
  writeFeatures(root, features);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const parity = () => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'classifier-scorer.json'), 'utf8')) as
  { scorer: Scorer; cases: { input: any; answers: Record<string, number>; vector: number[]; score: number }[] };

test('I07 v2: the request carries the frozen battery, one question per acceptance item, the pinned model and missing touches as null', async (t) => {
  const f = F('a', { acceptance: ['one', 'two'], deps: ['d'] }), d = F('d', { status: 'merged' });
  const root = project(t, [f, d]), seen = fakeTypesafe(t, [body(f)]);
  const recs = await classify(root, cfg(), [f], () => {}, 'manual', fakeKey);
  assert.equal(recs[0]!.status, 'assessed');
  assert.equal(seen[0]!.auth, 'Bearer test-key'); assert.equal(seen[0]!.body.model, MODEL);
  assert.equal(Object.keys(seen[0]!.body.questions).length, Object.keys(BATTERY.questions).length + 2);
  assert.match(JSON.stringify(seen[0]!.body.questions.a01_deliverable_1), /feature\.acceptance\[1\]/);
  assert.equal(seen[0]!.body.state.feature.touches, null); assert.equal(seen[0]!.body.state.feature.touchesMissing, true);
  assert.deepEqual(seen[0]!.body.state.dependencies, [{ id: 'd', title: 'Feature d' }]);
  assert.equal(recs[0]!.resolvedModel, MODEL); assert.equal(recs[0]!.attempts, 1); assert.deepEqual(recs[0]!.usage, { input_tokens: 100 });
});

test('I07 v2: invalid answers are errors, never low probabilities (F2)', () => {
  const f = F('a'), q = questionsFor(f);
  assert.ok(validateAnswers(q, body(f), MODEL).ok);
  const missing = body(f); delete missing.answers.s01_authoritative_amount;
  assert.match((validateAnswers(q, missing, MODEL) as any).error, /missing answer for s01/);
  assert.match((validateAnswers(q, body(f, { s05_authorization: 1.5 }), MODEL) as any).error, /invalid .* s05/);
  const inf = body(f); inf.answers.u01_unknown_root_cause!.noul = Infinity;
  assert.match((validateAnswers(q, inf, MODEL) as any).error, /u01/);
  const typed = body(f); (typed.answers as any).c01_new_lifecycle = { type: 'choice', choice: 'x' };
  assert.match((validateAnswers(q, typed, MODEL) as any).error, /c01/);
  assert.match((validateAnswers(q, body(f, {}, 'jev-1.14.0'), MODEL) as any).error, /different model than the pinned/);
  assert.match((validateAnswers(q, { answers: body(f).answers }, MODEL) as any).error, /did not report the model/);
});

test('I07 v2: an overflowing number in the response is rejected, and errors are recorded without answers', async (t) => {
  const f = F('a'), root = project(t, [f]);
  const raw = JSON.stringify(body(f)).replace('"noul":0.05', '"noul":1e309');
  fakeTypesafe(t, [{ status: 200, raw, headers: { 'content-type': 'application/json' } }]);
  const [rec] = await classify(root, cfg(), [f], () => {}, 'manual', fakeKey);
  assert.equal(rec!.status, 'error'); assert.match(rec!.error!, /invalid or missing answer/); assert.equal(rec!.answers, undefined);
});

test('I07 v2: retries are bounded and counted; 401 stops the batch; 422 is not retried; 503 is (F3, F4)', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [a, b]);
  let seen = fakeTypesafe(t, [429, body(a)]);
  let [rec] = await classify(root, cfg(), [a], () => {}, 'manual', fakeKey);
  assert.equal(rec!.status, 'assessed'); assert.equal(rec!.attempts, 2); assert.equal(seen.length, 2);
  assert.equal(JSON.parse(readFileSync(join(root, '.fact-os', 'classifier-usage.json'), 'utf8')).attempts, 2, 'the ledger counts every attempt');
  seen = fakeTypesafe(t, [401, body(b)]);
  const lines: string[] = [];
  const recs = await classify(root, cfg(), [b, F('c')], (s) => lines.push(s), 'manual', fakeKey);
  assert.equal(recs.length, 1); assert.match(recs[0]!.error!, /401/); assert.equal(seen.length, 1); assert.ok(lines.includes('stopping'));
  seen = fakeTypesafe(t, [422]);
  [rec] = await classify(root, cfg(), [b], () => {}, 'manual', fakeKey);
  assert.match(rec!.error!, /HTTP 422/); assert.equal(seen.length, 1);
  seen = fakeTypesafe(t, [503, body(b)]);
  [rec] = await classify(root, cfg(), [b], () => {}, 'manual', fakeKey);
  assert.equal(rec!.status, 'assessed'); assert.equal(seen.length, 2);
});

test('I07 v2: a Retry-After beyond the deadline sets a cooldown that later invocations honour (F4)', async (t) => {
  const a = F('a'), root = project(t, [a]);
  const seen = fakeTypesafe(t, [{ status: 429, headers: { 'retry-after': '120' } }]);
  const [rec] = await classify(root, cfg({ timeoutMs: 2000 }), [a], () => {}, 'manual', fakeKey);
  assert.match(rec!.error!, /429; not retried within the deadline/); assert.equal(seen.length, 1);
  assert.match(cooldown(root)!, /cooling down until/);
  const lines: string[] = [];
  assert.deepEqual(await classify(root, cfg(), [a], (s) => lines.push(s), 'manual', fakeKey), []);
  assert.match(lines[0]!, /cooling down/); assert.equal(seen.length, 1);
});

test('I07 v2: one deadline covers every attempt (F4)', async (t) => {
  const a = F('a'), root = project(t, [a]);
  const server = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(400); return Response.json(body(a)); } });
  const prev = process.env.FACTOS_TYPESAFE_URL; process.env.FACTOS_TYPESAFE_URL = `http://127.0.0.1:${server.port}/`;
  t.after(() => { server.stop(true); process.env.FACTOS_TYPESAFE_URL = prev; });
  const started = Date.now();
  const [rec] = await classify(root, cfg({ timeoutMs: 300, maxRetries: 2 }), [a], () => {}, 'manual', fakeKey);
  assert.equal(rec!.status, 'error'); assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test('I07 v2: the daily cap counts real attempts including retries (F3)', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [a, b]);
  const seen = fakeTypesafe(t, [429, body(a), body(b)]);
  const recs = await classify(root, cfg({ maxRequestsPerDay: 2 }), [a, b], () => {}, 'manual', fakeKey);
  assert.equal(seen.length, 2); assert.equal(recs[0]!.status, 'assessed'); assert.match(recs[1]!.error!, /daily request cap 2 reached/);
});

test('I07 v2: unchanged input is not asked again; duplicates in a batch are asked once; a policy change re-projects locally (F3, F7)', async (t) => {
  const a = F('a'), root = project(t, [a]);
  const seen = fakeTypesafe(t, [body(a), body(a)]);
  await classify(root, cfg(), [a, a], () => {}, 'manual', fakeKey);
  assert.equal(seen.length, 1);
  // A person tiers it afterwards: re-projected locally, without a key, with the human-tier disposition.
  writeFeatures(root, [{ ...a, tier: 'hard' }]);
  const [re] = await classify(root, cfg(), [{ ...a, tier: 'hard' }], () => {}, 'manual', noKey);
  assert.equal(re!.attempts, 0); assert.ok(re!.assessment!.dispositions.some((d) => /human tier hard/.test(d)));
  writeFeatures(root, [a]);
  await classify(root, cfg(), [a], () => {}, 'manual', fakeKey);
  assert.equal(seen.length, 1);
  const lines: string[] = [];
  await classify(root, cfg(), [a], (s) => lines.push(s), 'manual', fakeKey);
  assert.equal(seen.length, 1); assert.match(lines[0]!, /unchanged since its last assessment/);
  // A scorer appears: same answers, new policy identity: re-projected without a request.
  writeFileSync(join(root, 'scorer.json'), JSON.stringify(parity().scorer));
  const recs = await classify(root, cfg({ scorer: 'scorer.json' }), [a], () => {}, 'manual', fakeKey);
  assert.equal(seen.length, 1); assert.equal(recs[0]!.attempts, 0); assert.ok('score' in recs[0]!.assessment!.attention);
  // A different model is a different input: asked again.
  await classify(root, cfg({ model: 'jev-1.14.0' }), [a], () => {}, 'manual', fakeKey);
  assert.equal(seen.length, 2);
});

test('I07 v2: a feature edited or tiered during its request is recorded stale, and the edit is kept (F8)', async (t) => {
  const a = F('a'), root = project(t, [a]);
  fakeTypesafe(t, [body(a)], () => writeFeatures(root, [{ ...a, description: 'rewritten', tier: 'hard' }]));
  const [rec] = await classify(root, cfg(), [a], () => {}, 'manual', fakeKey);
  assert.equal(rec!.status, 'stale'); assert.equal(rec!.assessment, undefined);
  const now = JSON.parse(readFileSync(join(root, '.fact-os', 'features.json'), 'utf8')).features[0];
  assert.equal(now.description, 'rewritten'); assert.equal(now.tier, 'hard');
});

test('I07 v2: shadow mode never writes features, and records never contain the key', async (t) => {
  const a = F('a', { tier: 'normal' }), root = project(t, [a]);
  const before = readFileSync(join(root, '.fact-os', 'features.json'), 'utf8');
  fakeTypesafe(t, [body(a, { s02_funds_effect: 0.99 })]);
  const [rec] = await classify(root, cfg(), [a], () => {}, 'manual', fakeKey);
  assert.equal(readFileSync(join(root, '.fact-os', 'features.json'), 'utf8'), before);
  assert.ok(rec!.assessment!.dispositions.some((d) => /human tier normal is authoritative/.test(d)));
  assert.doesNotMatch(readFileSync(join(root, '.fact-os', 'classifier.jsonl'), 'utf8'), /test-key/);
  const lines: string[] = [];
  assert.deepEqual(await classify(root, cfg(), [F('b')], (s) => lines.push(s), 'manual', noKey), []); assert.match(lines[0]!, /no TypeSafe API key/);
});

test('I07 v2: the TypeScript scorer reproduces the Python pipeline (vectors and scores), Unicode and missing touches included', () => {
  const { scorer, cases } = parity();
  for (const c of cases) {
    const v = { ...codeFeatures(scorer, c.input), ...compositeFeatures(scorer, c.answers)! };
    scorer.features.forEach((k, i) => assert.ok(Math.abs(v[k]! - c.vector[i]!) < 1e-9, `${c.input.title}: ${k} ${v[k]} vs ${c.vector[i]}`));
    assert.ok(Math.abs(score(scorer, v)! - c.score) < 1e-9, `${c.input.title}: score ${score(scorer, v)} vs ${c.score}`);
  }
  const missing = { ...cases[0]!.answers }; delete missing.s05_authorization;
  assert.equal(compositeFeatures(scorer, missing), null, 'a partly filled vector gives no score');
});

test('I07 v2: a malformed or mismatched scorer is rejected, and the assessment says the score is unavailable', (t) => {
  const root = project(t), file = join(root, 's.json'), { scorer } = parity();
  const expect = { model: MODEL, glossaryHash: null };
  const bad = (o: object, rx: RegExp) => { writeFileSync(file, JSON.stringify({ ...scorer, ...o })); assert.match((loadScorer(file, expect) as any).error, rx, JSON.stringify(o).slice(0, 80)); };
  bad({ coef: scorer.coef.slice(1) }, /do not line up/);
  bad({ scale: scorer.scale.map((x, i) => (i ? x : 0)) }, /do not line up/);
  bad({ batteryHash: 'other' }, /different question battery/);
  bad({ model: 'jev-9.99.0' }, /fitted on jev-9\.99\.0 answers/);
  bad({ glossaryHash: 'abc' }, /different codebase glossary/);
  bad({ reference: { ...scorer.reference, scores: ['bad'] } }, /reference/);
  bad({ reference: { ...scorer.reference, threshold: 2 } }, /reference/);
  bad({ composites: undefined }, /composite settings missing/);
  bad({ features: [...scorer.features.slice(1), 'mystery'] }, /feature names/);
  writeFileSync(file, JSON.stringify(scorer)); assert.ok(loadScorer(file, expect).ok);
  assert.deepEqual(assess(F('a'), probs(F('a')), [], null, 'scorer unreadable').attention, { unavailable: 'scorer unreadable' });
});

test('I07 v2: projection: review floor, uncertainty band, mechanisms, workload precedence and the compatibility tier', () => {
  const f = F('a', { title: 'Settings page', description: 'A page' });
  let a = assess(f, probs(f, { s04_stock_authority: 0.93 }), [f], null);
  assert.deepEqual(a.reviewRequirements.map((r) => r.axis), ['s04_stock_authority']); assert.equal(a.candidateTier, 'risky');
  a = assess(f, probs(f, { s07_sensitive_data: 0.85 }), [f], null);
  assert.equal(a.reviewRequirements.length, 0); assert.deepEqual(a.reviewUncertain.map((r) => r.axis), ['s07_sensitive_data']);
  assert.equal(a.candidateTier, 'normal'); assert.ok(a.dispositions.some((d) => /review-uncertain: sensitive data/.test(d)));
  a = assess(f, probs(f, { s11_replay_effect: 0.97, s14_release_evidence: 0.95 }), [f], null);
  assert.equal(a.candidateTier, 'normal', 'replay or release machinery alone is a mechanism, not a review floor'); assert.equal(a.mechanisms.length, 2);
  a = assess(f, probs(f, { u02_unresolved_design: 0.9, c04_existing_consumers: 0.9, s02_funds_effect: 0.95 }), [f], null);
  assert.equal(a.workloadCandidate, 'hard', 'workload is computed even with a review requirement'); assert.equal(a.candidateTier, 'risky');
  a = assess(f, probs(f, { c06_shared_contract: 0.9, c07_client_and_server: 0.9 }), [f], null);
  assert.equal(a.candidateTier, 'multi'); assert.deepEqual(a.planningCandidates, ['clientServerContract']);
  a = assess(f, probs(f, { u01_unknown_root_cause: 0.9, s05_authorization: 0.95 }), [f], null);
  assert.equal(a.candidateTier, 'investigate'); assert.ok(a.dispositions.some((d) => /routing-review/.test(d)));
  assert.ok(DIRECT_AXES.every((q) => q.startsWith('s')));
});

test('I07 v2: dispositions: protected conflict, explicit risk normal, quality-only acceptance, unknown dependencies, unestablished contracts (F5, F6)', () => {
  const refund = F('r', { title: 'Refund flow', description: 'Refund a payment' });
  assert.ok(assess(refund, probs(refund), [refund], null).dispositions.some((d) => /protected-conflict: protected feature, candidate normal/.test(d)));
  const explicit = F('e', { risk: 'normal' });
  assert.ok(assess(explicit, probs(explicit, { s01_authoritative_amount: 0.95 }), [explicit], null).dispositions.some((d) => /risk-review/.test(d)));
  const g = F('g', { deps: ['ghost'] });
  const d = assess(g, probs(g, { u04_quality_only_acceptance: 0.9, u03_unverified_external_contract: 0.9 }), [g], null).dispositions;
  assert.ok(d.some((x) => /needs-scope/.test(x))); assert.ok(d.some((x) => /unknown dependencies ghost/.test(x))); assert.ok(d.some((x) => /external contract/.test(x)));
});

test('I07 v2: the report counts current, stale and never-assessed features separately', async (t) => {
  const a = F('a', { status: 'merged', costUsd: 3 }), b = F('b'), c = F('c'), root = project(t, [a, b, c]);
  fakeTypesafe(t, [body(a, { s02_funds_effect: 0.95 }), body(b)]);
  await classify(root, cfg(), [a, b], () => {}, 'manual', fakeKey);
  const r = report(root, [a, { ...b, description: 'changed' }, c], cfg());
  assert.match(r, /candidate risky\s+1\s+1\s+0\s+0\.00\s+\$3\.00/);
  assert.match(r, /1 current .*, 1 stale .*, 0 with only failed attempts, 1 never attempted/);
  assert.match(report(project(t), [], cfg()), /No v2 assessments yet/);
});

test('I07 v2: config: off by default, pinned model, v1 thresholds rejected, escalation defaults fill a partial block', (t) => {
  const root = project(t), file = join(root, '.fact-os', 'config.json');
  const set = (o: object) => writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, test: 'true', ...o }));
  set({}); assert.equal(loadConfig(root).classifier, null);
  set({ classifier: { provider: 'typesafe' } }); assert.deepEqual(loadConfig(root).classifier, CLASSIFIER_DEFAULTS);
  assert.equal(CLASSIFIER_DEFAULTS.model, 'jev-1.13.0');
  set({ classifier: { provider: 'typesafe', escalation: { maxPerDay: 3 } } });
  assert.deepEqual(loadConfig(root).classifier!.escalation, { ...ESCALATION_DEFAULTS, maxPerDay: 3 });
  for (const c of [{ minConfidence: 0.8 }, { provider: 'openai' }, { mode: 'apply' }, { timeoutMs: 10 }, { maxRetries: 3 }, { scorer: 5 }, { model: 'jev-latest' },
    { escalation: { timeoutMin: 0 } }, { escalation: 'x' }, 'x']) {
    set({ classifier: c }); assert.throws(() => loadConfig(root), /config\.classifier/, JSON.stringify(c));
  }
});

test('I07: the key comes from TYPESAFE_API_KEY or fact-os .env', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fact-os-env-')), env = join(dir, '.env');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(env, '# local\nexport TYPESAFE_API_KEY="from-env-file"\nOTHER=1\n');
  const prev = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev; });
  assert.equal(typesafeKey(env), 'from-env-file'); assert.equal(typesafeKey(join(dir, 'missing')), null);
});

test('I07: factory secrets never reach agents, hooks or scripts', () => {
  const prev = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'sentinel-secret';
  try { assert.equal(childEnv().TYPESAFE_API_KEY, undefined); assert.equal(process.env.TYPESAFE_API_KEY, 'sentinel-secret'); }
  finally { if (prev === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prev; }
  // Every child process takes childEnv(); a raw process.env spread would hand the key to an agent.
  const lib = join(import.meta.dir, '..', 'lib');
  for (const f of readdirSync(lib).filter((f) => f.endsWith('.ts')))
    for (const [i, line] of readFileSync(join(lib, f), 'utf8').split('\n').entries())
      if (/env: process\.env|\.\.\.process\.env/.test(line) && !/const env = \{ \.\.\.process\.env \};/.test(line)) assert.fail(`${f}:${i + 1} passes process.env to a child`);
});

test('I07 v2: state shape: the classifier sees the glossary and declared touches, and is told repository facts are not supplied', (t) => {
  const f = F('a', { touches: ['packages/orders/src/'] });
  const s = classifierState(f, [f], { money: 'packages/orders' }) as any;
  assert.deepEqual(s.feature.touches, ['packages/orders/src/']); assert.equal(s.feature.touchesMissing, false);
  assert.deepEqual(s.codebase, { money: 'packages/orders' }); assert.equal(s.repoFacts.status, 'not_supplied');
  assert.equal(readRecords(project(t)).length, 0);
});


test('I07 v2 review: overlapping batches never pay twice for an answer another process published (R03)', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [a, b]);
  const posts: string[] = [];
  const server = Bun.serve({ port: 0, fetch: async (req) => {
    const id = (await req.json() as any).state.feature.id; posts.push(id);
    if (id === 'a') await Bun.sleep(300);
    return Response.json(body(id === 'a' ? a : b));
  } });
  const prev = process.env.FACTOS_TYPESAFE_URL; process.env.FACTOS_TYPESAFE_URL = `http://127.0.0.1:${server.port}/`;
  t.after(() => { server.stop(true); process.env.FACTOS_TYPESAFE_URL = prev; });
  const first = classify(root, cfg(), [a], () => {}, 'manual', fakeKey);
  await Bun.sleep(50);
  const lines: string[] = [];
  await Promise.all([first, (async () => { await Bun.sleep(400); await classify(root, cfg(), [b, a], (s) => lines.push(s), 'manual', fakeKey); })()]);
  assert.deepEqual(posts, ['a', 'b']);
  assert.ok(lines.some((l) => /a: (unchanged|assessed meanwhile)/.test(l)));
});

test('I07 v2 review: a provider cooldown stops the rest of the batch, and HTTP-date Retry-After is honoured (R04)', async (t) => {
  const a = F('a'), b = F('b'), root = project(t, [a, b]);
  const seen = fakeTypesafe(t, [{ status: 429, headers: { 'retry-after': new Date(Date.now() + 120_000).toUTCString() } }, body(b)]);
  const recs = await classify(root, cfg({ timeoutMs: 2000 }), [a, b], () => {}, 'manual', fakeKey);
  assert.equal(seen.length, 1, 'b is not requested during the cooldown'); assert.equal(recs.length, 1);
  assert.ok(Date.parse(JSON.parse(readFileSync(join(root, '.fact-os', 'classifier-usage.json'), 'utf8')).cooldownUntil) > Date.now() + 100_000);
  assert.ok(Math.abs(retryAfterMs(new Date(Date.now() + 30_000).toUTCString()) - 30_000) < 1500); assert.equal(retryAfterMs('7'), 7000);
  assert.ok(Number.isNaN(retryAfterMs('soon'))); assert.ok(Number.isNaN(retryAfterMs(null)));
});

test('I07 v2 review: waiting for the state lock counts against the deadline; an expired decision sends nothing (R05)', async (t) => {
  const a = F('a'), root = project(t, [a]);
  const seen = fakeTypesafe(t, [body(a)]);
  const holder = withLock(root, () => Bun.sleep(600));
  await Bun.sleep(20);
  const lines: string[] = [];
  const recs = await classify(root, cfg({ timeoutMs: 150 }), [a], (s) => lines.push(s), 'manual', fakeKey);
  await holder;
  assert.equal(seen.length, 0, 'no request after the deadline'); assert.equal(recs.length, 0); assert.match(lines[0]!, /deadline 150 ms reached waiting for the state lock/);
});

test('I07 v2 review: investigate keeps routing-review for protected work and risk-review for explicit normal (R06)', () => {
  const refund = F('r', { title: 'Refund flow', description: 'Refund a payment', risk: 'high' });
  assert.ok(assess(refund, probs(refund, { u01_unknown_root_cause: 0.95 }), [refund], null).dispositions.some((d) => /routing-review/.test(d)));
  const e = F('e', { risk: 'normal' });
  const d = assess(e, probs(e, { u01_unknown_root_cause: 0.95, s02_funds_effect: 0.95 }), [e], null).dispositions;
  assert.ok(d.some((x) => /risk-review/.test(x))); assert.ok(d.some((x) => /routing-review/.test(x)));
});

test('I07 v2 review: the report separates stale, failed and never-attempted features, re-projects with today\'s scorer, and never averages unknown cost (R07, R08)', async (t) => {
  const a = F('a', { status: 'merged' }), b = F('b'), c = F('c'), d = F('d'), root = project(t, [a, b, c, d]);
  fakeTypesafe(t, [body(a), body(b), 422]);
  await classify(root, cfg(), [a, b, c], () => {}, 'manual', fakeKey);
  let r = report(root, [a, { ...b, description: 'changed' }, c, d], cfg());
  assert.match(r, /1 current .*, 1 stale .*, 1 with only failed attempts, 1 never attempted/); assert.match(r, /candidate normal\s+1\s+1\s+0\s+0\.00\s+unknown/);
  writeFileSync(join(root, 'scorer.json'), JSON.stringify(parity().scorer));
  r = report(root, [a], cfg({ scorer: 'scorer.json' }));
  assert.match(r, /Attention score available for 1 of 1/);
});

test('I07 v2 review: provider metadata is allowlisted, untrusted model strings are not recorded, extra answers and aliases are rejected (R09, R10)', async (t) => {
  const f = F('a'), q = questionsFor(f);
  const v = validateAnswers(q, { ...body(f), usage: { input_tokens: 5, output_tokens: -1, debug_auth: 'leak' } }, MODEL);
  assert.ok(v.ok); assert.deepEqual((v as any).usage, { input_tokens: 5 });
  const echoed = validateAnswers(q, body(f, {}, 'test-key-echo'), MODEL);
  assert.ok(!echoed.ok); assert.doesNotMatch((echoed as any).error, /test-key-echo/);
  const extra = body(f); (extra.answers as any).unrequested = { type: 'noul', noul: 0.5 };
  assert.match((validateAnswers(q, extra, MODEL) as any).error, /not asked/);
  const root = project(t, [f]);
  fakeTypesafe(t, [{ ...body(f), usage: { input_tokens: 1, note: 'test-key' } }]);
  await classify(root, cfg(), [f], () => {}, 'manual', fakeKey);
  assert.doesNotMatch(readFileSync(join(root, '.fact-os', 'classifier.jsonl'), 'utf8'), /test-key/);
});

test('I07 v2 review: records keep a secret-free input snapshot, the authority and the roles in effect (R11)', async (t) => {
  const f = F('a', { risk: 'high' }), root = project(t, [f]);
  fakeTypesafe(t, [body(f)]);
  const roles = { builder: { provider: 'claude' as const, model: 'sonnet', effort: 'medium' }, evaluator: { provider: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' } };
  const [rec] = await classify(root, cfg(), [f], () => {}, 'manual', fakeKey, () => roles);
  assert.deepEqual(rec!.roles, roles); assert.deepEqual(rec!.authority, { tier: null, risk: 'high' });
  assert.equal((rec!.input as any).feature.title, 'Feature a'); assert.equal((rec!.input as any).glossaryHash, null); assert.equal((rec!.input as any).codebase, undefined);
  assert.ok('score' in rec!.assessment!.attention === false);
});

test('I07 v2 review: Python-compatible keyword folding for dotted and dotless i (R13)', () => {
  const { scorer } = parity();
  assert.equal(codeFeatures(scorer, { title: 'Adjust prİce and dıscount', description: '', acceptance: [], surface: 'api', touches: [], deps: [] }).kw_hits, 2);
});

test('I07 v2 review: every subprocess in lib gets an explicit childEnv() (R14)', () => {
  const lib = join(import.meta.dir, '..', 'lib');
  for (const f of readdirSync(lib).filter((f) => f.endsWith('.ts')))
    for (const [i, line] of readFileSync(join(lib, f), 'utf8').split('\n').entries())
      if (/\b(spawnSync|spawn|execSync|execFileSync)\(/.test(line) && !/import /.test(line)) assert.match(line, /env(: childEnv\(\)|,|: env\b)/, `${f}:${i + 1} starts a process without an explicit environment`);
});

test('I07 v3 review: the scorer contract is strict: version, frozen families and exclusions, typed threshold equal to the reference quantile (V314)', (t) => {
  const root = project(t), file = join(root, 's.json'), { scorer } = parity(), expect = { model: MODEL, glossaryHash: null };
  const bad = (o: object, rx: RegExp) => { writeFileSync(file, JSON.stringify({ ...scorer, ...o })); assert.match((loadScorer(file, expect) as any).error, rx, JSON.stringify(o).slice(0, 80)); };
  bad({ version: 'i07-v9' }, /unsupported extraction contract/);
  bad({ composites: { ...scorer.composites, families: { ...scorer.composites.families, stakes: [...scorer.composites.families.stakes!, 'm03_existing_writer_delegation'] } } }, /family stakes differs/);
  bad({ composites: { ...scorer.composites, excludedWithoutFacts: [] } }, /exclusions differ/);
  bad({ reference: { ...scorer.reference, threshold: '0' } }, /out of range/);
  bad({ reference: { ...scorer.reference, tailFraction: undefined } }, /tail fraction/);
  bad({ reference: { ...scorer.reference, threshold: 0 } }, /not the reference quantile/);
});

test('I07 v3 review: the sent glossary is kept by content so inputs can be reconstructed; a role change re-projects locally (V315)', async (t) => {
  const a = F('a'), root = project(t, [a]);
  writeFileSync(join(root, 'glossary.json'), JSON.stringify({ money: 'immutable context expected' }));
  const seen = fakeTypesafe(t, [body(a)]);
  const roles = (model: string) => () => ({ builder: { provider: 'claude' as const, model, effort: 'medium' }, evaluator: { provider: 'claude' as const, model: 'opus', effort: 'high' } });
  const [rec] = await classify(root, cfg({ glossary: 'glossary.json' }), [a], () => {}, 'manual', fakeKey, roles('sonnet'));
  const kept = join(root, '.fact-os', 'classifier-context', `${(rec!.input as any).glossaryHash}.json`);
  assert.deepEqual(JSON.parse(readFileSync(kept, 'utf8')), { money: 'immutable context expected' });
  const [again] = await classify(root, cfg({ glossary: 'glossary.json' }), [a], () => {}, 'manual', noKey, roles('opus'));
  assert.equal(seen.length, 1); assert.equal(again!.attempts, 0); assert.equal(again!.roles!.builder.model, 'opus');
});
