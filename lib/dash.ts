// Dashboard: one page across every project under --root, bound to 127.0.0.1.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, load, loadConfig, STATE_DIRS, NAME, mutate, log, tailLines, errMsg, pidAlive, readJson, readControlFile, writeControl, effectiveLimit, validLanes, MAX_LANES } from './state.ts';
import { analyze, taskReach } from './ready.ts';
import { act, ACTIONS, type Action } from './actions.ts';
import { observerPaths, observerConfig, recurringTests, hotFiles, type ObserverState, type Era } from './observe.ts';
import { promptSummary, type PromptSummary } from './promptreview.ts';
import { readNotes } from './notes.ts';
import { profileNames, profileLabel, roleTable, validProfile, type RoleRow } from './profiles.ts';
import { IN_FLIGHT, type ActivityEvent, type Config, type Control, type Diagnosis, type Feature, type HumanTask, type LogEvent, type MergeMode, type RoleConfig } from './types.ts';

// Median durations (ms) of each pipeline stage, for the dashboard's estimated progress; null = no history yet.
export interface Estimates { build: number | null; test: number | null; eval: number | null }
export interface ProjectState {
  path: string; name: string; merge?: MergeMode; branchPrefix?: string; error?: string; features: Feature[]; tasks: HumanTask[];
  ready: string[]; waiting: string[]; activity: ActivityEvent[]; events: LogEvent[];
  config?: Pick<Config, 'base' | 'maxParallel' | 'maxAttempts' | 'groupBy'> & { builder: RoleConfig; evaluator: RoleConfig };
  foreman: { running: boolean; since: string | null };
  stageSince: Record<string, string>;  // in-flight feature id → ISO start of its current stage
  estimates: Estimates;
  hasProjectView: boolean;
  repoUrl?: string;                    // https://github.com/<owner>/<repo>, from the origin remote
  stats: Stats;
  observer: ObserverSummary | null;    // null when the observer has never run here
  control?: ControlState;              // control.json with what it means now (absent when the state files are unreadable)
  inFlight?: number;                   // features building, testing or evaluating
}
// A person's pause / lanes (control.json): effective = how many may be in flight now (0 while paused); configMax = config.maxParallel.
// An invalid file is reported as `invalid` (the reason) with effective null: the foreman then keeps its last good control, or
// holds all new work if it started with this file, so the page must not show the defaults as if they applied.
// profile: the active model profile (null = opus; also null while the file is invalid); roles: what each role runs with under it;
// profiles: every selectable profile, opus first, with its label ("Opus", "Fable + Sonnet", else the name) and role table.
export type ControlState = Pick<Control, 'paused' | 'maxParallel' | 'updatedAt' | 'by'> & { effective: number | null; configMax: number; invalid?: string;
  profile: string | null; roles: RoleRow[]; profiles: ProfileInfo[]; observerAgent: boolean /* config.observer.agent set; else the observer rows are what `observe --agent` would use */ };
export interface ProfileInfo { name: string; label: string; roles: RoleRow[] }
export interface ObserverSummary {
  updatedAt: string; running: boolean; alerts24h: { ts: string; text: string }[]; stuck: { id: string; cause: string; evidence: string }[];
  decisions: Diagnosis[]; causes24h: { cause: string; n: number }[]; recurring: { test: string; features: string[] }[];
  improvements: { id: string; title: string; status: string }[]; sentBack24h: number; bounces24h: number; hotFiles: { file: string; n: number }[]; improveAt?: string; agentNotes?: string; agents: Era[]; prompts: PromptSummary; proposals: { id: string; title: string }[];
  conflicts24h: Conflict[]; titles: Record<string, string>; // titles: feature id → title, for every id the view shows
}
// One merge conflict followed to its outcome (see conflictTimeline). `resolving`: the resolver is working on it right now.
export interface Conflict {
  feature: string; title?: string; ts: string; files: string[]; resolvedBy: 'resolver' | 'builder' | null; resolving?: boolean; note?: string;
  outcome: 'merged' | 'resolved' | 'resolved then stuck' | 'failed' | 'conflicted again' | 'still open'; outcomeTs?: string; stuckCause?: string; ms: number;
}
export interface Stats { mergedAt: string[]; costToday: number; costYesterday: number }
export interface Run {
  n: number; role: 'build' | 'eval'; at: string; ms: number | null; cost: number | null; turns: number | null; model: string | null;
  pass?: boolean; findings?: { check: string; ok: boolean; note?: string }[]; summary: string;
}
export type OpenTask = HumanTask & { project: string; projectName: string; reach: number };

const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
const isWorktree = (dir: string) => { try { return statSync(join(dir, '.git')).isFile(); } catch { return false; } };

const HUMAN = ['start', 'done', 'reopen', 'step', 'wait', 'unwait'] as const;
const CONTROL = ['pause', 'resume', 'lanes', 'profile'] as const;

export function controlState(dir: string, config: Config): ControlState {
  const r = readControlFile(dir, config), configMax = Math.max(1, config.maxParallel), agent = observerConfig(config, { agent: true }).agent;
  const profiles = profileNames(config).map((name) => ({ name, label: profileLabel(name), roles: roleTable(config, name, agent) }));
  const profile = r.ok ? r.control.profile ?? null : null, roles = profiles.find((p) => p.name === (profile ?? 'opus'))!.roles, observerAgent = !!config.observer?.agent;
  return r.ok ? { ...r.control, profile, effective: effectiveLimit(r.control, config), configMax, roles, profiles, observerAgent }
    : { paused: false, maxParallel: null, effective: null, configMax, invalid: r.error, profile, roles, profiles, observerAgent };
}
// Page scripts, styles and pixel art under lib/dash/ and lib/assets/, served at /dash/* and /assets/*.
const ASSET_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png' };

export function discover(root: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (STATE_DIRS.some((d) => existsSync(join(dir, d, 'features.json'))) && !isWorktree(dir)) found.push(dir);
    if (depth >= maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(dir, e.name), depth + 1);
  };
  walk(resolve(root), 0);
  return found.sort();
}

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const STAGE_EVENT: Record<string, string> = { building: 'launch', testing: 'testing', evaluating: 'evaluating' };
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const readLog = (dir: string, n: number) => tailLines(paths(dir).log, n).map(tryJson).filter(Boolean) as LogEvent[];

// Every raw `claude -p` output under <state dir>/runs/<feature>/<n>-(build|eval).json.
function runFiles(dir: string): { file: string; mtime: number }[] {
  const runs = paths(dir).runs, files: { file: string; mtime: number }[] = [];
  try {
    for (const f of readdirSync(runs, { withFileTypes: true })) if (f.isDirectory())
      for (const r of readdirSync(join(runs, f.name))) if (/-(build|eval)\.json$/.test(r)) {
        const file = join(runs, f.name, r);
        try { files.push({ file, mtime: statSync(file).mtimeMs }); } catch {}
      }
  } catch {}
  return files;
}

// Build/eval medians come from the last 200 raw `claude -p` outputs (duration_ms); test from testing → evaluating log pairs.
const estCache = new Map<string, { at: number; est: Estimates }>();
function estimates(dir: string, events: LogEvent[]): Estimates {
  const hit = estCache.get(dir);
  if (hit && Date.now() - hit.at < 60000) return hit.est;
  const build: number[] = [], evals: number[] = [], tests: number[] = [];
  const files = runFiles(dir).sort((a, b) => b.mtime - a.mtime).slice(0, 200);
  for (const { file } of files) {
    try {
      const ms = (readJson(file, {}) as { duration_ms?: unknown }).duration_ms;
      if (typeof ms === 'number' && ms > 0) (file.endsWith('-build.json') ? build : evals).push(ms);
    } catch {}
  }
  const started = new Map<string, number>();
  for (const e of events) {
    if (!e.feature) continue;
    if (e.event === 'testing') started.set(e.feature, Date.parse(e.ts));
    else if (e.event === 'evaluating' && started.has(e.feature)) { tests.push(Date.parse(e.ts) - started.get(e.feature)!); started.delete(e.feature); }
  }
  const est = { build: median(build), test: median(tests), eval: median(evals) };
  estCache.set(dir, { at: Date.now(), est });
  return est;
}

// Merges in the last 48h and run cost by local day (file mtime), cached like estimates.
const statsCache = new Map<string, { at: number; stats: Stats }>();
function statsOf(dir: string): Stats {
  const hit = statsCache.get(dir);
  if (hit && Date.now() - hit.at < 60000) return hit.stats;
  const now = Date.now(), midnight = new Date(now).setHours(0, 0, 0, 0), yesterday = new Date(midnight - 12 * 3600000).setHours(0, 0, 0, 0);
  let costToday = 0, costYesterday = 0;
  for (const { file, mtime } of runFiles(dir)) {
    if (mtime < yesterday) continue;
    const c = (readJson(file, {}) as { total_cost_usd?: unknown }).total_cost_usd;
    if (typeof c === 'number' && Number.isFinite(c)) mtime >= midnight ? (costToday += c) : (costYesterday += c);
  }
  const mergedAt = readLog(dir, 2000).filter((e) => e.event === 'merged' && Date.parse(e.ts) >= now - 48 * 3600000).map((e) => e.ts);
  const stats = { mergedAt, costToday, costYesterday };
  statsCache.set(dir, { at: now, stats });
  return stats;
}

// https://github.com/<owner>/<repo> from the project's origin remote (.git/config), cached by config mtime.
const repoCache = new Map<string, { mtime: number; url: string | undefined }>();
function repoUrl(dir: string): string | undefined {
  const file = join(dir, '.git', 'config');
  try {
    const mtime = statSync(file).mtimeMs, hit = repoCache.get(dir);
    if (hit && hit.mtime === mtime) return hit.url;
    const m = /\[remote "origin"\][^\[]*?\burl\s*=\s*(\S+)/.exec(readFileSync(file, 'utf8'));
    const g = m && /^(?:git@github\.com:|https:\/\/(?:[^@\/]+@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(m[1]!);
    const url = g ? `https://github.com/${g[1]}/${g[2]}` : undefined;
    repoCache.set(dir, { mtime, url });
    return url;
  } catch { return undefined; }
}

// Start of each in-flight feature's current stage: its stage's log event after its last launch, else updatedAt.
function stageSince(features: Feature[], events: LogEvent[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of features) {
    const want = STAGE_EVENT[f.status];
    if (!want) continue;
    let since: string | null = null;
    for (const e of events) if (e.feature === f.id) {
      if (e.event === 'launch') since = want === 'launch' ? e.ts : null;
      else if (e.event === want) since = e.ts;
    }
    out[f.id] = since ?? f.updatedAt;
  }
  return out;
}

function foreman(dir: string): ProjectState['foreman'] {
  try {
    const file = paths(dir).foreman, pid = parseInt(readFileSync(file, 'utf8'), 10);
    return pidAlive(pid) ? { running: true, since: new Date(statSync(file).mtimeMs).toISOString() } : { running: false, since: null };
  } catch { return { running: false, since: null }; }
}

// Every merge conflict that started in the last 24 h, newest first, each followed to its outcome from the feature's own events:
// `refreshed` "conflicts in: …" opens it; `resolved` = the resolver finished it (`resolving` = it is working on it), `resolve-failed` or the
// next `launch` with no resolver result = the builder (its `keep-check` ok = kept, anything else = lines lost, noted). Outcome: the first
// later `merged` = merged; another conflict = conflicted again (it opens its own row); `stuck` "too many base refreshes" = failed (the
// foreman gave up); any other `stuck` is not final (a retry picks it up again): until a `launch`/`retrying` clears it, a resolved row
// reads "resolved then stuck" (ms up to the stuck). Else "resolved" once resolved, else "still open" (ms runs to now).
export function conflictTimeline(events: LogEvent[], now: number, titles: Record<string, string> = {}): Conflict[] {
  const since = now - 24 * 3600e3, rows: Conflict[] = [], open = new Map<string, { row: Conflict; done: boolean }>();
  const close = (f: string, outcome: Conflict['outcome'], ts: string) => { const o = open.get(f)!; o.row.outcome = outcome; o.row.outcomeTs = ts; o.row.ms = Date.parse(ts) - Date.parse(o.row.ts); delete o.row.resolving; open.delete(f); };
  const note = (r: Conflict, n: string) => { r.note = r.note ? r.note + '; ' + n : n; };
  for (const e of events) {
    const f = e.feature;
    if (!f) continue;
    const conflicted = e.event === 'refreshed' && e.detail.startsWith('conflicts in: '), giveUp = e.event === 'stuck' && e.detail.startsWith('too many base refreshes');
    if (open.has(f) && (conflicted || e.event === 'merged' || giveUp)) {
      if (giveUp) note(open.get(f)!.row, 'gave up after too many conflicts');
      close(f, conflicted ? 'conflicted again' : giveUp ? 'failed' : 'merged', e.ts);
    }
    if (conflicted) {
      const row: Conflict = { feature: f, ...(titles[f] ? { title: titles[f] } : {}), ts: e.ts, files: e.detail.slice(14).split(',').map((x) => x.trim()).filter(Boolean), resolvedBy: null, outcome: 'still open', ms: 0 };
      open.set(f, { row, done: false });
      if (Date.parse(e.ts) >= since) rows.push(row);
      continue;
    }
    const o = open.get(f);
    if (!o) continue;
    const r = o.row;
    if (e.event === 'resolving') r.resolving = true;
    else if (e.event === 'resolved') { r.resolvedBy = 'resolver'; delete r.resolving; o.done = true; }
    else if (e.event === 'resolve-failed') { r.resolvedBy = 'builder'; delete r.resolving; note(r, e.detail); }
    else if (e.event === 'launch') { r.resolvedBy ??= 'builder'; delete r.resolving; o.done = true; delete r.stuckCause; delete r.outcomeTs; }
    else if (e.event === 'keep-check') { if (e.detail.startsWith('ok')) o.done = true; else note(r, e.detail); }
    else if (e.event === 'stuck') { r.outcomeTs = e.ts; r.stuckCause = e.detail.split('\n')[0]!.slice(0, 120); }
    else if (e.event === 'retrying' || e.event === 'resumed') { delete r.stuckCause; delete r.outcomeTs; }
  }
  for (const { row, done } of open.values()) {
    row.outcome = !done ? 'still open' : row.stuckCause ? 'resolved then stuck' : 'resolved';
    row.ms = (row.outcome === 'resolved then stuck' ? Date.parse(row.outcomeTs!) : now) - Date.parse(row.ts);
  }
  return rows.reverse();
}

// The observer's summary for the Observer view; null when it has not run here or its file is unreadable.
function observer(dir: string, features: Feature[], tasks: HumanTask[], events: LogEvent[]): ObserverSummary | null {
  try {
    const O = observerPaths(dir);
    if (!existsSync(O.state)) return null;
    const o = readJson(O.state, null) as Partial<ObserverState> | null;
    if (!o || typeof o !== 'object') return null;
    const titles = Object.fromEntries(features.map((f) => [f.id, f.title]));
    const diags = Array.isArray(o.diagnoses) ? o.diagnoses : [], since = Date.now() - 24 * 3600e3, recent = diags.filter((d) => Date.parse(d.ts) >= since);
    let running = false;
    try { running = pidAlive(parseInt(readFileSync(O.pid, 'utf8'), 10)); } catch {}
    const lastFor = (id: string) => [...diags].reverse().find((d) => d.feature === id && d.action !== 'none: the foreman retries it');
    const causes = new Map<string, number>();
    for (const d of recent) causes.set(d.cause, (causes.get(d.cause) ?? 0) + 1);
    return { updatedAt: new Date(statSync(O.state).mtimeMs).toISOString(), running,
      alerts24h: (Array.isArray(o.alerts) ? o.alerts : []).filter((a) => Date.parse(a.ts) >= since).reverse(),
      stuck: features.filter((f) => f.status === 'stuck').map((f) => { const d = lastFor(f.id); return { id: f.id, cause: d?.cause ?? 'unknown', evidence: d?.evidence ?? (f.lastFeedback || '').split('\n')[0]!.slice(0, 200) }; }),
      decisions: diags.filter((d) => d.action && d.action !== 'none: the foreman retries it').slice(-15).reverse(),
      causes24h: [...causes].map(([cause, n]) => ({ cause, n })).sort((a, b) => b.n - a.n),
      recurring: recurringTests(diags, since, 2).map(([test, features]) => ({ test, features })),
      improvements: (Array.isArray(o.improvements) ? o.improvements : []).slice(-10).reverse().map((id) => { const f = features.find((x) => x.id === id); return { id, title: f?.title ?? '(removed)', status: f?.status ?? 'removed' }; }), sentBack24h: recent.filter((d) => d.action === 'sent back').length,
      ...(() => { const b = (Array.isArray(o.bounces) ? o.bounces : []).filter((x) => Date.parse(x.ts) >= since); return { bounces24h: b.length, hotFiles: hotFiles(b).slice(0, 5).map(([file, n]) => ({ file, n })) }; })(),
      ...(o.improveAt ? { improveAt: o.improveAt } : {}), agents: Array.isArray(o.agents) ? o.agents : [], prompts: promptSummary(o, (model, role) => readNotes(dir, model, role) ?? ''), ...(o.agentNotes ? { agentNotes: o.agentNotes } : {}),
      proposals: tasks.filter((t) => t.status === 'open' && t.id.startsWith('observer-')).map((t) => ({ id: t.id, title: t.title })),
      conflicts24h: conflictTimeline(events.filter((e) => Date.parse(e.ts) >= since - 3600e3), Date.now(), titles), titles };
  } catch { return null; }
}

const projectViewFile = (dir: string) => join(paths(dir).dir, 'project-view.html');

function projectState(dir: string): ProjectState {
  const base = { path: dir, name: basename(dir), features: [], tasks: [], ready: [], waiting: [], activity: [], events: [],
    foreman: foreman(dir), stageSince: {}, estimates: { build: null, test: null, eval: null }, hasProjectView: existsSync(projectViewFile(dir)),
    stats: { mergedAt: [], costToday: 0, costYesterday: 0 }, observer: null as ObserverSummary | null, ...(repoUrl(dir) ? { repoUrl: repoUrl(dir) } : {}) };
  try {
    const { config, features, tasks } = load(dir);
    const a = analyze(features, tasks, config.merge), all = readLog(dir, 20000), events = all.slice(-2000);
    return { ...base, merge: config.merge, branchPrefix: config.branchPrefix, features, tasks, ready: a.ready, waiting: a.waiting,
      activity: tailLines(paths(dir).activity, 200).map(tryJson).filter(Boolean) as ActivityEvent[], events: events.slice(-80),
      config: { base: config.base, maxParallel: config.maxParallel, maxAttempts: config.maxAttempts, groupBy: config.groupBy,
        builder: config.builder, evaluator: config.evaluator },
      stageSince: stageSince(features, events), estimates: estimates(dir, events), stats: statsOf(dir), observer: observer(dir, features, tasks, all),
      control: controlState(dir, config), inFlight: features.filter((f) => IN_FLIGHT.includes(f.status)).length };
  } catch (e) {
    return { ...base, error: errMsg(e) };
  }
}

// One feature's runs (last 20), parsed from runs/<id>/<n>-(build|eval).json; build before eval within a try.
function featureRuns(dir: string, id: string): Run[] {
  if (!/^[\w.-]+$/.test(id) || id.startsWith('..')) return [];
  const rd = join(paths(dir).runs, id), out: Run[] = [];
  let names: string[] = [];
  try { names = readdirSync(rd); } catch { return []; }
  for (const name of names) {
    const m = /^(\d+)(?:\.\d+)?-(build|eval)\.json$/.exec(name);
    if (!m) continue;
    try {
      const file = join(rd, name), j = readJson(file, {}) as { duration_ms?: unknown; total_cost_usd?: unknown; num_turns?: unknown; modelUsage?: unknown; result?: unknown };
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const role = m[2] as Run['role'], text = typeof j.result === 'string' ? j.result : '';
      const run: Run = { n: Number(m[1]), role, at: new Date(statSync(file).mtimeMs).toISOString(), ms: num(j.duration_ms), cost: num(j.total_cost_usd),
        turns: num(j.num_turns), model: j.modelUsage && typeof j.modelUsage === 'object' ? Object.keys(j.modelUsage)[0] ?? null : null, summary: text.slice(0, 400) };
      if (role === 'eval') {
        const v = tryJson(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { pass?: unknown; findings?: unknown } | undefined;
        if (v && typeof v === 'object') {
          if (typeof v.pass === 'boolean') run.pass = v.pass;
          if (Array.isArray(v.findings)) run.findings = v.findings.filter((f): f is { check: string; ok: boolean; note?: string } => !!f && typeof f.check === 'string' && typeof f.ok === 'boolean')
            .map((f) => ({ check: f.check, ok: f.ok, ...(typeof f.note === 'string' ? { note: f.note } : {}) }));
          if (run.pass !== undefined || run.findings) run.summary = '';
        }
      }
      out.push(run);
    } catch {}
  }
  return out.sort((a, b) => a.n - b.n || (a.role === b.role ? 0 : a.role === 'build' ? -1 : 1)).slice(-20);
}

// One feature's history for the detail panel.
export function featureHistory(dir: string, id: string): { log: LogEvent[]; activity: ActivityEvent[]; runs: Run[] } {
  return { log: readLog(dir, 2000).filter((e) => e.feature === id).slice(-60),
    activity: (tailLines(paths(dir).activity, 2000).map(tryJson).filter(Boolean) as ActivityEvent[]).filter((a) => a.feature === id).slice(-40),
    runs: featureRuns(dir, id) };
}

export function state(root: string): { projects: ProjectState[]; human: OpenTask[] } {
  const projects = discover(root).map(projectState);
  const human = projects.flatMap((p) => p.tasks
    .map((t): OpenTask => ({ ...t, project: p.path, projectName: p.name, reach: taskReach(t, p.features) })))
    .sort((a, b) => b.reach - a.reach || a.id.localeCompare(b.id)); // done ones included; the page filters
  return { projects, human };
}

export function startDash({ root = process.cwd(), port = 7420 } = {}): Promise<{ server: Server; url: string }> {
  root = resolve(root);
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = 'application/json', headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
    };
    try {
      const p = (server.address() as AddressInfo).port;
      const hosts = [`127.0.0.1:${p}`, `localhost:${p}`];
      if (req.headers.origin && !hosts.map((h) => `http://${h}`).includes(req.headers.origin)) return send(403, { error: 'foreign origin' });
      if (!hosts.includes(req.headers.host!)) return send(403, { error: 'unexpected host' }); // DNS rebinding
      const url = new URL(req.url!, 'http://x'), q = (k: string) => url.searchParams.get(k) ?? '';
      if (req.method === 'GET' && url.pathname === '/') return send(200, page(), 'text/html; charset=utf-8');
      const asset = req.method === 'GET' && /^\/(dash|assets)\/([a-z0-9-]+)\.(js|css|png)$/.exec(url.pathname);
      if (asset) {
        const f = join(HERE, asset[1]!, `${asset[2]}.${asset[3]}`);
        return existsSync(f) ? send(200, readFileSync(f) as unknown as string, ASSET_TYPES[asset[3]!]!) : send(404, { error: 'not found' });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, state(root));
      if (req.method === 'GET' && (url.pathname === '/api/feature' || url.pathname === '/project-view')) {
        if (!discover(root).includes(q('project'))) return send(400, { error: 'unknown project' });
        if (url.pathname === '/api/feature') return send(200, featureHistory(q('project'), q('id')));
        const f = projectViewFile(q('project'));
        // CSP sandbox gives the page an opaque origin even when opened directly, so it can't POST to this API.
        return existsSync(f) ? send(200, readFileSync(f, 'utf8'), 'text/html; charset=utf-8', { 'content-security-policy': 'sandbox allow-scripts' })
          : send(404, { error: 'no project view' });
      }
      const action = ACTIONS.find((a) => req.url === `/api/feature/${a}`);
      const ctl = CONTROL.find((c) => req.url === `/api/control/${c}`);
      if (req.method !== 'POST' || (!action && !ctl && ![...HUMAN.map((h) => `/api/human/${h}`), '/api/feature/merged'].includes(req.url!))) return send(404, { error: 'not found' });
      let body = '';
      for await (const c of req) { body += c; if (body.length > 10000) return send(413, { error: 'body too large' }); }
      const parsed = (tryJson(body) || {}) as { project?: unknown; id?: unknown; step?: unknown; on?: unknown; who?: unknown; maxParallel?: unknown; profile?: unknown };
      const { project, id, step, on, who } = parsed;
      if (typeof project !== 'string' || !discover(root).includes(project)) return send(400, { error: 'unknown project' });
      if (ctl) { // pause / resume new launches, set the lanes (null = config default) or the model profile (null = opus); the
        // foreman re-reads control.json every tick and applies a profile to new launches only
        if (ctl === 'lanes' && !('maxParallel' in parsed && validLanes(parsed.maxParallel)))
          return send(400, { error: `maxParallel must be an integer from 0 to ${MAX_LANES}, or null for the config default` });
        const config = loadConfig(project); // before the write: an unreadable config fails the request without changing anything
        if (ctl === 'profile' && !('profile' in parsed && validProfile(config, parsed.profile)))
          return send(400, { error: `profile must be one of ${profileNames(config).join(', ')}, or null for opus (is ${JSON.stringify(parsed.profile)})` });
        await writeControl(project, ctl === 'lanes' ? { maxParallel: parsed.maxParallel as number | null } : ctl === 'profile' ? { profile: parsed.profile as string | null }
          : { paused: ctl === 'pause' }, 'dashboard', config);
        return send(200, { ok: true, control: controlState(project, config) });
      }
      if (typeof id !== 'string') return send(400, { error: 'id must be a string' });
      if (action) {
        const err = (await act(project, action as Action, [id]))[id];
        return send(err ? (err === 'unknown feature' ? 404 : 409) : 200, err ? { error: `${id}: ${err}` } : { ok: true });
      }
      if (req.url!.startsWith('/api/human/')) {
        const what = req.url!.slice('/api/human/'.length) as (typeof HUMAN)[number];
        if (what === 'step' && !(Number.isInteger(step) && (step as number) >= 0 && typeof on === 'boolean')) return send(400, { error: 'step must be an index and on a boolean' });
        const waitee = typeof who === 'string' ? who.trim() : '';
        if (what === 'wait' && (!waitee || waitee.length > 200)) return send(400, { error: 'who must be a non-empty string of at most 200 characters' });
        const code = await mutate(project, 'human', (d) => {
          const t = d.tasks.find((x) => x.id === id);
          if (!t) return 404;
          const now = new Date().toISOString();
          if (what === 'done') { if (t.status !== 'done') Object.assign(t, { status: 'done', doneAt: now }); delete t.waitingOn; delete t.waitingSince; }
          else if (what === 'reopen') { t.status = 'open'; delete t.doneAt; delete t.waitingOn; delete t.waitingSince; }
          else if (what === 'wait') {
            if (t.status === 'done') return 409;
            Object.assign(t, { waitingOn: waitee, waitingSince: now });
            t.startedAt ??= now;
          }
          else if (what === 'unwait') { delete t.waitingOn; delete t.waitingSince; }
          else if (what === 'start') t.startedAt ??= now;
          else {
            if ((step as number) >= t.steps.length) return 400;
            const set = new Set(t.checked || []);
            on ? set.add(step as number) : set.delete(step as number);
            t.checked = [...set].sort((a, b) => a - b);
            if (on && t.status === 'open') t.startedAt ??= now;
          }
          return 200;
        });
        if (code === 200 && what !== 'step') log(project, null, `human-${what}`, id);
        return send(code, code === 200 ? { ok: true } : { error: code === 404 ? `unknown human task ${id}` : code === 409 ? `human task ${id} is already done` : 'no such step' });
      }
      if (load(project).config.merge !== 'manual') return send(409, { error: 'this project merges automatically' });
      const code = await mutate(project, 'features', (d) => {
        const f = d.features.find((x) => x.id === id);
        if (!f) return 404;
        if (f.status !== 'ready') return 409;
        Object.assign(f, { status: 'merged', updatedAt: new Date().toISOString() });
        return 200;
      });
      if (code === 200) log(project, id, 'merged', 'marked merged from the dashboard');
      return send(code, code === 200 ? { ok: true } : { error: code === 404 ? `unknown feature ${id}` : `${id} is not ready` });
    } catch (e) {
      send(500, { error: errMsg(e) });
    }
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

// The page lives in dash.html; re-read on each request so edits show on reload.
const page = () => readFileSync(join(HERE, 'dash.html'), 'utf8').replaceAll('{{NAME}}', NAME);
