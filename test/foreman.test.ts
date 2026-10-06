import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTag, promptFingerprint, evaluatorDiff, evaluatorDiffCommands, diffFileList, evaluatorRunsGit, builtWhenStopped, parseDiagnosis, parseCodexEvents, codexArgs, CODEX_UNAVAILABLE, evaluatorPrompt, builderPrompt } from '../lib/foreman.ts';
import { DEFAULT_CONFIG } from '../lib/state.ts';
import { finalReply, transcriptLines, transcriptPath, parseExit, parseVerdict, baseOnly, testOutcome, FINISH_RULE, parseClaudeOutput, applyFailure, recoverInFlight, feedbackFromVerdict, appendLesson,
  waitForChange, stamp, childAlive, procStart, groupOf } from '../lib/foreman.ts';
import type { Feature } from '../lib/types.ts';

// Only the fields these pure helpers read; the rest of a Feature doesn't matter to them.
const feat = (o: Partial<Feature>) => o as Feature;

const verdict = (o = {}) => JSON.stringify({ pass: true, findings: [{ check: 'c1', ok: true, evidence: 'e' }], cheating: [], lesson: null, ...o });

test('R15: malformed negative verdict keeps raw defect context without validating partial fields', () => {
  const raw = verdict({ pass: false, findings: [], blocking: 'cancel.ts:182 bypasses tenant isolation', lesson: 'Invalid lesson advice' });
  const v = parseVerdict(raw);
  assert.deepEqual([v.pass, v.findings, v.cheating, v.blocking, v.notes, v.lesson], [false, [], [], [], [], null]);
  assert.equal(v.diagnostic, raw);
  const feedback = feedbackFromVerdict(v);
  assert.match(feedback, /^Evaluator: verdict.findings must be a nonempty array\n/);
  assert.match(feedback, /Unvalidated evaluator output \(diagnostic only\):/);
  assert.match(feedback, /cancel.ts:182 bypasses tenant isolation/);
  assert.doesNotMatch(feedback, /^BLOCKING:|^FAILED /m);
});

test('R15: malformed positive verdict stays rejected and cannot promote its raw lesson', () => {
  const raw = verdict({ notes: 'refund.ts:27 double refunds', lesson: 'Never promote this malformed advice' });
  const v = parseVerdict(raw);
  assert.equal(v.pass, false); assert.equal(v.lesson, null); assert.deepEqual(v.findings, []);
  assert.equal(v.diagnostic, raw);
  assert.match(feedbackFromVerdict(v), /refund.ts:27 double refunds/);
});

test('R15: JSON and root rejection retain original text including wrappers', () => {
  for (const raw of ['defect at checkout.ts:10, not JSON', '{"blocking":"tenant bug"', '[' + verdict() + ']',
    'Here is the verdict:\n```json\n' + verdict({ notes: 'missing guard' }) + '\n```\nEnd']) {
    const v = parseVerdict(raw);
    assert.equal(v.pass, false); assert.equal(v.lesson, null); assert.equal(v.diagnostic, raw);
    assert.match(feedbackFromVerdict(v), /Unvalidated evaluator output/);
  }
});

test('R15: empty evaluator text has no invented diagnostic section', () => {
  for (const raw of ['', ' \n\t ', null, undefined]) {
    const v = parseVerdict(raw);
    assert.equal(v.diagnostic, undefined);
    assert.equal(feedbackFromVerdict(v), 'Evaluator: evaluator output is not a JSON object');
  }
});

test('R15: rejected output excerpt is bounded, keeps both ends and marks omitted context', () => {
  const raw = 'START checkout.ts:10 ' + 'x'.repeat(10000) + ' END tenant.ts:27';
  const v = parseVerdict(raw);
  assert.equal(v.diagnostic!.length, 2000);
  assert.ok(v.diagnostic!.startsWith('START checkout.ts:10'));
  assert.ok(v.diagnostic!.endsWith('END tenant.ts:27'));
  assert.match(v.diagnostic!, /\[truncated\]/);
  assert.ok(feedbackFromVerdict(v).length < 2500, 'keep the schema header inside the reviewer outcome limit');
  const exact = 'a'.repeat(2000); assert.equal(parseVerdict(exact).diagnostic, exact);
});

test('R15: valid negative and contradictory verdicts keep their existing validated feedback', () => {
  const good = verdict({ lesson: 'Valid advice' });
  assert.equal(parseVerdict(good).pass, true); assert.equal(parseVerdict(good).diagnostic, undefined);
  for (const pass of [true, false]) {
    const v = parseVerdict(verdict({ pass, findings: [{ check: 'tenant', ok: false, evidence: 'missing guard' }], blocking: ['defect'], lesson: 'Valid advice' }));
    assert.equal(v.pass, false); assert.equal(v.diagnostic, undefined); assert.equal(v.lesson, 'Valid advice');
    assert.equal(feedbackFromVerdict(v), (pass ? 'Evaluator: pass:true contradicted by findings, cheating or blocking\n' : '') + 'FAILED tenant: missing guard\nBLOCKING: defect');
  }
});

test('parseVerdict accepts a bare JSON verdict and one wrapped in prose/fences', () => {
  assert.equal(parseVerdict(verdict()).pass, true);
  const v = parseVerdict('Here is my verdict:\n```json\n' + verdict({ lesson: 'L' }) + '\n```\nThanks');
  assert.equal(v.pass, true);
  assert.equal(v.lesson, 'L');
});

test('parseVerdict fails closed on unparseable or malformed output', () => {
  for (const bad of ['', 'looks good to me!', '{"pass": true', JSON.stringify({ pass: 'true', findings: [] }),
    JSON.stringify({ findings: [] }), JSON.stringify({ pass: true }), '[true]']) {
    const v = parseVerdict(bad);
    assert.equal(v.pass, false, bad);
    assert.ok(v.error, bad);
  }
});

test('parseVerdict: pass:true with a failed finding or cheating is still a fail', () => {
  assert.equal(parseVerdict(verdict({ findings: [{ check: 'c', ok: false, evidence: 'no' }] })).pass, false);
  assert.equal(parseVerdict(verdict({ cheating: ['test asserts true'] })).pass, false);
});

test('parseVerdict rejects malformed present lists instead of discarding or coercing them', () => {
  for (const pass of [true, false]) for (const field of ['cheating', 'blocking', 'notes']) for (const bad of ['tenant isolation broken', null, {}, [true], [7], [{}], [' '], ['valid', null]]) {
    const v = parseVerdict(verdict({ pass, [field]: bad }));
    assert.equal(v.pass, false, `${field}: ${JSON.stringify(bad)}`);
    assert.match(v.error!, new RegExp(field));
    assert.equal(v.lesson, null);
  }
});

test('parseVerdict validates every finding without filtering malformed entries', () => {
  const good = { check: 'c', ok: true, evidence: 'checked' };
  for (const pass of [true, false]) for (const bad of [null, true, 'ignored', [], { ok: true }, { check: 'c', ok: true },
    { check: 'c', evidence: 'e' }, { ...good, check: 7 }, { ...good, check: ' ' },
    { ...good, evidence: {} }, { ...good, evidence: '' }, { ...good, ok: 'true' }, { ...good, ok: 1 }]) {
    const v = parseVerdict(verdict({ pass, findings: [good, bad] }));
    assert.equal(v.pass, false, JSON.stringify(bad));
    assert.match(v.error!, /findings\[1\]/);
  }
  const empty = parseVerdict(verdict({ findings: [] }));
  assert.equal(empty.pass, false);
  assert.match(empty.error!, /findings/);
});

test('parseVerdict rejects malformed lessons without compounding their advice', () => {
  for (const pass of [true, false]) for (const lesson of [true, 7, {}, []]) {
    const v = parseVerdict(verdict({ pass, lesson }));
    assert.equal(v.pass, false);
    assert.match(v.error!, /lesson/);
    assert.equal(v.lesson, null);
  }
});

test('parseVerdict rejects parsed non-object roots instead of unwrapping an inner verdict', () => {
  for (const text of ['[' + verdict() + ']', '```json\n[' + verdict() + ']\n```', JSON.stringify(verdict()), 'null']) {
    const v = parseVerdict(text);
    assert.equal(v.pass, false, text);
    assert.match(v.error!, /JSON object/);
  }
});

test('parseVerdict preserves legacy omissions and normalizes correctly typed optional fields', () => {
  const core = { pass: true, findings: [{ check: 'c', ok: true, evidence: 'e' }] };
  assert.deepEqual(parseVerdict(JSON.stringify(core)), { ...core, cheating: [], blocking: [], notes: [], lesson: null });
  const v = parseVerdict(JSON.stringify({ ...core, cheating: [], blocking: [], notes: [' minor '], lesson: ' L ' }));
  assert.equal(v.pass, true);
  assert.deepEqual(v.notes, ['minor']);
  assert.equal(v.lesson, 'L');
  assert.equal(parseVerdict(JSON.stringify({ ...core, lesson: ' ' })).lesson, null);
  const rejected = parseVerdict(JSON.stringify({ ...core, pass: false,
    findings: [{ check: 'c', ok: false, evidence: 'fails in production' }], lesson: 'Keep the guard' }));
  assert.equal(rejected.pass, false);
  assert.equal(rejected.error, undefined, 'valid rejection retains its evidence instead of a schema error');
  assert.match(feedbackFromVerdict(rejected), /FAILED c: fails in production/);
  assert.equal(rejected.lesson, 'Keep the guard');
});

test('parseClaudeOutput reads result and cost (total_cost_usd, falling back to cost_usd)', () => {
  assert.deepEqual(parseClaudeOutput(JSON.stringify({ type: 'result', is_error: false, result: 'hi', total_cost_usd: 0.5 })),
    { ok: true, text: 'hi', cost: 0.5 });
  assert.equal(parseClaudeOutput(JSON.stringify({ result: 'x', cost_usd: 0.25 })).cost, 0.25);
  const err = parseClaudeOutput(JSON.stringify({ is_error: true, result: 'budget exceeded', total_cost_usd: 1 }));
  assert.equal(err.ok, false); assert.equal(err.cost, 1);
  assert.equal(parseClaudeOutput('not json').ok, false);
});

test('applyFailure: attempts increment, feedback kept, stuck at maxAttempts', () => {
  const f = feat({ id: 'a', status: 'evaluating', attempts: 0 });
  applyFailure(f, 'fb1', 2);
  assert.deepEqual([f.status, f.attempts, f.lastFeedback], ['todo', 1, 'fb1']);
  applyFailure(f, 'fb2', 2);
  assert.deepEqual([f.status, f.attempts, f.lastFeedback], ['stuck', 2, 'fb2']);
});

test('recoverInFlight resets only in-flight statuses and keeps attempts', () => {
  const fs = (['building', 'testing', 'evaluating', 'todo', 'ready', 'merged', 'stuck'] as const).map((s) => feat({ id: s, status: s, attempts: 1 }));
  assert.deepEqual(recoverInFlight(fs).todo, ['building', 'testing', 'evaluating']);
  assert.deepEqual(fs.map((f) => f.status), ['todo', 'todo', 'todo', 'todo', 'ready', 'merged', 'stuck']);
  assert.ok(fs.every((f) => f.attempts === 1));
});

test('recoverInFlight: a merged branch wins; an overdue live child makes the feature stuck with its pid', () => {
  const fs = [feat({ id: 'm', status: 'testing', pid: 7 }), feat({ id: 'o', status: 'building', pid: 8 }), feat({ id: 'd', status: 'evaluating', pid: 9 })];
  const r = recoverInFlight(fs, { merged: (f) => f.id === 'm', overdue: (f) => f.id !== 'd' });
  assert.deepEqual([r.merged, r.stuck, r.todo], [['m'], ['o'], ['d']]);
  assert.deepEqual(fs.map((f) => f.status), ['merged', 'stuck', 'todo']);
  assert.equal(fs[1].lastFeedback, 'previous child still running (pid 8)');
});

test('waitForChange returns at once when the files changed after the caller\'s stamp (bug: missed wakeup)', async (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fact-os-wait-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const P = { features: join(d, 'features.json'), human: join(d, 'human.json') };
  writeFileSync(P.features, '{}');
  const before = stamp(P);
  writeFileSync(P.human, '{}'); // e.g. `shipyard done` lands between load() and the wait
  const r = await Promise.race([waitForChange(P, before, () => false).then(() => 'woke'), new Promise((r) => setTimeout(r, 1000, 'slept'))]);
  assert.equal(r, 'woke');
});

test('feedbackFromVerdict lists failed findings and cheating, not passing findings', () => {
  const fb = feedbackFromVerdict({ pass: false, findings: [{ check: 'good', ok: true, evidence: 'fine' },
    { check: 'bad', ok: false, evidence: 'returns 42 always' }], cheating: ['skipped test'] });
  assert.match(fb, /bad.*returns 42 always/);
  assert.match(fb, /skipped test/);
  assert.doesNotMatch(fb, /good/);
  assert.match(feedbackFromVerdict({ pass: false, error: 'unparseable', findings: [], cheating: [] }), /unparseable/);
});

test('appendLesson: creates heading once, dedupes by exact text, keeps later sections intact', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fact-os-lesson-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const file = join(d, 'CLAUDE.md');
  assert.equal(appendLesson(file, 'Run the linter', '2026-01-01'), true);
  assert.equal(appendLesson(file, 'Run the linter', '2026-02-02'), false);
  assert.equal(appendLesson(file, 'Multi\nline  lesson', '2026-01-01'), true);
  let s = readFileSync(file, 'utf8');
  assert.equal(s.match(/## fact-os lessons/g)!.length, 1);
  assert.equal(s.match(/Run the linter/g)!.length, 1);
  assert.match(s, /- 2026-01-01: Multi line lesson/);
  writeFileSync(file, '# Proj\n\n## Shipyard lessons\n\n- 2026-01-01: A\n\n## Other\n\ntext\n');
  appendLesson(file, 'B', '2026-01-03');
  s = readFileSync(file, 'utf8');
  assert.ok(s.indexOf('- 2026-01-03: B') < s.indexOf('## Other'), s);
  assert.match(s, /## Other\n\ntext\n$/);
});

test('childAlive: a foreign pid (EPERM), a reused pid or a missing start time is not our child (bug: pid 1 waited on forever)', (t) => {
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout);
  const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => kid.kill());
  // Without /proc: dead once the recorded foreman is dead, otherwise by pid.
  assert.equal(childAlive({ pid: kid.pid, foremanPid: dead }, { proc: false }), false);
  assert.equal(childAlive({ pid: kid.pid, foremanPid: process.pid }, { proc: false }), true);
  assert.equal(childAlive({ pid: dead, foremanPid: process.pid }, { proc: false }), false);
  if (!existsSync('/proc/self/stat')) return;
  assert.equal(childAlive({ pid: 1 }), false, 'pid 1 exists but has no recorded start time');
  assert.equal(childAlive({ pid: 1, pidStart: procStart(1)!, foremanPid: process.pid }), false, 'EPERM: not our user');
  const start = procStart(kid.pid!)!;
  assert.match(start, /^\d+$/);
  assert.equal(childAlive({ pid: kid.pid, pidStart: start }), true);
  assert.equal(childAlive({ pid: kid.pid, pidStart: String(Number(start) + 1) }), false, 'same pid, other process');
  assert.equal(childAlive({ pid: dead, pidStart: start }), false);
});

test('groupOf: explicit group wins; idPrefix:<n> defaults to the first n chars of the id; null or unknown groupBy means no group', () => {
  assert.equal(groupOf({ id: 'F05-02-x' }, 'idPrefix:3'), 'F05');
  assert.equal(groupOf({ id: 'F05-02-x', group: 'db' }, 'idPrefix:3'), 'db');
  assert.equal(groupOf({ id: 'F05-02-x', group: 'db' }, null), 'db');
  assert.equal(groupOf({ id: 'F05-02-x' }, null), null);
  assert.equal(groupOf({ id: 'F05-02-x' }, 'bogus'), null);
});

test('runTag never reuses an earlier pass\'s run files', () => {
  assert.equal(runTag([], 1), '1');
  assert.equal(runTag(['1-build.json', '1-eval.json'], 1), '1.2');
  assert.equal(runTag(['1-build.json', '1.2-build.json'], 1), '1.3');
  assert.equal(runTag(['1-build.json'], 2), '2');
});

test('promptFingerprint names the role, model and effort, and hashes lessons and briefs', () => {
  const a = promptFingerprint('builder', { model: 'opus', effort: 'medium' }, 'lessons v1', 'brief');
  assert.match(a, /^builder model=opus effort=medium lessons=[0-9a-f]{8} briefs=[0-9a-f]{8}$/);
  assert.notEqual(a, promptFingerprint('builder', { model: 'opus', effort: 'medium' }, 'lessons v2', 'brief'));
  assert.equal(promptFingerprint('evaluator', {}, null, ''), 'evaluator model=- effort=- lessons=- briefs=-');
});

test('a blocking problem fails the feature even when every acceptance check is ok, and reaches the next build', () => {
  const v = parseVerdict(verdict({ blocking: ['F07-09: a paid manual order cancels with only orders.fulfill (cancel.ts:182)'], notes: ['naming'] }));
  assert.equal(v.pass, false);
  assert.deepEqual(v.notes, ['naming']);
  assert.match(v.error!, /contradicted/);
  assert.match(feedbackFromVerdict(v), /^BLOCKING: F07-09: a paid manual order/m);
  assert.equal(parseVerdict(verdict({ notes: ['minor'] })).pass, true, 'notes alone do not block');
  assert.deepEqual(parseVerdict(verdict()).blocking, [], 'older verdicts without the field still parse');
});

test('evaluatorDiff keeps whole files in order while they fit and names what it leaves out', () => {
  const files = [{ path: 'apps/api/routes.ts', diff: 'A'.repeat(60) }, { path: 'packages/c/generated/x.json', diff: '' },
    { path: 'migrations/0001.sql', diff: 'B'.repeat(60) }, { path: 'packages/z.ts', diff: 'C'.repeat(30) }];
  const out = evaluatorDiff(' 4 files changed', files, ['packages/c/generated/x.json'], 100);
  assert.match(out, /^Files changed \(git diff --stat\):\n 4 files changed/);
  assert.match(out, /Generated or excluded files, not shown[^\n]*\n- packages\/c\/generated\/x\.json/);
  assert.match(out, /NOT SHOWN because the diff is too long[^\n]*\n- migrations\/0001\.sql/);
  assert.ok(out.includes('A'.repeat(60)) && out.includes('C'.repeat(30)) && !out.includes('B'.repeat(60)));
  assert.doesNotMatch(evaluatorDiff('s', [{ path: 'a', diff: 'x' }], []), /NOT SHOWN|excluded/);
});

test('evaluatorDiffCommands: status, counts and one git diff per file; excluded files by name; the duty to read them all', () => {
  const files = diffFileList('M\tlib/a.ts\nA\ttest/a test.ts\nR087\told.ts\tnew.ts\nM\tgen/x.json\nA\tlogo.png',
    '3\t1\tlib/a.ts\n10\t0\ttest/a test.ts\n1\t1\t{old.ts => new.ts}\n500\t400\tgen/x.json\n-\t-\tlogo.png');
  assert.deepEqual(files[2], { status: 'R087', paths: ['old.ts', 'new.ts'], added: 1, removed: 1 });
  assert.deepEqual(files[4], { status: 'A', paths: ['logo.png'], added: null, removed: null });
  const out = evaluatorDiffCommands(files, ['gen/x.json'], 'b0', 'h1');
  assert.match(out, /^M \+3 -1 lib\/a\.ts\n {4}git diff --no-ext-diff b0\.\.\.h1 -- lib\/a\.ts$/m);
  assert.match(out, /^A \+10 -0 test\/a test\.ts\n {4}git diff --no-ext-diff b0\.\.\.h1 -- 'test\/a test\.ts'$/m);
  assert.match(out, /^R \+1 -1 old\.ts -> new\.ts\n {4}git diff --no-ext-diff -M b0\.\.\.h1 -- old\.ts new\.ts$/m);
  assert.match(out, /^A binary logo\.png$/m);
  assert.match(out, /Generated or excluded files[^\n]*\nM \+500 -400 gen\/x\.json$/m);
  assert.doesNotMatch(out, /-- gen\/x\.json/);
  assert.match(out, /5 files changed, 514 insertions\(\+\), 402 deletions\(-\)/);
  assert.match(out, /Read the diff of every changed file[\s\S]*A defect in a file you did not read is still yours to find/);
  assert.deepEqual(['auto', 'bypassPermissions', 'plan', 'acceptEdits', undefined].map((m) => evaluatorRunsGit({ permissionMode: m, provider: 'codex' })),
    [true, true, false, false, false]);
});

test('builtWhenStopped: the sha a pass had built when the foreman stopped, only if nothing ended the pass since', () => {
  const ev = (feature: string, event: string, detail = '') => ({ feature, event, detail });
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'prompt', 'builder'), ev('a', 'testing', 'abc'), ev('a', 'interrupted')], 'a'), 'abc');
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'testing', 'abc'), ev('a', 'evaluating'), ev('a', 'lesson', 'x'), ev('a', 'interrupted')], 'a'), 'abc');
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'interrupted')], 'a'), null, 'stopped while building');
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'testing', 'abc'), ev('a', 'failed', 'x'), ev('a', 'launch'), ev('a', 'interrupted')], 'a'), null);
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'testing', 'abc'), ev('a', 'interrupted'), ev('a', 'launch')], 'a'), 'abc', 'read by the new pass after its launch');
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'testing', 'abc'), ev('a', 'interrupted'), ev('a', 'launch'), ev('a', 'interrupted'), ev('a', 'launch')], 'a'), null, 'stopped again while building');
  assert.equal(builtWhenStopped([ev('b', 'launch'), ev('b', 'testing', 'abc'), ev('b', 'interrupted')], 'a'), null);

  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'testing', 'abc'), ev('a', 'gate-fix'), ev('a', 'interrupted')], 'a'), null,
    'stopped during a resumed gate fix: the sha that failed the gate is not reused');
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'testing', 'abc'), ev('a', 'gate-fix'), ev('a', 'testing', 'def'), ev('a', 'interrupted')], 'a'), 'def',
    'stopped while the fixed sha was in the gate');
  assert.equal(builtWhenStopped([ev('a', 'launch'), ev('a', 'testing', 'abc'), ev('a', 'gate-fix'), ev('a', 'testing', 'def'), ev('a', 'commit-fix'), ev('a', 'interrupted')], 'a'), null,
    'stopped during a commit fix: no tested sha is reused');
});

test('parseDiagnosis: fault, evidence and fix, bare, fenced or in prose; anything else is an error', () => {
  const ok = { fault: 'test', evidence: 'expects 3 rows, the spec says 2', fix: 'expect 2 rows' };
  assert.deepEqual(parseDiagnosis(JSON.stringify(ok)), ok);
  assert.deepEqual(parseDiagnosis('Diagnosis:\n```json\n' + JSON.stringify(ok) + '\n```'), ok);
  assert.match((parseDiagnosis('{"fault":"maybe","evidence":"x","fix":"y"}') as { error: string }).error, /fault/);
  assert.match((parseDiagnosis('{"fault":"code","evidence":" ","fix":"y"}') as { error: string }).error, /evidence/);
  assert.match((parseDiagnosis('no idea') as { error: string }).error, /not a JSON object/);
});

test('parseCodexEvents: thread id, usage and real failures; warning items are not failures', () => {
  const events = [{ type: 'thread.started', thread_id: 't-1' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Under-development features enabled: reasoning_effort_override.' } },
    { type: 'turn.started' }, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{"ok": true}' } },
    { type: 'turn.completed', usage: { input_tokens: 18967, output_tokens: 9 } }].map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(parseCodexEvents(events), { threadId: 't-1', usage: { input_tokens: 18967, output_tokens: 9 } });
  assert.equal(parseCodexEvents(JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } })).error, 'usage limit reached');
  assert.ok(CODEX_UNAVAILABLE.test("You've hit your usage limit") && !CODEX_UNAVAILABLE.test('stream disconnected before completion'));
  assert.ok(CODEX_UNAVAILABLE.test("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.")); // the plan lost the model: cool down
  assert.deepEqual(codexArgs({ model: 'gpt-6.1-sol', effort: 'xhigh' }, '/tmp/last').slice(0, 5), ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"']);
});

test('evaluatorPrompt: a copied helper blocks only in production code; duplicated test setup is a note', () => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-evalprompt-'));
  try {
    const f: Feature = { id: 'a', title: 'A', description: '', acceptance: ['works'], surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '' };
    const p = evaluatorPrompt(root, { ...DEFAULT_CONFIG, lessonsFile: 'none.md' }, f, 'ship/a', '', { code: 0, tail: '' }, []);
    const blocking = p.slice(p.indexOf('Report under "blocking"'), p.indexOf('Minor remarks'));
    assert.match(blocking, /multi-line copy of an existing\s+production helper/);
    assert.match(p, /Duplicated setup or helpers inside test files go under "notes"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('I06: builder and evaluator see the same on-mock tasks by id and scope; without them the evaluator stays strict', () => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-onmock-'));
  try {
    const cfg = { ...DEFAULT_CONFIG, lessonsFile: 'none.md' };
    const f: Feature = { id: 'a', title: 'A', description: '', acceptance: ['works'], surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '' };
    const task = { id: 'H-C44', title: 'Gudink partner API', steps: ['confirm the partner API', 'share credentials'], unblocks: ['a'], mockable: true, status: 'open' as const };
    const ev = evaluatorPrompt(root, cfg, f, 'ship/a', '', { code: 0, tail: '' }, [], '', '', [], [task]);
    for (const re of [/ON MOCK/, /H-C44: Gudink partner API/, /confirm the partner API/, /documented deferral/, /under "notes", keyed by task id/])
      assert.match(ev, re);
    assert.match(ev, /outside the on-mock tasks below/, 'the fake/development rules name the exception');
    const strict = evaluatorPrompt(root, cfg, f, 'ship/a', '', { code: 0, tail: '' }, []);
    assert.doesNotMatch(strict, /ON MOCK|on-mock/);
    assert.match(strict, /a path that only works with a fake or a development setting/);
    const bp = builderPrompt(root, cfg, f, 'ship/a', [task]);
    assert.match(bp, /ON MOCK/); assert.match(bp, /H-C44: Gudink partner API/); assert.match(bp, /confirm the partner API/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('baseDefects: parsed and validated; base-only means every failed finding is explained by a base defect and nothing blocks', () => {
  const bd = { check: 'gate passes', command: 'pnpm test x.db.test.ts', signature: "Queue catalog.product-changed does not exist", baseSha: 'abcdef1234', featureSha: '1234abcdef', evidence: 'fails on base and branch', paths: ['apps/worker/src/testing/echo-worker.ts'] };
  const v = parseVerdict(JSON.stringify({ pass: false, findings: [{ check: 'gate passes', ok: false, evidence: 'x' }, { check: 'other', ok: true, evidence: 'y' }], cheating: [], blocking: [], baseDefects: [bd] }));
  assert.equal(v.error, undefined); assert.deepEqual(v.baseDefects, [bd]); assert.equal(baseOnly(v), true);
  assert.equal(baseOnly({ ...v, blocking: ['a real defect'] }), false, 'mixed: a blocking entry');
  assert.equal(baseOnly({ ...v, findings: [...v.findings, { check: 'mine', ok: false, evidence: 'z' }] }), false, 'an unexplained failed finding');
  assert.match(parseVerdict(JSON.stringify({ pass: true, findings: [{ check: 'gate passes', ok: true, evidence: 'x' }], cheating: [], baseDefects: [bd] })).error!, /check must name a failed finding/, 'a base defect must explain a failed finding');
  assert.match(parseVerdict(JSON.stringify({ pass: true, findings: [{ check: 'gate passes', ok: false, evidence: 'x' }], cheating: [], baseDefects: [bd] })).error!, /contradicted/, 'pass:true with a base defect is contradictory');
  assert.equal(baseOnly({ ...v, findings: [{ check: 'gate passes', ok: true, evidence: 'x' }] }), false, 'no failed finding: not base-only');
  assert.match(parseVerdict(JSON.stringify({ pass: false, findings: [{ check: 'a', ok: false, evidence: 'x' }], baseDefects: [{ ...bd, baseSha: 'main' }] })).error!, /baseSha/);
  assert.match(feedbackFromVerdict(v), /^FAILED gate passes[\s\S]*BASE DEFECT \(reproduced on abcdef1234 too; not this feature's to fix\): gate passes: Queue catalog\.product-changed does not exist/m);
});

test('verdict summary: kept when a plain string, dropped (never rejected) when malformed; the builder is asked for a Summary line', () => {
  const base = { pass: false, findings: [{ check: 'a', ok: false, evidence: 'x' }], cheating: [], blocking: [] };
  assert.equal(parseVerdict(JSON.stringify({ ...base, summary: 'Evidence logs are missing.' })).summary, 'Evidence logs are missing.');
  const bad = parseVerdict(JSON.stringify({ ...base, summary: 42 }));
  assert.equal(bad.error, undefined); assert.equal(bad.summary, undefined);
  assert.deepEqual(testOutcome('test command `g` exited 1:\nFAIL src/a.test.ts > b\nAssertionError: expected 1'), { code: 1, file: 'a.test.ts', error: 'AssertionError: expected 1' });
  assert.match(FINISH_RULE, /starting "Summary:"/);
});

test('parseVerdict: criterion and issue kind are optional attribution; a bad value is dropped, never the finding or the blocker', () => {
  const v = parseVerdict(JSON.stringify({ pass: false, cheating: [], notes: [], lesson: null, blocking: ['dup helper', 'no wiring'], blockingKinds: ['duplicated-helper', 'nonsense'],
    findings: [{ check: 'a', ok: false, evidence: 'e', criterion: 2, kind: 'weak-test' }, { check: 'b', ok: false, evidence: 'e', criterion: -1, kind: 'made-up' },
      { check: 'wiring', ok: false, evidence: 'e', criterion: 'extra:production wiring', kind: 'missing-wiring' }, { check: 'c', ok: true, evidence: 'e', criterion: 1, kind: 'weak-test' }] }));
  assert.equal(v.error, undefined); assert.equal(v.findings.length, 4); assert.deepEqual(v.blocking, ['dup helper', 'no wiring']);
  assert.deepEqual(v.findings.map((f) => [f.criterion ?? null, f.kind ?? null]), [[2, 'weak-test'], [null, null], ['extra:production wiring', 'missing-wiring'], [1, null]]);
  assert.deepEqual(v.blockingKinds, ['duplicated-helper', null]);
  assert.equal(parseVerdict(JSON.stringify({ pass: false, cheating: [], notes: [], lesson: null, blocking: ['x'], blockingKinds: ['a', 'b'], findings: [{ check: 'a', ok: false, evidence: 'e' }] })).blockingKinds, undefined);
});

test('parseExit: the last exit block, bounded; malformed or missing is simply absent', () => {
  const x = parseExit('Summary: Done.\n```exit\n{"touched": ["a.ts", 3, ""], "unsure": ["u1","u2","u3","u4","u5","u6"], "blocked": {"reason": "missing-info", "what": "which currency"}}\n```');
  assert.deepEqual(x, { touched: ['a.ts'], unsure: ['u1', 'u2', 'u3', 'u4', 'u5'], blocked: { reason: 'missing-info', what: 'which currency' } });
  assert.equal(parseExit('```exit\n{"touched": [], "blocked": {"reason": "bored", "what": "x"}}\n```')!.blocked, null);
  assert.equal(parseExit('Summary: no block'), null); assert.equal(parseExit('```exit\nnot json\n```'), null);
});

test('finalReply and transcriptPath: the real final reply of this run only — a stray last turn, an earlier resumed run, a sidechain or a marker mention never decide it', () => {
  const d = mkdtempSync(join(tmpdir(), 'tr-')), f = join(d, 's.jsonl');
  const msg = (type: string, text: string, o = {}) => JSON.stringify({ type, uuid: `u${text.length}`, timestamp: 't', message: { content: [{ type: 'text', text }] }, ...o });
  const exit = (t: string) => `\n\`\`\`exit\n{"touched": ["${t}"], "unsure": [], "blocked": null}\n\`\`\``;
  const earlier = [msg('user', 'build it'), msg('assistant', 'Summary: Added the list; all checks pass.' + exit('list.ts'))];
  const now = [msg('user', 'repair it'), msg('assistant', 'Summary: Repaired the guard.' + exit('guard.ts')), msg('assistant', 'Side work.' + exit('side.ts'), { isSidechain: true }),
    msg('assistant', 'Another notification: I already sent the ```exit block; nothing changed.'), msg('assistant', 'Nothing changed.'), 'not json'];
  writeFileSync(f, [...earlier, ...now].join('\n') + '\n');
  try {
    const r = finalReply(f, earlier.length)!;
    assert.match(r.text, /^Summary: Repaired the guard\./); assert.deepEqual(parseExit(r.text)!.touched, ['guard.ts']);
    writeFileSync(f, [...earlier, msg('user', 'repair it'), msg('assistant', 'Summary: Could not finish the checks.')].join('\n') + '\n');
    assert.equal(finalReply(f, earlier.length), null); // this run left no exit: nothing from the earlier run is borrowed
    assert.equal(finalReply(join(d, 'missing.jsonl')), null);
    // The boundary counts every existing record, the last one too when it has no trailing newline.
    writeFileSync(f, earlier.join('\n')); const at = transcriptLines(f); assert.equal(at, 2);
    writeFileSync(f, earlier.join('\n') + '\n' + [msg('user', 'repair it'), msg('assistant', 'Summary: Could not finish.')].join('\n'));
    assert.equal(finalReply(f, at), null); assert.equal(transcriptLines(join(d, 'missing.jsonl')), 0);
    const prev = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = '/cfg';
    assert.equal(transcriptPath('/home/o/Projects/x-worktrees/F99-17.a_b', 'sid'), '/cfg/projects/-home-o-Projects-x-worktrees-F99-17-a-b/sid.jsonl');
    const long = '/home/oscar/Projects/' + 'a'.repeat(185) + '/worktrees/F99-17', key = transcriptPath(long, 'sid').split('/').at(-2)!;
    assert.equal(key.length, 207); assert.match(key, /-lnrja3$/); // Claude Code 2.1.289's own key for this path assert.equal(key.slice(0, 200), long.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200));
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  } finally { rmSync(d, { recursive: true, force: true }); }
});
