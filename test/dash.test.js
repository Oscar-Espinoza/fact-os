import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDash } from '../lib/dash.js';

let root, dash;
const F = (id, o = {}) => ({ id, title: id, description: '', acceptance: ['x'], surface: 'any', deps: [], priority: 1,
  status: 'todo', attempts: 0, updatedAt: '', ...o });
function project(dir, { merge = 'auto', features = [], tasks = [], gitFile = false }) {
  mkdirSync(join(dir, '.shipyard'), { recursive: true });
  if (gitFile) writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n'); else mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.shipyard/config.json'), JSON.stringify({ merge }));
  writeFileSync(join(dir, '.shipyard/features.json'), JSON.stringify({ features }));
  writeFileSync(join(dir, '.shipyard/human.json'), JSON.stringify({ tasks }));
}
const humanOf = (p) => JSON.parse(readFileSync(join(root, p, '.shipyard/human.json'), 'utf8')).tasks;
const post = (path, body, headers = {}) => fetch(dash.url + path, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'shipyard-dash-'));
  project(join(root, 'shop'), { features: [F('pay'), F('cart', { deps: ['pay'] })],
    tasks: [{ id: 'stripe', title: 'Create Stripe account', steps: ['sign up'], unblocks: ['pay'], mockable: false, status: 'open' }] });
  project(join(root, 'group/blog'), { merge: 'manual', features: [F('post', { status: 'ready' })] });
  project(join(root, 'shop-worktrees/pay'), { gitFile: true }); // a worktree checkout, not a project
  dash = await startDash({ root, port: 0 });
});
after(() => { dash.server.close(); rmSync(root, { recursive: true, force: true }); });

test('serves the page and /api/state for discovered projects, skipping worktrees', async () => {
  const html = await (await fetch(dash.url + '/')).text();
  assert.match(html, /Only you/);
  assert.match(html, /\/api\/state/);
  const s = await (await fetch(dash.url + '/api/state')).json();
  assert.deepEqual(s.projects.map((p) => p.path).sort(), [join(root, 'group/blog'), join(root, 'shop')]);
  const t = s.human.find((h) => h.id === 'stripe');
  assert.equal(t.reach, 2); // pay directly, cart transitively
});

test('POST with a project that was not discovered is rejected and changes nothing', async () => {
  for (const project of ['/etc', join(root, 'shop-worktrees/pay'), root + '/shop/../shop', root + '/shop/', 42]) {
    const r = await post('/api/human/done', { project, id: 'stripe' });
    assert.equal(r.status, 400, String(project));
  }
  assert.equal(humanOf('shop')[0].status, 'open');
});

test('POST from a foreign Origin is rejected (CSRF from another site)', async () => {
  const r = await post('/api/human/done', { project: join(root, 'shop'), id: 'stripe' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(humanOf('shop')[0].status, 'open');
});

test('"I did my part" marks the task done and unblocks its feature', async () => {
  const r = await post('/api/human/done', { project: join(root, 'shop'), id: 'stripe' }, { origin: dash.url });
  assert.equal(r.status, 200);
  assert.equal(humanOf('shop')[0].status, 'done');
  assert.ok(humanOf('shop')[0].doneAt);
  const s = await (await fetch(dash.url + '/api/state')).json();
  assert.deepEqual(s.projects.find((p) => p.name === 'shop').ready, ['pay']);
  assert.equal((await post('/api/human/done', { project: join(root, 'shop'), id: 'nope' })).status, 404);
});

test('"Mark done" only applies to ready features in manual-merge projects', async () => {
  assert.equal((await post('/api/feature/merged', { project: join(root, 'shop'), id: 'pay' })).status, 409);
  assert.equal((await post('/api/feature/merged', { project: join(root, 'group/blog'), id: 'post' })).status, 200);
  const fs = JSON.parse(readFileSync(join(root, 'group/blog/.shipyard/features.json'), 'utf8')).features;
  assert.equal(fs[0].status, 'merged');
});
