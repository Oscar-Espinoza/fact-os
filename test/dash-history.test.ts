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
  const b = await browser(s.dash.url); b.log(1);
  assert.match(b.node('d-attempts').innerHTML, /Unvalidated evaluator output/);
  assert.match(b.node('d-attempts').innerHTML, /checkout.ts:10/);
  assert.match(b.node('d-attempts').innerHTML, /Original agent output/);
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
  const sandbox: any = { document: { getElementById: node, body: { dataset: { name: 'fact-os' } }, addEventListener() {}, querySelectorAll: () => [] },
    location: { hash: '#f/a' }, localStorage: { getItem: () => null, setItem() {} }, setInterval() {}, setTimeout, clearTimeout,
    scrollTo() {}, addEventListener: (name: string, fn: Function) => events.set(name, fn),
    fetch: async (path: string) => { const r = await fetch(url + path); if (path.startsWith('/api/feature')) paints++; return r; } };
  sandbox.window = sandbox;
  const ctx = createContext(sandbox);
  for (const script of ['core', 'factory', 'board', 'detail']) runInContext(await (await fetch(`${url}/dash/${script}.js`)).text(), ctx);
  sandbox.F.boot();
  for (let i = 0; i < 100 && (!paints || !node('d-sum').innerHTML); i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(node('foreman-t').textContent === 'Dashboard offline', false, 'render must not throw');
  return { F: sandbox.F, node, route: (view: string) => { sandbox.location.hash = '#' + view; events.get('hashchange')!(); },
    log: (n: number) => node('detail').click({ target: { closest: () => ({ dataset: { log: String(n) } }) } }) };
};

test('served detail, board and factory agree on first and second running attempts and second success', async (t) => {
  const s = await fixture(t, feature('building', 0)), b = await browser(s.dash.url);
  assert.match(b.node('d-sum').innerHTML, /Attempt 1 is running/);
  const f = b.F.P.features[0]; f.attempts = 1; b.F.render();
  assert.match(b.node('d-sum').innerHTML, /Attempt 2 is running/);
  b.route('board'); assert.match(b.node('b-active').innerHTML, /try 2\/3/);
  b.route('factory'); assert.equal(b.node('bay-a[data-tries]').textContent, 'try 2/3');
  f.status = 'merged'; b.route('f/a');
  assert.match(b.node('d-sum').innerHTML, /On try 2/);
  assert.match(b.node('d-attempts').innerHTML, /Try 2/);
});

test('served detail shows distinct refreshed outputs, current evidence and rejected raw verdicts', async (t) => {
  const s = await fixture(t), at = Date.now() - 1000;
  s.put('2-build.json', 'original build', at);
  s.put('2-eval.json', { pass: false, findings: [{ check: 'old', ok: false, evidence: 'old failure' }] }, at + 1);
  s.put('2.2-resolve.json', 'resolver output', at + 2);
  s.put('2.2-eval.json', { pass: true, findings: [] }, at + 3);
  s.put('2.10-eval.json', { pass: true, findings: [{ check: 'one', ok: true, evidence: '<current evidence>' }, { check: 'two', ok: true, evidence: 'verified' }] }, at + 4);
  const b = await browser(s.dash.url); b.log(2);
  const html = b.node('d-attempts').innerHTML;
  assert.match(html, /Run 2\.2/); assert.match(html, /Run 2\.10/); assert.match(html, /resolver output/);
  assert.match(html, /&#60;current evidence&#62;/); assert.match(html, /verdict.findings/);
  assert.match(html, /&#34;findings&#34;:\[\]/); assert.match(b.node('d-benches').innerHTML, /2 of 2 checks passed/);
});

test('fresh human retry does not attach an earlier failure to the new attempt', async (t) => {
  const s = await fixture(t, feature('building', 0)), time = Date.now() - 1000;
  s.put('1-build.json', 'old build', time); s.put('1-eval.json', { pass: false, findings: [{ check: 'old', ok: false, evidence: 'old defect' }] }, time + 1);
  writeFileSync(join(s.dir, 'log.jsonl'), [{ ts: new Date(time + 2).toISOString(), feature: 'a', event: 'stuck', detail: 'FAILED old: old defect' },
    { ts: new Date(time + 3).toISOString(), feature: 'a', event: 'retrying', detail: 'by a person' }, { ts: new Date(time + 4).toISOString(), feature: 'a', event: 'launch', detail: '' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const b = await browser(s.dash.url);
  assert.doesNotMatch(b.node('d-prob').innerHTML, /Try 1 failed/);
  assert.match(b.node('d-prob').innerHTML, /old defect/, 'historical evidence remains available');
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
  assert.match(b.node('d-attempts').innerHTML, /Failed while building/);
  assert.doesNotMatch(b.node('d-attempts').innerHTML, /Failed evaluation/);
  assert.doesNotMatch(b.node('d-benches').innerHTML, /old defect/);
  b.log(1); assert.match(b.node('d-attempts').innerHTML, /old defect/, 'distinct historical outputs remain inspectable');
});

test('legacy merged state does not make a rejected saved verdict appear to pass inspection', async (t) => {
  const s = await fixture(t, feature('merged', 0)); s.put('1-eval.json', { pass: true, findings: [] }, Date.now());
  const b = await browser(s.dash.url);
  assert.match(b.node('d-benches').innerHTML, /Verdict rejected/);
  assert.match(b.node('d-benches').innerHTML, /verdict.findings/);
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
    assert.match(b.node('d-sum').innerHTML, /Stuck on try 1/);
    assert.match(b.node('d-attempts').innerHTML, /Try 1[\s\S]*Stopped/);
    assert.doesNotMatch(b.node('d-attempts').innerHTML, /stuck after 1 failed try/);
    assert.match(b.node('d-prob').innerHTML, /Try 1 stopped/);
    assert.doesNotMatch(b.node('d-benches').innerHTML, /No try got this far/);
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
  const html = b.node('d-attempts').innerHTML;
  assert.match(html, /Try 1[\s\S]*Failed evaluation[\s\S]*Try 2[\s\S]*Stopped/);
  assert.doesNotMatch(html, /Failed at merge/);
  assert.match(b.node('d-prob').innerHTML, /Try 1 failed inspection/);
  assert.match(b.node('d-prob').innerHTML, /Try 2 stopped/);
  b.log(1); assert.match(b.node('d-attempts').innerHTML, /old payment defect/);
  b.log(2); assert.match(b.node('d-attempts').innerHTML, /Why it stopped/);
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
  assert.match(b.node('d-attempts').innerHTML, /Try 3[\s\S]*Stopped/);
  assert.doesNotMatch(b.node('d-prob').innerHTML, /Try [12] failed inspection/);
  assert.match(b.node('d-prob').innerHTML, /failure with unknown try/);
  assert.doesNotMatch(b.node('d-attempts').innerHTML, /Failed evaluation/);
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
  assert.doesNotMatch(b.node('d-prob').innerHTML, /Try 1 stopped/);
  assert.match(b.node('d-prob').innerHTML, /too many base refreshes/);
});

test('R16: legacy counted refresh failure remains a failure rather than an uncounted stop', async (t) => {
  const reason = 'merge conflict with main; the foreman could not merge main into your branch because the worktree is not clean';
  const s = await fixture(t, { ...feature('stuck', 1), lastFeedback: reason });
  writeFileSync(join(s.dir, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), feature: 'a', event: 'stuck', detail: reason }) + '\n');
  const b = await browser(s.dash.url);
  assert.equal(b.F.attemptNumber(b.F.P.features[0]), 1);
  assert.match(b.node('d-attempts').innerHTML, /Failed at merge/);
  assert.doesNotMatch(b.node('d-attempts').innerHTML, />Stopped</);
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
  assert.match(b.node('d-attempts').innerHTML, reset ? /Failed while building/ : /Failed evaluation/);
  assert.doesNotMatch(b.node('d-attempts').innerHTML, reset ? /Failed evaluation/ : /Failed while building/);
  assert.match(b.node('d-attempts').innerHTML, /Try 2[\s\S]*Stopped/);
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
  assert.match(b.node('d-prob').innerHTML, /Try 2 failed inspection/);
  assert.match(b.node('d-attempts').innerHTML, /Try 1[\s\S]*Failed \(record unavailable\)[\s\S]*Try 2[\s\S]*Failed evaluation[\s\S]*Try 3[\s\S]*Stopped/);
});
