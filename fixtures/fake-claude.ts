#!/usr/bin/env bun
// Fake `claude -p --output-format json` for the end-to-end tests. Builder mode commits a file;
// evaluator mode answers with the next scripted verdict from $FAKE_VERDICTS (default: pass); resolver mode finishes the
// merge the foreman started, keeping both sides; review mode (the observer's failure review, `You review one failed pass`)
// answers with the next scripted review of the feature named in the prompt from $FAKE_REVIEWS (default: model-limitation).
// $FAKE_SCENARIO = {"<feature id>": "flag,flag"} makes it misbehave (see the flags below;
// plain flags apply to the builder, "eval:<flag>" to the evaluator, "resolve:<flag>" to the resolver).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { FeaturesFile, Verdict } from '../lib/types.ts';

const prompt = readFileSync(0, 'utf8');
const id = (process.env.FACTOS_FEATURE ?? /^Feature: (\S+?):/m.exec(prompt)?.[1]) as string;
const log = process.env.FAKE_LOG as string;
const argv = process.argv.slice(2);
// fix: a resumed builder session (--resume) fixing a failed test gate; diagnose: the read-only gate-failure diagnosis
const mode = argv.includes('--resume') ? 'fix' : prompt.startsWith('You diagnose a failed test gate') ? 'diagnose' : prompt.startsWith('You are the planner') ? 'plan'
  : prompt.startsWith('You are the builder') ? 'build' : prompt.startsWith('You are the merge resolver') ? 'resolve' : prompt.startsWith('You review one failed pass') ? 'review' : 'eval';
const flags = ((JSON.parse(process.env.FAKE_SCENARIO || '{}') as Record<string, string>)[id] || '').split(',');
const has = (f: string) => flags.includes(mode === 'build' ? f : `${mode}:${f}`);
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const root = () => dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const commit = (file: string, text: string) => { writeFileSync(file, text); git('add', file); git('commit', '-qm', `${mode} ${id}: ${file}`); };
const t0 = Date.now();

if (has('hang')) { // never answers; leaves a grandchild in its process group
  if (has('ignore-term')) process.on('SIGTERM', () => {});
  const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
  appendFileSync(process.env.FAKE_PIDS as string, `${process.pid}\n${kid.pid}\n`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
// "slow" (any mode): five times the delay, so one feature can outlast another
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY_MS ?? 400) * (flags.includes('slow') ? 5 : 1)));
let result = 'done', extra: Record<string, unknown> = {}, responses: unknown[] | null = null;
const conflicted = () => git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
if (mode === 'resolve') {
  // keep both sides of each conflicted file (ours, then theirs) and commit the merge; "drop": keep only ours (loses
  // theirs' lines); "declare": the same, but the commit message lists theirs' lines as dropped; "leave": do nothing
  if (!has('leave')) {
    const dropped: string[] = [];
    for (const f of conflicted()) {
      const ours = git('show', `:2:${f}`), theirs = git('show', `:3:${f}`);
      writeFileSync(f, has('drop') || has('declare') ? ours + '\n' : ours + '\n' + theirs + '\n');
      if (has('declare')) for (const l of theirs.split('\n').filter((x) => x.trim())) dropped.push(`dropped: ${f}: ${l.trim()}`);
      git('add', f);
    }
    git('commit', '-q', '-m', ['resolve the merge', ...dropped].join('\n'));
  }
} else if (mode === 'build') {
  if (has('acceptance')) { // rewrite its own acceptance checks in features.json
    const file = join(root(), '.fact-os/features.json'), d = JSON.parse(readFileSync(file, 'utf8')) as FeaturesFile;
    d.features.find((f) => f.id === id)!.acceptance = ['nothing to check'];
    writeFileSync(file, JSON.stringify(d));
  }
  if (has('config')) { // loosen the foreman's config
    const file = join(root(), '.fact-os/config.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), maxAttempts: 99 }));
  }
  if (has('budget')) extra = { subtype: 'error_max_budget_usd', is_error: true, result: '' };
  else if (has('noop')) {} // no changes, no commit
  else if (has('same-again') && existsSync(log) && readFileSync(log, 'utf8').split('\n').some((l) => l.includes('"mode":"build"') && l.includes(`"id":"${id}"`))) {} // later builds change nothing
  else if (has('abandon-merge') && existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) { // abort the foreman's merge, commit other work
    git('merge', '--abort'); commit(`${id}.txt`, `built ${id} without the merge\n`);
  }
  else if ((has('resolve-drop') || has('resolve-drop-bt')) && existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) {
    // finish the merge keeping only this branch's side (loses base's lines); "resolve-drop-bt" also declares them the way
    // a builder did in the field: the line in backticks with the reason after it on the same line
    const dropped: string[] = [];
    for (const f of conflicted()) {
      const theirs = git('show', `:3:${f}`);
      writeFileSync(f, git('show', `:2:${f}`) + '\n'); git('add', f);
      if (has('resolve-drop-bt')) for (const l of theirs.split('\n').filter((x) => x.trim())) dropped.push(`dropped: ${f}: \`${l.trim()}\` - moved elsewhere`);
    }
    git('commit', '-q', '-m', ['merge main, keeping this side', ...dropped].join('\n'));
  }
  else if (has('resolve') && existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) {
    // finish the merge the foreman started: keep both sides of each conflicted file, commit the merge and nothing else
    for (const f of git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) {
      writeFileSync(f, git('show', `:2:${f}`) + '\n' + git('show', `:3:${f}`) + '\n');
      git('add', f);
    }
    git('commit', '-q', '--no-edit');
  }
  else {
    if (has('hide')) { // hide the diff from a plain `git diff`
      writeFileSync('.gitattributes', '*.txt diff=hide\n');
      git('add', '.gitattributes');
      git('config', 'diff.hide.textconv', 'true');
      git('config', 'diff.external', 'true');
    }
    commit(`${id}.txt`, `built ${id} at ${Date.now()}\n`);
    if (has('break')) commit('broken.txt', 'the guard tests\' gate fails while this exists\n');
    if (has('close-tasks')) { // a person finishes every human task while this feature builds
      const file = join(root(), '.fact-os/human.json'), d = JSON.parse(readFileSync(file, 'utf8')) as { tasks: { status: string }[] };
      for (const t of d.tasks) t.status = 'done';
      writeFileSync(file, JSON.stringify(d));
    }
    if (has('skip-test')) commit('a.test.ts', "it.skip('works', () => {});\n"); // weakens the test that exists on base
    if (has('new-test')) commit(`${id}-new.test.ts`, "it('is new', () => { expect(2).toBe(2); });\n");
    if (has('dirty')) writeFileSync('leftover.txt', 'not committed\n');
    if (has('move-base')) { git('update-ref', 'refs/heads/main', 'HEAD'); commit(`${id}-2.txt`, 'more\n'); } // base gets its unevaluated commit
    if (has('synthetic-base')) { // a commit built from the branch's tree, put on base without a feature-branch parent
      const c = git('commit-tree', 'HEAD^{tree}', '-p', 'main', '-m', 'looks like the user');
      git('-c', 'a.b=1', 'update-ref', 'refs/heads/main', c);
    }
    if (has('root-commit')) { // the same file committed straight onto base in the main checkout
      writeFileSync(join(root(), `${id}.txt`), readFileSync(`${id}.txt`));
      git('-C', root(), 'add', `${id}.txt`); git('-C', root(), 'commit', '-qm', 'looks like the user too');
    }
    if (has('user-commit')) git('-C', root(), 'commit', '-q', '--allow-empty', '-m', 'the user\'s own work on main');
    for (const [flag, f, text] of [['base-file', `base-${id}.txt`, 'from base\n'], ['base-conflict', `${id}.txt`, 'base version\n']])
      if (has(flag)) { // the user commits on base while this feature builds (base-conflict: the same file, other content)
        writeFileSync(join(root(), f), text);
        git('-C', root(), 'add', f); git('-C', root(), 'commit', '-qm', `the user's ${f} on main`);
      }
  }
} else if (mode === 'fix') {
  // A resumed builder session. Commit-only prompts (I04) commit leftover work, or finish a pending foreman merge keeping both
  // sides, and nothing else; gate-fix prompts (I01) also delete broken.txt (what makes the guard tests' gate fail).
  // "noop": change nothing; "noop1": nothing on this feature's first resume; "dirty1": the first resume leaves new work
  // uncommitted; "gatedirty": every gate fix leaves new work uncommitted.
  const fixes = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).filter((l) => { const e = JSON.parse(l) as { mode: string; id: string }; return e.mode === 'fix' && e.id === id; }).length : 0;
  const commitOnly = prompt.startsWith('The foreman found that your work is not committed');
  const keepFix = prompt.startsWith('The foreman checked the merge you resolved'), reviewFix = prompt.startsWith('An independent evaluator rejected');
  const progressFix = prompt.startsWith('Your branch still has exactly the content the evaluator rejected');
  const earlyResume = prompt.startsWith('Your turn ended while work was pending');
  // A review fix answers each numbered finding ("fix:dispute": the first is disputed; "fix:no-answer": no responses; an early
  // resume answers the findings of this feature's last review fix). "fix:early-exit": the review fix ends its turn waiting.
  const findingsOf = (p: string) => p.startsWith('An independent evaluator rejected') ? [...p.split('\n\n')[1]!.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1])) : [];
  const lastReview = earlyResume && existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { mode: string; id: string; prompt: string })
    .filter((e) => e.mode === 'fix' && e.id === id && e.prompt.startsWith('An independent evaluator rejected')).pop() : undefined;
  const nums = reviewFix ? findingsOf(prompt) : lastReview ? findingsOf(lastReview.prompt) : [];
  if (nums.length && !has('no-answer')) responses = nums.map((n, i) => (has('dispute') && i === 0
    ? { finding: n, status: 'disputed', how: 'The 409 is the specified answer for a saved partial claim; credit.test.ts covers it.', where: 'credit.test.ts:12' }
    : { finding: n, status: 'fixed', how: 'Changed the handler so the case works, with a test that failed before.', where: `${id}-review-fix.txt` }));
  if (reviewFix && has('early-exit')) result = 'Gate running (~18 min last time); waiting for its completion notification.';
  if (keepFix) { // declare every lost line exactly as the feedback shows it
    const recs = [...prompt.matchAll(/^ {2}(dropped: .+)$/gm)].map((m) => m[1]!);
    if (!has('noop') && recs.length) git('commit', '-q', '--allow-empty', '-m', ['declare the lines the merge dropped', ...recs.flatMap((r) => [r, 'Reason: moved'])].join('\n'));
  } else if (reviewFix) { if (!has('noop')) commit(`${id}-review-fix.txt`, 'fixed what the evaluator found\n'); }
  else if (earlyResume) {} // finishes the pending work: nothing to change, it replies with its Summary and exit block
  else if (progressFix) { if (has('empty')) git('commit', '-q', '--allow-empty', '-m', 'an empty commit'); else if (!has('noop')) commit(`${id}-progress.txt`, 'the missing work\n'); }
  else if (!has('noop') && !(has('noop1') && fixes === 0)) {
    if (existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) {
      for (const f of conflicted()) { writeFileSync(f, git('show', `:2:${f}`) + '\n' + git('show', `:3:${f}`) + '\n'); git('add', f); }
      git('add', '-A'); git('commit', '-q', '--no-edit');
    }
    if (git('status', '--porcelain')) { git('add', '-A'); git('commit', '-qm', `fix ${id}: commit the leftover work`); }
    if (!commitOnly && existsSync('broken.txt')) { git('rm', '-q', 'broken.txt'); git('commit', '-qm', `fix ${id}: remove broken.txt`); }
  }
  if (has('dirty1') && fixes === 0) writeFileSync('leftover-fix.txt', 'not committed by the first resume\n');
  if (has('gatedirty') && !commitOnly) writeFileSync('leftover-gate.txt', 'not committed by the gate fix\n');
} else if (mode === 'diagnose') {
  // answers with the next scripted diagnosis from $FAKE_DIAGNOSES, default a code fault; "edit": also commits a file (it must not)
  if (has('edit')) commit('diagnoser.txt', 'edited by the diagnosis\n');
  const past = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).filter((l) => { const e = JSON.parse(l) as { mode: string; id: string }; return e.mode === 'diagnose' && e.id === id; }).length : 0;
  const scripted = process.env.FAKE_DIAGNOSES ? (JSON.parse(readFileSync(process.env.FAKE_DIAGNOSES, 'utf8')) as Record<string, unknown[]>)[id]?.[past] : undefined;
  result = 'Diagnosis:\n```json\n' + JSON.stringify(scripted ?? { fault: 'code', evidence: 'broken.txt makes the gate fail', fix: 'delete broken.txt and commit' }) + '\n```';
} else if (mode === 'plan') {
  // The read-only planner: a FEASIBLE plan by default. "plan:infeasible" (a conflict with file:line evidence), "plan:garbage" (breaks
  // the contract), "plan:error" (the run fails), "plan:high" (EFFORT: high), "plan:split" (suggests a cut), "plan:edit" (commits a file,
  // which it must not), "plan:long" (a FEASIBLE plan of about 800 words).
  if (has('edit')) commit('planner.txt', 'edited by the planner\n');
  const head = `EFFORT: ${has('high') ? 'high' : 'medium'}\nSPLIT: ${has('split') ? 'yes: the API part and the UI part' : 'no'}`;
  result = has('garbage') ? 'Here is my plan: just build it.' : has('infeasible')
    ? `VERDICT: INFEASIBLE\n${head}\nCONFLICTS\n1. "no runtime change" contradicts "must fail safely": README.md:1 has no failure path.\n   Resolutions: drop one requirement.`
    : `VERDICT: FEASIBLE\n${head}\n1. Add ${id}.txt (no existing helper: rg found none).\n2. Do not touch README.md.${has('long') ? '\n3. ' + 'detail '.repeat(780) : ''}`;
  if (has('error')) extra = { is_error: true, subtype: 'error_during_execution' };
} else if (mode === 'review') {
  const past = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).filter((l) => { const e = JSON.parse(l) as { mode: string; id: string }; return e.mode === 'review' && e.id === id; }).length : 0;
  const scripted = process.env.FAKE_REVIEWS ? (JSON.parse(readFileSync(process.env.FAKE_REVIEWS, 'utf8')) as Record<string, unknown[]>)[id]?.[past] : undefined;
  result = JSON.stringify(scripted ?? { cause: 'model-limitation', evidence: ['fake'], confidence: 'low', suggestion: '', target: 'lessons' });
} else {
  if (has('move-branch')) commit('evil.txt', 'committed during evaluation\n');
  const past = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { mode: string; id: string }) : [];
  const n = past.filter((e) => e.mode === 'eval' && e.id === id).length;
  // "$BASE_SHA" / "$FEATURE_SHA" in a scripted verdict: the commits the foreman pinned for this evaluation (for baseDefects)
  const pin = /the base commit of this evaluation is ([0-9a-f]+) and the feature commit is ([0-9a-f]+)/.exec(prompt);
  const rawScript = (JSON.parse(readFileSync(process.env.FAKE_VERDICTS as string, 'utf8')) as Record<string, Partial<Verdict>[]>)[id]?.[n];
  const scripted = rawScript && JSON.parse(JSON.stringify(rawScript).replaceAll('$BASE_SHA', pin?.[1] ?? 'none').replaceAll('$FEATURE_SHA', pin?.[2] ?? 'none')) as Partial<Verdict>;
  // a scripted string is the evaluator's whole reply, as is (prose instead of a verdict)
  result = typeof scripted === 'string' ? scripted : 'Verdict:\n```json\n' + JSON.stringify(scripted ?? { pass: true,
    findings: [{ check: 'works', ok: true, evidence: 'fake' }], cheating: [], lesson: null }) + '\n```';
}
// A builder's reply (build or resumed): a Summary line and an exit block, unless "no-exit" (a bare reply) or "early-exit" (the
// first build ends its turn waiting for a background command; the resumed session then finishes).
if ((mode === 'build' || mode === 'fix') && result === 'done') {
  if (has('early-exit') && mode === 'build') result = 'Gate running (~18 min last time); waiting for its completion notification.';
  else if (!has('no-exit')) result = 'Summary: Did the work.\n```exit\n' + JSON.stringify({ touched: [], unsure: [], blocked: null, ...(responses ? { responses } : {}) }) + '\n```';
}
const args = process.argv.slice(2), arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null); // model/effort: what this launch ran with
appendFileSync(log, JSON.stringify({ mode, id, t0, t1: Date.now(), model: arg('--model'), effort: arg('--effort'), provider: process.env.FAKE_PROVIDER ?? 'claude', prompt, args }) + '\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01,
  session_id: 'fake', ...extra }));
