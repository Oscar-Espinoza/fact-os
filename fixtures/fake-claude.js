#!/usr/bin/env node
// Fake `claude -p --output-format json` for the end-to-end test. Builder mode commits a file;
// evaluator mode answers with the next scripted verdict from $FAKE_VERDICTS (default: pass).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const prompt = readFileSync(0, 'utf8');
const id = process.env.SHIPYARD_FEATURE;
const log = process.env.FAKE_LOG;
const mode = prompt.startsWith('You are the builder') ? 'build' : 'eval';
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 400));
let result = 'done';
if (mode === 'build') {
  writeFileSync(`${id}.txt`, `built ${id} at ${Date.now()}\n`);
  execFileSync('git', ['add', `${id}.txt`]);
  execFileSync('git', ['commit', '-qm', `build ${id}`]);
} else {
  const past = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const n = past.filter((e) => e.mode === 'eval' && e.id === id).length;
  const scripted = JSON.parse(readFileSync(process.env.FAKE_VERDICTS, 'utf8'))[id]?.[n];
  result = 'Verdict:\n```json\n' + JSON.stringify(scripted ?? { pass: true,
    findings: [{ check: 'works', ok: true, evidence: 'fake' }], cheating: [], lesson: null }) + '\n```';
}
appendFileSync(log, JSON.stringify({ mode, id, t0, t1: Date.now(), prompt, args: process.argv.slice(2) }) + '\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01, session_id: 'fake' }));
