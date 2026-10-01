// The CLI; bin/fact-os only imports it (tsc does not check extensionless files).
import { existsSync, mkdirSync, copyFileSync, readFileSync, appendFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { paths, DEFAULT_CONFIG, writeJsonAtomic, readJson, load, mutate, withLock, log, loadConfig, envVar, errMsg, NAME } from './state.ts';
import { analyze, validate, SLUG } from './ready.ts';
import { STATUSES, type ActivityEvent, type Config, type Feature, type HumanTask } from './types.ts';
import { act, PAST, type Action } from './actions.ts';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const USAGE = `usage: ${NAME} <command>
  init [--test "<cmd>"]           set up .${NAME}/ and project skills in this repo
  run [--watch] [--once] [--max-features N]
  status                          features and open human tasks
  done <human-task-id>            mark a human task done
  pause|resume|retry <id>...      pause todo/stuck features, resume paused ones, retry stuck ones (attempts reset)
  doctor                          validate state files and tools
  dash [--root DIR] [--port 7420] dashboard on 127.0.0.1
  observe [--watch] [--agent]
                                  sort stuck features by cause, send back the ones stuck for a reason outside
                                  them, report; --agent also curates lessons and queues improvements
  hook                            (internal) Claude Code hook: stdin payload → activity.jsonl`;

// Main checkout of the repo containing dir (works from worktrees), or null.
function projectRoot(dir = process.cwd()): string | null {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? dirname(r.stdout.trim()) : null;
}
function needRoot(): string {
  const root = projectRoot();
  if (!root) throw new Error('not inside a git repository');
  return root;
}
const resolves = (cmd: string) => !!cmd && spawnSync('sh', ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'ignore' }).status === 0;

function init(test: string | undefined): void {
  const root = needRoot(), P = paths(root);
  mkdirSync(P.dir, { recursive: true });
  const made: string[] = [];
  const create = (file: string, data: unknown) => { if (!existsSync(file)) { writeJsonAtomic(file, data); made.push(file); } };
  create(P.config, { ...DEFAULT_CONFIG, worktreesDir: `../${basename(root)}-worktrees`, ...(test ? { test } : {}) });
  create(P.features, { features: [] });
  create(P.human, { tasks: [] });
  for (const s of ['intake', 'ship']) {
    const dest = join(root, '.claude/skills', s, 'SKILL.md');
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(HERE, '../skills', s, 'SKILL.md'), dest);
    made.push(dest);
  }
  const exclude = join(root, '.git/info/exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const have = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const add = ['runs/', '*.jsonl', '.lock', '.foreman', '.observer', 'observer.json', 'observer-report.md'].map((f) => `${paths(root).name}/${f}`)
    .filter((l) => !have.split('\n').includes(l));
  if (add.length) appendFileSync(exclude, (have && !have.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  console.log(made.length ? made.map((f) => `created ${f}`).join('\n') : 'already initialized');
}

function status(): void {
  const root = needRoot(), { config, features, tasks } = load(root);
  const a = analyze(features, tasks, config.merge);
  const rows = [['id', 'status', 'tries', 'cost', 'deps', 'notes'], ...features.map((f) => [f.id, f.status, String(f.attempts || 0),
    f.costUsd ? `$${f.costUsd.toFixed(2)}` : '', (f.deps || []).join(','), [f.onMock && 'onMock', a.ready.includes(f.id) && 'next',
      a.waiting.includes(f.id) && 'waiting-on-human', a.bad.has(f.id) && 'INVALID'].filter(Boolean).join(' ')])];
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd());
  const open = tasks.filter((t) => t.status === 'open');
  console.log(open.length ? '\nOpen human tasks:' : '\nNo open human tasks.');
  for (const t of open) console.log(`  ${t.id}: ${t.title} → unblocks ${(t.unblocks || []).join(', ')}${t.mockable ? ' (mockable)' : ''}`);
}

async function done(id: string | undefined): Promise<void> {
  const root = needRoot();
  if (!id) throw new Error(`usage: ${NAME} done <human-task-id>`);
  const ok = await mutate(root, 'human', (d) => {
    const t = d.tasks.find((x) => x.id === id);
    if (t && t.status !== 'done') Object.assign(t, { status: 'done', doneAt: new Date().toISOString() });
    return !!t;
  });
  if (!ok) throw new Error(`unknown human task: ${id}`);
  log(root, null, 'human-done', id);
  console.log(`done: ${id}`);
}

function doctor(): number {
  const root = needRoot(), P = paths(root), problems: string[] = [];
  // Entries stay untyped until checked below: this is where the state files' shape is validated.
  type Loose = Record<string, unknown> | null | undefined;
  let config: Config = DEFAULT_CONFIG, features: Loose[] = [], tasks: Loose[] = [];
  try { config = loadConfig(root); } catch (e) { problems.push(errMsg(e)); }
  try { features = (readJson(P.features, null) as { features?: Loose[] } | null)?.features ?? (problems.push(`${P.features}: missing or no "features" array`), []); } catch (e) { problems.push(errMsg(e)); }
  try { tasks = (readJson(P.human, null) as { tasks?: Loose[] } | null)?.tasks ?? (problems.push(`${P.human}: missing or no "tasks" array`), []); } catch (e) { problems.push(errMsg(e)); }
  const STATUS: string[] = STATUSES;
  const SURF = ['web', 'api', 'ios', 'android', 'desktop', 'any'];
  const str = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
  const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);
  for (const f of features) {
    const bad = (m: string) => problems.push(`feature ${f?.id ?? '?'}: ${m}`);
    if (!str(f?.id) || !SLUG.test(f!.id as string)) bad('id must be a slug');
    if (!str(f?.title)) bad('title required');
    if (!strs(f?.acceptance) || !(f!.acceptance as string[]).length) bad('needs at least one acceptance check');
    if (f?.surface !== undefined && !SURF.includes(f.surface as string)) bad(`surface must be one of ${SURF.join('|')}`);
    if (!strs(f?.deps ?? [])) bad('deps must be an array of ids');
    if (typeof (f?.priority ?? 0) !== 'number') bad('priority must be a number');
    if (!STATUS.includes(f?.status as string)) bad(`status must be one of ${STATUS.join('|')}`);
  }
  for (const t of tasks) {
    const bad = (m: string) => problems.push(`human task ${t?.id ?? '?'}: ${m}`);
    if (!str(t?.id) || !str(t?.title)) bad('id and title required');
    if (!strs(t?.steps) || !strs(t?.unblocks)) bad('steps and unblocks must be string arrays');
    if (typeof t?.mockable !== 'boolean') bad('mockable must be boolean');
    if (!['open', 'done'].includes(t?.status as string)) bad('status must be open|done');
  }
  if (!['auto', 'manual'].includes(config.merge)) problems.push('config.merge must be "auto" or "manual"');
  if (!problems.length) problems.push(...validate(features as unknown as Feature[], tasks as unknown as HumanTask[])); // shapes checked above
  const claude = envVar('CLAUDE') || 'claude';
  for (const [what, cmd] of [['claude', claude], ['git', 'git'], ['test command', String(config.test || '').trim().split(/\s+/)[0]]])
    if (!resolves(cmd)) problems.push(`${what}: "${cmd}" not found on PATH`);
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(problems.length ? `${problems.length} problem(s)` : `ok: ${features.length} features, ${tasks.length} human tasks`);
  return problems.length ? 1 : 0;
}

// Claude Code hook: never prints, never fails.
interface HookPayload { cwd?: string; session_id?: string; tool_name?: string; hook_event_name?: string; tool_input?: Record<string, unknown> }

async function hook(): Promise<void> {
  try {
    let input = '';
    for await (const c of process.stdin) input += c;
    const p = JSON.parse(input) as HookPayload; // parse boundary: a wrong shape throws below and is swallowed
    const root = projectRoot(p.cwd && existsSync(p.cwd) ? p.cwd : process.cwd());
    if (!root || !existsSync(paths(root).dir)) return;
    const ti = p.tool_input || {}, tool = p.tool_name || p.hook_event_name || 'event';
    const detail = String(ti.command ?? ti.file_path ?? ti.path ?? ti.pattern ?? ti.url ?? '').replace(/\s+/g, ' ').slice(0, 120);
    const event: ActivityEvent = { ts: new Date().toISOString(), session: p.session_id ?? null,
      feature: envVar('FEATURE') || null, tool, summary: `${tool} ${detail}`.trim() };
    const line = JSON.stringify(event) + '\n';
    const file = paths(root).activity;
    await withLock(root, () => {
      appendFileSync(file, line);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > 2000) { writeFileSync(file + '.tmp', lines.slice(-2000).join('\n') + '\n'); renameSync(file + '.tmp', file); }
    }, { timeoutMs: 3000 });
  } catch {}
}

const argv = process.argv.slice(2);
const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
  test: { type: 'string' }, watch: { type: 'boolean' }, once: { type: 'boolean' }, 'max-features': { type: 'string' },
  root: { type: 'string' }, port: { type: 'string' }, agent: { type: 'boolean' } }, strict: argv[0] !== 'hook' });
// strict parsing (every command but hook, which ignores o) guarantees these types.
const o = values as { test?: string; watch?: boolean; once?: boolean; 'max-features'?: string; root?: string; port?: string; agent?: boolean };
try {
  switch (argv[0]) {
    case 'init': init(o.test); break;
    case 'status': status(); break;
    case 'done': await done(positionals[0]); break;
    case 'pause': case 'resume': case 'retry': {
      if (!positionals.length) throw new Error(`usage: ${NAME} ${argv[0]} <feature-id>...`);
      const r = await act(needRoot(), argv[0] as Action, positionals);
      for (const [id, err] of Object.entries(r)) console.log(err ? `✗ ${id}: ${err}` : `${PAST[argv[0] as Action]} ${id}`);
      if (Object.values(r).some(Boolean)) process.exitCode = 1;
      break;
    }
    case 'doctor': process.exitCode = doctor(); break;
    case 'hook': await hook(); process.exit(0); break;
    case 'run': {
      const { run } = await import('./foreman.ts');
      process.exitCode = await run(needRoot(), { watch: o.watch, once: o.once,
        maxFeatures: o['max-features'] != null ? Number(o['max-features']) : undefined });
      break;
    }
    case 'observe': {
      const { observe } = await import('./observe.ts');
      process.exitCode = await observe(needRoot(), { watch: o.watch, agent: o.agent });
      break;
    }
    case 'dash': {
      const { startDash } = await import('./dash.ts');
      const { url } = await startDash({ root: resolve(o.root || process.cwd()), port: Number(o.port ?? 7420) });
      console.log(`${NAME} dash: ${url}`);
      break;
    }
    default: console.log(USAGE); process.exitCode = argv[0] && !['-h', '--help', 'help'].includes(argv[0]) ? 1 : 0;
  }
} catch (e) {
  if (argv[0] === 'hook') process.exit(0);
  console.error(`${NAME}: ${errMsg(e)}`);
  process.exitCode = 1;
}
