// Foreman: plan → build → test → evaluate → merge → compound, over ready features, in parallel worktrees.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, paths, loadState, loadConfig, mutate, log, withSupervisor, withCheckoutLock, sleep, envVar, featureEnv, readControlFile, effectiveLimit, readJson, writeJsonAtomic, readSetupState, updateSetupState, SETUP_HOLD_AFTER, SETUP_HOLD_WINDOW_MS, NAME } from './state.ts';
import { analyze, validate } from './ready.ts';
import { DEFAULT_CLAIMS, changedNote, claimBlock, conflictBrief, featureFiles, hotPaths, hotScores, hotTest, sharedPath, keepCheck, keepFeedback } from './merge.ts';
import { escalates, resolveRole, tierApplies } from './profiles.ts';
import { notesBlock, notesHash, readNotes } from './notes.ts';
import { IN_FLIGHT, type ClaudeResult, type Config, type Control, type Feature, type Finding, type HumanTask, type LogEvent, type Paths, type Role, type RoleConfig, type Verdict } from './types.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
export const HEADING = `## ${NAME} lessons`, OLD_HEADINGS = ['## Shipyard lessons'];
const now = (): string => new Date().toISOString();
const tail = (s: string, n = 4000): string => (s.length > n ? '…' + s.slice(-n) : s);

// ---- pure helpers (unit tested) ----

export function parseClaudeOutput(stdout: string): ClaudeResult {
  let j: Record<string, unknown> | null; // parse boundary: fields are checked where read
  try { j = JSON.parse(stdout); } catch { return { ok: false, text: '', cost: 0, error: `not JSON: ${tail(String(stdout), 500)}` }; }
  // Verified in claude 2.1.283: {type:"result", subtype, is_error, result, total_cost_usd, session_id, ...}.
  const cost = Number(j?.total_cost_usd ?? j?.cost_usd ?? 0) || 0;
  const text = j?.structured_output !== undefined ? JSON.stringify(j.structured_output) : String(j?.result ?? '');
  if (j?.subtype === 'error_max_budget_usd') return { ok: false, text, cost, error: 'budget exhausted (--max-budget-usd)' };
  const sessionId = typeof j?.session_id === 'string' && j.session_id ? { sessionId: j.session_id } : {};
  return j?.is_error ? { ok: false, text, cost, error: (text || j.subtype || 'claude reported an error') as string, ...sessionId } : { ok: true, text, cost, ...sessionId };
}

const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

export function parseVerdict(text: unknown): Verdict {
  const s = String(text ?? '');
  const fail = (error: string): Verdict => {
    const raw = s.trim(), marker = '\n… [truncated] …\n', limit = 2000, head = Math.floor((limit - marker.length) / 2);
    const diagnostic = raw.length > limit ? raw.slice(0, head) + marker + raw.slice(-(limit - marker.length - head)) : raw;
    return { pass: false, findings: [], cheating: [], blocking: [], notes: [], lesson: null, error, ...(diagnostic ? { diagnostic } : {}) };
  };
  // Once a candidate parses, its root is authoritative: never unwrap an object
  // from a parsed array or string just because that inner object would pass.
  const raw = [s, s.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]
    .map((x) => (x === undefined ? undefined : tryJson(x))).find((x) => x !== undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('evaluator output is not a JSON object');
  const v = raw as Record<string, unknown>;
  if (typeof v.pass !== 'boolean') return fail('verdict.pass must be a boolean');
  if (!Array.isArray(v.findings) || !v.findings.length) return fail('verdict.findings must be a nonempty array');
  const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
  const findings: Finding[] = [];
  for (const [i, rawFinding] of v.findings.entries()) {
    const at = `verdict.findings[${i}]`;
    if (!rawFinding || typeof rawFinding !== 'object' || Array.isArray(rawFinding)) return fail(`${at} must be an object`);
    const f = rawFinding as Record<string, unknown>;
    if (!nonempty(f.check)) return fail(`${at}.check must be a nonempty string`);
    if (typeof f.ok !== 'boolean') return fail(`${at}.ok must be a boolean`);
    if (!nonempty(f.evidence)) return fail(`${at}.evidence must be a nonempty string`);
    findings.push({ check: f.check, ok: f.ok, evidence: f.evidence });
  }
  const lists = { cheating: [] as string[], blocking: [] as string[], notes: [] as string[] };
  for (const field of ['cheating', 'blocking', 'notes'] as const) {
    const value = v[field];
    if (value === undefined) continue; // legacy omissions are supported; malformed present values are not
    if (!Array.isArray(value)) return fail(`verdict.${field} must be an array of nonempty strings`);
    for (const [i, item] of value.entries()) if (!nonempty(item)) return fail(`verdict.${field}[${i}] must be a nonempty string`);
    lists[field] = value.map((item: string) => item.trim());
  }
  const { cheating, blocking, notes } = lists;
  if (v.lesson !== undefined && v.lesson !== null && typeof v.lesson !== 'string') return fail('verdict.lesson must be a string or null');
  const lesson = typeof v.lesson === 'string' && v.lesson.trim() ? v.lesson.trim() : null;
  // A blocking problem fails the feature even when every acceptance check is ok: the evaluator used to find real defects,
  // write them into a note or the lesson, and pass anyway.
  const pass = v.pass && findings.length > 0 && findings.every((f) => f.ok === true) && cheating.length === 0 && blocking.length === 0;
  return { pass, findings, cheating, blocking, notes, lesson, ...(v.pass && !pass ? { error: 'pass:true contradicted by findings, cheating or blocking' } : {}) };
}

export function feedbackFromVerdict(v: Partial<Verdict>): string {
  const lines = v.error ? [`Evaluator: ${v.error}`] : [];
  for (const f of v.findings || []) if (f.ok !== true) lines.push(`FAILED ${f.check}: ${f.evidence}`);
  for (const c of v.cheating || []) lines.push(`CHEATING: ${c}`);
  for (const b of v.blocking || []) lines.push(`BLOCKING: ${b}`);
  if (v.diagnostic) lines.push(`\nUnvalidated evaluator output (diagnostic only):\n${v.diagnostic}`);
  return lines.join('\n') || 'Evaluator did not pass the feature.';
}

export function applyFailure(f: Feature, feedback: string, maxAttempts: number): void {
  delete f.sha; // counted failures rebuild; only unspent revalidation retains accepted build reuse
  delete f.pendingLesson;
  f.attempts = (f.attempts || 0) + 1;
  f.stop = { attempt: f.attempts, counted: true };
  f.lastFeedback = feedback;
  f.status = f.attempts >= maxAttempts ? 'stuck' : 'todo';
  f.updatedAt = now();
}

// Features left in flight by a dead foreman: skip those whose recorded child is still alive (see childAlive),
// mark merged the ones whose branch already landed on base, mark stuck those whose child outlived the wait
// (relaunching would put two processes in one worktree), send the rest back to todo.
type Check = (f: Feature) => boolean;
export function recoverInFlight(features: Feature[], { skip = new Set<string>(), alive = () => false, merged = () => false, overdue = () => false }:
  { skip?: Set<string>; alive?: Check; merged?: Check; overdue?: Check } = {}): Record<'todo' | 'merged' | 'alive' | 'stuck', string[]> {
  const r = { todo: [] as string[], merged: [] as string[], alive: [] as string[], stuck: [] as string[] };
  for (const f of features) {
    if (!IN_FLIGHT.includes(f.status) || skip.has(f.id)) continue;
    const k = alive(f) ? 'alive' : merged(f) ? 'merged' : overdue(f) ? 'stuck' : 'todo';
    r[k].push(f.id);
    if (k === 'stuck') { f.lastFeedback = `previous child still running (pid ${f.pid})`; f.stop = { attempt: (f.attempts || 0) + 1, counted: false }; }
    else if (k !== 'alive') delete f.stop;
    if (k !== 'alive') { f.status = k; f.updatedAt = now(); }
  }
  return r;
}

// Start time of pid in clock ticks since boot (/proc/<pid>/stat field 22), or null.
export function procStart(pid: number): string | null {
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] || null; } catch { return null; }
}

const HAS_PROC = existsSync('/proc/self/stat');
const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } }; // EPERM: not our user's, so not ours

// Is f's recorded child (pid + start time + the foreman that spawned it) still running? A bare pid can be
// reused, e.g. after a reboot. Without /proc the child counts as dead once its foreman is dead.
const int = (x: unknown): x is number => Number.isInteger(x);
export function childAlive(f: Pick<Feature, 'pid' | 'pidStart' | 'foremanPid'>, { proc = HAS_PROC } = {}): boolean {
  if (!int(f.pid) || f.pid <= 0 || !exists(f.pid)) return false;
  return proc ? !!f.pidStart && procStart(f.pid) === f.pidStart : int(f.foremanPid) && exists(f.foremanPid);
}

// Conflict group: features of one group never run at the same time. An explicit `group` wins; otherwise
// groupBy "idPrefix:<n>" uses the first n characters of the id. null (or any other groupBy) = no group.
export function groupOf(f: Pick<Feature, 'id' | 'group'>, groupBy: string | null | undefined): string | null {
  if (typeof f.group === 'string' && f.group) return f.group;
  const n = /^idPrefix:(\d+)$/.exec(groupBy ?? '')?.[1];
  return n ? f.id.slice(0, Number(n)) : null;
}

export function appendLesson(file: string, lesson: string, date = now().slice(0, 10)): boolean {
  const text = lesson.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const bullet = `- ${date}: ${text}`;
  const s = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = s.split('\n');
  const h = lines.findIndex((l) => [HEADING, ...OLD_HEADINGS].includes(l.trim()));
  if (h < 0) { writeFileSync(file, (s.trim() ? s.replace(/\n*$/, '\n\n') : '') + `${HEADING}\n\n${bullet}\n`); return true; }
  let end = lines.findIndex((l, i) => i > h && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  if (lines.slice(h + 1, end).some((l) => l.replace(/^- \d{4}-\d{2}-\d{2}: /, '') === text)) return false;
  let at = end;
  while (at > h + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, ...(at === h + 1 ? ['', bullet] : [bullet]));
  writeFileSync(file, lines.join('\n'));
  return true;
}

// Run files of one pipeline pass: "<attempt>" for the first pass of an attempt, "<attempt>.<k>" for later passes (a
// base refresh or an inline conflict resolution starts a new pass without spending an attempt), so earlier runs are
// never overwritten.
export function runTag(existing: string[], attempt: number): string {
  const has = (t: string) => existing.some((n) => n.startsWith(`${t}-`));
  if (!has(String(attempt))) return String(attempt);
  let k = 2;
  while (has(`${attempt}.${k}`)) k++;
  return `${attempt}.${k}`;
}

// What a prompt was made of, to compare agents across prompt versions: role, the model and effort actually passed, and short
// hashes of the lessons and briefs it included (the feature's own text is left out). Under a model profile it ends with
// ` profile=<name>`, plus ` risk=high effortBase=<effort>` when the builder got the profile's effortHigh for a risky feature
// (effortBase: what it would have had otherwise, so the observer can key prompt versions without it). A prompt that carries
// per-model notes (notes.ts) has ` notes=<sha8>` after the briefs, so agent stats split by notes version. Opus adds nothing, so
// its fingerprints are unchanged.
export function promptFingerprint(role: Role, r: { model?: string; effort?: string }, lessons: string | null, briefs: string, profile: string | null = null, effortBase: string | null = null, notes: string | null = null, tier: string | null = null): string {
  const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
  return `${role} model=${r.model || '-'} effort=${r.effort || '-'} lessons=${lessons == null ? '-' : h(lessons)} briefs=${briefs ? h(briefs) : '-'}` + (notes ? ` notes=${notesHash(notes)}` : '') +
    (profile ? ` profile=${profile}` : '') + (effortBase != null ? ` risk=high effortBase=${effortBase || '-'}` : '') + (tier ? ` tier=${tier}` : '');
}

// The sha a feature's last pass had built when the foreman was stopped (its last event is `interrupted`, after a
// `testing <sha>` of the same pass), or null. The next pass can skip the builder if the branch is still exactly there.
const ENDS_PASS = ['failed', 'stuck', 'refreshed', 'merged', 'ready', 'recovered', 'error', 'merge-failed', 'merge-hook-failed', 'unparked', 'gate-fix', 'commit-fix'];
export function builtWhenStopped(events: Pick<LogEvent, 'feature' | 'event' | 'detail'>[], id: string): string | null {
  let sha: string | null = null, last = '', before: { sha: string | null; last: string } | null = null;
  for (const e of events) {
    if (e.feature !== id || e.event === 'prompt' || e.event === 'lesson') continue;
    if (e.event === 'launch') before = { sha, last }; // the pass now starting is judged by the one before it
    last = e.event;
    if (e.event === 'launch' || ENDS_PASS.includes(e.event)) sha = null;
    else if (e.event === 'testing') sha = e.detail || null;
  }
  const end = last === 'launch' && before ? before : { sha, last };
  return end.last === 'interrupted' ? end.sha : null;
}

// A control state in words, for the log: "paused, lanes default" / "running, lanes 2, profile fable-sonnet". The profile is
// named when one is set, or always with `profile` true (a change back to opus says so).
export const describeControl = (c: Pick<Control, 'paused' | 'maxParallel' | 'profile'>, profile = false): string =>
  `${c.paused ? 'paused' : 'running'}, lanes ${c.maxParallel ?? 'default'}${c.profile || profile ? `, profile ${c.profile ?? 'opus'}` : ''}`;

// ---- prompts ----

const readIf = (file: string): string | null => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const briefs = (root: string, config: Config) => (config.briefFiles || []).map((f) => {
  const c = readIf(resolve(root, f));
  return c == null ? '' : `\n## Brief: ${f}\n\n${c}`;
}).join('\n');

const RUN_FILE: Record<Role, string> = { builder: 'build', evaluator: 'eval', resolver: 'resolve' };
const REFRESH_SEP = '\n\nThis failure is not fixed yet. Also: ';

// `notes`: the notes block for this model and role (notesBlock), appended last.
// The open, mockable human tasks a launch may build against a mock of (captured at launch), by id, title and scope,
// rendered the same way for the builder and the evaluator.
const mockList = (tasks: HumanTask[]): string => tasks.map((t) => `- ${t.id}: ${t.title}${(t.steps || []).length ? `\n${t.steps.map((x) => `  - ${x}`).join('\n')}` : ''}`).join('\n');

export function builderPrompt(root: string, config: Config, f: Feature, branch: string, mockTasks: HumanTask[], hotHeld: string[] = [], notes = ''): string {
  const lessons = readIf(resolve(root, config.lessonsFile));
  return [`You are the builder for feature "${f.id}": ${f.title}`,
    `You work in a git worktree on branch ${branch}, created from ${config.base}.`, '', f.description || '', '',
    'Acceptance checks (an independent evaluator verifies each one):', ...(f.acceptance || []).map((a) => `- ${a}`), '',
    mockTasks.length ? 'ON MOCK: these human tasks were open at launch, so build against a clearly isolated mock/fake of the external ' +
      'capability they provide, behind a boundary that is easy to swap for the real thing later. Wire everything else for production: the ' +
      'real routes, jobs and state transitions must reach that boundary, and production must fail explicitly while no real integration ' +
      `exists (never enable the fake in production):\n${mockList(mockTasks)}\n` : '',
    f.lastFeedback ? `Feedback on your previous attempt:\n${f.lastFeedback}\n` : '',
    hotHeld.length ? `Hot files: merge conflicts keep sending work back on these, and other features in flight are changing them:\n${
      hotHeld.map((h) => `- ${h}`).join('\n')}\nKeep your edits there small and additive (never reorder or reformat them); do not skip a change the feature needs.\n` : '',
    'Rules:', '- Commit your work on this branch (git add + git commit). Uncommitted changes are not evaluated.',
    '- Do not weaken or delete tests to make them pass.', '- Do not stub behavior the acceptance checks require.',
    '- You may run parallel subagents when that clearly helps. Give each one a disjoint set of files, so that no two ever',
    '  edit the same file. Only you commit on this branch: subagents never commit. Nobody, including you, merges, rebases,',
    '  pulls, resets or switches branches, except to complete a merge the foreman started or explicitly assigned in this worktree (resolve,',
    '  git add, git commit); the foreman alone merges into ' + config.base + '.',
    `- The test command \`${config.test}\` must pass.`,
    lessons ? `\n## Lessons (${config.lessonsFile})\n\n${lessons}` : '', briefs(root, config), notes].join('\n');
}

// The evaluator's view of the diff: a file list first, then whole files' diffs while they fit in `budget` characters
// (generated files and other `evaluatorDiffExclude` paths by name only), and an explicit list of what was left out.
// git lists files alphabetically, so a plain tail used to drop routes, migrations and new tests from large diffs.
export function evaluatorDiff(stat: string, files: { path: string; diff: string }[], excluded: string[], budget = 150000): string {
  const out: string[] = [], omitted: string[] = [];
  let used = 0;
  for (const f of files) {
    if (excluded.includes(f.path)) continue;
    if (used + f.diff.length > budget) { omitted.push(f.path); continue; }
    out.push(f.diff); used += f.diff.length;
  }
  return [`Files changed (git diff --stat):\n${stat}`,
    excluded.length ? `Generated or excluded files, not shown (read them in the worktree if a check depends on them):\n${excluded.map((p) => `- ${p}`).join('\n')}` : '',
    omitted.length ? `NOT SHOWN because the diff is too long (read them in the worktree with git diff before judging):\n${omitted.map((p) => `- ${p}`).join('\n')}` : '',
    out.join('\n')].filter(Boolean).join('\n\n');
}

const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export function evaluatorPrompt(root: string, config: Config, f: Feature, branch: string, diff: string, test: { code: number; tail: string }, tests: string[], resolved = '', notes = '', edits: string[] = [], mockTasks: HumanTask[] = []): string {
  const onMock = mockTasks.length > 0;
  return [`You are the evaluator for feature "${f.id}": ${f.title}`,
    'You did not write this code. Judge it skeptically. You may read files and run commands; do not modify or commit anything in this',
    'worktree (for a mutation check, use a scratch copy: git worktree add /tmp/<name> HEAD, and remove it afterwards).',
    '', f.description || '', '', 'Acceptance checks (verify each one):', ...(f.acceptance || []).map((a) => `- ${a}`), '',
    'Before you answer, you must:',
    tests.length ? `- Run each test file this feature adds or changes (targeted runs, not the whole suite):\n${tests.map((t) => `  - ${t}`).join('\n')}` : '- This feature changes no test files: say whether it needed tests.',
    '- For each check about money, permissions, tenant isolation or a state change: remove or flip the guard in a scratch copy, run its',
    '  test, and report which test fails. A test that still passes does not prove the check.',
    '- Check production wiring: every check must be reachable from a real route, job or composition, not only from a test, a fake or a',
    `  development-only setting${onMock ? ' (outside the on-mock tasks below)' : ''}. Every new state or status needs production code that moves it forward.`,
    '',
    'Look explicitly for pass-through implementations, tests that cannot fail, skipped or deleted tests, and hard-coded results. ' +
    'Report any under "cheating".',
    'Report under "blocking" every problem that must stop the merge even if no acceptance check names it: a defect in money, auth,',
    `tenant isolation or state handling; a path that only works with a fake or a development setting${onMock ? ' outside the on-mock tasks below' : ''}; a multi-line copy of an existing`,
    'production helper (name both file:line locations); changed behaviour of an existing export whose callers were not checked; edits to',
    'unrelated tests that weaken them. Duplicated setup or helpers inside test files go under "notes" (suggest the shared helper), never',
    'under "blocking". Minor remarks go under "notes" and do not block. "lesson" is only advice for future builders.', '',
    onMock ? 'ON MOCK: these human tasks were open when this feature launched, and the builder was told to build against an isolated ' +
      'mock of the external capability they provide:\n' + mockList(mockTasks) + '\nFor exactly that capability, a missing real adapter ' +
      'or a live provider report is a documented deferral, not a failed wiring check, cheating or blocking. Verify instead that the mock ' +
      'is isolated behind a swappable boundary, that the real internal routes, jobs, state transitions and their consumers reach it, ' +
      'and that production fails explicitly rather than using the fake. Simulated provider reports must still drive the real internal ' +
      'transitions. A mock outside these tasks, one that is not isolated, or a fake enabled in production still blocks, and so does ' +
      'any defect in money, auth, tenant isolation or state handling. Put what the real integration will need under "notes", keyed by task id.\n' : '',
    `Test command \`${config.test}\` exited ${test.code}. Output tail:\n\`\`\`\n${test.tail}\n\`\`\``, '',
    resolved ? `This branch resolved a merge conflict with ${config.base} in this pass. Also verify that the features merged into ` +
      `${config.base} it conflicted with still behave as their acceptance checks say (a failure there fails this feature):\n${resolved}\n` : '',
    `Diff ${config.base}...${branch}:\n\`\`\`diff\n${diff}\n\`\`\``, '',
    'Answer with ONLY a JSON object: {"pass": boolean, "findings": [{"check": string, "ok": boolean, "evidence": string}], ' +
    '"cheating": string[], "blocking": string[], "notes": string[], "lesson": string|null}. One finding per acceptance check, plus one ' +
    '"production wiring" finding; "pass" only if every finding is ok and cheating and blocking are empty. Evidence names files, ' +
    'lines, the tests you ran and what the mutation check showed.',
    edits.length ? `\nExisting tests this branch changes (tests that already exist on ${config.base}). Justify each change from the acceptance ` +
      `checks or the diff, or reject the feature and list it under "cheating":\n${edits.map((e) => `- ${e}`).join('\n')}\n` : '',
    briefs(root, config), notes].join('\n');
}

// Edits between two commits to test files that exist at `from` (TEST_FILE): deleted files, removed lines, and added
// skip/only/todo/fails markers. New test files are not edits. Evidence for the evaluator and the diagnosis, never a block by itself.
export function testEdits(cwd: string, from: string, to: string): string[] {
  const out: string[] = [];
  for (const row of git(['diff', '--name-status', '--no-renames', from, to], cwd).out.split('\n').filter(Boolean)) {
    const [st, path] = row.split('\t');
    if (!path || !TEST_FILE.test(path) || st === 'A') continue;
    if (st === 'D') { out.push(`${path}: deletes the file`); continue; }
    const lines = git(['diff', '--unified=0', '--no-ext-diff', '--no-textconv', from, to, '--', path], cwd).out.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    for (const m of new Set(added.flatMap((l) => l.match(/\.(?:skip|only|todo|fails)\b|\bx(?:it|describe|test)\b/g) ?? []))) out.push(`${path}: adds \`${m}\``);
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---') && l.slice(1).trim()).length;
    if (removed) out.push(`${path}: removes ${removed} line${removed === 1 ? '' : 's'}`);
  }
  return out.slice(0, 30);
}

export interface Diagnosis { fault: 'code' | 'test' | 'environment'; evidence: string; fix: string }
// The diagnoser's answer: a JSON object (bare, fenced or inside prose) with fault, evidence and fix.
export function parseDiagnosis(text: unknown): Diagnosis | { error: string } {
  const s = String(text ?? '');
  const raw = [s, s.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]
    .map((x) => (x === undefined ? undefined : tryJson(x))).find((x) => x !== undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the diagnosis is not a JSON object' };
  const v = raw as Record<string, unknown>;
  if (v.fault !== 'code' && v.fault !== 'test' && v.fault !== 'environment') return { error: 'diagnosis.fault must be "code", "test" or "environment"' };
  for (const k of ['evidence', 'fix'] as const) if (typeof v[k] !== 'string' || !v[k].trim()) return { error: `diagnosis.${k} must be a nonempty string` };
  return { fault: v.fault, evidence: (v.evidence as string).trim().slice(0, 2000), fix: (v.fix as string).trim().slice(0, 2000) };
}

// Sent to the builder's own resumed session after a test-gate failure (and, with a diagnosis, its brief).
export function gateFixPrompt(config: Config, failure: string, d: Diagnosis | null, diagnoserModel?: string): string {
  return [`The test gate \`${config.test}\` failed on the work you just committed. Fix it in this same worktree and branch.`, '',
    'The gate\'s output:', '```', failure, '```', '',
    'Fix the code, not the tests. Change an existing test only when the test itself is wrong, and then name that test and say why in the ' +
    'commit message: an independent evaluator sees every edit to an existing test. Never skip, delete or weaken a test to make the gate pass. ' +
    'Run the failing tests before you finish, commit all your work and leave the worktree clean. Only the foreman merges.',
    d ? `\nA read-only diagnosis of this failure${diagnoserModel ? ` (${diagnoserModel})` : ''} found a ${d.fault} fault.\nEvidence: ${d.evidence}\nFix: ${d.fix}\n` +
      (d.fault === 'test' ? 'Change only the test it names, as it describes, and keep everything that test checks that is still right.' : 'Change the code; leave the tests as they are.') : '',
  ].join('\n');
}

// Sent to the builder's own resumed session when it left its work uncommitted (config.commitFixes).
export function commitFixPrompt(config: Config, problem: string): string {
  return [`The foreman found that your work is not committed, so the test gate cannot run on it yet:`, '', problem, '',
    'Finish only the existing work: commit all of it (git add, git commit). If a merge the foreman started is pending, resolve it ' +
    'and commit the merge; never abort it and never start another merge or rebase. Do not start new work, do not weaken or delete ' +
    `tests and do not discard changes that belong to this feature. Leave the worktree clean. Only the foreman merges into ${config.base}.`,
  ].join('\n');
}

// The read-only diagnosis of a gate failure that a resumed fix did not cure (config.diagnoser, run in plan mode).
// The launch's on-mock scope for the fresh sessions that did not see the builder's prompt (resolver, diagnoser).
const onMockBrief = (tasks: HumanTask[], extra: string): string => tasks.length ? 'ON MOCK: these human tasks were open when ' +
  'this feature launched, so it builds against an isolated mock of the external capability they provide, behind a swappable ' +
  `boundary, with production failing explicitly while no real integration exists:\n${mockList(tasks)}\n${extra}\n` : '';

export function diagnosisPrompt(config: Config, f: Feature, branch: string, failure: string, diffStat: string, edits: string[], mockTasks: HumanTask[] = []): string {
  return [`You diagnose a failed test gate for feature "${f.id}": ${f.title}`,
    `Branch ${branch}, in this worktree; the builder already tried to fix this failure once. Do not edit, create or delete files and do not ` +
    'commit: read the code and run only read-only commands (for example a single failing test file).', '',
    'Acceptance checks:', ...(f.acceptance || []).map((a) => `- ${a}`), '',
    onMockBrief(mockTasks, 'A missing real integration of exactly that capability is a deliberate deferral, not a code fault to fix ' +
      'now; a broken mock boundary, internal wiring or state handling is a code fault, and a fake enabled in production is never the fix.'),
    `The gate \`${config.test}\` output:`, '```', failure, '```', '',
    `What the branch changes (git diff --stat against ${config.base}):`, '```', diffStat || '(nothing)', '```',
    edits.length ? `\nEdits to tests that already exist on ${config.base}:\n${edits.map((e) => `- ${e}`).join('\n')}` : '', '',
    'Decide where the fault is: "code" (the feature\'s code is wrong), "test" (a test is wrong about the intended behaviour; name it and say ' +
    'what it should check instead) or "environment" (the database, services, setup or a flaky test outside this change).',
    'Answer with ONLY a JSON object: {"fault": "code" | "test" | "environment", "evidence": string, "fix": string}. "evidence" quotes the ' +
    'failing output and the code that shows the cause; "fix" is the specific change the builder should make.',
  ].join('\n');
}

function resolverPrompt(root: string, config: Config, f: Feature, branch: string, brief: string, notes = '', mockTasks: HumanTask[] = []): string {
  return [`You are the merge resolver for feature "${f.id}": ${f.title}`,
    `You work in a git worktree on branch ${branch}. The foreman started merging ${config.base} into it and the merge conflicts; ` +
    'the merge is in progress. Your only job is to finish it so that both sides keep working.', '', brief, '',
    onMockBrief(mockTasks, 'Keep that mock behind its boundary while resolving: do not wire the fake into production and do not ' +
      'replace it with a real integration here.'),
    'Rules:', '- Resolve every conflict keeping both behaviours: this feature\'s and each feature listed above. Read the code around the ' +
    'hunks, not just the markers. Where both sides add entries to one list or object, keep every entry, each with its own closing lines.',
    '- Keep every line either side added. If one must go or change (a duplicate, a key or number both sides used), list each such ' +
    'line in the merge commit message as `dropped: <file>: <the line as it was>`, followed by why. A check compares the lines both ' +
    'sides added with your result and sends unlisted losses back.',
    '- Change nothing beyond what the merge needs. Do not weaken or delete tests.',
    '- Run the quickest checks that cover the files you touched (type-check, the tests next to them) and fix what the merge broke.',
    `- Finish with git add and git commit (the merge commit). Do not abort the merge, and do not start another merge, rebase, reset or ` +
    `switch branches. The full test command \`${config.test}\` and an independent evaluator run after you.`,
    briefs(root, config), notes].join('\n');
}

// `role` is the resolved RoleConfig the launch uses (resolveRole), or a role name for its plain config (as in opus mode).
// ---- codex (read-only roles: the evaluator and the diagnoser) ----

// `codex exec`: the role's model and reasoning effort; a workspace-write sandbox with network access (reviews run the tests,
// including local database suites) that cannot reach the repository's .git, so a review cannot commit; no approval prompts;
// JSONL events on stdout and the last message in `lastFile`; the prompt on stdin.
export function codexArgs(cfg: RoleConfig, lastFile: string): string[] {
  return ['exec', ...(cfg.model ? ['-m', cfg.model] : []), ...(cfg.effort ? ['-c', `model_reasoning_effort="${cfg.effort}"`] : []),
    '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"',
    '--json', '--color', 'never', '-o', lastFile, '-'];
}
// Codex JSONL events: the thread (session) id, the token usage and a turn or stream error. `item.completed` items of type
// "error" are warnings (Codex reports enabled preview features that way), never a failure.
export function parseCodexEvents(stdout: string): { threadId?: string; usage?: unknown; error?: string } {
  const out: { threadId?: string; usage?: unknown; error?: string } = {};
  for (const line of stdout.split('\n')) {
    const e = tryJson(line) as Record<string, unknown> | undefined;
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') out.threadId = e.thread_id;
    else if (e.type === 'turn.completed') out.usage = e.usage;
    else if (e.type === 'turn.failed' || e.type === 'error') {
      const err = e.error as { message?: unknown } | undefined;
      out.error = String(err?.message ?? e.message ?? JSON.stringify(e));
    }
  }
  return out;
}
// A Codex failure that will not clear by itself soon: the account is out of credits, rate limited or logged out.
export const CODEX_UNAVAILABLE = /usage limit|rate.?limit|quota|credits?|insufficient|\b429\b|unauthori[sz]ed|\b401\b|not logged in|log ?in|authenticat/i;

export function claudeArgs(config: Config, role: Role | RoleConfig, root: string): string[] {
  const r = typeof role === 'string' ? resolveRole(config, null, role) : role;
  const hook = [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${BIN}" hook` }] }];
  return ['-p', '--output-format', 'json', ...(r.model ? ['--model', r.model] : []), ...(r.effort ? ['--effort', r.effort] : []),
    ...(r.permissionMode ? ['--permission-mode', r.permissionMode] : []),
    ...((config.budgetUsdPerRun ?? 0) > 0 ? ['--max-budget-usd', String(config.budgetUsdPerRun)] : []),
    '--settings', JSON.stringify({ hooks: { PostToolUse: hook, Stop: hook },
      // "//" = absolute path; Edit(path) covers every file-writing tool. Deny rules hold even under bypassPermissions.
      permissions: { deny: [`Edit(/${root}/${paths(root).name}/**)`, `Edit(/${root}/.git/**)`, 'Bash(git update-ref *)', 'Bash(git push *)',
        'Bash(git branch -f *)', 'Bash(git config *)'] } })];
}

// ---- processes ----

export function git(args: string[], cwd: string): { code: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  // trimEnd: keep the leading status column of `status --porcelain`
  return { code: r.status ?? 1, out: (r.stdout || '').trimEnd(), err: (r.stderr || r.error?.message || '').trim() };
}

// Children run in their own process group, so a signal reaches everything they started.
const killGroup = (cp: ChildProcess, sig: NodeJS.Signals) => { try { process.kill(-cp.pid!, sig); } catch {} }; // no pid: -NaN throws

export interface ExecOptions { cwd: string; env: NodeJS.ProcessEnv; input?: string; children: Set<ChildProcess>; timeoutMin: number | null; onSpawn?: (pid: number) => unknown }
export interface ExecResult { code: number; out: string; err: string; timedOut: boolean }

export function exec(cmd: string, args: string[], { cwd, env, input = '', children, timeoutMin, onSpawn }: ExecOptions): Promise<ExecResult> {
  return new Promise((res) => {
    let out = '', err = '', done = false, timedOut = false;
    const cp = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    children.add(cp);
    if (cp.pid) onSpawn?.(cp.pid);
    const ms = (timeoutMin ?? 0) * 60000;
    const timer = ms > 0 ? setTimeout(() => {
      timedOut = true;
      killGroup(cp, 'SIGTERM');
      setTimeout(() => killGroup(cp, 'SIGKILL'), 5000).unref();
    }, ms) : undefined;
    const finish = (code: number) => { if (!done) { done = true; clearTimeout(timer); children.delete(cp); res({ code, out, err, timedOut }); } };
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', (e) => { err += e.message; finish(127); });
    cp.on('close', (code) => finish(code ?? 1));
    cp.stdin.on('error', () => {});
    cp.stdin.end(input);
  });
}

const readLogEvents = (file: string): LogEvent[] => { try { return readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l) as LogEvent] : []; } catch { return []; } }); } catch { return []; } };

// ---- the loop ----

export interface RunOptions { watch?: boolean; once?: boolean; maxFeatures?: number; out?: (s: string) => void }

export function run(root: string, opts: RunOptions = {}): Promise<number> {
  return withSupervisor(root, 'foreman', () => runOwned(root, opts));
}

async function runOwned(root: string, opts: RunOptions): Promise<number> {
  const P = paths(root);
  const out = opts.out || ((s: string) => console.log(s));
  const children = new Set<ChildProcess>(), inflight = new Map<string, Promise<unknown>>();
  let stopping = false, lastSetupHold = '', launched = 0, onceDone = false, chain: Promise<unknown> = Promise.resolve(), lastWaiting = '', lastManualWaiting = '', lastOrphans = '', lastParked = '';
  // control.json: the control applied last tick (null before the first read), the last valid one read, the invalid content
  // last reported, and the ready features last logged as held by its limit.
  let lastControl: Control | null = null, lastGood: Control | null = null, lastBad: string | null = null, lastHeld = '';
  const serial = <R>(fn: () => R | Promise<R>): Promise<R> => { const p = chain.then(() => withCheckoutLock(root, fn)); chain = p.catch(() => {}); return p; }; // shared main-checkout git ops
  const onSignal = () => {
    if (stopping) { out('forced exit'); for (const c of children) killGroup(c, 'SIGKILL'); process.exit(130); }
    stopping = true;
    out('stopping… (again to force)');
    for (const c of children) killGroup(c, 'SIGTERM');
  };
  try {
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const edit = (id: string, fn: (f: Feature) => void) => mutate(root, 'features', (d) => { const f = d.features.find((x) => x.id === id); if (f) fn(f); });
  const set = (id: string, patch: Partial<Feature>) => edit(id, (f) => Object.assign(f, patch, { updatedAt: now() }));

  // Config stays fixed for this foreman run; acceptance is captured separately at each locked launch.
  const config = loadConfig(root), configText = readIf(P.config);
  { const { features, tasks } = loadState(root); for (const e of validate(features, tasks)) { out(`warning: ${e}`); log(root, null, 'invalid', e); } }
  if (config.groupBy != null && !/^idPrefix:\d+$/.test(config.groupBy)) out(`warning: groupBy ${JSON.stringify(config.groupBy)} is not "idPrefix:<n>"; ignored`);
  const baseHead = () => git(['rev-parse', '--verify', '--quiet', `refs/heads/${config.base}`], root).out;
  let baseSha = baseHead(), halted: string | null = null, spent = 0; // spent: reported cost in this run only
  // Base moved outside fact-os: an alert if it now reaches a commit of a feature branch, or carries a blob of
  // one, that the foreman did not evaluate (its own merges are in baseSha; a ready or merged feature's recorded
  // evaluated sha is excluded, so merging a ready branch by hand is fine); otherwise it's the user's own work.
  const baseMoved = (): string | null => {
    const head = baseHead();
    if (head === baseSha) return null;
    const why = `${config.base} moved outside ${NAME} (expected ${baseSha.slice(0, 12)})`;
    if (!head || !baseSha) return why;
    const features = loadState(root).features;
    const names = new Set(features.map((f) => f.branch).filter(Boolean));
    for (const b of git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root).out.split('\n'))
      if (b.startsWith(config.branchPrefix)) names.add(b);
    const has = (r: string) => git(['rev-parse', '--verify', '--quiet', r], root).code === 0;
    const refs = [...names].map((b) => `refs/heads/${b}`).filter(has);
    const done = features.filter((f) => ['ready', 'merged'].includes(f.status) && f.sha && has(`${f.sha}^{commit}`)).map((f) => `^${f.sha}`);
    const lines = (...a: string[]) => git(['rev-list', ...a], root).out.split('\n').filter(Boolean);
    const fresh = new Set(lines(head, `^${baseSha}`));
    const hit = refs.length ? lines(...refs, `^${baseSha}`, ...done).find((c) => fresh.has(c)) : undefined;
    if (hit) return `${why}: it now contains ${hit.slice(0, 12)} from a feature branch`;
    const blobs = (...a: string[]) => { // blob ids among the objects rev-list --objects reaches, minus the empty blob
      const ids = lines('--objects', ...a).map((l) => l.split(' ')[0]);
      const r = spawnSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectname)'], { cwd: root, input: ids.join('\n'), encoding: 'utf8', maxBuffer: 256 << 20 });
      return (r.stdout || '').split('\n').filter((l) => l.startsWith('blob ') && l !== 'blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391').map((l) => l.slice(5));
    };
    const branchBlobs = refs.length ? new Set(blobs(...refs, `^${baseSha}`, ...done)) : new Set();
    const blob = branchBlobs.size ? blobs(head, `^${baseSha}`).find((b) => branchBlobs.has(b)) : undefined;
    if (blob) return `${why}: it now carries blob ${blob.slice(0, 12)} from a feature branch it did not merge`;
    const note = `${config.base} moved outside ${NAME} (${baseSha.slice(0, 12)} → ${head.slice(0, 12)}); no feature-branch commits, continuing`;
    log(root, null, 'base-moved', note);
    out(`notice: ${note}`);
    baseSha = head;
    return null;
  };
  const tampered = () => {
    if (halted) return true;
    halted = readIf(P.config) !== configText ? 'config.json changed on disk during the run' : baseMoved();
    if (halted) { log(root, null, 'alert', halted); out(`ALERT: ${halted}; launching nothing more`); }
    return !!halted;
  };
  const isMerged = (f: Feature) => { // merged with --no-ff: tip reachable from base but not on its first-parent line
    const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${f.branch || config.branchPrefix + f.id}`], root).out;
    return !!tip && git(['merge-base', '--is-ancestor', tip, config.base], root).code === 0 &&
      !git(['rev-list', '--first-parent', config.base], root).out.split('\n').includes(tip);
  };
  const waitingSince = new Map<string, number>(); // feature id → when this foreman first found its orphaned child alive
  const pendingBrief = new Map<string, { text: string; others: string }>(); // feature id → brief of its last conflicted refresh
  // File claims (config.claims): what a feature changes or is about to, and the log the hot files are scored from.
  const claimsCfg = config.claims ? { ...DEFAULT_CLAIMS, ...config.claims } : null, claimWait = new Map<string, string>();
  const filesOf = (f: Feature) => { const wt = resolve(root, config.worktreesDir, f.id); return featureFiles(root, f, config.base, f.branch || config.branchPrefix + f.id, existsSync(wt) ? wt : null); };
  let logCache = { size: -1, events: [] as LogEvent[] };
  const readEvents = (): LogEvent[] => {
    let size = 0; try { size = statSync(P.log).size; } catch {}
    if (size !== logCache.size) logCache = { size, events: (readIf(P.log) || '').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l) as LogEvent] : []; } catch { return []; } }) };
    return logCache.events;
  };
  const orphanAlive = (f: Feature) => {
    if (!childAlive(f)) return false;
    if (!waitingSince.has(f.id)) waitingSince.set(f.id, Date.now());
    if (!((config.timeoutMin ?? 0) > 0) || Date.now() - waitingSince.get(f.id)! < config.timeoutMin! * 60000) return true;
    log(root, f.id, 'recovered', `child pid ${f.pid} still running after timeoutMin (${config.timeoutMin} min); not killed`);
    return false;
  };
  const recover = async (): Promise<string[]> => !loadState(root).features.some((f) => IN_FLIGHT.includes(f.status) && !inflight.has(f.id)) ? [] : mutate(root, 'features', (d) => {
    const r = recoverInFlight(d.features, { skip: new Set(inflight.keys()), alive: orphanAlive, merged: isMerged, overdue: (f) => childAlive(f) });
    for (const id of r.todo) log(root, id, 'recovered', 'left in flight by a dead foreman; back to todo');
    for (const id of r.stuck) { const f = d.features.find((f) => f.id === id)!; log(root, id, 'stuck', f.lastFeedback, undefined, { stop: f.stop }); }
    for (const id of r.merged) log(root, id, 'recovered', `already merged into ${config.base}`);
    return r.alive;
  });

  const setupFailed = async (id: string, msg: string, afterBuild = false): Promise<void> => {
    const delays = config.setupRetryDelaysSec;
    await edit(id, (x) => {
      const n = (x.setupFailures || 0) + 1, stuck = n > delays.length, stop = { attempt: (x.attempts || 0) + 1, counted: false };
      Object.assign(x, { status: stuck ? 'stuck' : 'todo', setupFailures: n, stop, updatedAt: now(),
        setupRetryAt: stuck ? undefined : new Date(Date.now() + delays[n - 1]! * 1000).toISOString(), ...(stuck ? { lastFeedback: msg } : {}) });
      log(root, id, stuck ? 'stuck' : 'failed', `${msg}\n(setup failure ${n} of ${delays.length + 1}${afterBuild ? ', after the build' : ''}; ${stuck ? 'no more retries' : `retry after ${delays[n - 1]}s`}; no attempt spent)`, undefined, { stop });
      out(`${stuck ? 'stuck' : 'setup failed'} ${id}: ${msg.split('\n')[0]}${stuck ? '' : ` (retry after ${delays[n - 1]}s)`}`);
    });
    const opened = await updateSetupState(root, (st) => {
      const t = Date.now();
      st.failures = [...st.failures.filter((x) => t - Date.parse(x.ts) < SETUP_HOLD_WINDOW_MS), { feature: id, ts: new Date(t).toISOString() }];
      const recent = st.failures.slice(-SETUP_HOLD_AFTER), who = [...new Set(recent.map((x) => x.feature))];
      if (st.hold || recent.length < SETUP_HOLD_AFTER || who.length < 2) return null;
      st.hold = { since: new Date(t).toISOString(), reason: msg.split('\n').slice(0, 3).join(' ').slice(0, 300), features: who };
      return st.hold;
    });
    if (opened) {
      log(root, null, 'setup-hold', `${SETUP_HOLD_AFTER} setups failed in a row (${opened.features.join(', ')}); no new launches until \`${NAME} setup-resume\`: ${opened.reason}`);
      out(`ALERT: setup keeps failing (${opened.features.join(', ')}); launching nothing more until \`${NAME} setup-resume\``);
    }
  };
  const setupSucceeded = async (id: string): Promise<void> => {
    if (loadState(root).features.find((x) => x.id === id)?.setupFailures) await edit(id, (x) => { delete x.setupFailures; delete x.setupRetryAt; });
    if (readSetupState(root).failures.length) await updateSetupState(root, (st) => { if (!st.hold) st.failures = []; });
  };

  type Fail = (fb: string) => Promise<void>;
  const failer = (id: string): Fail => (fb) => edit(id, (x) => { applyFailure(x, fb, config.maxAttempts); log(root, id, x.status === 'stuck' ? 'stuck' : 'failed', fb, undefined, { stop: x.stop }); out(`${x.status === 'stuck' ? 'stuck' : 'retry'} ${id}: ${fb.split('\n')[0]}`); });

  // `profile`: the model profile applied when this pass launched. Every claude run of the pass (builder, resolver, evaluator)
  // uses it, never the live control.json value, so a switch mid-pass never changes a feature's models halfway.
  async function pipeline(f: Feature, config: Config, mockTasks: HumanTask[], hotHeld: string[], profile: string | null): Promise<unknown> {
    const id = f.id, attempt = (f.attempts || 0) + 1, branch = f.branch || config.branchPrefix + id;
    const wt = resolve(root, config.worktreesDir, id), runDir = join(P.runs, id);
    const env = { ...childEnv(), ...featureEnv({ FEATURE: id }) };
    const onSpawn = (pid: number) => edit(id, (x) => { Object.assign(x, { pid, pidStart: procStart(pid) ?? undefined, foremanPid: process.pid }); }).catch(() => {}); // lets a later foreman see the child is alive
    const fail = failer(id);
    const stopped = async () => { if (!stopping) return false; await set(id, { status: 'todo', pendingLesson: undefined }); log(root, id, 'interrupted'); return true; };
    const roleCfg = (role: Role) => resolveRole(config, profile, role, { feature: f });
    const claude = async (role: Role, prompt: string, file: string, opts: { extra?: string[]; cfg?: RoleConfig } = {}): Promise<ClaudeResult> => {
      const r = await exec(envVar('CLAUDE') || 'claude', [...claudeArgs(config, opts.cfg ?? roleCfg(role), root), ...(opts.extra ?? [])],
        { cwd: wt, env, input: prompt, children, timeoutMin: config.timeoutMin, onSpawn });
      writeFileSync(join(runDir, file), tryJson(r.out) ? r.out : JSON.stringify({ exitCode: r.code, stdout: r.out, stderr: tail(r.err) }));
      const p = parseClaudeOutput(r.out);
      spent += p.cost;
      if (p.cost) await edit(id, (x) => { x.costUsd = Math.round(((x.costUsd || 0) + p.cost) * 1e6) / 1e6; });
      if (r.timedOut) return { ...p, ok: false, error: `timed out after ${config.timeoutMin} min` };
      return r.code === 0 || !p.ok ? p : { ...p, ok: false, error: `exit ${r.code}: ${tail(r.err, 500)}` };
    };

    // A role run by its provider. Codex (evaluator, diagnoser): whatever the run leaves in the worktree is undone (`cleaned`);
    // a run that cannot answer (an error, a timeout, no last message) falls back to config.codex.fallback, a Claude run of the
    // same prompt; an exhausted, rate-limited or logged-out account also cools Codex down for config.codex.cooldownMin.
    const codexState = join(P.dir, 'codex.json');
    const codexCooling = (): string | null => {
      let c: { until?: string; reason?: string } | null = null;
      try { c = readJson(codexState, null) as { until?: string; reason?: string } | null; } catch { c = null; }
      const until = c?.until;
      return until && Date.parse(until) > Date.now() ? `cooling down until ${until} after: ${c?.reason ?? 'unavailable'}` : null;
    };
    const agent = async (role: Role, prompt: string, file: string, opts: { cfg?: RoleConfig } = {}): Promise<ClaudeResult & { cleaned?: boolean }> => {
      const cfg = opts.cfg ?? roleCfg(role);
      if (cfg.provider !== 'codex') return claude(role, prompt, file, { cfg });
      const fallback = async (why: string, cleaned = false) => {
        const fcfg: RoleConfig = { permissionMode: cfg.permissionMode, ...config.codex.fallback, provider: 'claude' };
        log(root, id, 'codex-fallback', `${why}; ${[fcfg.model, fcfg.effort].filter(Boolean).join(' ') || 'claude'} instead`);
        out(`codex ${id}: ${why.split('\n')[0]}; falling back to ${fcfg.model ?? 'claude'}`);
        recordPrompt(role, prompt, null, fcfg);
        return { ...await claude(role, prompt, file, { cfg: fcfg }), cleaned };
      };
      const cooling = codexCooling();
      if (cooling) return fallback(`codex is ${cooling}`);
      const head = git(['rev-parse', 'HEAD'], wt).out, started = Date.now(), last = join(runDir, `.${file}.codex-last`);
      const r = await exec(envVar('CODEX') || 'codex', codexArgs(cfg, last), { cwd: wt, env, input: prompt, children, timeoutMin: config.timeoutMin, onSpawn });
      const text = (readIf(last) ?? '').trim(), ev = parseCodexEvents(r.out);
      try { unlinkSync(last); } catch {}
      let cleaned = false;
      if (git(['rev-parse', 'HEAD'], wt).out !== head || git(['status', '--porcelain'], wt).out) {
        git(['reset', '-q', '--hard', head], wt); git(['clean', '-q', '-fd'], wt); cleaned = true;
        log(root, id, 'codex-cleaned', `the ${role === 'evaluator' ? 'review' : 'run'} left changes in the worktree; undone`);
      }
      if (r.code !== 0 || r.timedOut || !text || ev.error) {
        const why = r.timedOut ? `timed out after ${config.timeoutMin} min` : ev.error ?? (tail(r.err, 300).trim() || `exit ${r.code}, no answer`);
        writeFileSync(join(runDir, file.replace(/\.json$/, '.codex-failed.json')), JSON.stringify({ provider: 'codex', model: cfg.model, exitCode: r.code, stderr: tail(r.err), events: tail(r.out) }));
        if (!r.timedOut && CODEX_UNAVAILABLE.test(`${why}\n${r.err}`))
          writeJsonAtomic(codexState, { until: new Date(Date.now() + config.codex.cooldownMin * 60e3).toISOString(), reason: why.split('\n')[0] });
        return fallback(`codex unavailable: ${why.split('\n')[0]}`, cleaned);
      }
      writeFileSync(join(runDir, file), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0,
        duration_ms: Date.now() - started, session_id: ev.threadId, provider: 'codex', model: cfg.model, effort: cfg.effort, usage: ev.usage }));
      return { ok: true, text, cost: 0, ...(ev.threadId ? { sessionId: ev.threadId } : {}), cleaned };
    };

    mkdirSync(runDir, { recursive: true });
    let tag = runTag(readdirSync(runDir), attempt);
    // The per-model notes (notes.ts) for the model this role launches with; read once per prompt, so the text in the prompt
    // and the `notes=` in its fingerprint are the same version.
    const notesFor = (role: Role) => readNotes(root, roleCfg(role).model, role);
    const recordPrompt = (role: Role, prompt: string, notes: string | null, cfg?: RoleConfig) => {
      writeFileSync(join(runDir, `${tag}-${RUN_FILE[role]}.prompt.md`), prompt);
      log(root, id, 'prompt', promptFingerprint(role, cfg ?? roleCfg(role), role === 'builder' ? readIf(resolve(root, config.lessonsFile)) : null, briefs(root, config),
        profile, role === 'builder' && escalates(config, profile, f) ? resolveRole(config, profile, 'builder').effort ?? '' : null, notes, cfg ? null : tierApplies(config, profile, role, f)));
    };
    // A conflicted refresh resolved at once by a resolver run (config.resolver), in this same pass: the feature keeps its slot
    // and its claims, and goes on to test and evaluation. Returns the note for the evaluator, or null when the feature went
    // back to todo (the builder then finishes the merge with the same brief, and its resolution is checked) or the run stopped.
    const resolveNow = async (): Promise<string | null> => {
      const cur = loadState(root).features.find((x) => x.id === id)!, rec = cur.conflict!, pending = pendingBrief.get(id);
      tag = runTag(readdirSync(runDir), attempt);
      await set(id, { status: 'building' });
      log(root, id, 'resolving', rec.files.join(', '));
      out(`resolve ${id}: ${rec.files.join(', ')}`);
      const rn = notesFor('resolver');
      const rp = resolverPrompt(root, config, f, branch, pending?.text || cur.lastFeedback || '', notesBlock(roleCfg('resolver').model, 'resolver', rn), mockTasks);
      recordPrompt('resolver', rp, rn);
      const r = await claude('resolver', rp, `${tag}-resolve.json`);
      if (await stopped()) return null;
      const tip = git(['rev-parse', branch], wt).out, has = (c: string) => git(['merge-base', '--is-ancestor', c, tip], wt).code === 0;
      const why = !r.ok ? `the resolver failed: ${r.error}`
        : git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code === 0 ? 'the resolver left the merge uncommitted'
        : git(['status', '--porcelain'], wt).out ? 'the resolver left uncommitted changes'
        : !has(rec.ours) || !has(rec.theirs) ? `the resolver did not commit the merge of ${config.base}` : null;
      const k = why ? null : keepCheck(wt, rec.ours, rec.theirs, tip, rec.files);
      if (why || !k!.ok) {
        log(root, id, 'resolve-failed', why ?? `keep-check: ${k!.missing.length} lines lost`);
        out(`retry ${id}: ${why ?? 'the resolution lost lines one side added'}`);
        const fb = why ? `${why}; finish it yourself.` : keepFeedback(config.base, k!.missing);
        await set(id, { status: 'todo', lastFeedback: `${cur.lastFeedback || ''}\n\nA resolver run tried first: ${fb}` });
        return null;
      }
      log(root, id, 'resolved', `${tip}${k!.changed.length ? `; ${k!.changed.length} lines changed` : ''}`);
      await set(id, { conflict: undefined });
      return [pending?.others || `(conflicts were in ${rec.files.join(', ')})`, changedNote(k!.changed)].filter(Boolean).join('\n');
    };
    const wtErr = await serial(() => {
      if (existsSync(wt)) return null;
      const has = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).code === 0;
      const r = git(['worktree', 'add', ...(has ? [wt, branch] : ['-b', branch, wt, config.base])], root);
      return r.code ? r.err : null;
    });
    if (wtErr) return fail(`worktree: ${wtErr}`);
    // A branch with no commits of its own either picks up earlier work saved under restoreFrom (e.g. an archive tag left
    // by a cleanup), or (e.g. prepared before its deps merged) starts from the current base. Both need a clean worktree;
    // restoring moves only a branch with nothing of its own, and only to work base does not already have.
    if (git(['rev-list', '--count', `${config.base}..${branch}`], root).out === '0' && !git(['status', '--porcelain'], wt).out) {
      const saved = config.restoreFrom && git(['rev-parse', '--verify', '--quiet', `${config.restoreFrom.replaceAll('{id}', id)}^{commit}`], root).out;
      if (saved && git(['merge-base', '--is-ancestor', saved, config.base], root).code !== 0) {
        git(['reset', '--keep', '--quiet', saved], wt);
        log(root, id, 'restored', `${config.restoreFrom!.replaceAll('{id}', id)} (${saved.slice(0, 8)})`);
      } else git(['merge', '--ff-only', '--quiet', config.base], wt);
    }
    // Reused/restored branches can carry their own work from before a dependency
    // merged. Import that work before setup/build, independently of refreshBeforeTest.
    const required: string[] = [];
    let prepareDeferred = false;
    if (f.deps?.length) {
      const r = await serial(async () => {
        if (tampered()) { await set(id, { status: 'todo' }); return 'halted'; }
        const deps = loadState(root).features;
        for (const dep of f.deps) {
          const d = deps.find((x) => x.id === dep), sha = d?.sha || baseSha;
          if (d?.status !== 'merged' || git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], root).code !== 0 ||
            git(['merge-base', '--is-ancestor', sha, baseSha], root).code !== 0) {
            await fail(`worktree: dependency ${dep} is not a merged commit on ${config.base}`); return 'halted';
          }
          required.push(sha);
        }
        if (required.every((sha) => git(['merge-base', '--is-ancestor', sha, branch], wt).code === 0)) return 'current';
        const pending = git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt);
        if (pending.code === 0) {
          if (required.every((sha) => git(['merge-base', '--is-ancestor', sha, branch], wt).code === 0 ||
            git(['merge-base', '--is-ancestor', sha, pending.out], wt).code === 0)) return 'pending';
          await fail('worktree: the pending merge does not contain the declared dependencies'); return 'halted';
        }
        return refresh(f, branch, fail, true, false, true);
      });
      if (r !== 'current' && r !== 'clean' && r !== 'conflicted' && r !== 'pending') return;
      if (r === 'conflicted' || r === 'pending') {
        f.lastFeedback = loadState(root).features.find((x) => x.id === id)?.lastFeedback;
        if (r === 'pending') f.lastFeedback = (f.lastFeedback || '') + '\n\nThe foreman assigns you the pending dependency merge already in this worktree. Resolve it preserving both sides and commit the merge; do not abort it.';
        prepareDeferred = !!config.prepare;
        if (prepareDeferred) f.lastFeedback = (f.lastFeedback || '') + `\n\nSetup \`${config.prepare}\` is deferred until this merge is resolved. ` +
          'Resolve the conflicts first, run that setup command if needed for your build, and commit all resulting work. The foreman reruns setup before testing.';
      }
    }
    // Optional per-worktree setup (dependencies, task databases), run before every build; must be idempotent.
    // A failed setup is the environment's fault more often than the builder's: it spends no attempt. The feature is retried
    // after config.setupRetryDelaysSec, then goes stuck as an uncounted stop; repeated failures across features open a launch
    // hold (setupFailed). A good setup clears the feature's count and, while no hold is open, the cross-feature streak.
    const prepare = async (afterBuild = false): Promise<boolean> => {
      if (!config.prepare) return true;
      const pr = await exec('sh', ['-c', `exec 2>&1\n${config.prepare}`], { cwd: wt, env, children, timeoutMin: config.timeoutMin, onSpawn });
      if (await stopped()) return false;
      if (pr.code !== 0) { await setupFailed(id, `prepare \`${config.prepare}\` exited ${pr.code}:\n${tail(pr.out + pr.err)}`, afterBuild); return false; }
      await setupSucceeded(id);
      return true;
    };
    if (!prepareDeferred && !await prepare()) return;

    // Reuse a parked evaluation that needs current-base validation, or an interrupted build,
    // only when the clean worktree still points to exactly that commit.
    const reevaluate = config.refreshBeforeTest ? f.sha : undefined;
    const built = reevaluate || builtWhenStopped(readLogEvents(P.log), id);
    const skipBuild = !!built && git(['rev-parse', branch], wt).out === built && !git(['status', '--porcelain'], wt).out &&
      git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code !== 0;
    if (skipBuild) log(root, id, 'build-skipped', reevaluate
      ? `revalidating the previously evaluated ${built!.slice(0, 12)} against current base`
      : `the foreman stopped after it built ${built!.slice(0, 12)}`);
    // The builder's Claude session in this pass: a test-gate failure resumes it (config.gateFixes), so the fix keeps its context.
    // A skipped build has no session, so its gate failure stays an ordinary failure.
    let builderSession: string | null = null, builderNotes: string | null = null;
    if (!skipBuild) {
    const bn = notesFor('builder');
    const bp = builderPrompt(root, config, f, branch, mockTasks, hotHeld, notesBlock(roleCfg('builder').model, 'builder', bn));
    recordPrompt('builder', bp, bn);
    const b = await claude('builder', bp, `${tag}-build.json`);
    if (await stopped()) return;
    if (!b.ok) return fail(`builder failed: ${b.error}`);
    builderSession = b.sessionId ?? null; builderNotes = bn;
    }
    // Any commit beyond base counts as the builder's, including the merge commit that completes a base refresh.
    // `resumable`: work exists but is not committed (dirty files or a pending merge). No commits at all, or lost dependency
    // ancestry, cannot be repaired by asking the builder to commit.
    // Lost dependency ancestry is checked first: dirty files must not earn a resume a commit cannot repair. While a foreman merge
    // is pending, a dependency counts when the branch or that merge contains it (as before the build).
    const commitProblem = (): { text: string; resumable: boolean } | null => {
      const pending = git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt);
      const has = (sha: string, ref: string) => git(['merge-base', '--is-ancestor', sha, ref], wt).code === 0;
      if (required.some((sha) => !has(sha, branch) && !(pending.code === 0 && has(sha, pending.out))))
        return { text: 'commit your work: the branch no longer contains its declared merged dependencies', resumable: false };
      const status = git(['status', '--porcelain'], wt).out.split('\n').filter(Boolean);
      const listed = status.slice(0, 40).join('\n') + (status.length > 40 ? `\n… ${status.length - 40} more` : '');
      const merging = pending.code === 0 ? `the merge of ${config.base} the foreman started is not committed; ` : '';
      if (merging || status.length || git(['rev-list', '--count', `${config.base}..${branch}`], wt).out === '0')
        return { text: `commit your work: ${merging}${status.length ? `the worktree has uncommitted changes (git status --porcelain):\n${listed}` : merging ? 'git commit it' : `${branch} has no commits beyond ${config.base}`}`,
          resumable: !!merging || status.length > 0 };
      return null;
    };
    // Uncommitted work after a build or a fix: resume the builder's session to commit it, config.commitFixes times per pass
    // (shared by every check in the pass). False: the pass ended (a counted failure, or a stop that left the feature todo).
    let commitsLeft = config.commitFixes;
    const ensureCommitted = async (): Promise<boolean> => {
      for (;;) {
        const cp = commitProblem();
        if (!cp) return true;
        if (!cp.resumable || !builderSession || commitsLeft <= 0) { await fail(cp.text); return false; }
        commitsLeft--;
        if (await stopped()) return false;
        tag = runTag(readdirSync(runDir), attempt);
        log(root, id, 'commit-fix', 'resuming the builder to commit work it left uncommitted');
        out(`fix ${id}: work left uncommitted; resuming the builder to commit it`);
        const cfp = commitFixPrompt(config, cp.text);
        recordPrompt('builder', cfp, builderNotes);
        const r = await claude('builder', cfp, `${tag}-build.json`, { extra: ['--resume', builderSession] });
        if (await stopped()) return false;
        if (!r.ok) { await fail(`builder failed: ${r.error}`); return false; }
        if (r.sessionId) builderSession = r.sessionId;
      }
    };
    // The build's own work (and a pending foreman merge) is committed before deferred setup runs, which needs the finished
    // merge; whatever setup leaves behind must be committed too (the same per-pass allowance).
    if (!await ensureCommitted()) return;
    if (prepareDeferred && (!await prepare(true) || !await ensureCommitted())) return;
    // A builder that finished a conflicted refresh: its resolution must keep what both sides added (keep-lines check).
    const rc = skipBuild ? { note: '' } as { lost?: string; note: string } : await checkResolution(id, branch, wt);
    if (rc.lost) return fail(rc.lost);
    const inline = !!config.resolver;
    let resolved = rc.note; // after a resolution in this pass: what the evaluator must also check
    // Gate-failure recovery, bounded per pass: config.gateFixes resumed fixes, then (config.diagnoser) one read-only diagnosis
    // and one more fix with its brief. 'retry' re-runs the gate; 'fail' counts the failure; 'done' means stopped or already failed.
    let fixesLeft = config.gateFixes, diagnosed = false, diagNote = '';
    const resumeFix = async (failure: string, d: Diagnosis | null): Promise<'retry' | 'done'> => {
      if (await stopped()) return 'done';
      const before = git(['rev-parse', 'HEAD'], wt).out;
      tag = runTag(readdirSync(runDir), attempt);
      await set(id, { status: 'building' });
      log(root, id, 'gate-fix', d ? `resuming the builder with a ${d.fault} diagnosis` : 'resuming the builder after a test-gate failure');
      out(`fix ${id}: the test gate failed; resuming the builder${d ? ' with the diagnosis' : ''}`);
      const fp = gateFixPrompt(config, failure, d, config.diagnoser?.model);
      recordPrompt('builder', fp, builderNotes);
      const r = await claude('builder', fp, `${tag}-build.json`, { extra: ['--resume', builderSession!] });
      if (await stopped()) return 'done';
      if (!r.ok) { await fail(`builder failed: ${r.error}`); return 'done'; }
      if (r.sessionId) builderSession = r.sessionId;
      if (!await ensureCommitted()) return 'done';
      const edits = testEdits(wt, before, 'HEAD');
      if (edits.length) log(root, id, 'test-edits', `in the fix: ${edits.join('; ')}`);
      return 'retry';
    };
    const diagnose = async (failure: string): Promise<Diagnosis | null | 'stopped'> => {
      if (await stopped()) return 'stopped';
      const head = git(['rev-parse', 'HEAD'], wt).out, dcfg = { ...config.diagnoser!, permissionMode: 'plan' };
      const mb = git(['merge-base', config.base, head], wt).out;
      const prompt = diagnosisPrompt(config, f, branch, failure, git(['diff', '--stat=160', `${mb}..${head}`], wt).out, testEdits(wt, mb, head), mockTasks);
      writeFileSync(join(runDir, `${tag}-diagnose.prompt.md`), prompt);
      const r = await agent('builder', prompt, `${tag}-diagnose.json`, { cfg: dcfg });
      if (await stopped()) return 'stopped';
      if (r.cleaned || git(['rev-parse', 'HEAD'], wt).out !== head || git(['status', '--porcelain'], wt).out) { // read-only, or nothing
        git(['reset', '-q', '--hard', head], wt); git(['clean', '-q', '-fd'], wt);
        log(root, id, 'diagnosis', 'refused: the diagnosis changed the worktree; its edits were undone'); return null;
      }
      if (!r.ok) { log(root, id, 'diagnosis', `failed: ${r.error}`); return null; }
      const d = parseDiagnosis(r.text);
      if ('error' in d) { log(root, id, 'diagnosis', `invalid: ${d.error}`); return null; }
      log(root, id, 'diagnosis', `${d.fault}: ${d.evidence.split('\n')[0]}`);
      return d;
    };
    const afterGateFailure = async (failure: string): Promise<'retry' | 'fail' | 'done'> => {
      if (!builderSession) return 'fail';
      if (fixesLeft > 0) { fixesLeft--; return resumeFix(failure, null); }
      if (!config.diagnoser || diagnosed) return 'fail';
      diagnosed = true;
      const d = await diagnose(failure);
      if (d === 'stopped') return 'done';
      if (!d) return 'fail';
      diagNote = `\n\nDiagnosis (${config.diagnoser.model || 'diagnoser'}): ${d.fault}: ${d.evidence}\nSuggested fix: ${d.fix}`;
      return d.fault === 'environment' ? 'fail' : resumeFix(failure, d);
    };
    for (;;) { // fresh validation after an inline resolution or a clean base advance
      if (await stopped()) return;
      // refreshBeforeTest: test "current base + this feature", so features that pass alone can't break base together.
      if (config.refreshBeforeTest) {
        const r = await serial<'halted' | 'current' | 'clean' | 'conflicted' | void>(() => tampered() ? 'halted'
          : git(['merge-base', '--is-ancestor', baseSha, branch], wt).code === 0 ? 'current' : refresh(f, branch, fail, true, inline));
        if (r === 'halted') { log(root, id, 'refresh-skipped', `${halted}; back to todo`); return set(id, { status: 'todo' }); }
        if (r === 'conflicted') { const note = await resolveNow(); if (note == null) return; resolved = note; continue; }
        if (r !== 'current' && r !== 'clean') return; // conflicted (back to todo), stuck, or failed
      }
      const sha = git(['rev-parse', branch], wt).out; // what gets tested, evaluated and merged

      await set(id, { status: 'testing' });
      log(root, id, 'testing', sha);
      const t = await exec('sh', ['-c', `exec 2>&1\n${config.test}`], { cwd: wt, env, children, timeoutMin: config.timeoutMin, onSpawn });
      if (await stopped()) return;
      const test = { code: t.code, tail: tail(t.out + t.err) + (t.timedOut ? `\n(timed out after ${config.timeoutMin} min)` : '') };
      if (t.code !== 0) {
        const failure = `test command \`${config.test}\` exited ${t.code}:\n${test.tail}`, next = await afterGateFailure(failure);
        if (next === 'retry') continue;
        if (next === 'done') return;
        return fail(failure + diagNote);
      }

      await set(id, { status: 'evaluating' });
      log(root, id, 'evaluating', '');
      const range = `${config.base}...${sha}`, d = (...a: string[]) => git(['diff', '--text', '--no-ext-diff', '--no-textconv', ...a], wt).out;
      const names = d('--name-only', range).split('\n').filter(Boolean);
      const excluded = (config.evaluatorDiffExclude || []).length
        ? d('--name-only', range, '--', ...config.evaluatorDiffExclude.map((p) => `:(glob)${p}`)).split('\n').filter(Boolean) : [];
      const diff = evaluatorDiff(d('--stat=160', range), names.map((p) => ({ path: p, diff: excluded.includes(p) ? '' : d(range, '--', p) })), excluded);
      const en = notesFor('evaluator');
      const edits = testEdits(wt, git(['merge-base', config.base, sha], wt).out, sha);
      if (edits.length) log(root, id, 'test-edits', edits.join('; '));
      const ep = evaluatorPrompt(root, config, f, branch, diff, test, names.filter((p) => TEST_FILE.test(p) && existsSync(join(wt, p))), resolved, notesBlock(roleCfg('evaluator').model, 'evaluator', en), edits, mockTasks);
      recordPrompt('evaluator', ep, en);
      const e = await agent('evaluator', ep, `${tag}-eval.json`);
      if (await stopped()) return;
      const v = e.ok ? parseVerdict(e.text) : { pass: false, findings: [], cheating: [], blocking: [], notes: [], lesson: null, error: `evaluator failed: ${e.error}` };
      const lesson = v.lesson;
      if (!v.pass) {
        if (lesson) await serial(() => compound(id, lesson));
        return fail(feedbackFromVerdict(v));
      }
      if (config.merge === 'manual') {
        if (lesson) await serial(() => compound(id, lesson));
        log(root, id, 'ready', branch); out(`ready ${id} (${branch})`);
        return set(id, { status: 'ready', sha, lastFeedback: undefined });
      }
      const merged = await serial(async () => {
        // Keep the accepted commit and lesson across parking or a crash after Git
        // merges but before feature state is recorded. Never promote it while ready.
        await set(id, { sha, pendingLesson: lesson ? { sha, text: lesson } : undefined });
        return merge(f, branch, sha, fail, inline);
      });
      if (merged === 'revalidate') {
        tag = runTag(readdirSync(runDir), attempt); // keep the prior evaluation and prompt
        continue;
      }
      if (merged !== 'conflicted') return;
      const note = await resolveNow(); // bounced: resolve now, then test and evaluate again
      if (note == null) return;
      resolved = note;
    }
  }

  // The keep-lines check of a conflicted refresh the builder resolved and committed (conflictBrief or resolver on): `lost` is
  // feedback when lines one side added are gone; `note` tells the evaluator what else to check after a good resolution.
  async function checkResolution(id: string, branch: string, wt: string): Promise<{ lost?: string; note: string }> {
    const rec = loadState(root).features.find((x) => x.id === id)?.conflict;
    if (!rec || !(config.conflictBrief || config.resolver)) return { note: '' }; // both turned off: a pending record is ignored
    const tip = git(['rev-parse', branch], wt).out, has = (c: string) => git(['merge-base', '--is-ancestor', c, tip], wt).code === 0;
    if (!has(rec.ours) || !has(rec.theirs)) { log(root, id, 'keep-check', `skipped: ${branch} does not contain the conflicted merge`); await set(id, { conflict: undefined }); return { note: '' }; }
    const k = keepCheck(wt, rec.ours, rec.theirs, tip, rec.files);
    log(root, id, 'keep-check', k.ok ? `ok: ${rec.files.join(', ')}${k.changed.length ? `; ${k.changed.length} lines changed` : ''}` : `${k.missing.length} lines lost`);
    if (!k.ok) return { lost: keepFeedback(config.base, k.missing), note: '' };
    await set(id, { conflict: undefined });
    return { note: [pendingBrief.get(id)?.others || `(conflicts were in ${rec.files.join(', ')})`, changedNote(k.changed)].filter(Boolean).join('\n') };
  }

  function compound(id: string, lesson: string): void {
    const file = resolve(root, config.lessonsFile);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const before = hash(readIf(file) ?? '');
    const wasClean = git(['status', '--porcelain', '--', file], root).out === '';
    if (!appendLesson(file, lesson)) return;
    log(root, id, 'lesson', lesson, { file, before, after: hash(readFileSync(file, 'utf8')) });
    if (wasClean && git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out === config.base && !tampered()) {
      git(['add', '--', file], root);
      git(['commit', '-q', '-m', `${NAME}: lesson from ${id}`, '--', file], root);
      baseSha = baseHead();
    }
  }

  // Caller owns checkout serialization. Delivery is retryable after an ordinary
  // write failure; appendLesson deduplicates an append completed before state clear.
  async function compoundPending(id: string): Promise<void> {
    const f = loadState(root).features.find((x) => x.id === id), pending = f?.pendingLesson;
    if (!pending || f.status !== 'merged') return;
    if (pending.sha !== f.sha || git(['merge-base', '--is-ancestor', pending.sha, config.base], root).code !== 0) return;
    try {
      compound(id, pending.text);
      await edit(id, (x) => {
        if (x.pendingLesson?.sha === pending.sha && x.pendingLesson.text === pending.text) delete x.pendingLesson;
      });
    } catch (e) {
      // A lesson failure must not send already-merged code back to the builder.
      const why = (e as Error).message ?? String(e);
      log(root, id, 'lesson-error', why); out(`warning ${id}: lesson delivery failed: ${why}`);
    }
  }

  // After a conflicting merge into base (or before the test, with refreshBeforeTest), the foreman (never the builder)
  // merges the verified base sha into the feature's clean worktree; a conflict there is left for the next build to
  // resolve and commit. No attempt is spent. beforeTest: a clean merge returns 'clean' and the pipeline goes on.
  // With conflictBrief or a resolver, the conflict feedback carries the both-sides brief and the conflict is recorded for
  // the keep-lines check; inline (a resolver is set and a pipeline is waiting): the feature stays in flight, 'conflicted'.
  function refresh(f: Feature, branch: string, fail: Fail, beforeTest = false, inline = false, beforeBuild = false): Promise<void | 'conflicted'> | 'clean' {
    const id = f.id, wt = resolve(root, config.worktreesDir, id), base = config.base;
    const cur = loadState(root).features.find((x) => x.id === id), n = cur?.refreshes || 0;
    // A refresh must not drop the failure the builder still has to fix (e.g. a gate failure): keep it, minus any older
    // refresh note, and append this refresh's note after it.
    const prior = (cur?.lastFeedback || '').split(REFRESH_SEP)[0];
    const keepPrior = prior && !prior.startsWith('the foreman') ? `${prior}${REFRESH_SEP}` : '';
    const tooMany = () => {
      const fb = `merge conflict with ${base}: too many base refreshes (${n})`;
      return edit(id, (x) => {
        Object.assign(x, { status: 'stuck', lastFeedback: fb, pendingLesson: undefined, updatedAt: now(),
          stop: { attempt: (x.attempts || 0) + 1, counted: false } });
        log(root, id, 'stuck', fb, undefined, { stop: x.stop }); out(`stuck ${id}: ${fb}`);
      });
    };
    if (n >= config.maxRefreshes && !beforeTest) return tooMany();
    const st = git(['status', '--porcelain'], wt);
    if (st.code || st.out) return fail(`merge conflict with ${base}; the foreman could not merge ${base} into your branch because the worktree is not clean`);
    const both = config.conflictBrief || !!config.resolver, ours = git(['rev-parse', 'HEAD'], wt).out;
    const m = git([...(both ? ['-c', 'merge.conflictStyle=diff3'] : []), 'merge', '--no-edit', '-m', `${NAME}: merge ${base} into ${branch}`, baseSha], wt);
    const conflicted = m.code !== 0 && git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code === 0;
    if (m.code && !conflicted) return fail(`merge conflict with ${base}; merging ${base} into your branch did not start: ${m.err}`);
    if (beforeTest && !conflicted) { log(root, id, 'refreshed', `before ${beforeBuild ? 'build' : 'test'}, conflict-free`); out(`refresh ${id}: merged ${base} into ${branch} before ${beforeBuild ? 'build' : 'test'}`); return 'clean'; }
    if (n >= config.maxRefreshes) { git(['merge', '--abort'], wt); return tooMany(); }
    const list = git(['diff', '--name-only', '--diff-filter=U'], wt).out.split('\n').filter(Boolean), files = list.join(', ');
    let fb = conflicted
      ? `the foreman started merging ${base} into your branch and it conflicts in: ${files}. Resolve the conflicts preserving both sides' intent, run the tests, and commit the merge (git add + git commit). Do not abort it and do not start another merge or rebase.`
      : `the foreman merged ${base} into your branch (conflict-free); re-run the tests and fix anything the new base broke`;
    const rec = conflicted && both ? { ours, theirs: baseSha, files: list } : undefined;
    if (rec) {
      const b = conflictBrief({ wt, base, branch, ours, theirs: baseSha, files: list, feature: f, features: loadState(root).features });
      pendingBrief.set(id, b);
      fb += ` Keep every line either side added; list any line you must drop or change in a commit message as \`dropped: <file>: <line>\` (a check compares).\n\n${b.text}`;
    }
    log(root, id, 'refreshed', (beforeBuild ? 'before build, ' : '') + (conflicted ? `conflicts in: ${files}` : 'conflict-free'));
    out(`refresh ${id}: merged ${base} into ${branch}${conflicted ? `, conflicts in: ${files}` : ''}`);
    const patch = { refreshes: n + 1, lastFeedback: keepPrior + fb, parked: undefined, pendingLesson: undefined, ...(rec ? { conflict: rec } : {}) };
    if (beforeBuild) return set(id, patch).then(() => 'conflicted' as const); // this builder owns the started merge
    if (rec && inline) return set(id, patch).then(() => 'conflicted' as const); // the pipeline's resolver takes it from here
    return set(id, { status: 'todo', ...patch });
  }

  const checkoutProblem = (): string | null => { // why the main checkout can't take a merge now, or null
    const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out;
    if (head !== config.base) return `main checkout is on ${head || 'a detached HEAD'}, not ${config.base}`;
    return git(['status', '--porcelain', '--untracked-files=no', '--', '.', `:(exclude)${paths(root).name}`], root).out ? 'main checkout has uncommitted changes' : null;
  };
  const isParked = (f: Feature) => config.merge === 'auto' && f.status === 'ready' && f.parked && f.sha;
  // A feature parked by merge-skipped: merge its evaluated sha if the branch still points to it, else rebuild it.
  async function retryMerge(f: Feature): Promise<void | 'conflicted'> {
    const branch = f.branch || config.branchPrefix + f.id;
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).out === f.sha) {
      const result = await merge(f, branch, f.sha!, failer(f.id));
      if (result !== 'revalidate') return result;
      // Preserve the evaluated SHA through the queue so the next launch can skip the
      // builder. Launch clears it from disk; a real subsequent failure rebuilds normally.
      return set(f.id, { status: 'todo', parked: undefined, pendingLesson: undefined });
    }
    log(root, f.id, 'unparked', `${branch} moved since it was evaluated; back to todo`);
    out(`retry ${f.id}: ${branch} moved since it was evaluated`);
    return set(f.id, { status: 'todo', parked: undefined, sha: undefined, pendingLesson: undefined });
  }

  async function merge(f: Feature, branch: string, sha: string, fail: Fail, inline = false): Promise<void | 'conflicted' | 'revalidate'> {
    const id = f.id;
    if (tampered()) { log(root, id, 'merge-skipped', `${halted}; back to todo`); return set(id, { status: 'todo', parked: undefined, pendingLesson: undefined }); }
    const why = checkoutProblem();
    if (why) {
      log(root, id, 'merge-skipped', `${why}; left as ready`);
      out(`ready ${id}: ${why}`);
      return set(id, { status: 'ready', sha, parked: true });
    }
    if (git(['rev-parse', branch], root).out !== sha) return fail(`${branch} moved during evaluation; only the evaluated commit is merged`);
    // A parked merge may have landed before a crash (or a verified hand merge).
    // It needs status/lesson recovery, not another gate against its own merge commit.
    if (git(['merge-base', '--is-ancestor', sha, baseSha], root).code === 0) {
      log(root, id, 'merged', `${branch}; evaluated commit already on ${config.base}`);
      out(`merged ${id} (already on ${config.base})`);
      await set(id, { status: 'merged', sha, lastFeedback: undefined, parked: undefined });
      return compoundPending(id);
    }
    if (config.refreshBeforeTest && git(['merge-base', '--is-ancestor', baseSha, sha], root).code !== 0) {
      log(root, id, 'revalidate', `${config.base} advanced after evaluation; refresh, test and evaluate again`);
      out(`revalidate ${id}: ${config.base} advanced after evaluation`);
      await set(id, { pendingLesson: undefined });
      return 'revalidate';
    }
    const msg = `${NAME}: merge ${id}: ${f.title}`, hook = config.mergeHook;
    const m = git(['merge', '--no-ff', ...(hook ? ['--no-commit'] : ['--no-edit', '-m', msg]), sha], root);
    if (m.code !== 0) {
      if (git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], root).code !== 0) { // the merge never started
        log(root, id, 'merge-failed', `${m.err}; left as ready`);
        out(`ready ${id}: merge did not start: ${m.err.split('\n')[0]}`);
        return set(id, { status: 'ready', sha, parked: undefined });
      }
      git(['merge', '--abort'], root);
      return refresh(f, branch, fail, false, inline) as Promise<void | 'conflicted'>; // 'clean' only comes back with beforeTest
    }
    if (hook) { // e.g. assigns migration numbers; what it stages becomes part of the merge commit
      const h = await exec('sh', ['-c', `exec 2>&1\n${hook}`], { cwd: root, env: { ...childEnv(), ...featureEnv({ FEATURE: id, BRANCH: branch }) }, children, timeoutMin: config.timeoutMin });
      const c = h.code === 0 ? git(['commit', '-q', '-m', msg], root) : null;
      if (h.code !== 0 || c!.code !== 0) {
        if (git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], root).code === 0) git(['merge', '--abort'], root);
        const fb = h.code !== 0 ? `mergeHook \`${hook}\` exited ${h.code}:\n${tail(h.out + h.err, 2000)}` : `committing the merge after mergeHook failed: ${c!.err}`;
        log(root, id, 'merge-hook-failed', fb);
        out(`retry ${id}: merge hook failed; merge aborted`);
        return set(id, { status: 'todo', lastFeedback: fb, sha: undefined, parked: undefined, pendingLesson: undefined }); // no attempt spent
      }
    }
    baseSha = baseHead();
    if (config.postMerge) {
      const r = await exec('sh', ['-c', `exec 2>&1\n${config.postMerge}`], { cwd: root, env: { ...childEnv(), ...featureEnv({ FEATURE: id, BRANCH: branch }) }, children, timeoutMin: config.timeoutMin });
      log(root, id, 'post-merge', `exit ${r.code}: ${tail(r.out, 1000)}`);
      baseSha = baseHead();
    }
    log(root, id, 'merged', branch);
    out(`merged ${id}`);
    await set(id, { status: 'merged', sha, lastFeedback: undefined, parked: undefined });
    return compoundPending(id);
  }

    for (;;) {
      const seen = stamp(P); // before loadState() and readControl(), so a change made during this tick still wakes --watch
      const ctlSeen = stamp({ control: P.control });
      // control.json (a person's pause / lanes), re-read every tick. It only limits new launches: nothing in flight is
      // interrupted, and parked merges below still merge while paused.
      // A missing file means the defaults; an invalid one never lifts a pause: it keeps the last good control, or, with none
      // read yet (an invalid file at startup), holds all new work.
      const cr = readControlFile(root, config);
      let control: Control;
      if (cr.ok) { control = lastGood = cr.control; lastBad = null; }
      else {
        control = lastGood ?? { paused: true, maxParallel: null, profile: null };
        if (cr.text !== lastBad) {
          lastBad = cr.text;
          const detail = `${cr.error}; ${lastGood ? `keeping the last good control (${describeControl(lastGood)})` : 'no good control read yet: treated as paused'}`;
          log(root, null, 'control-invalid', detail);
          out(`warning: ${detail}`);
        }
      }
      const limit = effectiveLimit(control, config);
      const profileChanged = (control.profile ?? null) !== (lastControl?.profile ?? null);
      if (!lastControl ? control.paused || control.maxParallel !== null || profileChanged
        : control.paused !== lastControl.paused || control.maxParallel !== lastControl.maxParallel || profileChanged) {
        const detail = lastControl ? `${describeControl(lastControl, profileChanged)} → ${describeControl(control, profileChanged)}; launch limit ${effectiveLimit(lastControl, config)} → ${limit}${control.by ? ` (by ${control.by})` : ''}`
          : `at start: ${describeControl(control)}; launch limit ${limit}`;
        log(root, null, 'control', detail);
        out(`control: ${detail}`);
      }
      lastControl = control;
      const orphans = await recover();
      // In flight now: this foreman's own launches plus live children of a previous foreman (orphans), against either limit.
      const busyCount = () => inflight.size + orphans.length;
      const { features, tasks } = loadState(root);
      // Recovery and verified dashboard acknowledgment can mark merged without
      // returning through merge(). Deliver their accepted pending lessons too.
      const pending = config.merge === 'auto' ? features.filter((f) => f.status === 'merged' && f.pendingLesson) : [];
      if (pending.length && !stopping && !tampered())
        await serial(async () => { for (const f of pending) await compoundPending(f.id); });
      const parked = features.filter(isParked);
      if (parked.length && !stopping && !tampered() && !checkoutProblem()) { // then reload: dependents may be ready now
        for (const f of parked) await serial(() => retryMerge(f));
        continue;
      }
      const a = analyze(features, tasks, config.merge);
      const manualWaiting = config.merge === 'manual' ? features.filter((f) => f.status === 'todo' && !a.bad.has(f.id) &&
        (f.deps || []).some((d) => features.find((x) => x.id === d)?.status === 'ready')).map((f) => f.id) : [];
      if (!manualWaiting.length) lastManualWaiting = '';
      const overBudget = config.budgetUsdTotal != null && spent >= config.budgetUsdTotal; // null = unlimited
      let claimDeferred = false; // a ready feature the locked claim refused this tick (see the idle/exit decision)
      const setupHold = readSetupState(root).hold;
      if (setupHold && setupHold.since !== lastSetupHold) { lastSetupHold = setupHold.since; out(`setup hold since ${setupHold.since}: no new launches until \`${NAME} setup-resume\``); }
      if (!setupHold) lastSetupHold = '';
      // The earliest delayed setup retry among ready features: the foreman wakes for it instead of exiting or sleeping past it.
      let nextRetry: number | null = null;
      const capped = () => opts.maxFeatures != null && launched >= opts.maxFeatures;
      if (!stopping && !overBudget && !onceDone && !setupHold && !tampered()) {
        const running = features.filter((f) => IN_FLIGHT.includes(f.status) || inflight.has(f.id));
        const busy = new Set(running.map((f) => groupOf(f, config.groupBy)));
        let claims: { hot: (file: string) => boolean; paths: string[]; held: [string, string[]][] } | null = null; // this tick's, computed on first use
        const held: string[] = []; // ready, but the launch limit is reached
        for (const id of a.ready) {
          const retryAt = Date.parse(features.find((x) => x.id === id)!.setupRetryAt ?? '');
          if (retryAt > Date.now()) { if (limit > 0) nextRetry = Math.min(nextRetry ?? retryAt, retryAt); continue; }
          const g = groupOf(features.find((x) => x.id === id)!, config.groupBy);
          if (inflight.has(id) || (g != null && busy.has(g))) continue; // its group is in flight: try the next-best one
          // The limit counts this foreman's own launches in flight; a feature that went back to todo mid-pipeline is a new
          // launch, so it waits here too while the count is at or over a lowered limit.
          if (busyCount() >= limit) { held.push(id); continue; }
          if (capped()) break;
          // File claims: never run two features that change one hot file; only features in flight hold claims, so nothing
          // ever waits on a feature that is not running.
          let hotHeld: string[] = [];
          if (claimsCfg) {
            if (!claims) {
              const scores = hotScores(readEvents(), Date.now() - claimsCfg.days * 86400e3);
              claims = { hot: hotTest(scores, claimsCfg), paths: hotPaths(scores, claimsCfg), held: running.map((x) => [x.id, filesOf(x)]) };
            }
            const mine = filesOf(features.find((x) => x.id === id)!), c = claimBlock(mine, claims.held, claims.hot);
            if (c) {
              const why = `${c.file} is claimed by ${c.by}`;
              if (claimWait.get(id) !== why) { claimWait.set(id, why); log(root, id, 'claim-wait', why); out(`waiting ${id}: ${why}`); }
              continue;
            }
            claimWait.delete(id);
            hotHeld = claims.held.flatMap(([by, files]) => {
              // Enumerate only protected intersections inside a holder's declared
              // directories, so a hot descendant does not label all of src/ hot.
              const hints = claimsCfg.minScore === 0 ? files : files.flatMap((file) => claims!.paths
                .map((p) => sharedPath(file, p)).filter((p): p is string => p !== null && claims!.hot(p)));
              return [...new Set(hints)].sort().map((p) => `${p} (${by})`);
            });
          }
          // Claim and capture together: a pending edit may have completed since this tick's load.
          // Keep the pre-transition SHA for build reuse; clear disk acceptance until a fresh auto pass.
          // The human tasks this launch may mock are captured here too, by value, and kept for the whole pass: closing or
          // editing a task mid-pass neither removes nor widens the allowance. A blocker that turned unmockable defers the launch.
          let mockTasks: HumanTask[] = [];
          const f = await mutate(root, 'features', (d) => {
            const current = d.features.find((x) => x.id === id);
            if (!current || current.status !== 'todo') return null;
            if (readSetupState(root).hold || (current.setupRetryAt && Date.parse(current.setupRetryAt) > Date.now())) return null; // under the state lock
            const open = loadState(root).tasks.filter((t) => t.status === 'open' && (t.unblocks || []).includes(id));
            if (open.some((t) => !t.mockable)) return null;
            mockTasks = open.map((t) => ({ ...t, steps: [...(t.steps || [])], unblocks: [...(t.unblocks || [])] }));
            const snapshot = { ...current, acceptance: [...(current.acceptance || [])], onMock: mockTasks.length > 0 };
            Object.assign(current, { status: 'building', onMock: mockTasks.length > 0, sha: undefined, pendingLesson: undefined, setupRetryAt: undefined,
              stop: undefined, pid: undefined, pidStart: undefined, foremanPid: undefined, updatedAt: now() });
            return snapshot;
          });
          if (!f) { claimDeferred = true; continue; }
          busy.add(g);
          launched++;
          if (claims) claims.held.push([id, filesOf(f)]);
          log(root, id, 'launch', mockTasks.length ? 'onMock' : '');
          out(`building ${id}${mockTasks.length ? ' (on mock)' : ''}`);
          inflight.set(id, pipeline(f, config, mockTasks, hotHeld, control.profile ?? null)
            .catch((e: unknown) => { log(root, id, 'error', (e as Error | undefined)?.stack || String(e)); return set(id, { status: 'todo' }); })
            .finally(() => inflight.delete(id)));
        }
        // A person's pause or lanes (control.json) holding ready work: logged once per limit and held set, not every tick.
        const heldKey = held.length && (control.paused || control.maxParallel != null) ? `${limit}|${held.join()}` : '';
        if (heldKey && heldKey !== lastHeld) {
          const why = control.paused ? 'paused' : `lanes ${limit}`;
          log(root, null, 'paused-launch', `${why}; ${busyCount()} running; waiting: ${held.join(', ')}`);
          out(`not launching (${why}, ${busyCount()} running): ${held.join(', ')}`);
        }
        lastHeld = heldKey;
        if (opts.once) onceDone = true;
      }
      if (inflight.size) {
        // With a free slot, also wake on a state change (a retry or resume) so it launches without waiting for a feature to finish.
        // Stamp after this tick's own writes (recovery, launches), or they would wake it at once and spin. A control.json change
        // (more lanes, resume) always wakes it, free slot or not; the foreman never writes that file, so the stamp taken before
        // this tick's read cannot spin and a change made since is not missed.
        let woke = false;
        // A live orphan holding a lane frees it without touching any state file: poll for that.
        const free = !stopping && !onceDone && !capped() && !overBudget && busyCount() < limit;
        const files = { features: P.features, human: P.human }, done = () => stopping || woke;
        // A timer for the next delayed setup retry, cancelled when the race settles: a stray one would keep the process alive.
        const retryWake = nextRetry != null && free ? timer(Math.max(0, nextRetry - Date.now()) + 50) : null;
        await Promise.race([...inflight.values(), ...(free ? [waitForChange(files, stamp(files), done)] : []),
          ...(!stopping && !onceDone ? [waitForChange({ control: P.control }, ctlSeen, done)] : []),
          ...(orphans.length && !free ? [sleep(Number(envVar('POLL_MS')) || 5000)] : []),
          ...(retryWake ? [retryWake.done] : [])]).finally(() => retryWake?.cancel());
        woke = true;
        continue;
      }
      if (orphans.length && !stopping && !halted) {
        if (orphans.join() !== lastOrphans) out(`waiting for children of a previous foreman: ${(lastOrphans = orphans.join())}`);
        await sleep(Number(envVar('POLL_MS')) || 5000);
        continue;
      }
      if (overBudget) { log(root, null, 'budget', `spent $${spent.toFixed(2)} of $${config.budgetUsdTotal}`); out('budget reached'); }
      if (stopping || onceDone || capped() || overBudget || halted) break;
      if (opts.watch && parked.length) { // poll: cleaning the checkout touches no state file
        if (parked.map((f) => f.id).join() !== lastParked) out(`waiting for a clean ${config.base} checkout to merge: ${(lastParked = parked.map((f) => f.id).join())}`);
        await sleep(Number(envVar('POLL_MS')) || 5000);
        continue;
      }
      // --watch also waits while features are paused, or ready ones are held by a pause / lanes 0 (control.json), so resuming
      // (CLI or dashboard) launches them.
      // A launch the locked claim refused (its readiness changed since this tick's load, e.g. a human task turned unmockable):
      // decide idling or exiting on fresh state, not this tick's analysis.
      if (claimDeferred) continue;
      // A setup hold: --watch polls for `setup-resume` (it writes no watched file); a run without --watch stops here.
      if (setupHold) { if (!opts.watch) break; await sleep(Number(envVar('POLL_MS')) || 5000); continue; }
      // A delayed setup retry is pending work in either mode: wait for it (bounded by config.setupRetryDelaysSec).
      if (nextRetry != null) { await waitForChange(P, seen, () => stopping, nextRetry); continue; }
      if (!(opts.watch && (a.waiting.length || manualWaiting.length || features.some((f) => f.status === 'paused') || (limit === 0 && a.ready.length)))) break;
      if (manualWaiting.length && manualWaiting.join() !== lastManualWaiting) {
        lastManualWaiting = manualWaiting.join();
        log(root, null, 'waiting-merge', manualWaiting.join(', ')); out(`waiting for manual merges before: ${manualWaiting.join(', ')}`);
      }
      if (a.waiting.join() !== lastWaiting) {
        lastWaiting = a.waiting.join();
        log(root, null, 'waiting', a.waiting.join(', '));
        out(`waiting on human tasks for: ${a.waiting.join(', ')}`);
      }
      await waitForChange(P, seen, () => stopping);
    }
    const { features } = loadState(root);
    const counts: Record<string, number> = {};
    for (const f of features) counts[f.status] = (counts[f.status] || 0) + 1;
    out(`summary: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'no features'}`);
    return !halted && features.every((f) => f.status === 'merged' || f.status === 'ready') ? 0 : 2;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

type Watched = Partial<Pick<Paths, 'features' | 'human' | 'control'>>;
export const stamp = (P: Watched): string => [P.features, P.human, P.control].map((f) => { if (!f) return '-'; try { return statSync(f).mtimeMs; } catch { return 0; } }).join();

// Sleep until the given state files (features.json, human.json, control.json) differ from `since` (a stamp taken before the
// caller read them).
// A cancellable sleep: `cancel` clears the timer so it cannot keep the process alive.
export function timer(ms: number): { done: Promise<void>; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  return { done: new Promise((r) => { t = setTimeout(r, ms); }), cancel: () => clearTimeout(t) };
}

export async function waitForChange(P: Watched, since: string, isStopping: () => boolean, until: number | null = null): Promise<void> {
  const ms = Number(envVar('POLL_MS')) || 5000;
  while (!isStopping() && stamp(P) === since && (until == null || Date.now() < until)) await sleep(until == null ? ms : Math.max(1, Math.min(ms, until - Date.now())));
}
