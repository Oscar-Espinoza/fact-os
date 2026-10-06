// Dashboard: one page across every project under --root, bound to 127.0.0.1.
import { applySpecFix, dismissSpecFix, specFixMode, undoProblem, undoSpecFix } from './specfix.ts';
import { readAtoms, readIfExists } from './context.ts';
import type { Scorecard } from './scorecard.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, load, loadConfig, STATE_DIRS, NAME, mutate, log, tailLines, errMsg, pidAlive, readJson, readControlFile, writeControl, withCheckoutLock, effectiveLimit, validLanes, MAX_LANES, readSetupState, releaseSetupHold, type SetupState } from './state.ts';
import { git, parseClaudeOutput, parseVerdict, feedbackFromVerdict, parseResponses } from './foreman.ts';
import { conflictFiles } from './merge.ts';
import { analyze, taskReach, specHash } from './ready.ts';
import { act, ACTIONS, type Action } from './actions.ts';
import { observerPaths, observerConfig, recurringTests, hotFiles, unpricedRun, type ObserverState, type Era } from './observe.ts';
import { promptSummary, type PromptSummary } from './promptreview.ts';
import { readNotes } from './notes.ts';
import { buildStory, transitions, queueNote, whoOf, type Story, type StoryRun, type Transition } from './story.ts';
import { profileNames, profileLabel, roleTable, validProfile, type RoleRow } from './profiles.ts';
import { IN_FLIGHT, type ActivityEvent, type Config, type Control, type Diagnosis, type Feature, type Finding, type HumanTask, type LogEvent, type MergeMode, type RoleConfig } from './types.ts';

// Median durations (ms) of each pipeline stage, for the dashboard's estimated progress; null = no history yet.
export interface Estimates { build: number | null; test: number | null; eval: number | null }
export interface ProjectState {
  path: string; name: string; merge?: MergeMode; branchPrefix?: string; error?: string; features: Feature[]; tasks: HumanTask[];
  ready: string[]; waiting: string[]; activity: ActivityEvent[]; events: LogEvent[];
  transitions: Transition[];           // the last meaningful changes, one plain line each (story.ts)
  queueNotes: Record<string, string>;  // todo feature id → why it is queued or waiting, in one line
  running: Record<string, string>;     // in-flight feature id → who is working on it now ("Built by Sonnet · high")
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
  setupHold?: SetupState['hold'];          // the foreman's launch hold after repeated setup failures (null = none)
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
  improvements: { id: string; title: string; status: string }[]; sentBack24h: number; bounces24h: number; hotFiles: { file: string; n: number }[]; improveAt?: string; agentNotes?: string; agents: Era[]; prompts: PromptSummary; proposals: { id: string; title: string }[]; holds: { id: string; cause: string; confidence: string; evidence: string[] }[];
  conflicts24h: Conflict[]; titles: Record<string, string>; // titles: feature id → title, for every id the view shows
  scorecard?: Scorecard;
  // What the factory learned and changed: context pointers by status, and its latest learning events (pointers, notes, escalations).
  learning: { atoms: Record<string, number>; recent: { ts: string; text: string }[] };
}
// One merge conflict followed to its outcome (see conflictTimeline). `resolving`: the resolver is working on it right now.
export interface Conflict {
  feature: string; title?: string; ts: string; files: string[]; resolvedBy: 'resolver' | 'builder' | null; resolving?: boolean; note?: string;
  outcome: 'merged' | 'resolved' | 'resolved then stuck' | 'failed' | 'conflicted again' | 'still open'; outcomeTs?: string; stuckCause?: string; ms: number;
}
export interface Stats { mergedAt: string[]; costToday: number; costYesterday: number; unpricedToday?: number; unpricedYesterday?: number } // costs: reported USD; unpriced: Codex runs
export interface Run {
  n: number; tag: string; role: 'build' | 'eval' | 'resolve' | 'diagnose'; at: string; ms: number | null; cost: number | null; turns: number | null; model: string | null;
  provider?: string; unpriced?: boolean; // a Codex run: tokens recorded, USD unavailable (cost is null)
  effort?: string; usage?: Record<string, number>;
  pass?: boolean; findings?: Finding[]; error?: string; text: string; summary: string;
}
export type OpenTask = HumanTask & { project: string; projectName: string; reach: number };

const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
const isWorktree = (dir: string) => { try { return statSync(join(dir, '.git')).isFile(); } catch { return false; } };

const HUMAN = ['start', 'done', 'reopen', 'step', 'wait', 'unwait'] as const;
const CONTROL = ['pause', 'resume', 'lanes', 'profile', 'spec-fixes'] as const;
const SPEC_FIX = ['apply', 'dismiss', 'undo'] as const; // POST /api/spec-fix/<what> {project, id}: a person's decision

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
  let costToday = 0, costYesterday = 0, unpricedToday = 0, unpricedYesterday = 0;
  for (const { file, mtime } of runFiles(dir)) {
    if (mtime < yesterday) continue;
    const j = readJson(file, {}) as { total_cost_usd?: unknown; cost_status?: unknown; provider?: unknown }, c = j.total_cost_usd;
    if (unpricedRun(j)) { if (mtime >= midnight) unpricedToday++; else unpricedYesterday++; continue; }
    if (typeof c === 'number' && Number.isFinite(c)) mtime >= midnight ? (costToday += c) : (costYesterday += c);
  }
  const mergedAt = readLog(dir, 2000).filter((e) => e.event === 'merged' && Date.parse(e.ts) >= now - 48 * 3600000).map((e) => e.ts);
  const stats = { mergedAt, costToday, costYesterday, unpricedToday, unpricedYesterday };
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
      else if (want === 'launch' && ['gate-fix', 'commit-fix', 'review-fix', 'keep-fix', 'progress-fix', 'resolving'].includes(e.event)) since = e.ts; // a resumed builder or resolver
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
// later `merged` = merged; another conflict = conflicted again (it opens its own row); a refresh-limit `stuck` = failed (the
// foreman gave up); any other `stuck` is not final (a retry picks it up again): until a `launch`/`retrying` clears it, a resolved row
// reads "resolved then stuck" (ms up to the stuck). Else "resolved" once resolved, else "still open" (ms runs to now).
export function conflictTimeline(events: LogEvent[], now: number, titles: Record<string, string> = {}): Conflict[] {
  const since = now - 24 * 3600e3, rows: Conflict[] = [], open = new Map<string, { row: Conflict; done: boolean }>();
  const close = (f: string, outcome: Conflict['outcome'], ts: string) => { const o = open.get(f)!; o.row.outcome = outcome; o.row.outcomeTs = ts; o.row.ms = Date.parse(ts) - Date.parse(o.row.ts); delete o.row.resolving; open.delete(f); };
  const note = (r: Conflict, n: string) => { r.note = r.note ? r.note + '; ' + n : n; };
  for (const e of events) {
    const f = e.feature;
    if (!f) continue;
    const files = e.event === 'refreshed' ? conflictFiles(e.detail) : [];
    const conflicted = files.length > 0, giveUp = e.event === 'stuck' && /^merge conflict with \S+: too many base refreshes \(\d+\)$/.test(e.detail);
    if (open.has(f) && (conflicted || e.event === 'merged' || giveUp)) {
      if (giveUp) note(open.get(f)!.row, 'gave up after too many conflicts');
      close(f, conflicted ? 'conflicted again' : giveUp ? 'failed' : 'merged', e.ts);
    }
    if (conflicted) {
      const row: Conflict = { feature: f, ...(titles[f] ? { title: titles[f] } : {}), ts: e.ts, files, resolvedBy: null, outcome: 'still open', ms: 0 };
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
    else if (e.event === 'testing' && r.resolvedBy === null) { r.resolvedBy = 'builder'; o.done = true; }
    else if (e.event === 'keep-check') { if (e.detail.startsWith('ok')) o.done = true; else note(r, e.detail); }
    else if (e.event === 'stuck') { r.outcomeTs = e.ts; r.stuckCause = e.detail.split('\n')[0]!.slice(0, 120); }
    else if (e.event === 'retrying' || e.event === 'resumed' || e.event === 'observer-retry') { delete r.stuckCause; delete r.outcomeTs; }
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
      holds: features.filter((f) => f.status === 'todo' && f.planningHold).map((f) => ({ id: f.id, cause: f.planningHold!.cause, confidence: f.planningHold!.confidence, evidence: f.planningHold!.evidence })),
      conflicts24h: conflictTimeline(events.filter((e) => Date.parse(e.ts) >= since - 3600e3), Date.now(), titles), titles,
      ...(o.scorecard ? { scorecard: o.scorecard } : {}), learning: learningOf(dir, events) };
  } catch { return null; }
}

// Who is working on an in-flight feature right now, from its stage and this launch's invocations only: the builder or resolver
// while building, the reviewer since the latest evaluation started, a diagnoser while its diagnosis is pending. During the
// checks themselves no agent is working, so nothing is named.
export function currentWorker(f: Pick<Feature, 'id' | 'status'>, events: LogEvent[]): string | null {
  const mine = events.filter((e) => e.feature === f.id), launch = mine.map((e) => e.event).lastIndexOf('launch');
  const since = launch < 0 ? [] : mine.slice(launch + 1);
  const label = (e: LogEvent | undefined) => { const w = e && whoOf(e); return w ? `${w.role === 'evaluator' ? 'Reviewing' : w.role === 'resolver' ? 'Combining' : w.role === 'diagnoser' ? 'Diagnosing' : w.role === 'planner' ? 'Planning' : 'Building'}: ${w.who}` : null; };
  const prompts = (xs: LogEvent[], roles: string[]) => xs.filter((e) => e.event === 'prompt' && roles.includes(whoOf(e)?.role ?? ''));
  if (f.status === 'building') return label(prompts(since, ['builder', 'resolver', 'planner']).at(-1));
  if (f.status === 'evaluating') { const ev = since.map((e) => e.event).lastIndexOf('evaluating'); return ev < 0 ? null : label(prompts(since.slice(ev + 1), ['evaluator']).at(-1)); }
  const last = since.at(-1);
  return f.status === 'testing' && last?.event === 'prompt' && whoOf(last)?.role === 'diagnoser' ? label(last) : null;
}

// Learning, as a person reads it: verified pointers added or retired, notes rewritten, a fresh try escalated by the ladder.
function learningOf(dir: string, events: LogEvent[]): ObserverSummary['learning'] {
  const atoms: Record<string, number> = {};
  for (const a of readAtoms(paths(dir).dir).atoms) atoms[a.status] = (atoms[a.status] ?? 0) + 1;
  const text = (e: LogEvent): string | null => {
    if (e.event === 'observer-atom') { const m = /^(A\w+) (verified|retired|quarantined|proposed)(?: from \S+)?: (.*)$/.exec(e.detail || '');
      return m ? ({ verified: 'Added a verified pointer', retired: 'Retired a pointer', quarantined: 'Paused a pointer (its code changed)', proposed: 'Proposed a pointer' } as Record<string, string>)[m[2]!]! + `: ${m[3]}` : null; }
    if (e.event === 'observer-notes') return `Updated prompt notes for ${e.detail}`;
    if (e.event === 'spec-fix-applied') return `${e.feature}: spec fixed ${/^\S+ auto:/.test(e.detail || '') ? 'automatically' : 'by a person'}: ${(e.detail || '').replace(/^\S+ \w+: /, '')}`;
    if (e.event === 'spec-fix-undone') return `${e.feature}: a spec fix was undone`;
    if (e.event === 'spec-note-added') return `Learned a spec-writing rule (from ${e.feature}): ${e.detail}`;
    if (e.event === 'spec-note-retired') return `Retired a spec-writing rule a person kept overriding: ${e.detail}`;
    if (e.event === 'prompt' && e.run?.rule?.includes('→')) return `${e.feature}: fresh try escalated, ${e.run.rule.replace(/^ladder: /, '')}`;
    return null;
  };
  return { atoms, recent: events.flatMap((e) => { const t = text(e); return t ? [{ ts: e.ts, text: t }] : []; }).slice(-8).reverse() };
}

const projectViewFile = (dir: string) => join(paths(dir).dir, 'project-view.html');

function projectState(dir: string): ProjectState {
  const base = { path: dir, name: basename(dir), features: [], tasks: [], ready: [], waiting: [], activity: [], events: [], transitions: [] as Transition[], queueNotes: {} as Record<string, string>, running: {} as Record<string, string>,
    foreman: foreman(dir), stageSince: {}, estimates: { build: null, test: null, eval: null }, hasProjectView: existsSync(projectViewFile(dir)),
    stats: { mergedAt: [], costToday: 0, costYesterday: 0 }, observer: null as ObserverSummary | null, ...(repoUrl(dir) ? { repoUrl: repoUrl(dir) } : {}) };
  try {
    const { config, features, tasks } = load(dir);
    const a = analyze(features, tasks, config.merge), all = readLog(dir, 20000), events = all.slice(-2000);
    return { ...base, merge: config.merge, branchPrefix: config.branchPrefix, features, tasks, ready: a.ready, waiting: a.waiting,
      activity: tailLines(paths(dir).activity, 200).map(tryJson).filter(Boolean) as ActivityEvent[], events: events.slice(-80),
      transitions: transitions(events, Object.fromEntries(features.map((f) => [f.id, f.shortTitle || f.title])), config.maxAttempts, config.base, 12),
      running: Object.fromEntries(features.filter((f) => IN_FLIGHT.includes(f.status)).flatMap((f) => { const w = currentWorker(f, events); return w ? [[f.id, w]] : []; })),
      queueNotes: Object.fromEntries(features.flatMap((f) => {
        const unmet = (f.deps || []).map((d) => features.find((x) => x.id === d)).filter((x): x is Feature => !!x && x.status !== 'merged').map((x) => ({ title: x.shortTitle || x.title }));
        const task = tasks.find((t) => t.status === 'open' && !t.mockable && (t.unblocks || []).includes(f.id));
        const note = queueNote(f, config.maxAttempts, config.base, unmet, task?.title);
        return note ? [[f.id, note]] : [];
      })),
      config: { base: config.base, maxParallel: config.maxParallel, maxAttempts: config.maxAttempts, groupBy: config.groupBy,
        builder: config.builder, evaluator: config.evaluator },
      stageSince: stageSince(features, events), estimates: estimates(dir, events), stats: statsOf(dir), observer: observer(dir, features, tasks, all),
      control: controlState(dir, config), inFlight: features.filter((f) => IN_FLIGHT.includes(f.status)).length, setupHold: readSetupState(dir).hold };
  } catch (e) {
    return { ...base, error: errMsg(e) };
  }
}

// Last 20 completed artifacts, with full tags (also unique across attempt resets).
// `pass` validates provider/verdict content; raw files do not record every exit/timeout outcome.
function featureRuns(dir: string, id: string): Run[] {
  if (!/^[\w.-]+$/.test(id) || id.startsWith('..')) return [];
  const rd = join(paths(dir).runs, id), out: Run[] = [];
  let names: string[] = [];
  try { names = readdirSync(rd); } catch { return []; }
  for (const name of names) {
    const m = /^(\d+(?:\.\d+)?)-(build|eval|resolve|diagnose)\.json$/.exec(name);
    if (!m) continue;
    try {
      const file = join(rd, name), raw = readFileSync(file, 'utf8'), j = tryJson(raw) as { duration_ms?: unknown; total_cost_usd?: unknown; num_turns?: unknown; modelUsage?: unknown; stdout?: unknown; provider?: unknown; model?: unknown; cost_status?: unknown; effort?: unknown; usage?: unknown } | undefined;
      if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const role = m[2] as Run['role'], provider = parseClaudeOutput(raw), text = provider.text || (typeof j.stdout === 'string' ? j.stdout : '');
      const unpriced = unpricedRun(j);
      const run: Run = { n: Number(m[1]!.split('.')[0]), tag: m[1]!, role, at: new Date(statSync(file).mtimeMs).toISOString(), ms: num(j.duration_ms), cost: unpriced ? null : num(j.total_cost_usd),
        turns: num(j.num_turns), model: j.modelUsage && typeof j.modelUsage === 'object' ? Object.keys(j.modelUsage)[0] ?? null : typeof j.model === 'string' ? j.model : null, text, summary: text.slice(0, 400),
        ...(typeof j.provider === 'string' ? { provider: j.provider } : {}), ...(unpriced ? { unpriced: true } : {}),
        ...(typeof j.effort === 'string' ? { effort: j.effort } : {}), ...(j.usage && typeof j.usage === 'object' && !Array.isArray(j.usage) ? { usage: Object.fromEntries(Object.entries(j.usage as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number> } : {}) };
      if (role === 'eval') {
        const v = parseVerdict(provider.text);
        run.pass = provider.ok && v.pass;
        run.findings = provider.ok ? v.findings : [];
        if (!run.pass) run.error = provider.ok ? feedbackFromVerdict(v) : `evaluator failed: ${provider.error}`;
        if (!v.error && provider.ok) run.summary = '';
      }
      out.push(run);
    } catch {}
  }
  const order = { build: 0, resolve: 1, diagnose: 2, eval: 3 };
  const passIndex = (r: Run) => Number(r.tag.split('.')[1] ?? 1);
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.n - b.n || passIndex(a) - passIndex(b) || order[a.role] - order[b.role]).slice(-20);
}

// Every run artifact of a feature, with its parsed verdict, for the story (featureRuns keeps only the last 20 for the logs).
function storyRuns(dir: string, id: string): StoryRun[] {
  if (!/^[\w.-]+$/.test(id) || id.startsWith('..')) return [];
  const rd = join(paths(dir).runs, id);
  let names: string[] = [];
  try { names = readdirSync(rd); } catch { return []; }
  return names.flatMap((name) => {
    const m = /^(\d+(?:\.\d+)?)-(build|eval|resolve|diagnose)\.json$/.exec(name);
    if (!m) return [];
    try {
      const file = join(rd, name), p = parseClaudeOutput(readFileSync(file, 'utf8'));
      // A build whose last turn was a stray reply: its real Summary line, recovered from the transcript (see noteExit).
      // Its exit record also lists the files it touched and what it was unsure of: the row's outcome comes from those.
      const rec = m[2] === 'build' ? (tryJson(readIfExists(join(rd, `${m[1]}-build.exit.json`)) ?? '') as { recovered?: boolean; summary?: string; exit?: { touched?: unknown; unsure?: unknown; responses?: unknown } | null; findings?: unknown } | null) : null;
      const text = rec?.recovered && rec.summary ? `Summary: ${rec.summary}` : p.text;
      const touched = rec?.exit?.touched, unsure = rec?.exit?.unsure;
      return [{ tag: m[1]!, role: m[2] as StoryRun['role'], at: new Date(statSync(file).mtimeMs).toISOString(), text, verdict: m[2] === 'eval' && p.ok ? parseVerdict(p.text) : null,
        ...(Array.isArray(touched) ? { files: touched.length } : {}), ...(Array.isArray(unsure) ? { unsure: unsure.map(String) } : {}),
        ...(Array.isArray(rec?.findings) ? { asked: rec.findings.length, ...storedResponses(rec.exit?.responses) } : {}) }];
    } catch { return []; }
  });
}
// A review fix's stored answers (its exit record), re-validated: the record is a file on disk, so it is read fail-soft.
function storedResponses(v: unknown): { responses?: StoryRun['responses'] } {
  const keyed = Array.isArray(v) ? v as { key?: unknown; text?: unknown }[] : [];
  const rs = parseResponses(v).map((r) => { const o = keyed.find((x) => (x as { finding?: unknown }).finding === r.finding);
    return { ...r, ...(typeof o?.key === 'string' ? { key: o.key } : {}), ...(typeof o?.text === 'string' ? { text: o.text } : {}) }; });
  return rs.length ? { responses: rs } : {};
}
// A feature's goal and short title: its own fields, else the observer's cached summary while the spec it was made from is unchanged.
function goalOf(dir: string, f: Feature): { goal: string; shortTitle?: string } | null {
  if (f.goal) return { goal: f.goal, ...(f.shortTitle ? { shortTitle: f.shortTitle } : {}) };
  try {
    const o = readJson(observerPaths(dir).state, {}) as { goals?: Record<string, { hash: string; goal: string; shortTitle?: string }> }, g = o.goals?.[f.id];
    return g && g.hash === specHash(f) ? { goal: g.goal, ...(g.shortTitle ? { shortTitle: g.shortTitle } : {}) } : null;
  } catch { return null; }
}

// One feature's history for the detail panel.
export function featureHistory(dir: string, id: string): { log: LogEvent[]; activity: ActivityEvent[]; runs: Run[]; story: Story | null } {
  const all = readLog(dir, 50000).filter((e) => e.feature === id);
  let story: Story | null = null;
  try {
    const { config, features, tasks } = load(dir), f = features.find((x) => x.id === id);
    if (f) {
      const unmet = (f.deps || []).map((d) => features.find((x) => x.id === d)).filter((x): x is Feature => !!x && x.status !== 'merged').map((x) => ({ id: x.id, title: x.shortTitle || x.title }));
      story = buildStory({ feature: f, specFixMode: specFixMode(dir, config) ?? undefined, events: all, runs: storyRuns(dir, id), maxAttempts: config.maxAttempts, base: config.base, manualMerge: config.merge === 'manual',
        openTasks: tasks.filter((t) => t.status === 'open' && (t.unblocks || []).includes(id)).map((t) => ({ title: t.title, mockable: t.mockable })), unmetDeps: unmet, goal: goalOf(dir, f) });
      // Undo is offered exactly when the server would accept it (the whole spec unchanged since the fix).
      for (const r of story.fixes) r.undoable = r === story.fixes.at(-1) && !undoProblem(dir, config, f, r.id);
    }
  } catch { story = null; }
  return { story, log: all.slice(-60),
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
      const ctl = CONTROL.find((c) => req.url === `/api/control/${c}`), fix = SPEC_FIX.find((x) => req.url === `/api/spec-fix/${x}`);
      if (req.method !== 'POST' || (!action && !ctl && !fix && ![...HUMAN.map((h) => `/api/human/${h}`), '/api/feature/merged', '/api/setup/resume'].includes(req.url!))) return send(404, { error: 'not found' });
      let body = '';
      for await (const c of req) { body += c; if (body.length > 10000) return send(413, { error: 'body too large' }); }
      const parsed = (tryJson(body) || {}) as { project?: unknown; id?: unknown; step?: unknown; on?: unknown; who?: unknown; maxParallel?: unknown; profile?: unknown; specFixes?: unknown; fix?: unknown };
      const { project, id, step, on, who } = parsed;
      if (typeof project !== 'string' || !discover(root).includes(project)) return send(400, { error: 'unknown project' });
      if (ctl) { // pause / resume new launches, set the lanes (null = config default) or the model profile (null = opus); the
        // foreman re-reads control.json every tick and applies a profile to new launches only
        if (ctl === 'lanes' && !('maxParallel' in parsed && validLanes(parsed.maxParallel)))
          return send(400, { error: `maxParallel must be an integer from 0 to ${MAX_LANES}, or null for the config default` });
        if (ctl === 'spec-fixes' && parsed.specFixes !== 'manual' && parsed.specFixes !== 'auto') return send(400, { error: 'specFixes must be "manual" or "auto"' });
        const config = loadConfig(project); // before the write: an unreadable config fails the request without changing anything
        if (ctl === 'profile' && !('profile' in parsed && validProfile(config, parsed.profile)))
          return send(400, { error: `profile must be one of ${profileNames(config).join(', ')}, or null for opus (is ${JSON.stringify(parsed.profile)})` });
        await writeControl(project, ctl === 'lanes' ? { maxParallel: parsed.maxParallel as number | null } : ctl === 'profile' ? { profile: parsed.profile as string | null }
          : ctl === 'spec-fixes' ? { specFixes: parsed.specFixes as 'manual' | 'auto' }
          : { paused: ctl === 'pause' }, 'dashboard', config);
        return send(200, { ok: true, control: controlState(project, config) });
      }
      if (req.url === '/api/setup/resume') { // the environment is fixed: release the foreman's setup hold (fact-os setup-resume)
        const was = await releaseSetupHold(project, 'a person (dashboard)');
        return send(200, { ok: true, released: was });
      }
      if (typeof id !== 'string') return send(400, { error: 'id must be a string' });
      if (fix) { // apply / dismiss / undo name the proposal or fix they were shown (`fix`): an older click never acts on a newer one
        if (typeof parsed.fix !== 'string') return send(400, { error: 'fix must be the id of the proposal or applied fix shown' });
        const err = fix === 'undo' ? await undoSpecFix(project, id, parsed.fix) : fix === 'apply' ? await applySpecFix(project, id, parsed.fix as string, 'person') : await dismissSpecFix(project, id, parsed.fix as string);
        return send(err ? (err === 'unknown feature' ? 404 : 409) : 200, err ? { error: `${id}: ${err}` } : { ok: true });
      }
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
      const result = await withCheckoutLock(project, async () => {
        const { config, features } = load(project), f = features.find((x) => x.id === id);
        if (config.merge !== 'manual') return { code: 409, error: 'this project merges automatically' };
        if (!f) return { code: 404, error: `unknown feature ${id}` };
        if (f.status !== 'ready') return { code: 409, error: `${id} is not ready` };
        if (!f.sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(f.sha) ||
          git(['rev-parse', '--verify', '--quiet', `${f.sha}^{commit}`], project).code !== 0 ||
          git(['merge-base', '--is-ancestor', f.sha, `refs/heads/${config.base}`], project).code !== 0) {
          return { code: 409, error: `merge the recorded evaluated commit into ${config.base} before marking ${id} merged; a recorded commit SHA is required` };
        }
        const code = await mutate(project, 'features', (d) => {
          const current = d.features.find((x) => x.id === id);
          if (!current || current.status !== 'ready' || current.sha !== f.sha) return 409;
          Object.assign(current, { status: 'merged', updatedAt: new Date().toISOString() }); return 200;
        });
        if (code === 200) log(project, id, 'merged', 'evaluated commit verified on base; marked merged from the dashboard');
        return { code, error: `${id} changed while acknowledging its merge` };
      });
      return send(result.code, result.code === 200 ? { ok: true } : { error: result.error });
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
