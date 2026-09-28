#!/usr/bin/env node
// Fake `claude -p --output-format json` for the end-to-end tests. Builder mode commits a file;
// evaluator mode answers with the next scripted verdict from $FAKE_VERDICTS (default: pass).
// $FAKE_SCENARIO = {"<feature id>": "flag,flag"} makes it misbehave (see the flags below;
// plain flags apply to the builder, "eval:<flag>" to the evaluator).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const prompt = readFileSync(0, 'utf8');
const id = process.env.SHIPYARD_FEATURE;
const log = process.env.FAKE_LOG;
const mode = prompt.startsWith('You are the builder') ? 'build' : 'eval';
const flags = (JSON.parse(process.env.FAKE_SCENARIO || '{}')[id] || '').split(',');
const has = (f) => flags.includes(mode === 'build' ? f : `eval:${f}`);
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const root = () => dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const commit = (file, text) => { writeFileSync(file, text); git('add', file); git('commit', '-qm', `${mode} ${id}: ${file}`); };
const t0 = Date.now();

if (has('hang')) { // never answers; leaves a grandchild in its process group
  if (has('ignore-term')) process.on('SIGTERM', () => {});
  const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
  appendFileSync(process.env.FAKE_PIDS, `${process.pid}\n${kid.pid}\n`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY_MS ?? 400)));
let result = 'done', extra = {};
if (mode === 'build') {
  if (has('acceptance')) { // rewrite its own acceptance checks in features.json
    const file = join(root(), '.shipyard/features.json'), d = JSON.parse(readFileSync(file, 'utf8'));
    d.features.find((f) => f.id === id).acceptance = ['nothing to check'];
    writeFileSync(file, JSON.stringify(d));
  }
  if (has('config')) { // loosen the foreman's config
    const file = join(root(), '.shipyard/config.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), maxAttempts: 99 }));
  }
  if (has('budget')) extra = { subtype: 'error_max_budget_usd', is_error: true, result: '' };
  else if (has('noop')) {} // no changes, no commit
  else {
    if (has('hide')) { // hide the diff from a plain `git diff`
      writeFileSync('.gitattributes', '*.txt diff=hide\n');
      git('add', '.gitattributes');
      git('config', 'diff.hide.textconv', 'true');
      git('config', 'diff.external', 'true');
    }
    commit(`${id}.txt`, `built ${id} at ${Date.now()}\n`);
    if (has('dirty')) writeFileSync('leftover.txt', 'not committed\n');
    if (has('move-base')) git('update-ref', 'refs/heads/main', git('commit-tree', 'HEAD^{tree}', '-p', 'main', '-m', 'sneaky'));
  }
} else {
  if (has('move-branch')) commit('evil.txt', 'committed during evaluation\n');
  const past = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const n = past.filter((e) => e.mode === 'eval' && e.id === id).length;
  const scripted = JSON.parse(readFileSync(process.env.FAKE_VERDICTS, 'utf8'))[id]?.[n];
  result = 'Verdict:\n```json\n' + JSON.stringify(scripted ?? { pass: true,
    findings: [{ check: 'works', ok: true, evidence: 'fake' }], cheating: [], lesson: null }) + '\n```';
}
appendFileSync(log, JSON.stringify({ mode, id, t0, t1: Date.now(), prompt, args: process.argv.slice(2) }) + '\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01,
  session_id: 'fake', ...extra }));
