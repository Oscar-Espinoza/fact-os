#!/usr/bin/env bun
// A fake escalation agent for tests, standing in for both `codex exec` and `claude -p` (FACTOS_CODEX / FACTOS_CLAUDE).
// FAKE_AGENT_SPEC: JSON file {codex?: Behaviour, claude?: Behaviour}; FAKE_AGENT_LOG: one JSON line per call {provider, args, cwd}.
// Behaviour: {exit?, stderr?, sleepMs?, raw?, values?: {qid: true|false|"unknown"}, evidence?: "spec"|"none"|"forged"|{repo: {...}},
//             touch?: [file, json] (rewrite a file mid-run, e.g. features.json)}.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2), provider = args[0] === 'exec' ? 'codex' : 'claude';
appendFileSync(process.env.FAKE_AGENT_LOG!, JSON.stringify({ provider, args, cwd: process.cwd() }) + '\n');
const spec = JSON.parse(readFileSync(process.env.FAKE_AGENT_SPEC!, 'utf8'))[provider] ?? {};
const prompt = await Bun.stdin.text();
if (spec.sleepMs) await Bun.sleep(spec.sleepMs);
if (spec.touch) writeFileSync(spec.touch[0], JSON.stringify(spec.touch[1]));
if (spec.exit) { process.stderr.write(spec.stderr ?? 'failed'); process.exit(spec.exit); }

const lines = prompt.split('\n');
const template = JSON.parse(lines[lines.indexOf('Reply with exactly one JSON object and nothing else:') + 1]!);
const input = JSON.parse(lines.slice(lines.indexOf('Input:') + 1).join('\n'));
const ref = (kind: unknown) => kind === 'none' ? [] : kind === 'forged' ? [{ kind: 'spec', field: 'feature.title', itemIndex: null, quote: 'never said this' }]
  : typeof kind === 'object' && kind && 'repo' in kind ? [{ kind: 'spec', field: 'feature.title', itemIndex: null, quote: input.feature.title }, (kind as any).repo]
  : [{ kind: 'spec', field: 'feature.title', itemIndex: null, quote: input.feature.title }];
const answers = Object.fromEntries(Object.keys(template.answers).map((q) => {
  const value = spec.values?.[q] ?? 'unknown';
  return [q, { value, reason: `fake reason for ${q}`, evidence: value === 'unknown' ? [] : ref(spec.evidence ?? 'spec') }];
}));
const answer = spec.raw ?? JSON.stringify({ version: template.version, assessmentId: template.assessmentId, inputHash: template.inputHash, baseSha: template.baseSha, answers });
if (provider === 'codex') writeFileSync(args[args.indexOf('-o') + 1]!, answer);
else process.stdout.write(JSON.stringify({ type: 'result', result: answer, total_cost_usd: 0.42, usage: { input_tokens: 1 } }));
