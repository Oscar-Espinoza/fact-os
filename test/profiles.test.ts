// Model profiles (lib/profiles.ts): pure resolution of the model/effort each role runs with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../lib/state.ts';
import { DEFAULT_PROFILES, profiles, profileNames, validProfile, normalizeProfile, resolveRole, isRisky, escalates, roleTable, profileProblems, profileLabel, riskFamilies, tierApplies, ladderFailures, ladderStep } from '../lib/profiles.ts';
import { promptFingerprint } from '../lib/foreman.ts';
import type { Config, Tier } from '../lib/types.ts';

const C = (o: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...o });
const plain = { title: 'Product list page', description: 'Show the products in a grid' };
const risky = { title: 'Refund flow', description: 'Customers can ask for a refund' };

test('opus (null) is each role\'s own config; resolver falls back to builder; observer/curator take the agent config', () => {
  const c = C({ builder: { model: 'opus', effort: 'medium', permissionMode: 'auto' }, evaluator: { model: 'opus', effort: 'high', permissionMode: 'plan' } });
  assert.deepEqual(resolveRole(c, null, 'builder', { feature: risky }), { model: 'opus', effort: 'medium', permissionMode: 'auto' }, 'opus never escalates');
  assert.deepEqual(resolveRole(c, 'opus', 'evaluator'), c.evaluator);
  assert.deepEqual(resolveRole(c, null, 'resolver'), c.builder, 'resolver: null → the builder config');
  assert.deepEqual(resolveRole(C({ resolver: { model: 'r' } }), null, 'resolver'), { model: 'r' });
  assert.deepEqual(resolveRole(c, null, 'observer', { agent: { model: 'opus', effort: 'high', permissionMode: 'auto' } }), { model: 'opus', effort: 'high', permissionMode: 'auto' });
  assert.deepEqual(resolveRole(c, null, 'curator'), {}, 'no agent config: nothing to pass');
});

test('fable-sonnet overrides model and effort for the roles it names, keeping permissionMode from the role config', () => {
  const c = C({ builder: { model: 'opus', effort: 'low', permissionMode: 'bypassPermissions' }, evaluator: { model: 'opus', effort: 'max', permissionMode: 'plan' } });
  assert.deepEqual(resolveRole(c, 'fable-sonnet', 'builder', { feature: plain }), { model: 'sonnet', effort: 'medium', permissionMode: 'bypassPermissions' });
  assert.deepEqual(resolveRole(c, 'fable-sonnet', 'builder', { feature: risky }), { model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions' });
  assert.deepEqual(resolveRole(c, 'fable-sonnet', 'resolver', { feature: risky }), { model: 'sonnet', effort: 'high', permissionMode: 'bypassPermissions' }, 'resolver base = builder');
  assert.deepEqual(resolveRole(c, 'fable-sonnet', 'evaluator'), { model: 'fable', effort: 'high', permissionMode: 'plan' });
  assert.deepEqual(resolveRole(c, 'fable-sonnet', 'observer', { agent: { model: 'opus', permissionMode: 'auto' } }), { model: 'fable', effort: 'high', permissionMode: 'auto' });
  assert.deepEqual(resolveRole(c, 'fable-sonnet', 'curator', { agent: null }), { model: 'fable', effort: 'medium' });
});

test('a role the profile does not name falls back to its config; entry fields override only when present', () => {
  const c = C({ profiles: { cheap: { builder: { model: 'haiku' }, evaluator: { effort: 'low' } } } });
  assert.deepEqual(resolveRole(c, 'cheap', 'builder'), { ...c.builder, model: 'haiku' });
  assert.deepEqual(resolveRole(c, 'cheap', 'evaluator'), { ...c.evaluator, effort: 'low' });
  assert.deepEqual(resolveRole(c, 'cheap', 'resolver'), c.builder, 'unnamed: the role config, not the profile\'s builder');
  assert.deepEqual(resolveRole(c, 'nope', 'builder'), c.builder, 'unknown resolves like opus');
});

test('config profiles add to the built-ins, replace one of the same name, and can never redefine opus', () => {
  const c = C({ profiles: { 'fable-sonnet': { builder: { model: 'x' } }, mine: { evaluator: { model: 'y' } }, opus: { builder: { model: 'z' } } } });
  assert.deepEqual(profileNames(c), ['opus', 'fable-sonnet', 'mine']);
  assert.deepEqual(profiles(c)['fable-sonnet'], { builder: { model: 'x' } }, 'replaced whole, not merged');
  assert.deepEqual(resolveRole(c, 'fable-sonnet', 'evaluator'), c.evaluator);
  assert.deepEqual(resolveRole(c, 'opus', 'builder'), c.builder);
  assert.deepEqual(profileNames(C()), ['opus', 'fable-sonnet']);
  assert.deepEqual(profiles(C()), DEFAULT_PROFILES);
});

test('validProfile / normalizeProfile: null and known names; "opus" and "default" are stored as null', () => {
  const c = C({ profiles: { mine: {} } });
  for (const ok of [null, 'opus', 'fable-sonnet', 'mine']) assert.equal(validProfile(c, ok), true, String(ok));
  for (const bad of ['nope', '', 'default', 'Opus', 3, undefined, {}]) assert.equal(validProfile(c, bad), false, String(bad));
  assert.deepEqual(['opus', 'default', null, 'mine'].map(normalizeProfile), [null, null, null, 'mine']);
  assert.deepEqual([null, 'opus', 'fable-sonnet', 'mine'].map(profileLabel), ['Opus', 'Opus', 'Fable + Sonnet', 'mine']);
});

test('isRisky: an explicit risk tag wins; untagged, a title keyword or two keyword families in the description', () => {
  assert.equal(isRisky({ ...plain, risk: 'high' }), true);
  assert.equal(isRisky({ ...risky, risk: 'normal' }), false, 'explicit non-high tag wins over keywords');
  assert.equal(isRisky({ ...risky, risk: 'low' }), false);
  for (const t of ['Money transfer', 'Payment page', 'Payments', 'Refunds', 'refunded orders', 'refundable items', 'Price rules', 'Pricing tiers', 'Invoice PDF',
    'invoicing', 'Tax rates', 'taxes', 'Permission matrix', 'permissions', 'Auth', 'authn flow', 'authz checks', 'OAuth login', 'oauth2 callback', 'Authentication',
    'authenticate users', 'unauthenticated requests', 'authorization', 'authorizations', 'authorized users', 'unauthorized access', 'unauthorization page',
    'authorisation', 'JWT signing', 'API keys', 'api key rotation', 'access token', 'refresh tokens', 'Tenant scoping', 'multi-tenant', 'tenants', 'RLS policies',
    'rls', 'DB migration', 'migrations', 'migrate users', 'concurrency limits', 'concurrent edits', 'Row lock', 'locking', 'locks', 'deadlock', 'race condition',
    'races', 'order state machine', 'State-machine'])
    assert.equal(isRisky({ title: t, description: '' }), true, t);
  for (const t of ['Author page', 'authored posts', 'Block editor', 'clock widget', 'blocks', 'Trace viewer', 'braces', 'pricey', 'syntax', 'taxonomy', 'stateful machine',
    'tokenizer', 'permissive', 'migratory birds', 'unlocked', 'design tokens', 'Theme tokens', 'token list', 'update pnpm-lock.yaml', 'regenerate bun.lock',
    'commit the lock file', 'lockfile check', 'optimistic-lock helper', 'Checkout copy', 'Login page'])
    assert.equal(isRisky({ title: t, description: '' }), false, t);
  assert.equal(isRisky({ title: 'Settings page', description: 'A long text that mentions the payment settings once.' }), false, 'one family in the description is not enough');
  assert.equal(isRisky({ title: 'Settings page', description: 'Payment, payments and refunds.\nMore payment text.' }), true, 'two families: payment and refund');
  assert.equal(isRisky({ title: 'Settings page', description: 'PAYMENT methods and the payments table, payment again.' }), false, 'repeating one family is still one');
  assert.equal(isRisky({ title: 'Checkout', description: 'Charges the PAYMENT method; needs a DB MIGRATION' }), true, 'description, case-insensitive');
  assert.equal(isRisky({ title: '', description: '' }), false);
  assert.deepEqual(riskFamilies('A refund needs a migration and an auth check; design tokens stay'), ['refund', 'auth', 'migration']);
});

test('escalates: only a profile whose builder has effortHigh, only for risky features', () => {
  assert.equal(escalates(C(), 'fable-sonnet', risky), true);
  assert.equal(escalates(C(), 'fable-sonnet', plain), false);
  assert.equal(escalates(C(), null, risky), false);
  assert.equal(escalates(C({ profiles: { flat: { builder: { model: 'x', effort: 'low' } } } }), 'flat', risky), false);
});

test('roleTable lists every role as resolved, with the builder\'s effortHigh', () => {
  const agent = { model: 'opus', effort: 'high' };
  assert.deepEqual(roleTable(C(), 'fable-sonnet', agent), [
    { role: 'builder', model: 'sonnet', effort: 'medium', effortHigh: 'high', fromProfile: true },
    { role: 'resolver', model: 'sonnet', effort: 'high', fromProfile: true },
    { role: 'evaluator', model: 'fable', effort: 'high', fromProfile: true },
    { role: 'observer', model: 'fable', effort: 'high', fromProfile: true },
    { role: 'curator', model: 'fable', effort: 'medium', fromProfile: true }]);
  assert.deepEqual(roleTable(C(), null, agent).map((r) => [r.role, r.model, r.effort, r.fromProfile]), [['builder', 'opus', 'medium', false], ['resolver', 'opus', 'medium', false],
    ['evaluator', 'opus', 'high', false], ['observer', 'opus', 'high', false], ['curator', 'opus', 'high', false]]);
});

test('profileProblems (doctor): object of objects, known roles, string fields, opus reserved', () => {
  assert.deepEqual(profileProblems(undefined), []);
  assert.deepEqual(profileProblems({ mine: { builder: { model: 'x', effort: 'low', effortHigh: 'high' }, curator: {} } }), []);
  assert.equal(profileProblems([]).length, 1);
  const p = profileProblems({ opus: {}, a: 3, b: { reviewer: {} }, c: { builder: 'x' }, d: { evaluator: { model: 3, permissionMode: 'plan', effortHigh: 'max' } } });
  for (const re of [/profiles\.opus: "opus" is reserved/, /profiles\.a must be an object/, /profiles\.b\.reviewer: unknown role/, /profiles\.c\.builder must be an object/,
    /profiles\.d\.evaluator\.model must be a non-empty string/, /profiles\.d\.evaluator\.permissionMode: unknown field.*role config/, /profiles\.d\.evaluator\.effortHigh: only the builder/])
    assert.ok(p.some((x) => re.test(x)), `${re} in ${JSON.stringify(p)}`);
});

// ---- I03: feature tiers, set at intake ----
const tiered = C({ builder: { model: 'opus', effort: 'medium', permissionMode: 'auto' }, evaluator: { model: 'opus', effort: 'high', permissionMode: 'auto' },
  profiles: { 'opus-sonnet': {
    builder: { model: 'sonnet', effort: 'medium', effortHigh: 'high' }, evaluator: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    tiers: { multi: { builder: { effort: 'high' } }, hard: { builder: { model: 'opus', effort: 'medium' } },
      risky: { builder: { model: 'opus', effort: 'high' }, evaluator: { effort: 'xhigh' } }, investigate: { builder: { model: 'opus', effort: 'high' } } },
  } } });
const tier = (t: Tier | undefined, base = risky) => ({ ...base, tier: t });

test('I03: a feature tier picks role models from the active profile; the risk heuristic is only the fallback', () => {
  const b = (t: Tier | undefined, base = risky) => resolveRole(tiered, 'opus-sonnet', 'builder', { feature: tier(t, base) });
  assert.deepEqual(b('normal'), { model: 'sonnet', effort: 'medium', permissionMode: 'auto' }, 'an explicit tier wins over risk keywords');
  assert.deepEqual(b('multi'), { model: 'sonnet', effort: 'high', permissionMode: 'auto' });
  assert.deepEqual(b('hard'), { model: 'opus', effort: 'medium', permissionMode: 'auto' });
  assert.deepEqual(b('risky', plain), { model: 'opus', effort: 'high', permissionMode: 'auto' });
  assert.deepEqual(b(undefined), { model: 'sonnet', effort: 'high', permissionMode: 'auto' }, 'untiered: the heuristic escalates effort');
  assert.deepEqual(b(undefined, plain), { model: 'sonnet', effort: 'medium', permissionMode: 'auto' });
  assert.deepEqual(resolveRole(tiered, 'opus-sonnet', 'evaluator', { feature: tier('risky') }),
    { model: 'gpt-6.1-sol', effort: 'xhigh', permissionMode: 'auto', provider: 'codex' }, 'risky: deep Codex review');
  assert.deepEqual(resolveRole(tiered, 'opus-sonnet', 'evaluator', { feature: tier('multi') }),
    { model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'auto', provider: 'codex' });
  assert.deepEqual(resolveRole(tiered, null, 'builder', { feature: tier('risky') }), tiered.builder, 'opus mode ignores tiers');
  assert.equal(escalates(tiered, 'opus-sonnet', tier('normal')), false);
  assert.equal(escalates(tiered, 'opus-sonnet', tier(undefined)), true);
  assert.equal(tierApplies(tiered, 'opus-sonnet', 'builder', tier('hard')), 'hard');
  assert.equal(tierApplies(tiered, 'opus-sonnet', 'evaluator', tier('hard')), null, 'the hard tier names no evaluator');
  assert.equal(tierApplies(tiered, null, 'builder', tier('hard')), null);
});

test('I03: profileProblems checks tiers, providers and their roles', () => {
  assert.deepEqual(profileProblems(tiered.profiles), []);
  const bad = (p: unknown) => profileProblems({ x: p }).join('\n');
  assert.match(bad({ tiers: { huge: { builder: { model: 'opus' } } } }), /tiers\.huge: unknown tier/);
  assert.match(bad({ tiers: { hard: { observer: { model: 'opus' } } } }), /tiers\.hard\.observer: unknown role/);
  assert.match(bad({ tiers: { hard: { builder: { effortHigh: 'high' } } } }), /tiers\.hard\.builder\.effortHigh: unknown field/);
  assert.match(bad({ tiers: { hard: { builder: { provider: 'codex' } } } }), /tiers\.hard\.builder\.provider/);
  assert.match(bad({ builder: { provider: 'codex' } }), /x\.builder\.provider/);
  assert.match(bad({ tiers: 'x' }), /tiers must be an object/);
});

test('I03: a tier that changed a role shows in its prompt fingerprint', () => {
  assert.match(promptFingerprint('builder', { model: 'opus', effort: 'high' }, null, '', 'opus-sonnet', null, null, 'risky'), / tier=risky$/);
  assert.doesNotMatch(promptFingerprint('builder', { model: 'opus', effort: 'high' }, null, '', 'opus-sonnet'), /tier=/);
});

test('retry ladder: counted build/review failures in the current cycle climb approved rungs from where profile and tier put the builder; never down, never off-ladder', () => {
  const config = { ...DEFAULT_CONFIG, profiles: { p: { builder: { model: 'sonnet', effort: 'medium' }, tiers: { risky: { builder: { model: 'opus', effort: 'high' } } },
    ladder: [{ model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' }] } } } as unknown as Config;
  const ev = (event: string, detail = '', o = {}) => ({ feature: 'a', event, detail, ...o });
  const counted = { stop: { attempt: 1, counted: true } };
  const events = [ev('failed', 'FAILED tenant check: x', counted), ev('failed', 'prepare `x` failed', counted), ev('failed', 'Evaluator: invalid JSON', counted),
    ev('failed', 'test command `t` failed', { ...counted, cause: 'environment' }), ev('failed', 'BLOCKING: dup', { stop: { attempt: 2, counted: false } })];
  assert.equal(ladderFailures(events, 'a', 3), 1);
  assert.equal(ladderFailures([...events, ev('retrying'), ev('failed', 'BLOCKING: y', counted)], 'a', 3), 1);
  assert.equal(ladderFailures([ev('failed', 'FAILED a', counted), ev('failed', 'CHEATING: b', counted)], 'a', 1), 1); // capped by attempts
  const base = resolveRole(config, 'p', 'builder', { feature: { title: 't', description: '' } });
  assert.deepEqual(ladderStep(config, 'p', base, 1), { cfg: { ...base, model: 'sonnet', effort: 'high' }, rule: 'ladder: 1 counted failure this cycle → sonnet high (from sonnet medium)' });
  assert.equal(ladderStep(config, 'p', base, 5)!.cfg.model, 'opus');
  const risky = resolveRole(config, 'p', 'builder', { feature: { title: 't', description: '', tier: 'risky' } });
  assert.match(ladderStep(config, 'p', risky, 2)!.rule, /already on the top rung/); assert.equal(ladderStep(config, 'p', risky, 2)!.cfg.model, 'opus');
  assert.equal(ladderStep(config, 'p', { model: 'haiku', effort: 'low' }, 2), null); assert.equal(ladderStep(config, 'p', base, 0), null);
  assert.deepEqual(profileProblems({ p: { ladder: [{ model: 'a', effort: 'b' }] } }), ['config.profiles.p.ladder must be an array of at least two {model, effort} rungs, weakest first']);
  assert.deepEqual(profileProblems({ p: { ladder: [{ model: 'a', effort: 'b' }, { model: 'a', effort: 'b', x: 1 }] } }), ['config.profiles.p.ladder[1] must be {model, effort} with non-empty strings']);
});
