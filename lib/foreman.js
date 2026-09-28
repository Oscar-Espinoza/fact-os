// Foreman: plan → build → test → evaluate → merge → compound, over ready features, in parallel worktrees.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, load, mutate, log, pidAlive, sleep } from './state.js';
import { analyze, validate } from './ready.js';

const BIN = fileURLToPath(new URL('../bin/shipyard', import.meta.url));
const IN_FLIGHT = ['building', 'testing', 'evaluating'];
const HEADING = '## Shipyard lessons';
const now = () => new Date().toISOString();
const tail = (s, n = 4000) => (s.length > n ? '…' + s.slice(-n) : s);

// ---- pure helpers (unit tested) ----

export function parseClaudeOutput(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return { ok: false, text: '', cost: 0, error: `not JSON: ${tail(String(stdout), 500)}` }; }
  // Verified in claude 2.1.283: {type:"result", subtype, is_error, result, total_cost_usd, session_id, ...}.
  const cost = Number(j?.total_cost_usd ?? j?.cost_usd ?? 0) || 0;
  const text = j?.structured_output !== undefined ? JSON.stringify(j.structured_output) : String(j?.result ?? '');
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

export function recoverInFlight(features) {
  const ids = features.filter((f) => IN_FLIGHT.includes(f.status)).map((f) => f.id);
  for (const f of features) if (ids.includes(f.id)) { f.status = 'todo'; f.updatedAt = now(); }
  return ids;
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
    f.lastFeedback ? `Your previous attempt was rejected. Feedback:\n${f.lastFeedback}\n` : '',
    'Rules:', '- Commit your work on this branch (git add + git commit). Uncommitted changes are not evaluated.',
    '- Do not weaken or delete tests to make them pass.', '- Do not stub behavior the acceptance checks require.',
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

export function claudeArgs(config, role) {
  const r = config[role] || {};
  const hook = [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${BIN}" hook` }] }];
  return ['-p', '--output-format', 'json', ...(r.model ? ['--model', r.model] : []), ...(r.effort ? ['--effort', r.effort] : []),
    ...(r.permissionMode ? ['--permission-mode', r.permissionMode] : []), '--max-budget-usd', String(config.budgetUsdPerRun),
    '--settings', JSON.stringify({ hooks: { PostToolUse: hook, Stop: hook } })];
}

// ---- processes ----

export function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}

function exec(cmd, args, { cwd, env, input = '', children }) {
  return new Promise((res) => {
    let out = '', err = '', done = false;
    const cp = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(cp);
    const finish = (code) => { if (!done) { done = true; children.delete(cp); res({ code, out, err }); } };
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
  let stopping = false, launched = 0, onceDone = false, chain = Promise.resolve(), lastWaiting = '';
  const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; }; // main-checkout git ops
  const onSignal = () => { if (!stopping) { stopping = true; out('stopping…'); for (const c of children) c.kill('SIGTERM'); } };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const edit = (id, fn) => mutate(root, 'features', (d) => { const f = d.features.find((x) => x.id === id); if (f) fn(f); });
  const set = (id, patch) => edit(id, (f) => Object.assign(f, patch, { updatedAt: now() }));

  await mutate(root, 'features', (d) => {
    for (const id of recoverInFlight(d.features)) log(root, id, 'recovered', 'left in flight by a dead foreman; back to todo');
  });
  { const { features, tasks } = load(root); for (const e of validate(features, tasks)) { out(`warning: ${e}`); log(root, null, 'invalid', e); } }

  async function pipeline(f, config, mockTasks) {
    const id = f.id, attempt = (f.attempts || 0) + 1, branch = f.branch || config.branchPrefix + id;
    const wt = resolve(root, config.worktreesDir, id), runDir = join(P.runs, id);
    const env = { ...process.env, SHIPYARD_FEATURE: id };
    const fail = (fb) => edit(id, (x) => { applyFailure(x, fb, config.maxAttempts); log(root, id, x.status === 'stuck' ? 'stuck' : 'failed', fb); out(`${x.status === 'stuck' ? 'stuck' : 'retry'} ${id}: ${fb.split('\n')[0]}`); });
    const stopped = async () => { if (!stopping) return false; await set(id, { status: 'todo' }); log(root, id, 'interrupted'); return true; };
    const claude = async (role, prompt, file) => {
      const r = await exec(process.env.SHIPYARD_CLAUDE || 'claude', claudeArgs(config, role), { cwd: wt, env, input: prompt, children });
      writeFileSync(join(runDir, file), tryJson(r.out) ? r.out : JSON.stringify({ exitCode: r.code, stdout: r.out, stderr: tail(r.err) }));
      const p = parseClaudeOutput(r.out);
      if (p.cost) await edit(id, (x) => { x.costUsd = Math.round(((x.costUsd || 0) + p.cost) * 1e6) / 1e6; });
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

    const b = await claude('builder', builderPrompt(root, config, f, branch, mockTasks), `${attempt}-build.json`);
    if (await stopped()) return;
    if (!b.ok) return fail(`builder failed: ${b.error}`);

    await set(id, { status: 'testing' });
    const t = await exec('sh', ['-c', `exec 2>&1\n${config.test}`], { cwd: wt, env, children });
    if (await stopped()) return;
    const test = { code: t.code, tail: tail(t.out + t.err) };
    if (t.code !== 0) return fail(`test command \`${config.test}\` exited ${t.code}:\n${test.tail}`);

    await set(id, { status: 'evaluating' });
    const diff = git(['diff', `${config.base}...${branch}`], wt).out;
    const e = await claude('evaluator', evaluatorPrompt(root, config, f, branch, diff, test), `${attempt}-eval.json`);
    if (await stopped()) return;
    const v = e.ok ? parseVerdict(e.text) : { pass: false, findings: [], cheating: [], lesson: null, error: `evaluator failed: ${e.error}` };
    if (v.lesson) await serial(() => compound(config, id, v.lesson));
    if (!v.pass) return fail(feedbackFromVerdict(v));
    if (config.merge === 'manual') { log(root, id, 'ready', branch); out(`ready ${id} (${branch})`); return set(id, { status: 'ready', lastFeedback: undefined }); }
    return serial(() => merge(config, f, branch, fail, set));
  }

  function compound(config, id, lesson) {
    const file = resolve(root, config.lessonsFile);
    const wasClean = git(['status', '--porcelain', '--', file], root).out === '';
    if (!appendLesson(file, lesson)) return;
    log(root, id, 'lesson', lesson);
    if (wasClean && git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out === config.base) {
      git(['add', '--', file], root);
      git(['commit', '-q', '-m', `shipyard: lesson from ${id}`, '--', file], root);
    }
  }

  async function merge(config, f, branch, fail, set) {
    const id = f.id;
    const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out;
    const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude).shipyard'], root).out;
    if (head !== config.base || dirty) {
      const why = head !== config.base ? `main checkout is on ${head || 'a detached HEAD'}, not ${config.base}` : 'main checkout has uncommitted changes';
      log(root, id, 'merge-skipped', `${why}; left as ready`);
      out(`ready ${id}: ${why}`);
      return set(id, { status: 'ready' });
    }
    if (git(['merge', '--no-ff', '--no-edit', '-m', `shipyard: merge ${id}: ${f.title}`, branch], root).code !== 0) {
      git(['merge', '--abort'], root);
      return fail(`merge conflict: rebase on ${config.base}`);
    }
    if (config.postMerge) {
      const r = await exec('sh', ['-c', `exec 2>&1\n${config.postMerge}`], { cwd: root, env: process.env, children });
      log(root, id, 'post-merge', `exit ${r.code}: ${tail(r.out, 1000)}`);
    }
    log(root, id, 'merged', branch);
    out(`merged ${id}`);
    return set(id, { status: 'merged', lastFeedback: undefined });
  }

  try {
    for (;;) {
      const { config, features, tasks } = load(root);
      const a = analyze(features, tasks, config.merge);
      const spent = features.reduce((s, f) => s + (f.costUsd || 0), 0);
      const overBudget = spent >= config.budgetUsdTotal;
      const capped = () => opts.maxFeatures != null && launched >= opts.maxFeatures;
      if (!stopping && !overBudget && !onceDone) {
        for (const id of a.ready) {
          if (inflight.size >= Math.max(1, config.maxParallel) || capped()) break;
          if (inflight.has(id)) continue;
          launched++;
          const mockTasks = tasks.filter((t) => t.status === 'open' && t.mockable && (t.unblocks || []).includes(id));
          await set(id, { status: 'building', onMock: a.mock.has(id) });
          log(root, id, 'launch', a.mock.has(id) ? 'onMock' : '');
          out(`building ${id}${a.mock.has(id) ? ' (on mock)' : ''}`);
          const f = features.find((x) => x.id === id);
          inflight.set(id, pipeline(f, config, mockTasks)
            .catch((e) => { log(root, id, 'error', e.stack || String(e)); return set(id, { status: 'todo' }); })
            .finally(() => inflight.delete(id)));
        }
        if (opts.once) onceDone = true;
      }
      if (inflight.size) { await Promise.race(inflight.values()); continue; }
      if (overBudget) { log(root, null, 'budget', `spent $${spent.toFixed(2)} of $${config.budgetUsdTotal}`); out('budget reached'); }
      if (stopping || onceDone || capped() || overBudget) break;
      if (!(opts.watch && a.waiting.length)) break;
      if (a.waiting.join() !== lastWaiting) {
        lastWaiting = a.waiting.join();
        log(root, null, 'waiting', a.waiting.join(', '));
        out(`waiting on human tasks for: ${a.waiting.join(', ')}`);
      }
      await waitForChange(P, () => stopping);
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
  return features.every((f) => f.status === 'merged' || f.status === 'ready') ? 0 : 2;
}

async function waitForChange(P, isStopping) {
  const stamp = () => [P.features, P.human].map((f) => { try { return statSync(f).mtimeMs; } catch { return 0; } }).join();
  const start = stamp(), ms = Number(process.env.SHIPYARD_POLL_MS) || 5000;
  while (!isStopping() && stamp() === start) await sleep(ms);
}
