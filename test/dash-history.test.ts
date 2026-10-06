import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContext, runInContext } from 'node:vm';
import { startDash, type Run } from '../lib/dash.ts';
import type { Feature, LogEvent } from '../lib/types.ts';

const feature = (status: Feature['status'], attempts: number): Feature => ({ id: 'a', title: 'A', description: '', acceptance: ['check'],
  surface: 'any', deps: [], priority: 1, status, attempts, updatedAt: new Date().toISOString() });
const verdict = (evidence = 'verified') => ({ pass: true, findings: [{ check: 'check', ok: true, evidence }] });
const fixture = async (t: { after: (fn: () => void) => void }, f = feature('merged', 1)) => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-dash-history-')), dir = join(root, '.fact-os'), runs = join(dir, 'runs/a');
  mkdirSync(runs, { recursive: true }); mkdirSync(join(root, '.git'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxAttempts: 3 }));
  writeFileSync(join(dir, 'features.json'), JSON.stringify({ features: [f] })); writeFileSync(join(dir, 'human.json'), '{"tasks":[]}');
  const dash = await startDash({ root, port: 0 });
  t.after(() => { dash.server.close(); rmSync(root, { recursive: true, force: true }); });
  const put = (name: string, result: unknown, at: number, extra = {}) => {
    const file = join(runs, name); writeFileSync(file, JSON.stringify({ result: typeof result === 'string' ? result : JSON.stringify(result), total_cost_usd: 0.2, duration_ms: 1000, ...extra }));
    utimesSync(file, at / 1000, at / 1000);
  };
  const history = () => fetch(dash.url + '/api/feature?project=' + encodeURIComponent(root) + '&id=a').then((r) => r.json()) as Promise<{ runs: Run[]; log: LogEvent[]; activity: unknown[] }>;
  return { root, dir, dash, put, history };
};

test('R15: dashboard rejection explains bounded raw diagnostics and retains full structured output', async (t) => {
  const s = await fixture(t, feature('stuck', 1));
  const raw = { pass: false, findings: [], blocking: 'START checkout.ts:10 ' + 'x'.repeat(10000) + ' END tenant.ts:27', lesson: 'Invalid advice' };
  s.put('1-eval.json', '', Date.now(), { structured_output: raw });
  const run = (await s.history()).runs[0]!;
  assert.equal(run.pass, false); assert.deepEqual(run.findings, []);
  assert.match(run.error!, /^Evaluator: verdict.findings/);
  assert.match(run.error!, /Unvalidated evaluator output \(diagnostic only\):/);
  assert.match(run.error!, /\[truncated\]/); assert.ok(run.error!.length < 2500);
  assert.equal(run.text, JSON.stringify(raw), 'saved original output is not replaced by the excerpt');
  const b = await browser(s.dash.url); b.run('1|eval');
  assert.match(b.node('d-folds').innerHTML, /Unvalidated evaluator output/);
  assert.match(b.node('d-folds').innerHTML, /checkout.ts:10/);
  assert.match(b.node('d-folds').innerHTML, /Original agent output/);
});

test('served history preserves full tags, resolver outputs, evidence and chronological retry order', async (t) => {
  const s = await fixture(t), time = Date.now() - 10000;
  for (const [tag, role] of [['1', 'build'], ['1', 'eval'], ['1.2', 'resolve'], ['1.2', 'eval'], ['1.10', 'eval'], ['2', 'eval']])
    s.put(`${tag}-${role}.json`, role === 'eval' ? verdict(`evidence ${tag}`) : `${role} text`, time);
  s.put('1.11-eval.json', verdict('new retry'), time + 1000);
  const h = await s.history();
  assert.deepEqual(h.runs.map((r) => `${(r as Run & { tag: string }).tag}-${r.role}`), ['1-build', '1-eval', '1.2-resolve', '1.2-eval', '1.10-eval', '2-eval', '1.11-eval']);
  assert.deepEqual(h.runs.at(-1)!.findings, [{ check: 'check', ok: true, evidence: 'new retry' }]);
});

test('served evaluation validity uses foreman parsers and retains rejection text', async (t) => {
  const s = await fixture(t), bad = { pass: true, findings: [] };
  const cases = [bad, { ...verdict(), findings: [{ check: 'check', ok: false, evidence: 'defect' }] }, { ...verdict(), blocking: ['unsafe'] },
    { ...verdict(), notes: 'invalid' }, ['wrapped', verdict()], 'plain invalid text', verdict(), `Here is the verdict:\n\`\`\`json\n${JSON.stringify(verdict('fenced'))}\n\`\`\``];
  cases.forEach((v, i) => s.put(`${i + 1}-eval.json`, v, Date.now() + i));
  s.put('9-eval.json', '', Date.now() + 9, { structured_output: verdict('structured') });
  s.put('10-eval.json', verdict(), Date.now() + 10, { is_error: true });
  const h = await s.history();
  assert.deepEqual(h.runs.map((r) => r.pass), [false, false, false, false, false, false, true, true, true, false]);
  assert.match((h.runs[0] as Run & { error: string }).error, /findings/);
  assert.equal((h.runs[0] as Run & { text: string }).text, JSON.stringify(bad));
  assert.equal((h.runs[8]!.findings![0] as { evidence: string }).evidence, 'structured');
});

// Execute the actual served scripts and registered render/click handlers. Nodes store
// markup without implementing layout; assertions exercise user-visible contracts.
const browser = async (url: string) => {
  const nodes = new Map<string, any>(), events = new Map<string, Function>();
  const node = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', dataset: {}, clientWidth: 1672,
      style: { getPropertyValue: () => '1', setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, addEventListener(name: string, fn: Function) { this[name] = fn; }, querySelectorAll: (selector: string) => selector === '[data-fid]' ? [...nodes.entries()].filter(([id]) => id.startsWith('fx-slot')).flatMap(([, slot]) => {
        const id = /data-fid="([^"]+)"/.exec(slot.innerHTML)?.[1], kind = /data-kind="([^"]+)"/.exec(slot.innerHTML)?.[1];
        return id ? [{ dataset: { fid: id, kind }, querySelector: (s: string) => node('bay-' + id + s), parentNode: slot }] : [];
      }) : [], parentNode: { classList: { toggle() {} } } });
    return nodes.get(id);
  };
  let paints = 0;
  const sandbox: any = { document: { getElementById: node, documentElement: node('html'), body: { dataset: { name: 'fact-os' } }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { hash: '#f/a' }, localStorage: { getItem: () => null, setItem() {} }, setInterval() {}, setTimeout, clearTimeout,
    scrollTo() {}, addEventListener: (name: string, fn: Function) => events.set(name, fn),
    fetch: async (path: string) => { const r = await fetch(url + path); if (path.startsWith('/api/feature')) paints++; return r; } };
  sandbox.window = sandbox;
  const ctx = createContext(sandbox);
  for (const script of ['core', 'factory', 'board', 'detail']) runInContext(await (await fetch(`${url}/dash/${script}.js`)).text(), ctx);
  sandbox.F.boot();
  for (let i = 0; i < 100 && (!paints || !node('d-folds').innerHTML.includes('d-chip') && !node('d-folds').innerHTML.includes('No run output')); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(node('foreman-t').textContent === 'Dashboard offline', false, 'render must not throw');
  return { F: sandbox.F, node, route: (view: string) => { sandbox.location.hash = '#' + view; events.get('hashchange')!(); },
    run: (k: string) => node('detail').click({ target: { closest: () => ({ dataset: { run: k } }) } }) };
};

test('served detail, board and factory agree on first and second running attempts and second success', async (t) => {
  const s = await fixture(t, feature('building', 0)), b = await browser(s.dash.url);
  assert.match(b.node('d-head').innerHTML, /Try 1<\/b> of 3/);
  const f = b.F.P.features[0]; f.attempts = 1; b.F.render();
  assert.match(b.node('d-head').innerHTML, /Try 2<\/b> of 3/);
  b.route('board'); assert.match(b.node('b-active').innerHTML, /try 2\/3/);
  b.route('factory'); assert.equal(b.node('bay-a[data-tries]').textContent, 'try 2/3');
  f.status = 'merged'; b.route('f/a');
  assert.match(b.node('d-head').innerHTML, /Try 2<\/b> of 3/);
});

test('served detail shows distinct refreshed outputs, current evidence and rejected raw verdicts', async (t) => {
  const s = await fixture(t), at = Date.now() - 1000;
  s.put('2-build.json', 'original build', at);
  s.put('2-eval.json', { pass: false, findings: [{ check: 'old', ok: false, evidence: 'old failure' }] }, at + 1);
  s.put('2.2-resolve.json', 'resolver output', at + 2);
  s.put('2.2-eval.json', { pass: true, findings: [] }, at + 3);
  s.put('2.10-eval.json', { pass: true, findings: [{ check: 'one', ok: true, evidence: '<current evidence>' }, { check: 'two', ok: true, evidence: 'verified' }] }, at + 4);
  const b = await browser(s.dash.url), logs = () => b.node('d-folds').innerHTML;
  assert.match(logs(), /Combine 2\.2/); assert.match(logs(), /Review 2\.10 ✓/); assert.match(logs(), /Review 2 ✗/);
  b.run('2.2|resolve'); assert.match(logs(), /Run 2\.2 · Combine/); assert.match(logs(), /resolver output/);
  b.run('2.10|eval'); assert.match(logs(), /Run 2\.10 · Review · passed/); assert.match(logs(), /&#60;current evidence&#62;/);
  b.run('2.2|eval'); assert.match(logs(), /verdict.findings/); assert.match(logs(), /&#34;findings&#34;:\[\]/);
});

test('fresh human retry does not attach an earlier failure to the new attempt', async (t) => {
  const s = await fixture(t, feature('building', 0)), time = Date.now() - 1000;
  s.put('1-build.json', 'old build', time); s.put('1-eval.json', { pass: false, findings: [{ check: 'old', ok: false, evidence: 'old defect' }] }, time + 1);
  writeFileSync(join(s.dir, 'log.jsonl'), [{ ts: new Date(time + 2).toISOString(), feature: 'a', event: 'stuck', detail: 'FAILED old: old defect' },
    { ts: new Date(time + 3).toISOString(), feature: 'a', event: 'retrying', detail: 'by a person' }, { ts: new Date(time + 4).toISOString(), feature: 'a', event: 'launch', detail: '' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const b = await browser(s.dash.url);
  assert.doesNotMatch(b.node('d-fixes').innerHTML + b.node('d-journey').innerHTML, /old defect/);
  b.run('1|eval'); assert.match(b.node('d-folds').innerHTML, /old defect/, 'historical evidence remains available');
});

test('current builder failure after a retry takes precedence over an older rejected evaluation', async (t) => {
  const s = await fixture(t, feature('stuck', 1)), time = Date.now() - 1000;
  s.put('1-eval.json', { pass: false, findings: [{ check: 'old', ok: false, evidence: 'old defect' }] }, time);
  s.put('1.2-build.json', 'new builder failed', time + 4);
  writeFileSync(join(s.dir, 'log.jsonl'), [{ ts: new Date(time + 1).toISOString(), feature: 'a', event: 'stuck', detail: 'FAILED old: old defect' },
    { ts: new Date(time + 2).toISOString(), feature: 'a', event: 'retrying', detail: 'by a person' },
    { ts: new Date(time + 3).toISOString(), feature: 'a', event: 'launch', detail: '' },
    { ts: new Date(time + 5).toISOString(), feature: 'a', event: 'stuck', detail: 'builder failed: new failure' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const b = await browser(s.dash.url);
  assert.match(b.node('d-journey').innerHTML, /The build did not finish: the builder run failed/);
  assert.match(b.node('d-fixes').innerHTML, /What needs fixing[\s\S]*The build did not finish/);
  assert.doesNotMatch(b.node('d-fixes').innerHTML + b.node('d-journey').innerHTML, /old defect|Rejected/);
  b.run('1|eval'); assert.match(b.node('d-folds').innerHTML, /old defect/, 'distinct historical outputs remain inspectable');
});

test('legacy merged state does not make a rejected saved verdict appear to pass inspection', async (t) => {
  const s = await fixture(t, feature('merged', 0)); s.put('1-eval.json', { pass: true, findings: [] }, Date.now());
  const b = await browser(s.dash.url);
  assert.match(b.node('d-folds').innerHTML, /Review 1 ✗/);
  b.run('1|eval'); assert.match(b.node('d-folds').innerHTML, /Run 1 · Review · rejected/); assert.match(b.node('d-folds').innerHTML, /verdict.findings/);
  assert.equal(b.F.P.features[0].status, 'merged', 'projection does not rewrite pipeline state');
});

for (const reason of ['merge conflict with main: too many base refreshes (5)', 'previous child still running (pid 8)'])
  test(`R16: served first-try uncounted stop: ${reason}`, async (t) => {
    const stopped = { ...feature('stuck', 0), lastFeedback: reason, stop: { attempt: 1, counted: false } };
    const s = await fixture(t, stopped), time = Date.now() - 1000;
    writeFileSync(join(s.dir, 'log.jsonl'), [{ ts: new Date(time).toISOString(), feature: 'a', event: 'launch', detail: '' },
      { ts: new Date(time + 1).toISOString(), feature: 'a', event: 'stuck', detail: reason, stop: stopped.stop }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const b = await browser(s.dash.url);
    assert.equal(b.F.attemptNumber(b.F.P.features[0]), 1);
    assert.match(b.node('d-head').innerHTML, /Stuck[\s\S]*Try 1<\/b> of 3/);
    assert.match(b.node('d-journey').innerHTML, /What happened on try 1[\s\S]*Stopped without using a retry/);
    assert.doesNotMatch(b.node('d-head').innerHTML + b.node('d-journey').innerHTML, /stuck after 1 failed try|No retries left/i);
    assert.match(b.node('d-you').innerHTML, /Needs you/);
    b.route('board'); assert.match(b.node('b-list').innerHTML, /1\/3 tries/);
    b.route('factory'); assert.equal(b.node('bay-a[data-tries]').textContent, 'try 1/3');
    assert.doesNotMatch(b.node('fx-events').innerHTML, /stuck after 3 tries/);
    assert.doesNotMatch(b.node('fx-kpis').innerHTML, /hit the retry limit/);
    assert.equal(b.F.P.features[0].attempts, 0);
    assert.deepEqual((await s.history()).log.at(-1), JSON.parse(readFileSync(join(s.dir, 'log.jsonl'), 'utf8').trim().split('\n').at(-1)!));
  });

test('R16: later uncounted stop preserves the earlier counted failure card', async (t) => {
  const reason = 'merge conflict with main: too many base refreshes (5)';
  const s = await fixture(t, { ...feature('stuck', 1), lastFeedback: reason, stop: { attempt: 2, counted: false } }), time = Date.now() - 1000;
  s.put('1-eval.json', { pass: false, findings: [{ check: 'payment', ok: false, evidence: 'old payment defect' }] }, time + 1);
  s.put('2-eval.json', verdict('latest passed check'), time + 4);
  writeFileSync(join(s.dir, 'log.jsonl'), [
    { ts: new Date(time).toISOString(), feature: 'a', event: 'launch', detail: '' },
    { ts: new Date(time + 2).toISOString(), feature: 'a', event: 'failed', detail: 'FAILED payment: old payment defect', stop: { attempt: 1, counted: true } },
    { ts: new Date(time + 3).toISOString(), feature: 'a', event: 'launch', detail: '' },
    { ts: new Date(time + 5).toISOString(), feature: 'a', event: 'stuck', detail: reason, stop: { attempt: 2, counted: false } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const b = await browser(s.dash.url);
  assert.match(b.node('d-journey').innerHTML, /What happened on try 2[\s\S]*Stopped without using a retry/);
  assert.match(b.node('d-earlier').innerHTML, /Try 1 ✗[\s\S]*check failed: payment/);
  assert.doesNotMatch(b.node('d-journey').innerHTML, /merge could not finish/);
  assert.match(b.node('d-fixes').innerHTML, /Earlier problems[\s\S]*Try 1:/);
  b.run('1|eval'); assert.match(b.node('d-folds').innerHTML, /old payment defect/);
  assert.equal(b.F.P.features[0].attempts, 1);
});

test('R16: legacy known stops have a limited fallback and incomplete failures stay unnumbered', async (t) => {
  const reason = 'previous child still running (pid 8)';
  const s = await fixture(t, { ...feature('stuck', 2), lastFeedback: reason }), time = Date.now() - 1000;
  s.put('1-eval.json', { pass: false, findings: [{ check: 'old', ok: false, evidence: 'old artifact' }] }, time);
  writeFileSync(join(s.dir, 'log.jsonl'), [
    { ts: new Date(time + 1).toISOString(), feature: 'a', event: 'failed', detail: 'FAILED retained: failure with unknown try' },
    { ts: new Date(time + 2).toISOString(), feature: 'a', event: 'stuck', detail: reason },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const b = await browser(s.dash.url);
  assert.equal(b.F.attemptNumber(b.F.P.features[0]), 3);
  assert.match(b.node('d-head').innerHTML, /Stuck[\s\S]*previous child still running[\s\S]*Try 3<\/b> of 3/);
  assert.doesNotMatch(b.node('d-fixes').innerHTML + b.node('d-journey').innerHTML + b.node('d-earlier').innerHTML, /Try [12]/);
});

test('R16: human retry clears the current stop while retaining historical stopped evidence', async (t) => {
  const reason = 'merge conflict with main: too many base refreshes (5)';
  const s = await fixture(t, { ...feature('stuck', 0), lastFeedback: reason, stop: { attempt: 1, counted: false } });
  writeFileSync(join(s.dir, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), feature: 'a', event: 'stuck', detail: reason, stop: { attempt: 1, counted: false } }) + '\n');
  const r = await fetch(s.dash.url + '/api/feature/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: s.root, id: 'a' }) });
  assert.equal(r.status, 200);
  const f = JSON.parse(readFileSync(join(s.dir, 'features.json'), 'utf8')).features[0];
  assert.deepEqual([f.status, f.attempts, f.stop], ['todo', 0, undefined]);
  assert.equal((await s.history()).log.at(-1)!.attemptsReset, true);
  const b = await browser(s.dash.url);
  assert.match(b.node('d-head').innerHTML, /Queued/);
  assert.doesNotMatch(b.node('d-fixes').innerHTML + b.node('d-you').innerHTML, /stopped|refreshes/i);
});

test('R16: legacy counted refresh failure remains a failure rather than an uncounted stop', async (t) => {
  const reason = 'merge conflict with main; the foreman could not merge main into your branch because the worktree is not clean';
  const s = await fixture(t, { ...feature('stuck', 1), lastFeedback: reason });
  writeFileSync(join(s.dir, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), feature: 'a', event: 'stuck', detail: reason }) + '\n');
  const b = await browser(s.dash.url);
  assert.equal(b.F.attemptNumber(b.F.P.features[0]), 1);
  assert.match(b.node('d-head').innerHTML, /Stuck[\s\S]*merge conflict with main[\s\S]*Try 1<\/b> of 3/);
  assert.doesNotMatch(b.node('d-head').innerHTML, /without using a retry/);
});

for (const reset of [true, false]) test(`R16: resumed event preserves only supported counted associations (reset=${reset})`, async (t) => {
  const reason = 'previous child still running (pid 8)';
  const s = await fixture(t, { ...feature('stuck', 1), lastFeedback: reason, stop: { attempt: 2, counted: false } }), time = Date.now() - 1000;
  writeFileSync(join(s.dir, 'log.jsonl'), [
    { ts: new Date(time).toISOString(), feature: 'a', event: 'failed', detail: 'FAILED old: earlier failure', stop: { attempt: 1, counted: true } },
    { ts: new Date(time + 1).toISOString(), feature: 'a', event: 'resumed', detail: 'by a person', attemptsReset: reset },
    ...(reset ? [{ ts: new Date(time + 2).toISOString(), feature: 'a', event: 'failed', detail: 'builder failed: current failure', stop: { attempt: 1, counted: true } }] : []),
    { ts: new Date(time + 3).toISOString(), feature: 'a', event: 'stuck', detail: reason, stop: { attempt: 2, counted: false } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const b = await browser(s.dash.url);
  assert.match(b.node('d-head').innerHTML, /Stuck[\s\S]*Try 2<\/b> of 3/);
  assert.match(b.node('d-you').innerHTML, /Needs you/);
});

test('R16: a truncated history associates the retained explicit failure and leaves missing records unknown', async (t) => {
  const reason = 'previous child still running (pid 8)';
  const s = await fixture(t, { ...feature('stuck', 2), lastFeedback: reason, stop: { attempt: 3, counted: false } }), time = Date.now() - 1000;
  writeFileSync(join(s.dir, 'log.jsonl'), [
    ...Array.from({ length: 80 }, (_, i) => ({ ts: new Date(time + i).toISOString(), feature: 'a', event: 'prompt', detail: '' })),
    { ts: new Date(time + 81).toISOString(), feature: 'a', event: 'failed', detail: 'FAILED retained: try two defect', stop: { attempt: 2, counted: true } },
    { ts: new Date(time + 82).toISOString(), feature: 'a', event: 'stuck', detail: reason, stop: { attempt: 3, counted: false } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const b = await browser(s.dash.url);
  assert.equal((await s.history()).log.length, 60);
  assert.match(b.node('d-head').innerHTML, /Stuck[\s\S]*Try 3<\/b> of 3/);
});

test('factory reconciliation: lowering lanes keeps running work, then departed features leave no cards and spare lanes read OFF', async (t) => {
  const s = await fixture(t, feature('building', 0)), b = await browser(s.dash.url);
  const mk = (i: number, status: Feature['status']): Feature => ({ ...feature(status, 1), id: 'f' + i, title: 'Feature ' + i });
  const slots = () => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => b.node('fx-slot' + i).innerHTML as string);
  const cards = () => slots().flatMap((h) => /data-fid="([^"]+)"/.exec(h)?.[1] ?? []);
  const P = b.F.P;
  b.route('factory');
  P.features = Array.from({ length: 8 }, (_, i) => mk(i, 'building'));
  P.control = { paused: false, maxParallel: 8, configMax: 8, effective: 8 }; P.inFlight = 8; b.F.render();
  assert.equal(cards().length, 8);
  P.control = { ...P.control, maxParallel: 4, effective: 4 }; b.F.render();
  assert.deepEqual(cards().sort(), P.features.map((f: Feature) => f.id).sort(), 'running work stays visible when lanes are lowered');
  // The high-lane features merge and the foreman restarts (new running/since): nothing of them may linger.
  for (const f of P.features.slice(4)) f.status = 'merged';
  P.foreman = { running: true, since: new Date().toISOString() }; P.inFlight = 4; b.F.render();
  const live = slots();
  assert.deepEqual(cards().sort(), ['f0', 'f1', 'f2', 'f3']);
  for (const id of ['f4', 'f5', 'f6', 'f7']) assert.ok(!live.some((h) => h.includes('data-fid="' + id + '"')), id + ' left the floor');
  live.slice(4).forEach((h) => { assert.match(h, /OFF/); assert.doesNotMatch(h, /data-fid/); });
  // Paused with nothing running: no cards, four idle lanes, four OFF lanes.
  for (const f of P.features) f.status = 'merged';
  P.control = { ...P.control, paused: true, effective: 0 }; P.inFlight = 0; b.F.render();
  const idle = slots();
  assert.equal(cards().length, 0);
  assert.equal(idle.slice(0, 4).filter((h) => !/OFF/.test(h) && h.includes('bay-idle')).length, 4);
  assert.equal(idle.slice(4).filter((h) => /OFF/.test(h) && h.includes('bay-idle')).length, 4);
  assert.match(b.node('fx-sign').innerHTML, /0 BUSY/);
});

test('served factory CSS dims disabled lanes without transparency, so the floor image cannot show through', async (t) => {
  const s = await fixture(t), css = await (await fetch(s.dash.url + '/dash/factory.css')).text();
  const rule = /\.fx-slot\.off\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'disabled-slot rule exists');
  const op = /(?:^|;)\s*opacity\s*:\s*([\d.]+)/.exec(rule![1]!);
  assert.ok(!op || Number(op[1]) >= 1, 'disabled slots must stay opaque');
});

test('I01: served history lists a resumed fix as a builder run of the same try and shows the gate diagnosis', async (t) => {
  const s = await fixture(t, feature('todo', 0)), time = Date.now() - 10000;
  s.put('1-build.json', 'built', time); s.put('1.2-build.json', 'fixed the gate', time + 1000);
  s.put('1.2-diagnose.json', '{"fault":"code","evidence":"broken.txt","fix":"delete it"}', time + 500);
  const h = await s.history();
  assert.deepEqual(h.runs.map((r) => `${r.tag}-${r.role}-${r.n}`), ['1-build-1', '1.2-diagnose-1', '1.2-build-1']);
  assert.match(h.runs[1]!.text, /"fault":"code"/);
});

test('F99-17 served timeline: the current try starts at the re-plan, earlier work is folded, rows carry dates and structured outcomes', async (t) => {
  const s = await fixture(t, { ...feature('testing', 0), updatedAt: '2026-10-05T23:40:00Z' });
  writeFileSync(join(s.dir, 'log.jsonl'), readFileSync(new URL('./fixtures/story-f99-17.jsonl', import.meta.url), 'utf8'));
  s.put('1.2-build.json', 'This is the last of the leftover gate-polling commands finishing, and it changes nothing.', Date.parse('2026-10-05T23:36:00Z'));
  writeFileSync(join(s.dir, 'runs/a/1.2-build.exit.json'), JSON.stringify({ exit: { touched: ['a.ts', 'b.ts'], unsure: [], blocked: null } }));
  const b = await browser(s.dash.url), j = b.node('d-journey').innerHTML as string;
  assert.match(j, /What happened on try 1<\/h3><span class="d-tag">started (today|yesterday|[A-Z][a-z]{2} \d+(, \d{4})?,) \d/);
  const rows = [...j.matchAll(/<span class="d-st">([^<]+)/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['Planned', 'Build', 'Test', 'Next']);
  const times = [...j.matchAll(/<time datetime="([^"]+)">([^<]+)<\/time>/g)];
  assert.equal(times.length, 3, 'every row shows when it started');
  for (const [, , text] of times) assert.match(text!, /^(today|yesterday|[A-Z][a-z]{2} \d+(, \d{4})?,) \d{1,2}:\d{2}/);
  assert.match(j, /Built: 2 files changed, commit ec0ed62\./);
  assert.doesNotMatch(j.replace(/<pre class="d-said">[\s\S]*?<\/pre>/g, ''), /leftover gate-polling/, 'the agent\'s chat message only behind the expand');
  assert.match(j, /What the agent said[\s\S]*leftover gate-polling/);
  assert.match(b.node('d-earlier').innerHTML, /Earlier work \(before the spec was edited\): 2 tries/);
  const now = Date.parse('2026-10-05T15:00:00'), F = b.F;
  assert.match(F.dayTime('2026-10-05T11:47:00', now), /^today 11:47/);
  assert.match(F.dayTime('2026-10-04T23:05:00', now), /^yesterday 11:05/);
  assert.match(F.dayTime('2026-10-01T09:00:00', now), /^Oct 1, 9:00/);
  assert.match(F.dayTime('2025-12-31T09:00:00', now), /^Dec 31, 2025, 9:00/);
});

test('served timeline: a review fix\'s answers show under each finding of the rejected review, and the fix row counts them', async (t) => {
  const s = await fixture(t, { ...feature('merged', 0), updatedAt: '2026-10-05T12:10:00Z' }), T = (m: number) => Date.parse('2026-10-05T12:00:00Z') + m * 60e3;
  const e = (m: number, event: string, detail = '') => JSON.stringify({ ts: new Date(T(m)).toISOString(), feature: 'a', event, detail });
  writeFileSync(join(s.dir, 'log.jsonl'), [e(0, 'launch'), e(2, 'testing', 'aaaaaaa1'), e(3, 'evaluating'), e(5, 'review-fix', 'resuming'), e(5.5, 'review-responses', '1 fixed, 1 disputed, 0 cannot, 1 unanswered (of 3 findings)'),
    e(7, 'testing', 'bbbbbbb2'), e(8, 'evaluating'), e(9, 'merged', 'task/a')].join('\n') + '\n');
  s.put('1-build.json', 'built', T(1));
  s.put('1-eval.json', { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'missing' }, { check: 'refunds', ok: false, evidence: 'wrong total' }], cheating: [], blocking: ['Money rounding is wrong.'], notes: [], lesson: null }, T(4));
  s.put('1.2-build.json', 'Summary: fixed two of them.', T(6));
  writeFileSync(join(s.dir, 'runs/a/1.2-build.exit.json'), JSON.stringify({ findings: [{ n: 1, key: 'blocking:Money rounding is wrong.' }, { n: 2, key: 'failed:a.txt exists' }, { n: 3, key: 'failed:refunds' }],
    exit: { touched: ['a.ts'], unsure: [], blocked: null, responses: [
      { finding: 1, status: 'disputed', how: 'Rounding follows the spec <half-even>.', where: 'money.test.ts:4', key: 'blocking:Money rounding is wrong.' },
      { finding: 2, status: 'fixed', how: 'Created the file.', where: 'a.txt', key: 'failed:a.txt exists' }] } }));
  s.put('1.3-eval.json', { pass: true, findings: [{ check: 'a.txt exists', ok: true, evidence: 'ok' }], cheating: [], blocking: [], notes: [], lesson: null }, T(8.5));
  const b = await browser(s.dash.url), j = b.node('d-journey').innerHTML as string;
  assert.match(j, /1 fixed, 1 disputed, 0 cannot, 1 not answered \(1 file changed, commit bbbbbbb\)\./);
  const reasons = /Why \(3\)[\s\S]*?<\/details>\s*<\/div>/.exec(j)?.[0] ?? j;
  assert.match(reasons, /Money rounding is wrong\.[\s\S]*How it was handled<\/span><span class="d-hs disputed">disputed<\/span>Rounding follows the spec &#60;half-even&#62;\. <code>money\.test\.ts:4<\/code>/);
  assert.match(reasons, /a\.txt exists[\s\S]*<span class="d-hs fixed">fixed<\/span>Created the file\./);
  assert.match(reasons, /refunds[\s\S]*How it was handled<\/span><span class="dim">no answer recorded<\/span>/);
});
