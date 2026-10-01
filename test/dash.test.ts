import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { startDash, type ProjectState, type OpenTask, type Run } from '../lib/dash.ts';
import type { Feature, HumanTask, MergeMode } from '../lib/types.ts';

let root: string, dash: { server: Server; url: string };
type DashState = { projects: ProjectState[]; human: OpenTask[] };
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: id, description: '', acceptance: ['x'], surface: 'any', deps: [], priority: 1,
  status: 'todo', attempts: 0, updatedAt: '', ...o });
function project(dir: string, { merge = 'auto', features = [], tasks = [], gitFile = false }:
  { merge?: MergeMode; features?: Feature[]; tasks?: HumanTask[]; gitFile?: boolean }) {
  mkdirSync(join(dir, '.fact-os'), { recursive: true });
  if (gitFile) writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n'); else mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.fact-os/config.json'), JSON.stringify({ merge }));
  writeFileSync(join(dir, '.fact-os/features.json'), JSON.stringify({ features }));
  writeFileSync(join(dir, '.fact-os/human.json'), JSON.stringify({ tasks }));
}
const humanOf = (p: string): HumanTask[] => JSON.parse(readFileSync(join(root, p, '.fact-os/human.json'), 'utf8')).tasks;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(dash.url + path, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'fact-os-dash-'));
  project(join(root, 'shop'), { features: [F('pay'), F('cart', { deps: ['pay'] })],
    tasks: [{ id: 'stripe', title: 'Create Stripe account', steps: ['sign up'], unblocks: ['pay'], mockable: false, status: 'open' }] });
  project(join(root, 'group/blog'), { merge: 'manual', features: [F('post', { status: 'ready' }), F('draft', { status: 'stuck', attempts: 2 })] });
  writeFileSync(join(root, 'group/blog/.fact-os/project-view.html'), '<p>view</p>');
  writeFileSync(join(root, 'shop/.git/config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  const runs = join(root, 'shop/.fact-os/runs/pay');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, '1-build.json'), JSON.stringify({ duration_ms: 1200, total_cost_usd: 0.5, num_turns: 7, modelUsage: { 'claude-x': {} }, result: 'x'.repeat(500) }));
  writeFileSync(join(runs, '1-eval.json'), JSON.stringify({ duration_ms: 300, total_cost_usd: 0.25, num_turns: 2, modelUsage: { 'claude-y': {} },
    result: JSON.stringify({ pass: false, findings: [{ check: 'a', ok: true }, { check: 'b', ok: false, note: 'nope' }] }) }));
  writeFileSync(join(runs, '2-eval.json'), JSON.stringify({ result: 'plain text verdict' }));
  project(join(root, 'shop-worktrees/pay'), { gitFile: true }); // a worktree checkout, not a project
  dash = await startDash({ root, port: 0 });
});
after(() => { dash?.server.close(); rmSync(root, { recursive: true, force: true }); });

test('serves the page and /api/state for discovered projects, skipping worktrees', async () => {
  const html = await (await fetch(dash.url + '/')).text();
  assert.match(html, /Only you/);
  assert.match(html, /\/dash\/core\.js/);
  const core = await fetch(dash.url + '/dash/core.js');
  assert.match(core.headers.get('content-type')!, /javascript/);
  assert.match(await core.text(), /\/api\/state/);
  const png = await fetch(dash.url + '/assets/logo.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(dash.url + '/dash/../dash.ts')).status, 404);
  const s = await (await fetch(dash.url + '/api/state')).json() as DashState;
  assert.deepEqual(s.projects.map((p) => p.path).sort(), [join(root, 'group/blog'), join(root, 'shop')]);
  const t = s.human.find((h) => h.id === 'stripe')!;
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

test('human tasks can be started, ticked step by step and reopened', async () => {
  const ask = (path: string, body: object) => post(path, { project: join(root, 'shop'), id: 'stripe', ...body }, { origin: dash.url });
  assert.equal((await ask('/api/human/step', { step: 5, on: true })).status, 400); // no such step
  assert.equal((await ask('/api/human/step', { step: 'x', on: true })).status, 400);
  assert.equal((await ask('/api/human/step', { step: 0, on: true })).status, 200);
  assert.deepEqual(humanOf('shop')[0].checked, [0]);
  assert.ok(humanOf('shop')[0].startedAt); // ticking a step starts the task
  assert.equal((await ask('/api/human/step', { step: 0, on: false })).status, 200);
  assert.deepEqual(humanOf('shop')[0].checked, []);
  assert.equal((await ask('/api/human/start', {})).status, 200);
  assert.equal((await post('/api/human/start', { project: join(root, 'shop'), id: 'nope' }, { origin: dash.url })).status, 404);
  assert.equal((await ask('/api/human/done', {})).status, 200);
  assert.equal((await ask('/api/human/reopen', {})).status, 200);
  assert.equal(humanOf('shop')[0].status, 'open');
  assert.equal(humanOf('shop')[0].doneAt, undefined);
});

test('"I did my part" marks the task done and unblocks its feature', async () => {
  const r = await post('/api/human/done', { project: join(root, 'shop'), id: 'stripe' }, { origin: dash.url });
  assert.equal(r.status, 200);
  assert.equal(humanOf('shop')[0].status, 'done');
  assert.ok(humanOf('shop')[0].doneAt);
  const s = await (await fetch(dash.url + '/api/state')).json() as DashState;
  assert.deepEqual(s.projects.find((p) => p.name === 'shop')!.ready, ['pay']);
  assert.equal((await post('/api/human/done', { project: join(root, 'shop'), id: 'nope' })).status, 404);
});

test('"Mark done" only applies to ready features in manual-merge projects', async () => {
  assert.equal((await post('/api/feature/merged', { project: join(root, 'shop'), id: 'pay' })).status, 409);
  assert.equal((await post('/api/feature/merged', { project: join(root, 'group/blog'), id: 'post' })).status, 200);
  const fs = JSON.parse(readFileSync(join(root, 'group/blog/.fact-os/features.json'), 'utf8')).features;
  assert.equal(fs[0].status, 'merged');
});

test('a request with a foreign Host header is rejected (DNS rebinding)', async () => {
  const status = (host: string) => new Promise<number | undefined>((res, rej) => request(dash.url + '/api/state', { headers: { host } }, (r) => { r.resume(); res(r.statusCode); })
    .on('error', rej).end());
  assert.equal(await status('evil.example:' + new URL(dash.url).port), 403);
  assert.equal(await status(new URL(dash.url).host), 200);
});

test('pause/resume/retry endpoints apply to the feature and refuse invalid transitions', async () => {
  const blog = join(root, 'group/blog'), fs = () => JSON.parse(readFileSync(join(blog, '.fact-os/features.json'), 'utf8')).features as Feature[];
  assert.equal((await post('/api/feature/resume', { project: blog, id: 'draft' })).status, 409);
  assert.equal((await post('/api/feature/pause', { project: blog, id: 'draft' })).status, 200);
  assert.equal(fs().find((f) => f.id === 'draft')!.status, 'paused');
  assert.equal((await post('/api/feature/resume', { project: blog, id: 'draft' })).status, 200);
  assert.deepEqual([fs().find((f) => f.id === 'draft')!.status, fs().find((f) => f.id === 'draft')!.attempts], ['todo', 0]);
  assert.equal((await post('/api/feature/pause', { project: blog, id: 'nope' })).status, 404);
  assert.equal((await post('/api/feature/pause', { project: '/etc', id: 'draft' })).status, 400);
});

test('state carries foreman status, estimates and project-view presence; feature history filters by id', async () => {
  const s = await (await fetch(dash.url + '/api/state')).json() as DashState;
  const blog = s.projects.find((p) => p.name === 'blog')!;
  assert.equal(blog.foreman.running, false);
  assert.deepEqual(blog.estimates, { build: null, test: null, eval: null });
  assert.equal(blog.hasProjectView, true);
  assert.equal(s.projects.find((p) => p.name === 'shop')!.hasProjectView, false);
  const h = await (await fetch(dash.url + '/api/feature?project=' + encodeURIComponent(blog.path) + '&id=draft')).json() as { log: { feature: string }[] };
  assert.ok(h.log.length && h.log.every((e) => e.feature === 'draft'));
  assert.equal((await fetch(dash.url + '/api/feature?project=%2Fetc&id=x')).status, 400);
});

test('the project view is served sandboxed so its scripts cannot call the dashboard API', async () => {
  const r = await fetch(dash.url + '/project-view?project=' + encodeURIComponent(join(root, 'group/blog')));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), 'sandbox allow-scripts');
  assert.equal((await fetch(dash.url + '/project-view?project=' + encodeURIComponent(join(root, 'shop')))).status, 404);
});

test('wait/unwait mark a task as waiting on someone; reopen and done clear it', async () => {
  const shop = join(root, 'shop'), ask = (path: string, body: object) => post(path, { project: shop, id: 'stripe', ...body }, { origin: dash.url });
  await ask('/api/human/reopen', {});
  assert.equal((await ask('/api/human/wait', { who: '  Stripe support  ' })).status, 200);
  let t = humanOf('shop')[0]!;
  assert.equal(t.waitingOn, 'Stripe support');
  assert.ok(t.waitingSince && t.startedAt);
  assert.equal(t.status, 'open');
  assert.equal((await ask('/api/human/unwait', {})).status, 200);
  t = humanOf('shop')[0]!;
  assert.equal(t.waitingOn, undefined);
  assert.equal(t.waitingSince, undefined);
  assert.equal((await ask('/api/human/wait', { who: '   ' })).status, 400);
  assert.equal((await ask('/api/human/wait', {})).status, 400);
  assert.equal((await ask('/api/human/wait', { who: 'x'.repeat(201) })).status, 400);
  assert.equal((await post('/api/human/wait', { project: shop, id: 'nope', who: 'a' })).status, 404);
  await ask('/api/human/wait', { who: 'legal' });
  await ask('/api/human/reopen', {});
  assert.equal(humanOf('shop')[0]!.waitingOn, undefined);
  await ask('/api/human/wait', { who: 'legal' });
  assert.equal((await ask('/api/human/done', {})).status, 200);
  assert.equal(humanOf('shop')[0]!.waitingOn, undefined);
  assert.equal((await ask('/api/human/wait', { who: 'legal' })).status, 409);
  const events = readFileSync(join(shop, '.fact-os/log.jsonl'), 'utf8');
  assert.match(events, /human-wait/);
  assert.match(events, /human-unwait/);
  await ask('/api/human/reopen', {});
});

test('state carries repoUrl from the origin remote and stats with numeric costs', async () => {
  const s = await (await fetch(dash.url + '/api/state')).json() as DashState;
  const shop = s.projects.find((p) => p.name === 'shop')!, blog = s.projects.find((p) => p.name === 'blog')!;
  assert.equal(shop.repoUrl, 'https://github.com/acme/shop');
  assert.equal(blog.repoUrl, undefined);
  assert.ok(Array.isArray(shop.stats.mergedAt));
  assert.ok(Math.abs(shop.stats.costToday - 0.75) < 1e-9); // fixture files were just written
  assert.equal(shop.stats.costYesterday, 0);
  assert.equal(blog.stats.costToday, 0);
});

test('feature history includes parsed runs, builds before evals', async () => {
  const h = await (await fetch(dash.url + '/api/feature?project=' + encodeURIComponent(join(root, 'shop')) + '&id=pay')).json() as { runs: Run[] };
  assert.deepEqual(h.runs.map((r) => `${r.n}-${r.role}`), ['1-build', '1-eval', '2-eval']);
  const [b, e, p] = h.runs as [Run, Run, Run];
  assert.equal(b.summary.length, 400);
  assert.deepEqual([b.ms, b.cost, b.turns, b.model, b.pass], [1200, 0.5, 7, 'claude-x', undefined]);
  assert.equal(e.pass, false);
  assert.deepEqual(e.findings, [{ check: 'a', ok: true }, { check: 'b', ok: false, note: 'nope' }]);
  assert.equal(e.summary, '');
  assert.deepEqual([p.pass, p.findings, p.ms, p.model, p.summary], [undefined, undefined, null, null, 'plain text verdict']);
  const none = await (await fetch(dash.url + '/api/feature?project=' + encodeURIComponent(join(root, 'shop')) + '&id=..%2F..')).json() as { runs: Run[] };
  assert.deepEqual(none.runs, []);
});

test('state carries the observer summary from observer.json, and null without it', async () => {
  const dir = join(root, 'shop/.fact-os'), ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString();
  const d = (feature: string, h: number, cause: string, action: string) => ({ ts: ago(h), feature, cause, tests: ['t/a.test.ts'], evidence: 'boom', action });
  const get = async () => ((await (await fetch(dash.url + '/api/state')).json()) as DashState).projects.find((p) => p.name === 'shop')!.observer;
  assert.equal(await get(), null);
  writeFileSync(join(dir, 'observer.json'), JSON.stringify({ offset: 0, retried: {}, agentTargets: {}, agentNotes: 'looked',
    diagnoses: [d('pay', 30, 'infra', 'sent back'), d('pay', 2, 'untouched', 'sent back'), d('cart', 1, 'untouched', 'none: the foreman retries it'), d('cart', 0.5, 'untouched', 'sent back')],
    alerts: [{ ts: ago(1), text: 'new' }, { ts: ago(40), text: 'old' }], fixes: [{ ts: ago(3), commit: 'abc', summary: 'fix a' }, { ts: ago(2), commit: 'def', summary: 'fix b' }] }));
  const human = readFileSync(join(dir, 'human.json'), 'utf8');
  writeFileSync(join(dir, 'human.json'), JSON.stringify({ tasks: [{ id: 'observer-x', title: 'Do x', steps: [], unblocks: [], mockable: false, status: 'open' }] }));
  const o = (await get())!;
  assert.equal(o.running, false);
  assert.deepEqual(o.alerts24h.map((a) => a.text), ['new']);
  assert.deepEqual(o.causes24h, [{ cause: 'untouched', n: 3 }]);
  assert.equal(o.sentBack24h, 2);
  assert.deepEqual(o.decisions.map((x) => x.feature + x.cause), ['cartuntouched', 'payuntouched', 'payinfra']);
  assert.deepEqual(o.recurring, [{ test: 't/a.test.ts', features: ['cart', 'pay'] }]);
  assert.deepEqual(o.fixes.map((f) => f.commit), ['def', 'abc']);
  assert.deepEqual(o.proposals, [{ id: 'observer-x', title: 'Do x' }]);
  assert.equal(o.agentNotes, 'looked');
  writeFileSync(join(dir, 'observer.json'), '{not json');
  assert.equal(await get(), null);
  rmSync(join(dir, 'observer.json'));
  writeFileSync(join(dir, 'human.json'), human);
});
