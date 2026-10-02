// The CLI; bin/fact-os only imports it (tsc does not check extensionless files).
import { existsSync, mkdirSync, copyFileSync, readFileSync, appendFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { paths, DEFAULT_CONFIG, writeJsonAtomic, readJson, load, mutate, withLock, log, loadConfig, envVar, errMsg, writeControl, readControlFile, effectiveLimit, pidAlive, MAX_LANES, NAME } from './state.ts';
import { analyze, validate, SLUG } from './ready.ts';
import { STATUSES, IN_FLIGHT, type ActivityEvent, type Config, type Control, type Feature, type HumanTask } from './types.ts';
import { act, PAST, type Action } from './actions.ts';
import { profileNames, profileLabel, profileProblems, roleTable, riskyOpen } from './profiles.ts';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const USAGE = `usage: ${NAME} <command>
  init [--test "<cmd>"]           set up .${NAME}/ and project skills in this repo
  run [--watch] [--once] [--max-features N]
  status                          features and open human tasks
  done <human-task-id>            mark a human task done
  pause|resume|retry <id>...      pause todo/stuck features, resume paused ones, retry stuck ones (attempts reset)
  pause-all | resume-all          stop / restart launching new features (nothing running is interrupted)
  lanes <n|default>               how many features may be in flight (0-${MAX_LANES}); default = config.maxParallel
  profile [<name|default>]        model profile for new launches (opus = each role's config; fable-sonnet; config.profiles);
                                  without a name: the active profile and its role → model/effort table
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
  const add = ['runs/', '*.jsonl', '.lock', '.foreman', '.observer', 'observer.json', 'observer-report.md', 'control.json', 'prompt-notes/'].map((f) => `${paths(root).name}/${f}`)
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
  const cr = readControlFile(root, config);
  console.log(`\nModel profile: ${cr.ok ? profileLine(cr.control.profile ?? null) : `unknown (${cr.error})`}`);
}

const profileLine = (p: string | null) => `${p ?? 'opus'} (${profileLabel(p)})`;
const riskyLine = (features: Feature[]) => { const r = riskyOpen(features);
  return `risky: ${r.risky} of ${r.open} open features would get the builder's effortHigh (a risk tag, a keyword in the title, or 2+ keyword families in the description)`; };

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
    if (f?.touches !== undefined && !strs(f.touches)) bad('touches must be an array of repo paths (or dir prefixes ending in "/")');
    if (f?.risk !== undefined && !['high', 'normal'].includes(f.risk as string)) bad('risk must be "high" or "normal" (absent: decided from the title and description)');
  }
  for (const t of tasks) {
    const bad = (m: string) => problems.push(`human task ${t?.id ?? '?'}: ${m}`);
    if (!str(t?.id) || !str(t?.title)) bad('id and title required');
    if (!strs(t?.steps) || !strs(t?.unblocks)) bad('steps and unblocks must be string arrays');
    if (typeof t?.mockable !== 'boolean') bad('mockable must be boolean');
    if (!['open', 'done'].includes(t?.status as string)) bad('status must be open|done');
  }
  if (!['auto', 'manual'].includes(config.merge)) problems.push('config.merge must be "auto" or "manual"');
  const cl = config.claims as Record<string, unknown> | null;
  if (cl != null && (typeof cl !== 'object' || !strs(cl.hot ?? []) || typeof (cl.minScore ?? 0) !== 'number' || typeof (cl.days ?? 0) !== 'number'))
    problems.push('config.claims must be null or {hot: string[], minScore: number, days: number}');
  if (config.resolver != null && typeof config.resolver !== 'object') problems.push('config.resolver must be null or {model, effort, permissionMode}');
  problems.push(...profileProblems(config.profiles));
  const cr = readControlFile(root, config);
  if (!cr.ok) problems.push(`${cr.error} (the foreman keeps its last good control, or holds all new work; fix it, or rewrite it with pause-all, resume-all, lanes or profile)`);
  if (!problems.length) problems.push(...validate(features as unknown as Feature[], tasks as unknown as HumanTask[])); // shapes checked above
  const claude = envVar('CLAUDE') || 'claude';
  for (const [what, cmd] of [['claude', claude], ['git', 'git'], ['test command', String(config.test || '').trim().split(/\s+/)[0]]])
    if (!resolves(cmd)) problems.push(`${what}: "${cmd}" not found on PATH`);
  for (const p of problems) console.log(`✗ ${p}`);
  console.log(problems.length ? `${problems.length} problem(s)` : `ok: ${features.length} features, ${tasks.length} human tasks`);
  if (cr.ok) console.log(`model profile: ${profileLine(cr.control.profile ?? null)}`);
  if (!problems.length) console.log(riskyLine(features as unknown as Feature[]));
  return problems.length ? 1 : 0;
}

// pause-all / resume-all / lanes / profile: write control.json (the foreman re-reads it every tick) and print the resulting state.
async function control(cmd: string, args: string[]): Promise<void> {
  const root = needRoot(), [arg] = args;
  let patch: Partial<Pick<Control, 'paused' | 'maxParallel' | 'profile'>>;
  if (cmd === 'profile') {
    const config = loadConfig(root), names = profileNames(config);
    if (args.length > 1) throw new Error(`usage: ${NAME} profile [<name|default>]  (names: ${names.join(', ')})`);
    if (!args.length) return showProfile(root, config);
    if (arg !== 'default' && !names.includes(arg!)) throw new Error(`profile: unknown profile "${arg}" (known: ${names.join(', ')}, or default)`);
    patch = { profile: arg! };
  } else if (cmd === 'lanes') {
    if (args.length !== 1) throw new Error(`usage: ${NAME} lanes <n|default>  (n: 0-${MAX_LANES})`);
    if (arg !== 'default' && !/^\d+$/.test(arg!)) throw new Error(`lanes: "${arg}" is not a number from 0 to ${MAX_LANES} or "default"`);
    patch = { maxParallel: arg === 'default' ? null : Number(arg) };
  } else {
    if (args.length) throw new Error(`usage: ${NAME} ${cmd}`);
    patch = { paused: cmd === 'pause-all' };
  }
  const config = loadConfig(root), def = Math.max(1, config.maxParallel), before = readControlFile(root, config);
  const c = await writeControl(root, patch, 'cli', config);
  if (!before.ok) console.log(`note: ${before.error}; rewritten (the other settings are back to their defaults)`);
  const running = load(root).features.filter((f) => IN_FLIGHT.includes(f.status)).length, limit = effectiveLimit(c, config);
  const state = c.paused ? 'paused: no new features start' : limit === 0 ? 'lanes 0: no new features start' : `up to ${limit} in flight`;
  const lanes = c.maxParallel == null ? `${def} (default)` : `${c.maxParallel} (default ${def})`;
  const note = !running ? 'nothing running' : limit === 0 ? `${running} still running will finish`
    : running > limit ? `${running} running will finish; no new ones start until fewer than ${limit} are running` : `${running} running`;
  let foreman = false;
  try { foreman = pidAlive(parseInt(readFileSync(paths(root).foreman, 'utf8'), 10)); } catch {} // no .foreman: none running
  console.log(`${state}; lanes ${lanes}; ${note}${foreman ? '' : ' (no foreman running; applies when one starts)'}`);
  if (cmd === 'profile') await showProfile(root, config, foreman);
}

// The active profile and what each role runs with under it (new launches only: running features keep the one they started with).
async function showProfile(root: string, config: Config, foreman?: boolean): Promise<void> {
  const cr = readControlFile(root, config), { observerConfig } = await import('./observe.ts');
  if (!cr.ok) console.log(`profile unknown: ${cr.error}; the foreman keeps its last good profile (rewrite it with ${NAME} profile <name|default>)`);
  else {
    const p = cr.control.profile ?? null, agentOn = !!config.observer?.agent; // observer rows: only with an agent, else what --agent would use
    console.log(`profile ${profileLine(p)}${foreman === undefined ? '' : `: applies to new launches${foreman ? '; running features keep theirs' : ''}`}`);
    for (const r of roleTable(config, p, observerConfig(config, { agent: true }).agent))
      console.log(`  ${r.role.padEnd(11)}${(r.model ?? '-').padEnd(8)}${r.effort ?? '-'}${r.effortHigh ? ` (${r.effortHigh} when risky)` : ''}${
        !agentOn && (r.role === 'observer' || r.role === 'curator') ? ' (observe --agent)' : ''}`);
  }
  console.log(`profiles: ${profileNames(config).join(', ')}`);
  console.log(riskyLine(load(root).features));
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
  root: { type: 'string' }, port: { type: 'string' }, agent: { type: 'boolean' } }, strict: !['hook', 'lanes'].includes(argv[0]!) });
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
    case 'pause-all': case 'resume-all': case 'lanes': case 'profile': await control(argv[0], argv.slice(1)); break;
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
