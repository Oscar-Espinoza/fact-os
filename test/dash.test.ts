import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { startDash, conflictTimeline, type ProjectState, type OpenTask, type Run, type ControlState } from '../lib/dash.ts';
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
// control without the profile tables (their own test checks them)
const core = (c: ControlState | undefined) => { const { roles, profiles, observerAgent, ...rest } = c!; return rest; };
const humanOf = (p: string): HumanTask[] => JSON.parse(readFileSync(join(root, p, '.fact-os/human.json'), 'utf8')).tasks;
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
function evaluatedBranch(dir: string, id: string): string {
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init'); git(dir, 'checkout', '-qb', `ship/${id}`);
  writeFileSync(join(dir, `${id}.txt`), 'evaluated work\n'); git(dir, 'add', `${id}.txt`); git(dir, 'commit', '-qm', id);
  const sha = git(dir, 'rev-parse', 'HEAD'); git(dir, 'checkout', '-q', 'main'); return sha;
}
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
  const blog = join(root, 'group/blog'), file = join(blog, '.fact-os/features.json'), sha = evaluatedBranch(blog, 'post');
  const state = JSON.parse(readFileSync(file, 'utf8')); state.features[0].sha = sha; writeFileSync(file, JSON.stringify(state));
  git(blog, 'merge', '-q', '--no-ff', '-m', 'merge evaluated post', sha);
  assert.equal((await post('/api/feature/merged', { project: blog, id: 'post' })).status, 200);
  const fs = JSON.parse(readFileSync(join(root, 'group/blog/.fact-os/features.json'), 'utf8')).features;
  assert.equal(fs[0].status, 'merged');
});

test('manual merge acknowledgment verifies the evaluated commit, accepts ff/no-ff and preserves state on refusal', async (t) => {
  for (const mode of ['missing', 'invalid', 'missing object', 'blob', 'not merged', 'moved branch', 'no-ff', 'ff']) {
    const dir = join(root, `ack-${mode.replaceAll(' ', '-')}`); project(dir, { merge: 'manual', features: [F('a', { status: 'ready' }), F('b', { deps: ['a'] })] });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sha = evaluatedBranch(dir, 'a'), file = join(dir, '.fact-os/features.json');
    const recorded = mode === 'missing' ? undefined : mode === 'invalid' ? 'main' : mode === 'missing object' ? '0'.repeat(40)
      : mode === 'blob' ? git(dir, 'rev-parse', `${sha}:a.txt`) : sha;
    writeFileSync(file, JSON.stringify({ features: [F('a', { status: 'ready', sha: recorded }), F('b', { deps: ['a'] })] }));
    if (mode === 'no-ff' || mode === 'ff' || mode === 'moved branch') git(dir, 'merge', '-q', ...(mode === 'ff' ? ['--ff-only'] : ['--no-ff', '-m', 'manual merge']), sha);
    if (mode === 'moved branch') { git(dir, 'checkout', '-q', 'ship/a'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'unevaluated later commit'); git(dir, 'checkout', '-q', 'main'); }
    const before = readFileSync(file, 'utf8'), r = await post('/api/feature/merged', { project: dir, id: 'a' });
    if (['no-ff', 'ff', 'moved branch'].includes(mode)) {
      assert.equal(r.status, 200, mode); assert.equal(JSON.parse(readFileSync(file, 'utf8')).features[0].status, 'merged');
      const state = await (await fetch(dash.url + '/api/state')).json() as DashState;
      assert.deepEqual(state.projects.find((p) => p.path === dir)!.ready, ['b']);
    } else {
      assert.equal(r.status, 409, mode); assert.match((await r.json() as { error: string }).error, /evaluated commit/);
      assert.equal(readFileSync(file, 'utf8'), before, mode); assert.equal(existsSync(join(dir, '.fact-os/log.jsonl')), false, mode);
    }
  }
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
  writeFileSync(join(dir, 'observer.json'), JSON.stringify({ offset: 0, retried: {}, agentNotes: 'looked', improvements: ['gone-1'],
    diagnoses: [d('pay', 30, 'infra', 'sent back'), d('pay', 2, 'untouched', 'sent back'), d('cart', 1, 'untouched', 'none: the foreman retries it'), d('cart', 0.5, 'untouched', 'sent back')],
    alerts: [{ ts: ago(1), text: 'new' }, { ts: ago(40), text: 'old' }] }));
  const human = readFileSync(join(dir, 'human.json'), 'utf8');
  writeFileSync(join(dir, 'human.json'), JSON.stringify({ tasks: [{ id: 'observer-x', title: 'Do x', steps: [], unblocks: [], mockable: false, status: 'open' }] }));
  const o = (await get())!;
  assert.equal(o.running, false);
  assert.deepEqual(o.alerts24h.map((a) => a.text), ['new']);
  assert.deepEqual(o.causes24h, [{ cause: 'untouched', n: 3 }]);
  assert.equal(o.sentBack24h, 2);
  assert.deepEqual(o.decisions.map((x) => x.feature + x.cause), ['cartuntouched', 'payuntouched', 'payinfra']);
  assert.deepEqual(o.recurring, [{ test: 't/a.test.ts', features: ['cart', 'pay'] }]);
  assert.deepEqual(o.improvements, [{ id: 'gone-1', title: '(removed)', status: 'removed' }]);
  assert.deepEqual(o.proposals, [{ id: 'observer-x', title: 'Do x' }]);
  assert.equal(o.agentNotes, 'looked');
  writeFileSync(join(dir, 'observer.json'), '{not json');
  assert.equal(await get(), null);
  rmSync(join(dir, 'observer.json'));
  writeFileSync(join(dir, 'human.json'), human);
});

test('state carries the prompt summary: causes per model and role, top suggestions, the notes in force and results by notes version', async () => {
  const dir = join(root, 'shop/.fact-os'), now = new Date().toISOString();
  const rev = (o: object) => ({ ts: now, feature: 'a', tag: '1', role: 'builder', model: 'sonnet', effort: 'medium', notes: '-', kind: 'gate-failed', next: '', cause: 'prompt-missing-info', evidence: ['q'], confidence: 'high', suggestion: 'Run the typecheck.', target: 'briefs', cost: 0, ...o });
  writeFileSync(join(dir, 'observer.json'), JSON.stringify({ offset: 0, retried: {}, diagnoses: [], alerts: [],
    promptReviews: { 'a/1': rev({}), 'b/1': rev({ feature: 'b', cause: 'model-limitation', suggestion: '', target: null }), 'c/1': rev({ feature: 'c', cause: null, confidence: null, suggestion: '', target: null, error: 'invalid answer: x' }) },
    promptRates: [{ model: 'sonnet', role: 'builder', notes: '-', since: now, ok: 1, bad: 2 }] }));
  mkdirSync(join(dir, 'prompt-notes'), { recursive: true });
  writeFileSync(join(dir, 'prompt-notes/sonnet-builder.md'), '- Run the typecheck.\n');
  try {
    const o = ((await (await fetch(dash.url + '/api/state')).json()) as DashState).projects.find((p) => p.name === 'shop')!.observer!;
    assert.deepEqual([o.prompts.reviewed, o.prompts.invalid, o.prompts.rows.length], [2, 1, 1]);
    const row = o.prompts.rows[0]!;
    assert.deepEqual([row.model, row.role, row.causes, row.suggestions, row.notes], ['sonnet', 'builder', [{ cause: 'prompt-missing-info', n: 1 }, { cause: 'model-limitation', n: 1 }],
      [{ text: 'Run the typecheck.', n: 1, target: 'briefs' }], { text: '- Run the typecheck.', bytes: 20 }]);
    rmSync(join(dir, 'observer.json'));
    writeFileSync(join(dir, 'observer.json'), JSON.stringify({ offset: 0, retried: {}, diagnoses: [], alerts: [] }));
    assert.deepEqual(((await (await fetch(dash.url + '/api/state')).json()) as DashState).projects.find((p) => p.name === 'shop')!.observer!.prompts, { reviewed: 0, invalid: 0, cost: 0, runs24h: 0, rows: [] }, 'an older observer.json has none');
  } finally { rmSync(join(dir, 'observer.json')); rmSync(join(dir, 'prompt-notes'), { recursive: true }); }
});

test('state carries the merge conflict timeline from the log: who resolved each conflict and how it ended', async () => {
  const dir = join(root, 'shop/.fact-os'), t0 = Date.now() - 20 * 3600e3, min = (m: number) => new Date(t0 + m * 60e3).toISOString();
  const ev = (m: number, feature: string, event: string, detail = '') => JSON.stringify({ ts: min(m), feature, event, detail });
  const hasLog = (() => { try { return readFileSync(join(dir, 'log.jsonl'), 'utf8'); } catch { return null; } })();
  writeFileSync(join(dir, 'observer.json'), JSON.stringify({ offset: 0, retried: {}, diagnoses: [], alerts: [] }));
  writeFileSync(join(dir, 'log.jsonl'), [
    ev(-1900, 'old', 'refreshed', 'conflicts in: a.ts'), ev(-1800, 'old', 'merged'),
    ev(0, 'pay', 'refreshed', 'conflicts in: src/a.ts, src/b.ts'), ev(1, 'pay', 'resolving', 'src/a.ts, src/b.ts'), ev(3, 'pay', 'resolved', 'abc; 2 lines changed'),
    ev(4, 'pay', 'testing'), ev(9, 'pay', 'evaluating'), ev(42, 'pay', 'merged'),
    ev(5, 'cart', 'refreshed', 'before test, conflict-free'), ev(6, 'cart', 'refreshed', 'conflicts in: src/c.ts'), ev(7, 'cart', 'launch'), ev(10, 'cart', 'keep-check', 'ok: src/c.ts'), ev(11, 'cart', 'testing'),
    ev(12, 'post', 'refreshed', 'conflicts in: p.ts'), ev(13, 'post', 'resolving', 'p.ts'), ev(14, 'post', 'resolve-failed', 'keep-check: 20 lines lost'), ev(15, 'post', 'launch'),
    ev(16, 'post', 'keep-check', 'lost 3 lines'), ev(20, 'post', 'refreshed', 'conflicts in: p.ts'), ev(21, 'post', 'stuck', 'too many base refreshes (5)'),
    ev(30, 'draft', 'refreshed', 'conflicts in: d.ts'),
  ].join('\n') + '\n');
  try {
    const o = ((await (await fetch(dash.url + '/api/state')).json()) as DashState).projects.find((p) => p.name === 'shop')!.observer!;
    const by = (f: string) => o.conflicts24h.filter((c) => c.feature === f);
    assert.deepEqual(o.conflicts24h.map((c) => c.feature + '@' + c.files.length), ['draft@1', 'post@1', 'post@1', 'cart@1', 'pay@2']); // newest first; "old" is over 24 h
    assert.deepEqual(by('pay')[0], { feature: 'pay', title: 'pay', ts: min(0), files: ['src/a.ts', 'src/b.ts'], resolvedBy: 'resolver', outcome: 'merged', outcomeTs: min(42), ms: 42 * 60e3 });
    assert.deepEqual([by('cart')[0]!.resolvedBy, by('cart')[0]!.outcome], ['builder', 'resolved']);
    assert.deepEqual(by('post').map((c) => [c.resolvedBy, c.outcome, c.note]), [[null, 'failed', 'gave up after too many conflicts'], ['builder', 'conflicted again', 'keep-check: 20 lines lost; lost 3 lines']]);
    assert.deepEqual(by('post').map((c) => c.ms), [60e3, 8 * 60e3]); // failed 20→21, conflicted again 12→20
    assert.deepEqual(by('draft')[0]!.outcome, 'still open');
    assert.ok(Math.abs(by('draft')[0]!.ms - (Date.now() - t0 - 30 * 60e3)) < 5000); // runs to now
  } finally {
    if (hasLog == null) rmSync(join(dir, 'log.jsonl')); else writeFileSync(join(dir, 'log.jsonl'), hasLog);
    rmSync(join(dir, 'observer.json'));
  }
});

test('conflictTimeline follows a dependency import conflict resolved by the same builder pass', () => {
  const t0 = Date.now() - 10000, ev = (n: number, event: string, detail = '') => ({ ts: new Date(t0 + n * 1000).toISOString(), feature: 'b', event, detail });
  const rows = conflictTimeline([ev(0, 'launch'), ev(1, 'refreshed', 'before build, conflicts in: src/a.ts, src/b.ts'),
    ev(2, 'prompt', 'builder model=opus effort=medium lessons=- briefs=-'), ev(3, 'keep-check', 'ok: src/a.ts, src/b.ts'), ev(4, 'testing'), ev(5, 'evaluating'), ev(6, 'ready')], Date.now());
  assert.deepEqual(rows.map((r) => [r.files, r.resolvedBy, r.outcome]), [[['src/a.ts', 'src/b.ts'], 'builder', 'resolved']]);
  assert.deepEqual(conflictTimeline([ev(1, 'refreshed', 'before build, conflict-free')], Date.now()), []);
});

test('conflictTimeline: a resolver failure hands the conflict to the builder, and the note is kept', () => {
  const now = Date.parse('2026-10-01T12:00:00Z'), ev = (m: number, event: string, detail = '', feature = 'x') => ({ ts: new Date(now - 60 * 60e3 + m * 60e3).toISOString(), feature, event, detail });
  const [c] = conflictTimeline([ev(0, 'refreshed', 'conflicts in: a.ts'), ev(1, 'resolving', 'a.ts'), ev(2, 'resolve-failed', 'keep-check: 3 lines lost'), ev(3, 'launch'), ev(5, 'keep-check', 'ok: a.ts'), ev(6, 'testing')], now, { x: 'The X' });
  assert.deepEqual([c!.title, c!.resolvedBy, c!.note, c!.outcome, c!.ms], ['The X', 'builder', 'keep-check: 3 lines lost', 'resolved', 3600e3]);
  // the resolver is still working: not resolved by anyone yet
  assert.deepEqual(conflictTimeline([ev(0, 'refreshed', 'conflicts in: a.ts'), ev(1, 'resolving', 'a.ts')], now).map((r) => [r.resolvedBy, r.resolving, r.outcome]), [[null, true, 'still open']]);
});

test('conflictTimeline: a test-gate stuck is not final; only "too many base refreshes" fails the conflict', () => {
  const now = Date.parse('2026-10-01T12:00:00Z'), ev = (m: number, event: string, detail = '', feature = 'x') => ({ ts: new Date(now - 60 * 60e3 + m * 60e3).toISOString(), feature, event, detail });
  const gate = 'test command `gate.sh` exited 1:\nFAIL a.test.ts';
  const base = [ev(0, 'refreshed', 'conflicts in: a.ts'), ev(1, 'launch'), ev(5, 'testing'), ev(9, 'stuck', gate)];
  assert.deepEqual(conflictTimeline(base, now).map((r) => [r.outcome, r.ms, r.stuckCause!.startsWith('test command')]), [['resolved then stuck', 9 * 60e3, true]]);
  const [c] = conflictTimeline([...base, ev(20, 'retrying'), ev(21, 'launch'), ev(25, 'testing'), ev(40, 'merged')], now);
  assert.deepEqual([c!.outcome, c!.ms, c!.stuckCause], ['merged', 40 * 60e3, undefined]);
  // retried and in flight again: resolved, no longer stuck
  assert.deepEqual(conflictTimeline([...base, ev(20, 'retrying'), ev(21, 'launch')], now).map((r) => r.outcome), ['resolved']);
});

test('conflictTimeline: events of different features interleave without bleeding into each other', () => {
  const now = Date.parse('2026-10-01T12:00:00Z'), ev = (m: number, feature: string, event: string, detail = '') => ({ ts: new Date(now - 60 * 60e3 + m * 60e3).toISOString(), feature, event, detail });
  const rows = conflictTimeline([ev(0, 'a', 'refreshed', 'conflicts in: a.ts'), ev(1, 'b', 'refreshed', 'conflicts in: b.ts'), ev(2, 'a', 'resolving', 'a.ts'), ev(3, 'b', 'launch'), ev(4, 'a', 'resolved', 'x'),
    ev(5, 'b', 'merged'), ev(6, 'a', 'merged'), ev(7, 'a', 'testing')], now);
  assert.deepEqual(rows.map((r) => [r.feature, r.resolvedBy, r.outcome, r.ms]), [['b', 'builder', 'merged', 4 * 60e3], ['a', 'resolver', 'merged', 6 * 60e3]]);
});

test('control routes: pause, resume and lanes write control.json; state carries control and the in-flight count', async () => {
  const shop = join(root, 'shop'), file = join(shop, '.fact-os/control.json'), feats = join(shop, '.fact-os/features.json'), saved = readFileSync(feats, 'utf8');
  const get = async () => ((await (await fetch(dash.url + '/api/state')).json()) as DashState).projects.find((p) => p.name === 'shop')!;
  const ask = (what: string, body: object = {}, headers: Record<string, string> = { origin: dash.url }) => post('/api/control/' + what, { project: shop, ...body }, headers);
  writeFileSync(feats, JSON.stringify({ features: [F('pay', { status: 'building' }), F('cart', { status: 'evaluating' }), F('more')] }));
  try {
    let p = await get();
    assert.deepEqual(core(p.control), { paused: false, maxParallel: null, effective: 3, configMax: 3, profile: null });
    assert.equal(p.inFlight, 2);
    let r = await ask('pause');
    assert.equal(r.status, 200);
    assert.deepEqual(core(((await r.json()) as { control: ControlState }).control), { ...JSON.parse(readFileSync(file, 'utf8')), effective: 0, configMax: 3 });
    assert.deepEqual([JSON.parse(readFileSync(file, 'utf8')).paused, JSON.parse(readFileSync(file, 'utf8')).by], [true, 'dashboard']);
    p = await get();
    assert.deepEqual([p.control!.paused, p.control!.effective, p.control!.maxParallel], [true, 0, null]);
    const before = readFileSync(file, 'utf8');
    for (const body of [{ maxParallel: 33 }, { maxParallel: -1 }, { maxParallel: 1.5 }, { maxParallel: '2' }, { maxParallel: true }, {}]) {
      r = await ask('lanes', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(((await r.json()) as { error: string }).error, /maxParallel must be an integer from 0 to 32/);
    }
    assert.equal((await ask('pause', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await ask('lanes', { maxParallel: 9 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/control/resume', { project: '/etc' })).status, 400);
    assert.equal((await post('/api/control/resume', { project: shop + '/' })).status, 400);
    assert.equal((await fetch(dash.url + '/api/control/pause')).status, 404, 'GET is not a control action');
    assert.equal((await ask('stop')).status, 404);
    assert.equal(readFileSync(file, 'utf8'), before, 'refused requests change nothing');
    assert.equal((await ask('lanes', { maxParallel: 0 })).status, 200);
    assert.deepEqual([(await get()).control!.paused, (await get()).control!.maxParallel], [true, 0], 'lanes keeps the pause');
    assert.equal((await ask('resume')).status, 200);
    assert.equal((await get()).control!.effective, 0, 'lanes 0 launches nothing either');
    assert.equal((await ask('lanes', { maxParallel: 5 })).status, 200);
    assert.deepEqual(core((await get()).control), { ...JSON.parse(readFileSync(file, 'utf8')), effective: 5, configMax: 3 });
    assert.equal((await ask('lanes', { maxParallel: null })).status, 200);
    assert.deepEqual([(await get()).control!.maxParallel, (await get()).control!.effective], [null, 3]);
    // an invalid file is surfaced, never shown as the defaults; any control action rewrites it
    writeFileSync(file, '{"paused":"true"}');
    p = await get();
    assert.match(p.control!.invalid!, /control\.json: "paused" must be true or false/);
    assert.equal(p.control!.effective, null);
    assert.equal((await ask('pause')).status, 200);
    p = await get();
    assert.deepEqual([p.control!.invalid, p.control!.paused, p.control!.effective], [undefined, true, 0]);
  } finally {
    writeFileSync(feats, saved);
    rmSync(file, { force: true });
  }
});

test('profile route: sets the model profile (known name, "opus" or null), refuses anything else; state carries the role tables', async () => {
  const shop = join(root, 'shop'), file = join(shop, '.fact-os/control.json');
  const get = async () => ((await (await fetch(dash.url + '/api/state')).json()) as DashState).projects.find((p) => p.name === 'shop')!;
  const ask = (body: object, headers: Record<string, string> = { origin: dash.url }) => post('/api/control/profile', { project: shop, ...body }, headers);
  try {
    let c = (await get()).control!;
    assert.equal(c.profile, null);
    assert.equal(c.observerAgent, false, 'no observer agent configured: the page labels the observer rows "observe --agent"');
    assert.deepEqual(c.profiles.map((p) => [p.name, p.label]), [['opus', 'Opus'], ['fable-sonnet', 'Fable + Sonnet']]);
    assert.deepEqual(c.roles.map((r) => [r.role, r.model, r.effort]), [['builder', 'opus', 'medium'], ['resolver', 'opus', 'medium'], ['evaluator', 'opus', 'high'],
      ['observer', 'opus', 'high'], ['curator', 'opus', 'high']]);
    assert.deepEqual(c.profiles[1]!.roles[0], { role: 'builder', model: 'sonnet', effort: 'medium', effortHigh: 'high', fromProfile: true });
    let r = await ask({ profile: 'fable-sonnet' });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { control: ControlState }).control.profile, 'fable-sonnet');
    assert.deepEqual([JSON.parse(readFileSync(file, 'utf8')).profile, JSON.parse(readFileSync(file, 'utf8')).by], ['fable-sonnet', 'dashboard']);
    c = (await get()).control!;
    assert.equal(c.profile, 'fable-sonnet');
    assert.deepEqual(c.roles.map((x) => x.model), ['sonnet', 'sonnet', 'fable', 'fable', 'fable']);
    const before = readFileSync(file, 'utf8');
    for (const body of [{ profile: 'nope' }, { profile: 'default' }, { profile: 3 }, { profile: '' }, {}]) {
      r = await ask(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(((await r.json()) as { error: string }).error, /profile must be one of opus, fable-sonnet, or null for opus/);
    }
    assert.equal((await ask({ profile: 'opus' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/control/profile', { project: '/etc', profile: 'opus' })).status, 400);
    assert.equal((await post('/api/control/profile', { project: shop + '/', profile: 'opus' })).status, 400);
    assert.equal((await fetch(dash.url + '/api/control/profile')).status, 404, 'GET is not a control action');
    assert.equal(readFileSync(file, 'utf8'), before, 'refused requests change nothing');
    assert.equal((await ask({ profile: 'opus' })).status, 200);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).profile, null, 'opus is stored as null');
    assert.equal((await ask({ profile: 'fable-sonnet' })).status, 200);
    assert.equal((await ask({ profile: null })).status, 200);
    assert.equal((await get()).control!.profile, null);
    // a config profile is selectable; an unknown one in the file is surfaced as invalid
    const cfg = join(shop, '.fact-os/config.json'), saved = readFileSync(cfg, 'utf8');
    try {
      writeFileSync(cfg, JSON.stringify({ ...JSON.parse(saved), profiles: { cheap: { builder: { model: 'haiku' } } } }));
      assert.equal((await ask({ profile: 'cheap' })).status, 200);
      c = (await get()).control!;
      assert.deepEqual([c.profile, c.profiles.at(-1)!.label, c.roles[0]!.model, c.roles[2]!.model], ['cheap', 'cheap', 'haiku', 'opus']);
    } finally { writeFileSync(cfg, saved); }
    c = (await get()).control!;
    assert.match(c.invalid!, /unknown profile "cheap"/);
    assert.equal(c.profile, null);
  } finally { rmSync(file, { force: true }); }
});
