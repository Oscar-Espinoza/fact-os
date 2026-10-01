// Foreman: plan → build → test → evaluate → merge → compound, over ready features, in parallel worktrees.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, load, loadConfig, mutate, log, pidAlive, sleep, envVar, featureEnv, NAME } from './state.ts';
import { analyze, validate } from './ready.ts';
import type { ClaudeResult, Config, Feature, Finding, HumanTask, Paths, Role, Status, Verdict } from './types.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const IN_FLIGHT: Status[] = ['building', 'testing', 'evaluating'];
const HEADING = `## ${NAME} lessons`, OLD_HEADINGS = ['## Shipyard lessons'];
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
  return j?.is_error ? { ok: false, text, cost, error: (text || j.subtype || 'claude reported an error') as string } : { ok: true, text, cost };
}

const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

export function parseVerdict(text: unknown): Verdict {
  const fail = (error: string): Verdict => ({ pass: false, findings: [], cheating: [], lesson: null, error });
  const s = String(text ?? '');
  const v = [s, s.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]
    .map((x) => (x === undefined ? undefined : tryJson(x))).find((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
  if (!v) return fail('evaluator output is not a JSON object');
  if (typeof v.pass !== 'boolean' || !Array.isArray(v.findings)) return fail('verdict needs boolean "pass" and array "findings"');
  const findings = v.findings.filter((f) => f && typeof f === 'object') as Finding[]; // fields unchecked: a missing ok is a failed finding
  const cheating = Array.isArray(v.cheating) ? v.cheating.map(String) : [];
  const lesson = typeof v.lesson === 'string' && v.lesson.trim() ? v.lesson.trim() : null;
  const pass = v.pass && findings.length > 0 && findings.every((f) => f.ok === true) && cheating.length === 0;
  return { pass, findings, cheating, lesson, ...(v.pass && !pass ? { error: 'pass:true contradicted by findings/cheating' } : {}) };
}

export function feedbackFromVerdict(v: Partial<Verdict>): string {
  const lines = v.error ? [`Evaluator: ${v.error}`] : [];
  for (const f of v.findings || []) if (f.ok !== true) lines.push(`FAILED ${f.check}: ${f.evidence}`);
  for (const c of v.cheating || []) lines.push(`CHEATING: ${c}`);
  return lines.join('\n') || 'Evaluator did not pass the feature.';
}

export function applyFailure(f: Feature, feedback: string, maxAttempts: number): void {
  f.attempts = (f.attempts || 0) + 1;
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
    if (k === 'stuck') f.lastFeedback = `previous child still running (pid ${f.pid})`;
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

// ---- prompts ----

const readIf = (file: string): string | null => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const briefs = (root: string, config: Config) => (config.briefFiles || []).map((f) => {
  const c = readIf(resolve(root, f));
  return c == null ? '' : `\n## Brief: ${f}\n\n${c}`;
}).join('\n');

const REFRESH_SEP = '\n\nThis failure is not fixed yet. Also: ';

function builderPrompt(root: string, config: Config, f: Feature, branch: string, mockTasks: HumanTask[]): string {
  const lessons = readIf(resolve(root, config.lessonsFile));
  return [`You are the builder for feature "${f.id}": ${f.title}`,
    `You work in a git worktree on branch ${branch}, created from ${config.base}.`, '', f.description || '', '',
    'Acceptance checks (an independent evaluator verifies each one):', ...(f.acceptance || []).map((a) => `- ${a}`), '',
    mockTasks.length ? 'ON MOCK: these human tasks are still open, so build against a clearly isolated mock/fake of what they ' +
      `provide, easy to swap for the real thing later:\n${mockTasks.map((t) => `- ${t.title}`).join('\n')}\n` : '',
    f.lastFeedback ? `Feedback on your previous attempt:\n${f.lastFeedback}\n` : '',
    'Rules:', '- Commit your work on this branch (git add + git commit). Uncommitted changes are not evaluated.',
    '- Do not weaken or delete tests to make them pass.', '- Do not stub behavior the acceptance checks require.',
    '- You may run parallel subagents when that clearly helps. Give each one a disjoint set of files, so that no two ever',
    '  edit the same file. Only you commit on this branch: subagents never commit. Nobody, including you, merges, rebases,',
    '  pulls, resets or switches branches, except to complete a merge the foreman started in this worktree (resolve,',
    '  git add, git commit); the foreman alone merges into ' + config.base + '.',
    `- The test command \`${config.test}\` must pass.`,
    lessons ? `\n## Lessons (${config.lessonsFile})\n\n${lessons}` : '', briefs(root, config)].join('\n');
}

function evaluatorPrompt(root: string, config: Config, f: Feature, branch: string, diff: string, test: { code: number; tail: string }): string {
  return [`You are the evaluator for feature "${f.id}": ${f.title}`,
    'You did not write this code. Judge it skeptically. You may read files and run commands, but do not modify or commit anything.',
    '', f.description || '', '', 'Acceptance checks (verify each one):', ...(f.acceptance || []).map((a) => `- ${a}`), '',
    'Look explicitly for pass-through implementations, tests that cannot fail, skipped or deleted tests, and hard-coded results. ' +
    'Report any under "cheating".', '',
    `Test command \`${config.test}\` exited ${test.code}. Output tail:\n\`\`\`\n${test.tail}\n\`\`\``, '',
    `Diff ${config.base}...${branch}:\n\`\`\`diff\n${tail(diff, 150000)}\n\`\`\``, '',
    'Answer with ONLY a JSON object: {"pass": boolean, "findings": [{"check": string, "ok": boolean, "evidence": string}], ' +
    '"cheating": string[], "lesson": string|null}. One finding per acceptance check; "pass" only if every check is ok and ' +
    'cheating is empty. "lesson": one short reusable lesson for future builders in this repo, or null.',
    briefs(root, config)].join('\n');
}

export function claudeArgs(config: Config, role: Role, root: string): string[] {
  const r = config[role] || {};
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

// ---- the loop ----

export interface RunOptions { watch?: boolean; once?: boolean; maxFeatures?: number; out?: (s: string) => void }

export async function run(root: string, opts: RunOptions = {}): Promise<number> {
  const P = paths(root);
  const out = opts.out || ((s: string) => console.log(s));
  const other = parseInt(readIf(P.foreman) ?? '', 10);
  if (other && other !== process.pid && pidAlive(other)) throw new Error(`another foreman is running (pid ${other})`);
  writeFileSync(P.foreman, String(process.pid));
  const children = new Set<ChildProcess>(), inflight = new Map<string, Promise<unknown>>();
  let stopping = false, launched = 0, onceDone = false, chain: Promise<unknown> = Promise.resolve(), lastWaiting = '', lastOrphans = '', lastParked = '';
  const serial = <R>(fn: () => R | Promise<R>): Promise<R> => { const p = chain.then(fn); chain = p.catch(() => {}); return p; }; // main-checkout git ops
  const onSignal = () => {
    if (stopping) { out('forced exit'); for (const c of children) killGroup(c, 'SIGKILL'); process.exit(130); }
    stopping = true;
    out('stopping… (again to force)');
    for (const c of children) killGroup(c, 'SIGTERM');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const edit = (id: string, fn: (f: Feature) => void) => mutate(root, 'features', (d) => { const f = d.features.find((x) => x.id === id); if (f) fn(f); });
  const set = (id: string, patch: Partial<Feature>) => edit(id, (f) => Object.assign(f, patch, { updatedAt: now() }));

  { const { features, tasks } = load(root); for (const e of validate(features, tasks)) { out(`warning: ${e}`); log(root, null, 'invalid', e); } }

  // Evaluate against what was on disk at launch; stop if config.json or base change behind fact-os's back.
  const config = loadConfig(root), configText = readIf(P.config);
  if (config.groupBy != null && !/^idPrefix:\d+$/.test(config.groupBy)) out(`warning: groupBy ${JSON.stringify(config.groupBy)} is not "idPrefix:<n>"; ignored`);
  const acceptance = new Map(load(root).features.map((f) => [f.id, f.acceptance]));
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
    const features = load(root).features;
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
  const orphanAlive = (f: Feature) => {
    if (!childAlive(f)) return false;
    if (!waitingSince.has(f.id)) waitingSince.set(f.id, Date.now());
    if (!((config.timeoutMin ?? 0) > 0) || Date.now() - waitingSince.get(f.id)! < config.timeoutMin! * 60000) return true;
    log(root, f.id, 'recovered', `child pid ${f.pid} still running after timeoutMin (${config.timeoutMin} min); not killed`);
    return false;
  };
  const recover = async (): Promise<string[]> => !load(root).features.some((f) => IN_FLIGHT.includes(f.status) && !inflight.has(f.id)) ? [] : mutate(root, 'features', (d) => {
    const r = recoverInFlight(d.features, { skip: new Set(inflight.keys()), alive: orphanAlive, merged: isMerged, overdue: (f) => childAlive(f) });
    for (const id of r.todo) log(root, id, 'recovered', 'left in flight by a dead foreman; back to todo');
    for (const id of r.stuck) log(root, id, 'stuck', d.features.find((f) => f.id === id)!.lastFeedback);
    for (const id of r.merged) log(root, id, 'recovered', `already merged into ${config.base}`);
    return r.alive;
  });

  type Fail = (fb: string) => Promise<void>;
  const failer = (id: string): Fail => (fb) => edit(id, (x) => { applyFailure(x, fb, config.maxAttempts); log(root, id, x.status === 'stuck' ? 'stuck' : 'failed', fb); out(`${x.status === 'stuck' ? 'stuck' : 'retry'} ${id}: ${fb.split('\n')[0]}`); });

  async function pipeline(f: Feature, config: Config, mockTasks: HumanTask[]): Promise<unknown> {
    const id = f.id, attempt = (f.attempts || 0) + 1, branch = f.branch || config.branchPrefix + id;
    const wt = resolve(root, config.worktreesDir, id), runDir = join(P.runs, id);
    const env = { ...process.env, ...featureEnv({ FEATURE: id }) };
    const onSpawn = (pid: number) => edit(id, (x) => { Object.assign(x, { pid, pidStart: procStart(pid) ?? undefined, foremanPid: process.pid }); }).catch(() => {}); // lets a later foreman see the child is alive
    const fail = failer(id);
    const stopped = async () => { if (!stopping) return false; await set(id, { status: 'todo' }); log(root, id, 'interrupted'); return true; };
    const claude = async (role: Role, prompt: string, file: string): Promise<ClaudeResult> => {
      const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs(config, role, root),
        { cwd: wt, env, input: prompt, children, timeoutMin: config.timeoutMin, onSpawn });
      writeFileSync(join(runDir, file), tryJson(r.out) ? r.out : JSON.stringify({ exitCode: r.code, stdout: r.out, stderr: tail(r.err) }));
      const p = parseClaudeOutput(r.out);
      spent += p.cost;
      if (p.cost) await edit(id, (x) => { x.costUsd = Math.round(((x.costUsd || 0) + p.cost) * 1e6) / 1e6; });
      if (r.timedOut) return { ...p, ok: false, error: `timed out after ${config.timeoutMin} min` };
      return r.code === 0 || !p.ok ? p : { ...p, ok: false, error: `exit ${r.code}: ${tail(r.err, 500)}` };
    };

    mkdirSync(runDir, { recursive: true });
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
    // Optional per-worktree setup (dependencies, task databases), run before every build; must be idempotent.
    if (config.prepare) {
      const pr = await exec('sh', ['-c', `exec 2>&1\n${config.prepare}`], { cwd: wt, env, children, timeoutMin: config.timeoutMin, onSpawn });
      if (await stopped()) return;
      if (pr.code !== 0) return fail(`prepare \`${config.prepare}\` exited ${pr.code}:\n${tail(pr.out + pr.err)}`);
    }

    const b = await claude('builder', builderPrompt(root, config, f, branch, mockTasks), `${attempt}-build.json`);
    if (await stopped()) return;
    if (!b.ok) return fail(`builder failed: ${b.error}`);
    // Any commit beyond base counts as the builder's, including the merge commit that completes a base refresh.
    const status = git(['status', '--porcelain'], wt).out.split('\n').filter(Boolean);
    const listed = status.slice(0, 40).join('\n') + (status.length > 40 ? `\n… ${status.length - 40} more` : '');
    const merging = git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code === 0 ? `the merge of ${config.base} the foreman started is not committed; ` : '';
    if (merging || status.length || git(['rev-list', '--count', `${config.base}..${branch}`], wt).out === '0')
      return fail(`commit your work: ${merging}${status.length ? `the worktree has uncommitted changes (git status --porcelain):\n${listed}` : merging ? 'git commit it' : `${branch} has no commits beyond ${config.base}`}`);
    // refreshBeforeTest: test "current base + this feature", so features that pass alone can't break base together.
    if (config.refreshBeforeTest) {
      const r = await serial<'halted' | 'current' | 'clean' | void>(() => tampered() ? 'halted'
        : git(['merge-base', '--is-ancestor', baseSha, branch], wt).code === 0 ? 'current' : refresh(id, branch, fail, true));
      if (r === 'halted') { log(root, id, 'refresh-skipped', `${halted}; back to todo`); return set(id, { status: 'todo' }); }
      if (r !== 'current' && r !== 'clean') return; // conflicted (back to todo), stuck, or failed
    }
    const sha = git(['rev-parse', branch], wt).out; // what gets tested, evaluated and merged

    await set(id, { status: 'testing' });
    log(root, id, 'testing', sha);
    const t = await exec('sh', ['-c', `exec 2>&1\n${config.test}`], { cwd: wt, env, children, timeoutMin: config.timeoutMin, onSpawn });
    if (await stopped()) return;
    const test = { code: t.code, tail: tail(t.out + t.err) + (t.timedOut ? `\n(timed out after ${config.timeoutMin} min)` : '') };
    if (t.code !== 0) return fail(`test command \`${config.test}\` exited ${t.code}:\n${test.tail}`);

    await set(id, { status: 'evaluating' });
    log(root, id, 'evaluating', '');
    const diff = git(['diff', '--text', '--no-ext-diff', '--no-textconv', `${config.base}...${sha}`], wt).out;
    const e = await claude('evaluator', evaluatorPrompt(root, config, f, branch, diff, test), `${attempt}-eval.json`);
    if (await stopped()) return;
    const v = e.ok ? parseVerdict(e.text) : { pass: false, findings: [], cheating: [], lesson: null, error: `evaluator failed: ${e.error}` };
    const lesson = v.lesson;
    if (lesson) await serial(() => compound(id, lesson));
    if (!v.pass) return fail(feedbackFromVerdict(v));
    if (config.merge === 'manual') { log(root, id, 'ready', branch); out(`ready ${id} (${branch})`); return set(id, { status: 'ready', sha, lastFeedback: undefined }); }
    return serial(() => merge(f, branch, sha, fail));
  }

  function compound(id: string, lesson: string): void {
    const file = resolve(root, config.lessonsFile);
    const wasClean = git(['status', '--porcelain', '--', file], root).out === '';
    if (!appendLesson(file, lesson)) return;
    log(root, id, 'lesson', lesson);
    if (wasClean && git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out === config.base && !tampered()) {
      git(['add', '--', file], root);
      git(['commit', '-q', '-m', `${NAME}: lesson from ${id}`, '--', file], root);
      baseSha = baseHead();
    }
  }

  // After a conflicting merge into base (or before the test, with refreshBeforeTest), the foreman (never the builder)
  // merges the verified base sha into the feature's clean worktree; a conflict there is left for the next build to
  // resolve and commit. No attempt is spent. beforeTest: a clean merge returns 'clean' and the pipeline goes on.
  function refresh(id: string, branch: string, fail: Fail, beforeTest = false): Promise<void> | 'clean' {
    const wt = resolve(root, config.worktreesDir, id), base = config.base;
    const cur = load(root).features.find((x) => x.id === id), n = cur?.refreshes || 0;
    // A refresh must not drop the failure the builder still has to fix (e.g. a gate failure): keep it, minus any older
    // refresh note, and append this refresh's note after it.
    const prior = (cur?.lastFeedback || '').split(REFRESH_SEP)[0];
    const keepPrior = prior && !prior.startsWith('the foreman') ? `${prior}${REFRESH_SEP}` : '';
    const tooMany = () => {
      const fb = `merge conflict with ${base}: too many base refreshes (${n})`;
      log(root, id, 'stuck', fb); out(`stuck ${id}: ${fb}`);
      return set(id, { status: 'stuck', lastFeedback: fb });
    };
    if (n >= config.maxRefreshes && !beforeTest) return tooMany();
    const st = git(['status', '--porcelain'], wt);
    if (st.code || st.out) return fail(`merge conflict with ${base}; the foreman could not merge ${base} into your branch because the worktree is not clean`);
    const m = git(['merge', '--no-edit', '-m', `${NAME}: merge ${base} into ${branch}`, baseSha], wt);
    const conflicted = m.code !== 0 && git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code === 0;
    if (m.code && !conflicted) return fail(`merge conflict with ${base}; merging ${base} into your branch did not start: ${m.err}`);
    if (beforeTest && !conflicted) { log(root, id, 'refreshed', 'before test, conflict-free'); out(`refresh ${id}: merged ${base} into ${branch} before test`); return 'clean'; }
    if (n >= config.maxRefreshes) { git(['merge', '--abort'], wt); return tooMany(); }
    const files = git(['diff', '--name-only', '--diff-filter=U'], wt).out.split('\n').filter(Boolean).join(', ');
    const fb = conflicted
      ? `the foreman started merging ${base} into your branch and it conflicts in: ${files}. Resolve the conflicts preserving both sides' intent, run the tests, and commit the merge (git add + git commit). Do not abort it and do not start another merge or rebase.`
      : `the foreman merged ${base} into your branch (conflict-free); re-run the tests and fix anything the new base broke`;
    log(root, id, 'refreshed', conflicted ? `conflicts in: ${files}` : 'conflict-free');
    out(`refresh ${id}: merged ${base} into ${branch}${conflicted ? `, conflicts in: ${files}` : ''}`);
    return set(id, { status: 'todo', refreshes: n + 1, lastFeedback: keepPrior + fb, parked: undefined });
  }

  const checkoutProblem = (): string | null => { // why the main checkout can't take a merge now, or null
    const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out;
    if (head !== config.base) return `main checkout is on ${head || 'a detached HEAD'}, not ${config.base}`;
    return git(['status', '--porcelain', '--untracked-files=no', '--', '.', `:(exclude)${paths(root).name}`], root).out ? 'main checkout has uncommitted changes' : null;
  };
  const isParked = (f: Feature) => config.merge === 'auto' && f.status === 'ready' && f.parked && f.sha;
  // A feature parked by merge-skipped: merge its evaluated sha if the branch still points to it, else rebuild it.
  function retryMerge(f: Feature): Promise<void> {
    const branch = f.branch || config.branchPrefix + f.id;
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).out === f.sha) return merge(f, branch, f.sha, failer(f.id));
    log(root, f.id, 'unparked', `${branch} moved since it was evaluated; back to todo`);
    out(`retry ${f.id}: ${branch} moved since it was evaluated`);
    return set(f.id, { status: 'todo', parked: undefined, sha: undefined });
  }

  async function merge(f: Feature, branch: string, sha: string, fail: Fail): Promise<void> {
    const id = f.id;
    if (tampered()) { log(root, id, 'merge-skipped', `${halted}; back to todo`); return set(id, { status: 'todo', parked: undefined }); }
    const why = checkoutProblem();
    if (why) {
      log(root, id, 'merge-skipped', `${why}; left as ready`);
      out(`ready ${id}: ${why}`);
      return set(id, { status: 'ready', sha, parked: true });
    }
    if (git(['rev-parse', branch], root).out !== sha) return fail(`${branch} moved during evaluation; only the evaluated commit is merged`);
    const msg = `${NAME}: merge ${id}: ${f.title}`, hook = config.mergeHook;
    const m = git(['merge', '--no-ff', ...(hook ? ['--no-commit'] : ['--no-edit', '-m', msg]), sha], root);
    if (m.code !== 0) {
      if (git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], root).code !== 0) { // the merge never started
        log(root, id, 'merge-failed', `${m.err}; left as ready`);
        out(`ready ${id}: merge did not start: ${m.err.split('\n')[0]}`);
        return set(id, { status: 'ready', sha, parked: undefined });
      }
      git(['merge', '--abort'], root);
      return refresh(id, branch, fail) as Promise<void>; // 'clean' only comes back with beforeTest
    }
    if (hook) { // e.g. assigns migration numbers; what it stages becomes part of the merge commit
      const h = await exec('sh', ['-c', `exec 2>&1\n${hook}`], { cwd: root, env: { ...process.env, ...featureEnv({ FEATURE: id, BRANCH: branch }) }, children, timeoutMin: config.timeoutMin });
      const c = h.code === 0 ? git(['commit', '-q', '-m', msg], root) : null;
      if (h.code !== 0 || c!.code !== 0) {
        if (git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], root).code === 0) git(['merge', '--abort'], root);
        const fb = h.code !== 0 ? `mergeHook \`${hook}\` exited ${h.code}:\n${tail(h.out + h.err, 2000)}` : `committing the merge after mergeHook failed: ${c!.err}`;
        log(root, id, 'merge-hook-failed', fb);
        out(`retry ${id}: merge hook failed; merge aborted`);
        return set(id, { status: 'todo', lastFeedback: fb, sha: undefined, parked: undefined }); // no attempt spent
      }
    }
    baseSha = baseHead();
    if (config.postMerge) {
      const r = await exec('sh', ['-c', `exec 2>&1\n${config.postMerge}`], { cwd: root, env: { ...process.env, ...featureEnv({ FEATURE: id, BRANCH: branch }) }, children, timeoutMin: config.timeoutMin });
      log(root, id, 'post-merge', `exit ${r.code}: ${tail(r.out, 1000)}`);
      baseSha = baseHead();
    }
    log(root, id, 'merged', branch);
    out(`merged ${id}`);
    return set(id, { status: 'merged', sha, lastFeedback: undefined, parked: undefined });
  }

  try {
    for (;;) {
      const seen = stamp(P); // before load(), so a change made during this tick still wakes --watch
      const orphans = await recover();
      const { features, tasks } = load(root);
      const parked = features.filter(isParked);
      if (parked.length && !stopping && !tampered() && !checkoutProblem()) { // then reload: dependents may be ready now
        for (const f of parked) await serial(() => retryMerge(f));
        continue;
      }
      const a = analyze(features, tasks, config.merge);
      const overBudget = config.budgetUsdTotal != null && spent >= config.budgetUsdTotal; // null = unlimited
      const capped = () => opts.maxFeatures != null && launched >= opts.maxFeatures;
      if (!stopping && !overBudget && !onceDone && !tampered()) {
        const busy = new Set(features.filter((f) => IN_FLIGHT.includes(f.status) || inflight.has(f.id)).map((f) => groupOf(f, config.groupBy)));
        for (const id of a.ready) {
          if (inflight.size >= Math.max(1, config.maxParallel) || capped()) break;
          const g = groupOf(features.find((x) => x.id === id)!, config.groupBy);
          if (inflight.has(id) || (g != null && busy.has(g))) continue; // its group is in flight: try the next-best one
          busy.add(g);
          launched++;
          const mockTasks = tasks.filter((t) => t.status === 'open' && t.mockable && (t.unblocks || []).includes(id));
          await set(id, { status: 'building', onMock: a.mock.has(id), sha: undefined, pid: undefined, pidStart: undefined, foremanPid: undefined });
          log(root, id, 'launch', a.mock.has(id) ? 'onMock' : '');
          out(`building ${id}${a.mock.has(id) ? ' (on mock)' : ''}`);
          if (!acceptance.has(id)) acceptance.set(id, features.find((x) => x.id === id)!.acceptance);
          const f = { ...features.find((x) => x.id === id)!, acceptance: acceptance.get(id)! };
          inflight.set(id, pipeline(f, config, mockTasks)
            .catch((e: unknown) => { log(root, id, 'error', (e as Error | undefined)?.stack || String(e)); return set(id, { status: 'todo' }); })
            .finally(() => inflight.delete(id)));
        }
        if (opts.once) onceDone = true;
      }
      if (inflight.size) {
        // With a free slot, also wake on a state change (a retry or resume) so it launches without waiting for a feature to finish.
        // Stamp after this tick's own writes (recovery, launches), or they would wake it at once and spin.
        let woke = false;
        const free = !stopping && !onceDone && !capped() && !overBudget && inflight.size < Math.max(1, config.maxParallel);
        await Promise.race([...inflight.values(), ...(free ? [waitForChange(P, stamp(P), () => stopping || woke)] : [])]);
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
      // --watch also waits while features are paused, so resuming one (CLI or dashboard) launches it.
      if (!(opts.watch && (a.waiting.length || features.some((f) => f.status === 'paused')))) break;
      if (a.waiting.join() !== lastWaiting) {
        lastWaiting = a.waiting.join();
        log(root, null, 'waiting', a.waiting.join(', '));
        out(`waiting on human tasks for: ${a.waiting.join(', ')}`);
      }
      await waitForChange(P, seen, () => stopping);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (parseInt(readIf(P.foreman) ?? '', 10) === process.pid) unlinkSync(P.foreman);
  }
  const { features } = load(root);
  const counts: Record<string, number> = {};
  for (const f of features) counts[f.status] = (counts[f.status] || 0) + 1;
  out(`summary: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'no features'}`);
  return !halted && features.every((f) => f.status === 'merged' || f.status === 'ready') ? 0 : 2;
}

export const stamp = (P: Pick<Paths, 'features' | 'human'>): string => [P.features, P.human].map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join();

// Sleep until features.json/human.json differ from `since` (a stamp taken before the caller read them).
export async function waitForChange(P: Pick<Paths, 'features' | 'human'>, since: string, isStopping: () => boolean): Promise<void> {
  const ms = Number(envVar('POLL_MS')) || 5000;
  while (!isStopping() && stamp(P) === since) await sleep(ms);
}
