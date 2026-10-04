// I07 phase 1: the shadow classifier against a local fake TypeSafe server (no real provider calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askJev, classify, classifierState, decide, inputHash, readRecords, report, typesafeKey, QUESTIONS, type JevAnswer } from '../lib/classifier.ts';
import { CLASSIFIER_DEFAULTS, DEFAULT_CONFIG, loadConfig } from '../lib/state.ts';
import type { Feature } from '../lib/types.ts';

// Never reach the real TypeSafe API from a test: every request goes to a dead local port unless a fake server replaces it,
// and the key never comes from fact-os's own .env (which may hold a real key).
process.env.FACTOS_TYPESAFE_URL = 'http://127.0.0.1:9/never-real';
const noKey = () => null, fakeKey = () => 'test-key';

const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id} works`],
  surface: 'api', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
const cfg = { ...CLASSIFIER_DEFAULTS, timeoutMs: 2000, maxRetries: 1 };
const answer = (tier: string, confidence: number, split = 0.1) => ({ model: 'jev-1.2', answers: {
  tier: { type: 'choice', choice: tier, probabilities: { [tier]: 0.9 }, confidence }, needsSplit: { type: 'noul', noul: split } } });

// A fake systemone endpoint: `replies` per request in order (an object is a 200 body, a number an HTTP status).
function fakeTypesafe(t: { after: (fn: () => void) => void }, replies: (object | number)[]) {
  const seen: { auth: string | null; body: { model: string; state: unknown; questions: typeof QUESTIONS } }[] = [];
  const server = Bun.serve({ port: 0, fetch: async (req) => {
    seen.push({ auth: req.headers.get('authorization'), body: await req.json() as never });
    const r = replies.shift() ?? 500;
    return typeof r === 'number' ? new Response('{}', { status: r }) : Response.json(r);
  } });
  const prev = { url: process.env.FACTOS_TYPESAFE_URL, key: process.env.TYPESAFE_API_KEY };
  process.env.FACTOS_TYPESAFE_URL = `http://127.0.0.1:${server.port}/v1/systemone`; process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => { server.stop(true); process.env.FACTOS_TYPESAFE_URL = prev.url ?? 'http://127.0.0.1:9/never-real'; if (prev.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prev.key; });
  return seen;
}
function project(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-classifier-'));
  mkdirSync(join(root, '.fact-os')); mkdirSync(join(root, '.git'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('I07: the request carries the agreed questions, the feature state and the key as a bearer token', async (t) => {
  const seen = fakeTypesafe(t, [answer('multi', 0.9)]);
  const deps = [F('d', { status: 'merged' })], f = F('a', { deps: ['d'], touches: ['src/'] });
  const r = await askJev(cfg, classifierState(f, [...deps, f]), 'test-key');
  assert.ok(r.ok); assert.deepEqual([r.answer.tier, r.answer.model, r.answer.needsSplit], ['multi', 'jev-1.2', 0.1]);
  assert.equal(seen[0]!.auth, 'Bearer test-key'); assert.equal(seen[0]!.body.model, 'jev-latest');
  assert.deepEqual(Object.keys(seen[0]!.body.questions.tier.criteria), ['normal', 'multi', 'hard', 'risky', 'investigate', 'insufficient_info']);
  assert.equal(seen[0]!.body.questions.needsSplit.type, 'noul');
  assert.deepEqual((seen[0]!.body.state as { dependencies: unknown[] }).dependencies, [{ id: 'd', title: 'Feature d', status: 'merged' }]);
});

test('I07: 401 stops without retrying; 429 and 529 retry within the bound; a bad shape is an error, never a guess', async (t) => {
  let seen = fakeTypesafe(t, [401]);
  let r = await askJev(cfg, {}, 'k'); assert.equal(r.ok, false); assert.match((r as { error: string }).error, /401.*invalid TypeSafe API key/); assert.equal(seen.length, 1);
  seen.length = 0; seen = fakeTypesafe(t, [429, answer('normal', 0.95)]);
  r = await askJev(cfg, {}, 'k'); assert.ok(r.ok); assert.equal(seen.length, 2);
  seen = fakeTypesafe(t, [529, 529, answer('normal', 0.95)]);
  r = await askJev(cfg, {}, 'k'); assert.equal(r.ok, false, 'only maxRetries retries');
  fakeTypesafe(t, [{ answers: { tier: { type: 'choice', choice: 'enormous', probabilities: {}, confidence: 0.9 }, needsSplit: { type: 'noul', noul: 0.2 } } }]);
  r = await askJev(cfg, {}, 'k'); assert.equal(r.ok, false); assert.match((r as { error: string }).error, /unexpected answer shape/);
});

test('I07: abstention rules: insufficient info, low confidence, risk conflicts and a person\'s tier', () => {
  const a = (tier: JevAnswer['tier'], confidence: number): JevAnswer => ({ model: 'm', tier, probabilities: {}, confidence, needsSplit: 0 });
  const plain = F('a', { title: 'Product list page', description: 'Show products in a grid' }), money = F('b', { title: 'Refund flow', description: 'Refund a payment' });
  assert.equal(decide(plain, a('multi', 0.85), cfg).decision, 'would-apply');
  assert.match(decide(plain, a('multi', 0.5), cfg).reason, /confidence 0\.50 below 0\.8/);
  assert.match(decide(plain, a('insufficient_info', 0.99), cfg).reason, /insufficient information/);
  assert.match(decide(money, a('normal', 0.99), cfg).reason, /risk conflict/, 'a risky-looking feature is never downgraded on the model\'s word');
  assert.match(decide(money, a('risky', 0.85), cfg).reason, /below 0\.9/, 'protected features need the higher risk confidence');
  assert.equal(decide(money, a('risky', 0.95), cfg).decision, 'would-apply');
  assert.equal(decide(F('c', { tier: 'hard' }), a('normal', 0.99), cfg).decision, 'skip');
});

test('I07: classify records shadow answers, changes no feature, skips unchanged input and a person\'s tier, and honors the daily cap', async (t) => {
  const root = project(t), seen = fakeTypesafe(t, [answer('multi', 0.9), answer('risky', 0.95, 0.85)]);
  const features = [F('a'), F('b', { title: 'Refund flow', description: 'Refund a payment' }), F('c', { tier: 'normal' })];
  const before = JSON.stringify(features), lines: string[] = [];
  const recs = await classify(root, cfg, features, features, (s) => lines.push(s), 'manual', fakeKey);
  assert.equal(JSON.stringify(features), before, 'shadow mode never changes a feature');
  assert.deepEqual(recs.map((r) => [r.feature, r.decision]), [['a', 'would-apply'], ['b', 'would-apply'], ['c', 'skip']]);
  assert.equal(seen.length, 2, 'no request for a feature a person tiered');
  assert.equal(readRecords(root)[1]!.needsSplit, 0.85);
  assert.equal(readRecords(root)[0]!.hash, inputHash(classifierState(features[0]!, features)));
  await classify(root, cfg, features.slice(0, 1), features, (s) => lines.push(s), 'manual', fakeKey);
  assert.equal(seen.length, 2); assert.ok(lines.some((l) => /unchanged since its last classification/.test(l)));
  await classify(root, { ...cfg, maxRequestsPerDay: 2 }, [F('d')], [F('d')], (s) => lines.push(s), 'manual', fakeKey);
  assert.equal(seen.length, 2); assert.ok(lines.some((l) => /daily request cap 2 reached/.test(l)));
});

test('I07: without a key nothing is requested; the key comes from TYPESAFE_API_KEY or fact-os .env and is never recorded', async (t) => {
  const root = project(t), dir = mkdtempSync(join(tmpdir(), 'fact-os-env-')), env = join(dir, '.env');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(env, '# local\nexport TYPESAFE_API_KEY="from-env-file"\nOTHER=1\n');
  const prev = process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev; });
  assert.equal(typesafeKey(env), 'from-env-file'); assert.equal(typesafeKey(join(dir, 'missing')), null);
  const lines: string[] = [];
  assert.deepEqual(await classify(root, cfg, [F('a')], [F('a')], (s) => lines.push(s), 'manual', noKey), []);
  assert.match(lines[0]!, /no TypeSafe API key/);
  fakeTypesafe(t, [answer('normal', 0.9)]);
  await classify(root, cfg, [F('a')], [F('a')], () => {}, 'manual', fakeKey);
  assert.doesNotMatch(readFileSync(join(root, '.fact-os', 'classifier.jsonl'), 'utf8'), /test-key/);
});

test('I07: the report puts the latest shadow tier beside what each feature actually took', async (t) => {
  const root = project(t);
  fakeTypesafe(t, [answer('risky', 0.95, 0.9), answer('normal', 0.9)]);
  const features = [F('a', { status: 'stuck', attempts: 2, costUsd: 20 }), F('b', { status: 'merged', attempts: 0, costUsd: 2 })];
  await classify(root, cfg, features, features, () => {}, 'manual', fakeKey);
  const r = report(root, features);
  assert.match(r, /risky\s+1\s+0\s+1\s+2\.00\s+\$20\.00\s+1/); assert.match(r, /normal\s+1\s+1\s+0\s+0\.00\s+\$2\.00/);
  assert.match(report(project(t), features), /No shadow classifications yet/);
});

test('I07: config: classifier is off by default; shadow is the only mode; defaults fill a partial block', (t) => {
  const root = project(t), file = join(root, '.fact-os', 'config.json');
  const set = (o: object) => writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, test: 'true', ...o }));
  set({}); assert.equal(loadConfig(root).classifier, null);
  set({ classifier: { provider: 'typesafe' } }); assert.deepEqual(loadConfig(root).classifier, CLASSIFIER_DEFAULTS);
  for (const c of [{ provider: 'openai' }, { mode: 'apply' }, { minConfidence: 1.5 }, { timeoutMs: 10 }, { maxRetries: 9 }, 'x']) {
    set({ classifier: c }); assert.throws(() => loadConfig(root), /config\.classifier/, JSON.stringify(c));
  }
});
