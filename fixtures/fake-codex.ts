#!/usr/bin/env bun
// Fake `codex exec ... --json -o <file> -` for the end-to-end tests. Every invocation appends {mode: 'codex', id, args} to
// $FAKE_LOG, then answers like fake-claude.ts would (verdicts from $FAKE_VERDICTS, diagnoses from $FAKE_DIAGNOSES; that call is
// logged with provider 'codex'), as Codex JSONL events plus the last message in the -o file.
// $FAKE_SCENARIO flags for the feature: "codex:limit" (exits 1 with a usage-limit error), "codex:fail" (exits 1, another
// error), "codex:edit" (also leaves an uncommitted file in the worktree).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const prompt = readFileSync(0, 'utf8');
const id = (process.env.FACTOS_FEATURE ?? /^Feature: (\S+?):/m.exec(prompt)?.[1]) as string;
const flags = ((JSON.parse(process.env.FAKE_SCENARIO || '{}') as Record<string, string>)[id] || '').split(',');
const effort = args.find((a) => a.startsWith('model_reasoning_effort='))?.split('=')[1]?.replace(/"/g, '') ?? null;
appendFileSync(process.env.FAKE_LOG as string, JSON.stringify({ mode: 'codex', id, t0: Date.now(), t1: Date.now(), model: arg('-m'), effort, prompt, args }) + '\n');

if (flags.includes('codex:limit')) { process.stderr.write("ERROR: You've hit your usage limit. Try again later.\n"); process.exit(1); }
if (flags.includes('codex:fail')) { process.stderr.write('ERROR: stream disconnected before completion\n'); process.exit(1); }
if (flags.includes('codex:edit')) writeFileSync('codex-was-here.txt', 'left behind by the reviewer\n');

const claude = fileURLToPath(new URL('./fake-claude.ts', import.meta.url));
const r = spawnSync(process.execPath, [claude, '--model', arg('-m') ?? '', '--effort', effort ?? ''],
  { input: prompt, encoding: 'utf8', env: { ...process.env, FAKE_PROVIDER: 'codex' } });
const result = (JSON.parse(r.stdout) as { result: string }).result;
writeFileSync(arg('-o') as string, result);
for (const e of [{ type: 'thread.started', thread_id: 'fake-codex-thread' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Under-development features enabled: a harmless warning' } },
  { type: 'turn.started' }, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: result } },
  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 } }])
  process.stdout.write(JSON.stringify(e) + '\n');
