// Foreman: plan → build → test → evaluate → merge → compound, over ready features, in parallel worktrees.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, load, loadConfig, mutate, log, pidAlive, sleep } from './state.js';
import { analyze, validate } from './ready.js';

const BIN = fileURLToPath(new URL('../bin/shipyard', import.meta.url));
const IN_FLIGHT = ['building', 'testing', 'evaluating'];
const HEADING = '## Shipyard lessons';
const MAX_REFRESHES = 5; // times the foreman may merge base into one feature's branch after a merge conflict
const now = () => new Date().toISOString();
const tail = (s, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

// ---- pure helpers (unit tested) ----

export function parseClaudeOutput(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return { ok: false, text: '', cost: 0, error: `not JSON: ${tail(String(stdout), 500)}` }; }
  // Verified in claude 2.1.283: {type:"result", subtype, is_error, result, total_cost_usd, session_id, ...}.
  const cost = Number(j?.total_cost_usd ?? j?.cost_usd ?? 0) || 0;
  const text = j?.structured_output !== undefined ? JSON.stringify(j.structured_output) : String(j?.result ?? '');
  if (j?.subtype === 'error_max_budget_usd') return { ok: false, text, cost, error: 'budget exhausted (--max-budget-usd)' };
  return j?.is_error ? { ok: false, text, cost, error: text || j.subtype || 'claude reported an error' } : { ok: true, text, cost };
}

const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

export function parseVerdict(text) {
  const fail = (error) => ({ pass: false, findings: [], cheating: [], lesson: null, error });
  const s = String(text ?? '');
  const v = [s, s.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]
    .map(tryJson).find((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (!v) return fail('evaluator output is not a JSON object');
  if (typeof v.pass !== 'boolean' || !Array.isArray(v.findings)) return fail('verdict needs boolean "pass" and array "findings"');
  const findings = v.findings.filter((f) => f && typeof f === 'object');
  const cheating = Array.isArray(v.cheating) ? v.cheating.map(String) : [];
  const lesson = typeof v.lesson === 'string' && v.lesson.trim() ? v.lesson.trim() : null;
  const pass = v.pass && findings.length > 0 && findings.every((f) => f.ok === true) && cheating.length === 0;
  return { pass, findings, cheating, lesson, ...(v.pass && !pass ? { error: 'pass:true contradicted by findings/cheating' } : {}) };
}

export function feedbackFromVerdict(v) {
  const lines = v.error ? [`Evaluator: ${v.error}`] : [];
  for (const f of v.findings || []) if (f.ok !== true) lines.push(`FAILED ${f.check}: ${f.evidence}`);
  for (const c of v.cheating || []) lines.push(`CHEATING: ${c}`);
  return lines.join('\n') || 'Evaluator did not pass the feature.';
}

export function applyFailure(f, feedback, maxAttempts) {
  f.attempts = (f.attempts || 0) + 1;
  f.lastFeedback = feedback;
  f.status = f.attempts >= maxAttempts ? 'stuck' : 'todo';
  f.updatedAt = now();
}

// Features left in flight by a dead foreman: skip those whose recorded child is still alive (see childAlive),
// mark merged the ones whose branch already landed on base, mark stuck those whose child outlived the wait
// (relaunching would put two processes in one worktree), send the rest back to todo.
export function recoverInFlight(features, { skip = new Set(), alive = () => false, merged = () => false, overdue = () => false } = {}) {
  const r = { todo: [], merged: [], alive: [], stuck: [] };
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
export function procStart(pid) {
  try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] || null; } catch { return null; }
}

const HAS_PROC = existsSync('/proc/self/stat');
const exists = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }; // EPERM: not our user's, so not ours

// Is f's recorded child (pid + start time + the foreman that spawned it) still running? A bare pid can be
// reused, e.g. after a reboot. Without /proc the child counts as dead once its foreman is dead.
export function childAlive(f, { proc = HAS_PROC } = {}) {
  if (!Number.isInteger(f.pid) || f.pid <= 0 || !exists(f.pid)) return false;
  return proc ? !!f.pidStart && procStart(f.pid) === f.pidStart : Number.isInteger(f.foremanPid) && exists(f.foremanPid);
}

export function appendLesson(file, lesson, date = now().slice(0, 10)) {
  const text = lesson.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const bullet = `- ${date}: ${text}`;
  const s = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = s.split('\n');
  const h = lines.findIndex((l) => l.trim() === HEADING);
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

const readIf = (file) => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
const briefs = (root, config) => (config.briefFiles || []).map((f) => {
  const c = readIf(resolve(root, f));
  return c == null ? '' : `\n## Brief: ${f}\n\n${c}`;
}).join('\n');

function builderPrompt(root, config, f, branch, mockTasks) {
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

function evaluatorPrompt(root, config, f, branch, diff, test) {
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

export function claudeArgs(config, role, root) {
  const r = config[role] || {};
  const hook = [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${BIN}" hook` }] }];
  return ['-p', '--output-format', 'json', ...(r.model ? ['--model', r.model] : []), ...(r.effort ? ['--effort', r.effort] : []),
    ...(r.permissionMode ? ['--permission-mode', r.permissionMode] : []),
    ...(config.budgetUsdPerRun > 0 ? ['--max-budget-usd', String(config.budgetUsdPerRun)] : []),
    '--settings', JSON.stringify({ hooks: { PostToolUse: hook, Stop: hook },
      // "//" = absolute path; Edit(path) covers every file-writing tool. Deny rules hold even under bypassPermissions.
      permissions: { deny: [`Edit(/${root}/.shipyard/**)`, `Edit(/${root}/.git/**)`, 'Bash(git update-ref *)', 'Bash(git push *)',
        'Bash(git branch -f *)', 'Bash(git config *)'] } })];
}

// ---- processes ----

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  // trimEnd: keep the leading status column of `status --porcelain`
  return { code: r.status ?? 1, out: (r.stdout || '').trimEnd(), err: (r.stderr || r.error?.message || '').trim() };
}

// Children run in their own process group, so a signal reaches everything they started.
const killGroup = (cp, sig) => { try { process.kill(-cp.pid, sig); } catch {} };

function exec(cmd, args, { cwd, env, input = '', children, timeoutMin, onSpawn }) {
  return new Promise((res) => {
    let out = '', err = '', done = false, timedOut = false;
    const cp = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    children.add(cp);
    if (cp.pid) onSpawn?.(cp.pid);
    const timer = timeoutMin > 0 && setTimeout(() => {
      timedOut = true;
      killGroup(cp, 'SIGTERM');
      setTimeout(() => killGroup(cp, 'SIGKILL'), 5000).unref();
    }, timeoutMin * 60000);
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); children.delete(cp); res({ code, out, err, timedOut }); } };
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', (e) => { err += e.message; finish(127); });
    cp.on('close', (code) => finish(code ?? 1));
    cp.stdin.on('error', () => {});
    cp.stdin.end(input);
  });
}

// ---- the loop ----

export async function run(root, opts = {}) {
  const P = paths(root);
  const out = opts.out || ((s) => console.log(s));
  const other = parseInt(readIf(P.foreman), 10);
  if (other && other !== process.pid && pidAlive(other)) throw new Error(`another foreman is running (pid ${other})`);
  writeFileSync(P.foreman, String(process.pid));
  const children = new Set(), inflight = new Map();
  let stopping = false, launched = 0, onceDone = false, chain = Promise.resolve(), lastWaiting = '', lastOrphans = '', lastParked = '';
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; }; // main-checkout git ops
  const onSignal = () => {
    if (stopping) { out('forced exit'); for (const c of children) killGroup(c, 'SIGKILL'); process.exit(130); }
    stopping = true;
    out('stopping… (again to force)');
    for (const c of children) killGroup(c, 'SIGTERM');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const edit = (id, fn) => mutate(root, 'features', (d) => { const f = d.features.find((x) => x.id === id); if (f) fn(f); });
  const set = (id, patch) => edit(id, (f) => Object.assign(f, patch, { updatedAt: now() }));

  { const { features, tasks } = load(root); for (const e of validate(features, tasks)) { out(`warning: ${e}`); log(root, null, 'invalid', e); } }

  // Evaluate against what was on disk at launch; stop if config.json or base change behind Shipyard's back.
  const config = loadConfig(root), configText = readIf(P.config);
  const acceptance = new Map(load(root).features.map((f) => [f.id, f.acceptance]));
  const baseHead = () => git(['rev-parse', '--verify', '--quiet', `refs/heads/${config.base}`], root).out;
  let baseSha = baseHead(), halted = null, spent = 0; // spent: reported cost in this run only
  // Base moved outside Shipyard: an alert if it now reaches a commit of a feature branch, or carries a blob of
  // one, that the foreman did not evaluate (its own merges are in baseSha; a ready or merged feature's recorded
  // evaluated sha is excluded, so merging a ready branch by hand is fine); otherwise it's the user's own work.
  const baseMoved = () => {
    const head = baseHead();
    if (head === baseSha) return null;
    const why = `${config.base} moved outside Shipyard (expected ${baseSha.slice(0, 12)})`;
    if (!head || !baseSha) return why;
    const features = load(root).features;
    const names = new Set(features.map((f) => f.branch).filter(Boolean));
    for (const b of git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root).out.split('\n'))
      if (b.startsWith(config.branchPrefix)) names.add(b);
    const has = (r) => git(['rev-parse', '--verify', '--quiet', r], root).code === 0;
    const refs = [...names].map((b) => `refs/heads/${b}`).filter(has);
    const done = features.filter((f) => ['ready', 'merged'].includes(f.status) && f.sha && has(`${f.sha}^{commit}`)).map((f) => `^${f.sha}`);
    const lines = (...a) => git(['rev-list', ...a], root).out.split('\n').filter(Boolean);
    const fresh = new Set(lines(head, `^${baseSha}`));
    const hit = refs.length && lines(...refs, `^${baseSha}`, ...done).find((c) => fresh.has(c));
    if (hit) return `${why}: it now contains ${hit.slice(0, 12)} from a feature branch`;
    const blobs = (...a) => { // blob ids among the objects rev-list --objects reaches, minus the empty blob
      const ids = lines('--objects', ...a).map((l) => l.split(' ')[0]);
      const r = spawnSync('git', ['cat-file', '--batch-check=%(objecttype) %(objectname)'], { cwd: root, input: ids.join('\n'), encoding: 'utf8', maxBuffer: 256 << 20 });
      return (r.stdout || '').split('\n').filter((l) => l.startsWith('blob ') && l !== 'blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391').map((l) => l.slice(5));
    };
    const branchBlobs = refs.length ? new Set(blobs(...refs, `^${baseSha}`, ...done)) : new Set();
    const blob = branchBlobs.size && blobs(head, `^${baseSha}`).find((b) => branchBlobs.has(b));
    if (blob) return `${why}: it now carries blob ${blob.slice(0, 12)} from a feature branch it did not merge`;
    const note = `${config.base} moved outside Shipyard (${baseSha.slice(0, 12)} → ${head.slice(0, 12)}); no feature-branch commits, continuing`;
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
  const isMerged = (f) => { // merged with --no-ff: tip reachable from base but not on its first-parent line
    const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${f.branch || config.branchPrefix + f.id}`], root).out;
    return !!tip && git(['merge-base', '--is-ancestor', tip, config.base], root).code === 0 &&
      !git(['rev-list', '--first-parent', config.base], root).out.split('\n').includes(tip);
  };
  const waitingSince = new Map(); // feature id → when this foreman first found its orphaned child alive
  const orphanAlive = (f) => {
    if (!childAlive(f)) return false;
    if (!waitingSince.has(f.id)) waitingSince.set(f.id, Date.now());
    if (!(config.timeoutMin > 0) || Date.now() - waitingSince.get(f.id) < config.timeoutMin * 60000) return true;
    log(root, f.id, 'recovered', `child pid ${f.pid} still running after timeoutMin (${config.timeoutMin} min); not killed`);
    return false;
  };
  const recover = async () => !load(root).features.some((f) => IN_FLIGHT.includes(f.status) && !inflight.has(f.id)) ? [] : mutate(root, 'features', (d) => {
    const r = recoverInFlight(d.features, { skip: new Set(inflight.keys()), alive: orphanAlive, merged: isMerged, overdue: (f) => childAlive(f) });
    for (const id of r.todo) log(root, id, 'recovered', 'left in flight by a dead foreman; back to todo');
    for (const id of r.stuck) log(root, id, 'stuck', d.features.find((f) => f.id === id).lastFeedback);
    for (const id of r.merged) log(root, id, 'recovered', `already merged into ${config.base}`);
    return r.alive;
  });

  const failer = (id) => (fb) => edit(id, (x) => { applyFailure(x, fb, config.maxAttempts); log(root, id, x.status === 'stuck' ? 'stuck' : 'failed', fb); out(`${x.status === 'stuck' ? 'stuck' : 'retry'} ${id}: ${fb.split('\n')[0]}`); });

  async function pipeline(f, config, mockTasks) {
    const id = f.id, attempt = (f.attempts || 0) + 1, branch = f.branch || config.branchPrefix + id;
    const wt = resolve(root, config.worktreesDir, id), runDir = join(P.runs, id);
    const env = { ...process.env, SHIPYARD_FEATURE: id };
    const onSpawn = (pid) => edit(id, (x) => { Object.assign(x, { pid, pidStart: procStart(pid) ?? undefined, foremanPid: process.pid }); }).catch(() => {}); // lets a later foreman see the child is alive
    const fail = failer(id);
    const stopped = async () => { if (!stopping) return false; await set(id, { status: 'todo' }); log(root, id, 'interrupted'); return true; };
    const claude = async (role, prompt, file) => {
      const r = await exec(process.env.SHIPYARD_CLAUDE || 'claude', claudeArgs(config, role, root),
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
    // A branch with no commits of its own (e.g. prepared before its deps merged) starts from the current base.
    // Fast-forward only, so it can never conflict; a clean worktree is required.
    if (git(['rev-list', '--count', `${config.base}..${branch}`], root).out === '0' && !git(['status', '--porcelain'], wt).out)
      git(['merge', '--ff-only', '--quiet', config.base], wt);

    const b = await claude('builder', builderPrompt(root, config, f, branch, mockTasks), `${attempt}-build.json`);
    if (await stopped()) return;
    if (!b.ok) return fail(`builder failed: ${b.error}`);
    // Any commit beyond base counts as the builder's, including the merge commit that completes a base refresh.
    const status = git(['status', '--porcelain'], wt).out.split('\n').filter(Boolean);
    const listed = status.slice(0, 40).join('\n') + (status.length > 40 ? `\n… ${status.length - 40} more` : '');
    const merging = git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code === 0 ? `the merge of ${config.base} the foreman started is not committed; ` : '';
    if (merging || status.length || git(['rev-list', '--count', `${config.base}..${branch}`], wt).out === '0')
      return fail(`commit your work: ${merging}${status.length ? `the worktree has uncommitted changes (git status --porcelain):\n${listed}` : merging ? 'git commit it' : `${branch} has no commits beyond ${config.base}`}`);
    const sha = git(['rev-parse', branch], wt).out; // what gets tested, evaluated and merged

    await set(id, { status: 'testing' });
    const t = await exec('sh', ['-c', `exec 2>&1\n${config.test}`], { cwd: wt, env, children, timeoutMin: config.timeoutMin, onSpawn });
    if (await stopped()) return;
    const test = { code: t.code, tail: tail(t.out + t.err) + (t.timedOut ? `\n(timed out after ${config.timeoutMin} min)` : '') };
    if (t.code !== 0) return fail(`test command \`${config.test}\` exited ${t.code}:\n${test.tail}`);

    await set(id, { status: 'evaluating' });
    const diff = git(['diff', '--text', '--no-ext-diff', '--no-textconv', `${config.base}...${sha}`], wt).out;
    const e = await claude('evaluator', evaluatorPrompt(root, config, f, branch, diff, test), `${attempt}-eval.json`);
    if (await stopped()) return;
    const v = e.ok ? parseVerdict(e.text) : { pass: false, findings: [], cheating: [], lesson: null, error: `evaluator failed: ${e.error}` };
    if (v.lesson) await serial(() => compound(id, v.lesson));
    if (!v.pass) return fail(feedbackFromVerdict(v));
    if (config.merge === 'manual') { log(root, id, 'ready', branch); out(`ready ${id} (${branch})`); return set(id, { status: 'ready', sha, lastFeedback: undefined }); }
    return serial(() => merge(f, branch, sha, fail));
  }

  function compound(id, lesson) {
    const file = resolve(root, config.lessonsFile);
    const wasClean = git(['status', '--porcelain', '--', file], root).out === '';
    if (!appendLesson(file, lesson)) return;
    log(root, id, 'lesson', lesson);
    if (wasClean && git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out === config.base && !tampered()) {
      git(['add', '--', file], root);
      git(['commit', '-q', '-m', `shipyard: lesson from ${id}`, '--', file], root);
      baseSha = baseHead();
    }
  }

  // After a conflicting merge into base, the foreman (never the builder) merges the verified base sha into the
  // feature's clean worktree; a conflict there is left for the next build to resolve and commit. No attempt is spent.
  function refresh(id, branch, fail) {
    const wt = resolve(root, config.worktreesDir, id), base = config.base;
    const n = load(root).features.find((x) => x.id === id)?.refreshes || 0;
    if (n >= MAX_REFRESHES) {
      const fb = `merge conflict with ${base}: too many base refreshes (${n})`;
      log(root, id, 'stuck', fb); out(`stuck ${id}: ${fb}`);
      return set(id, { status: 'stuck', lastFeedback: fb });
    }
    const st = git(['status', '--porcelain'], wt);
    if (st.code || st.out) return fail(`merge conflict with ${base}; the foreman could not merge ${base} into your branch because the worktree is not clean`);
    const m = git(['merge', '--no-edit', '-m', `shipyard: merge ${base} into ${branch}`, baseSha], wt);
    const conflicted = m.code !== 0 && git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code === 0;
    if (m.code && !conflicted) return fail(`merge conflict with ${base}; merging ${base} into your branch did not start: ${m.err}`);
    const files = git(['diff', '--name-only', '--diff-filter=U'], wt).out.split('\n').filter(Boolean).join(', ');
    const fb = conflicted
      ? `the foreman started merging ${base} into your branch and it conflicts in: ${files}. Resolve the conflicts preserving both sides' intent, run the tests, and commit the merge (git add + git commit). Do not abort it and do not start another merge or rebase.`
      : `the foreman merged ${base} into your branch (conflict-free); re-run the tests and fix anything the new base broke`;
    log(root, id, 'refreshed', conflicted ? `conflicts in: ${files}` : 'conflict-free');
    out(`refresh ${id}: merged ${base} into ${branch}${conflicted ? `, conflicts in: ${files}` : ''}`);
    return set(id, { status: 'todo', refreshes: n + 1, lastFeedback: fb, parked: undefined });
  }

  const checkoutProblem = () => { // why the main checkout can't take a merge now, or null
    const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out;
    if (head !== config.base) return `main checkout is on ${head || 'a detached HEAD'}, not ${config.base}`;
    return git(['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).shipyard'], root).out ? 'main checkout has uncommitted changes' : null;
  };
  const isParked = (f) => config.merge === 'auto' && f.status === 'ready' && f.parked && f.sha;
  // A feature parked by merge-skipped: merge its evaluated sha if the branch still points to it, else rebuild it.
  function retryMerge(f) {
    const branch = f.branch || config.branchPrefix + f.id;
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).out === f.sha) return merge(f, branch, f.sha, failer(f.id));
    log(root, f.id, 'unparked', `${branch} moved since it was evaluated; back to todo`);
    out(`retry ${f.id}: ${branch} moved since it was evaluated`);
    return set(f.id, { status: 'todo', parked: undefined, sha: undefined });
  }

  async function merge(f, branch, sha, fail) {
    const id = f.id;
    if (tampered()) { log(root, id, 'merge-skipped', `${halted}; back to todo`); return set(id, { status: 'todo', parked: undefined }); }
    const why = checkoutProblem();
    if (why) {
      log(root, id, 'merge-skipped', `${why}; left as ready`);
      out(`ready ${id}: ${why}`);
      return set(id, { status: 'ready', sha, parked: true });
    }
    if (git(['rev-parse', branch], root).out !== sha) return fail(`${branch} moved during evaluation; only the evaluated commit is merged`);
    const m = git(['merge', '--no-ff', '--no-edit', '-m', `shipyard: merge ${id}: ${f.title}`, sha], root);
    if (m.code !== 0) {
      if (git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], root).code !== 0) { // the merge never started
        log(root, id, 'merge-failed', `${m.err}; left as ready`);
        out(`ready ${id}: merge did not start: ${m.err.split('\n')[0]}`);
        return set(id, { status: 'ready', sha, parked: undefined });
      }
      git(['merge', '--abort'], root);
      return refresh(id, branch, fail);
    }
    baseSha = baseHead();
    if (config.postMerge) {
      const r = await exec('sh', ['-c', `exec 2>&1\n${config.postMerge}`], { cwd: root, env: process.env, children, timeoutMin: config.timeoutMin });
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
        for (const id of a.ready) {
          if (inflight.size >= Math.max(1, config.maxParallel) || capped()) break;
          if (inflight.has(id)) continue;
          launched++;
          const mockTasks = tasks.filter((t) => t.status === 'open' && t.mockable && (t.unblocks || []).includes(id));
          await set(id, { status: 'building', onMock: a.mock.has(id), sha: undefined, pid: undefined, pidStart: undefined, foremanPid: undefined });
          log(root, id, 'launch', a.mock.has(id) ? 'onMock' : '');
          out(`building ${id}${a.mock.has(id) ? ' (on mock)' : ''}`);
          if (!acceptance.has(id)) acceptance.set(id, features.find((x) => x.id === id).acceptance);
          const f = { ...features.find((x) => x.id === id), acceptance: acceptance.get(id) };
          inflight.set(id, pipeline(f, config, mockTasks)
            .catch((e) => { log(root, id, 'error', e.stack || String(e)); return set(id, { status: 'todo' }); })
            .finally(() => inflight.delete(id)));
        }
        if (opts.once) onceDone = true;
      }
      if (inflight.size) { await Promise.race(inflight.values()); continue; }
      if (orphans.length && !stopping && !halted) {
        if (orphans.join() !== lastOrphans) out(`waiting for children of a previous foreman: ${(lastOrphans = orphans.join())}`);
        await sleep(Number(process.env.SHIPYARD_POLL_MS) || 5000);
        continue;
      }
      if (overBudget) { log(root, null, 'budget', `spent $${spent.toFixed(2)} of $${config.budgetUsdTotal}`); out('budget reached'); }
      if (stopping || onceDone || capped() || overBudget || halted) break;
      if (opts.watch && parked.length) { // poll: cleaning the checkout touches no state file
        if (parked.map((f) => f.id).join() !== lastParked) out(`waiting for a clean ${config.base} checkout to merge: ${(lastParked = parked.map((f) => f.id).join())}`);
        await sleep(Number(process.env.SHIPYARD_POLL_MS) || 5000);
        continue;
      }
      if (!(opts.watch && a.waiting.length)) break;
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
    if (parseInt(readIf(P.foreman), 10) === process.pid) unlinkSync(P.foreman);
  }
  const { features } = load(root);
  const counts = {};
  for (const f of features) counts[f.status] = (counts[f.status] || 0) + 1;
  out(`summary: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'no features'}`);
  return !halted && features.every((f) => f.status === 'merged' || f.status === 'ready') ? 0 : 2;
}

export const stamp = (P) => [P.features, P.human].map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join();

// Sleep until features.json/human.json differ from `since` (a stamp taken before the caller read them).
export async function waitForChange(P, since, isStopping) {
  const ms = Number(process.env.SHIPYARD_POLL_MS) || 5000;
  while (!isStopping() && stamp(P) === since) await sleep(ms);
}
