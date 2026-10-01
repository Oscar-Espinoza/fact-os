// Model profiles (lib/profiles.ts): pure resolution of the model/effort each role runs with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../lib/state.ts';
import { DEFAULT_PROFILES, profiles, profileNames, validProfile, normalizeProfile, resolveRole, isRisky, escalates, roleTable, profileProblems, profileLabel } from '../lib/profiles.ts';
import type { Config } from '../lib/types.ts';

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

test('isRisky: an explicit risk tag wins; untagged features go by keywords', () => {
  assert.equal(isRisky({ ...plain, risk: 'high' }), true);
  assert.equal(isRisky({ ...risky, risk: 'normal' }), false, 'explicit non-high tag wins over keywords');
  assert.equal(isRisky({ ...risky, risk: 'low' }), false);
  for (const t of ['Money transfer', 'Payment page', 'Payments', 'Refunds', 'refunded orders', 'Price rules', 'Pricing tiers', 'Invoice PDF', 'invoicing', 'Tax rates',
    'taxes', 'Permission matrix', 'permissions', 'Auth', 'authn flow', 'authz checks', 'Authentication', 'authorization', 'authorisation', 'API tokens', 'token refresh',
    'Tenant scoping', 'multi-tenant', 'tenants', 'RLS policies', 'rls', 'DB migration', 'migrations', 'migrate users', 'concurrency limits', 'concurrent edits',
    'Row lock', 'locking', 'locks', 'deadlock', 'race condition', 'races', 'order state machine', 'State-machine'])
    assert.equal(isRisky({ title: t, description: '' }), true, t);
  for (const t of ['Author page', 'authored posts', 'Block editor', 'clock widget', 'blocks', 'Trace viewer', 'braces', 'pricey', 'syntax', 'taxonomy', 'stateful machine',
    'tokenizer', 'permissive', 'migratory birds', 'unlocked']) assert.equal(isRisky({ title: t, description: '' }), false, t);
  assert.equal(isRisky({ title: 'Checkout', description: 'Charges the PAYMENT method' }), true, 'description, case-insensitive');
  assert.equal(isRisky({ title: '', description: '' }), false);
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
