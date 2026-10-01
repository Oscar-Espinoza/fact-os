// Observer: a second loop beside the foreman. It reads log.jsonl, sorts every stuck feature by cause, sends back
// the ones stuck for a reason outside the feature (a failing test the feature does not change, an infrastructure
// error) with a note for the next build, re-parks features whose merge never started, and writes a report.
// With an agent it also runs a fresh Claude session on tests that keep failing across features: a fix that only
// touches test files is merged into base; anything else it would change becomes a human task. It also keeps the
// lessons builders read short: once their section grows past a limit, the agent rewrites it into a curated set and
// the full text goes to an archive. The observer itself never edits config, gates or product code.
import { existsSync, readFileSync, writeFileSync, appendFileSync, openSync, readSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { paths, load, loadConfig, mutate, log, readJson, writeJsonAtomic, pidAlive, sleep, envVar, featureEnv, NAME } from './state.ts';
import { git, exec, claudeArgs, parseClaudeOutput, HEADING, OLD_HEADINGS } from './foreman.ts';
import type { Cause, Config, Diagnosis, Feature, HumanTask, LogEvent, ObserverConfig, RoleConfig } from './types.ts';

export const DEFAULT_OBSERVER: ObserverConfig = { pollSec: 60, retry: true, maxRetries: 1, infraPatterns: [], recurring: 2,
  agent: null, agentEveryMin: 120, featureId: 'observer', lessonsMaxBytes: 12000, curateEveryHours: 24 };
export const DEFAULT_AGENT: RoleConfig = { model: 'opus', effort: 'high' };
const INFRA = ['out of shared memory', 'no space left on device', 'enospc', 'too many clients', 'econnrefused',
  'connection terminated unexpectedly', 'terminating connection due to administrator command',
  'the database system is starting up', 'the database system is shutting down', 'cannot allocate memory'];
const DAY = 24 * 3600e3;
const now = (): string => new Date().toISOString();
const tail = (s: string, n: number): string => (s.length > n ? '…' + s.slice(-n) : s);
const firstLine = (s: string): string => s.split('\n')[0]!.slice(0, 200);

// ---- pure helpers (unit tested) ----

const TEST_PATH = /[\w@.+-]+(?:\/[\w@.+-]+)*\.(?:test|spec)\.[cm]?[jt]sx?/g;
const FAIL_LINE = /\bFAIL\b|×|✗|\bnot ok\b|\(fail\)/;

// Test files named on failure lines of a test command's output (vitest/jest "FAIL", tables, ×/✗, TAP "not ok").
export function failingTests(detail: string): string[] {
  const out = new Set<string>();
  for (const line of detail.split('\n')) if (FAIL_LINE.test(line)) for (const m of line.match(TEST_PATH) || []) out.add(m.replace(/^\.\//, ''));
  return [...out];
}

// Repo-relative paths for those names: an exact path, or the one file ending in "/<name>" (ambiguous names are dropped).
export function resolveTests(names: string[], files: string[]): string[] {
  const all = new Set(files), out = new Set<string>();
  for (const n of names) {
    if (all.has(n)) { out.add(n); continue; }
    const hits = files.filter((f) => f.endsWith('/' + n));
    if (hits.length === 1) out.add(hits[0]!);
  }
  return [...out];
}

// Why a feature got stuck. `tests` are the resolved failing tests, `changed` the files the feature changes.
// A test counts as the feature's own when the feature changes it or a file in its directory.
export function classify(detail: string, tests: string[], changed: string[], extra: string[] = []): { cause: Cause; evidence: string } {
  const low = detail.toLowerCase();
  const infra = [...INFRA, ...extra.map((p) => p.toLowerCase())].find((p) => p && low.includes(p));
  if (infra) return { cause: 'infra', evidence: infra };
  if (/too many base refreshes/.test(detail)) return { cause: 'conflict-loop', evidence: firstLine(detail) };
  if (/^(prepare `|worktree:)/.test(detail)) return { cause: 'setup', evidence: firstLine(detail) };
  if (/^(builder failed|commit your work|evaluator failed)/.test(detail)) return { cause: 'builder', evidence: firstLine(detail) };
  if (/^test command `/.test(detail)) {
    if (!tests.length) return { cause: 'unknown', evidence: 'test command failed; no failing test file recognized' };
    const own = tests.filter((t) => changed.some((c) => c === t || dirname(c) === dirname(t)));
    return own.length ? { cause: 'own', evidence: own.join(', ') } : { cause: 'untouched', evidence: tests.join(', ') };
  }
  if (/^(Evaluator:|FAILED |CHEATING:)/m.test(detail)) return { cause: 'own', evidence: 'the evaluator did not pass it' };
  return { cause: 'unknown', evidence: firstLine(detail) };
}

export const signature = (d: Pick<Diagnosis, 'cause' | 'tests' | 'evidence'>): string => `${d.cause}:${d.cause === 'infra' ? d.evidence : [...d.tests].sort().join(',')}`;
export const retryable = (c: Cause): boolean => c === 'untouched' || c === 'infra';

export function retryNote(d: Pick<Diagnosis, 'cause' | 'tests' | 'evidence'>, feedback: string): string {
  const why = d.cause === 'infra' ? `an infrastructure error ("${d.evidence}")` : `${d.tests.join(', ')}, which this feature does not change`;
  return `${NAME} observer: your last attempt failed on ${why}. It was sent back without counting against you; do not change ` +
    `those tests for this feature. If it fails the same way again, a person looks at it.\n\nThat failure was:\n${feedback}`;
}

// Tests that failed (stuck or failed, outside the feature or on infrastructure) in at least `n` features since `since`.
export function recurringTests(diags: Diagnosis[], since: number, n: number): [string, string[]][] {
  const by = new Map<string, Set<string>>();
  for (const d of diags) {
    if (Date.parse(d.ts) < since || !retryable(d.cause)) continue;
    for (const t of d.tests) (by.get(t) ?? by.set(t, new Set()).get(t)!).add(d.feature);
  }
  return [...by].filter(([, f]) => f.size >= n).map(([t, f]) => [t, [...f].sort()] as [string, string[]]).sort((a, b) => b[1].length - a[1].length);
}

// A change the agent may merge on its own: test files, test helpers and fixtures only.
const TESTISH = /(^|\/)(test|tests|__tests__|fixtures|testing|test-support|test-utils)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
export const testOnly = (files: string[]): boolean => files.length > 0 && files.every((f) => TESTISH.test(f));

export function parseAgentReport(text: string): { fixed: { test: string; summary: string }[]; proposals: { title: string; why: string; steps: string[] }[]; notes: string } {
  const tryJson = (s: string | undefined): Record<string, unknown> | undefined => { try { const v = s && JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; } };
  const v = tryJson(text) ?? tryJson(text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]) ?? tryJson(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) ?? {};
  const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter((e) => e && typeof e === 'object') : []);
  return {
    fixed: arr(v.fixed).map((f) => ({ test: String(f.test ?? ''), summary: String(f.summary ?? '') })).filter((f) => f.summary),
    proposals: arr(v.proposals).map((p) => ({ title: String(p.title ?? '').trim(), why: String(p.why ?? ''), steps: Array.isArray(p.steps) ? p.steps.map(String) : [] })).filter((p) => p.title),
    notes: typeof v.notes === 'string' ? v.notes : '',
  };
}

// The lessons section of a lessons file: from its heading to the next level-1/2 heading (as appendLesson writes it).
export function lessonSection(text: string): { before: string; heading: string; body: string; after: string } | null {
  const lines = text.split('\n'), h = lines.findIndex((l) => [HEADING, ...OLD_HEADINGS].includes(l.trim()));
  if (h < 0) return null;
  let end = lines.findIndex((l, i) => i > h && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return { before: lines.slice(0, h).join('\n'), heading: lines[h]!, body: lines.slice(h + 1, end).join('\n'), after: lines.slice(end).join('\n') };
}
export const bulletsOf = (body: string): string[] => body.split('\n').filter((l) => /^- /.test(l));

// The agent's curated lessons, or why they are refused: between <lessons> tags, bullets (### topics allowed), within
// 1.25× the size limit, and at least 5 bullets.
export function parseCurated(text: string, maxBytes: number): { body: string } | { error: string } {
  const m = text.match(/<lessons>\s*([\s\S]*?)\s*<\/lessons>/);
  if (!m) return { error: 'no <lessons> block' };
  const body = m[1]!.trim(), n = bulletsOf(body).length;
  if (n < 5) return { error: `only ${n} bullets` };
  if (Buffer.byteLength(body) > maxBytes * 1.25) return { error: `${Buffer.byteLength(body)} bytes, over the limit` };
  if (body.split('\n').some((l) => l.trim() && !/^(- |  |### )/.test(l))) return { error: 'lines other than bullets and ### topics' };
  return { body };
}

// Files whose merge conflicts sent finished features back, most first.
export function hotFiles(bounces: { files: string[] }[]): [string, number][] {
  const n = new Map<string, number>();
  for (const b of bounces) for (const f of b.files) n.set(f, (n.get(f) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]);
}

// ---- state ----

export interface ObserverState {
  offset: number;                               // bytes of log.jsonl already read
  retried: Record<string, string[]>;            // feature → signatures it was sent back for
  diagnoses: Diagnosis[];                       // newest last, capped
  alerts: { ts: string; text: string }[];
  fixes: { ts: string; commit: string; summary: string }[];
  agentAt?: string;
  agentTargets: Record<string, string>;         // test → when the agent last looked at it
  lastEvent: Record<string, string>;            // feature → its previous log event, across passes
  bounces: { ts: string; feature: string; files: string[] }[]; // passed evaluation, then sent back by a merge conflict
  agentNotes?: string;
  lessonsAt?: string;                           // last curation
}
const fresh = (): ObserverState => ({ offset: 0, retried: {}, diagnoses: [], alerts: [], fixes: [], agentTargets: {}, lastEvent: {}, bounces: [] });
export const observerPaths = (root: string) => { const d = paths(root).dir; return { state: join(d, 'observer.json'), report: join(d, 'observer-report.md'), pid: join(d, '.observer') }; };

export function observerConfig(config: Config, opts: { agent?: boolean; as?: string } = {}): ObserverConfig {
  const c = { ...DEFAULT_OBSERVER, ...(config.observer || {}) };
  if (opts.agent && !c.agent) c.agent = { ...DEFAULT_AGENT, permissionMode: config.builder?.permissionMode };
  if (opts.as) c.featureId = opts.as;
  return c;
}

// New complete lines of the log from `offset` (a shorter file means it was replaced: start over).
export function readNew(file: string, offset: number): { events: LogEvent[]; offset: number } {
  let size = 0;
  try { size = statSync(file).size; } catch { return { events: [], offset: 0 }; }
  if (size < offset) offset = 0;
  if (size === offset) return { events: [], offset };
  const fd = openSync(file, 'r'), buf = Buffer.alloc(size - offset);
  try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
  const text = buf.toString('utf8'), end = text.lastIndexOf('\n') + 1;
  const events = text.slice(0, end).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LogEvent]; } catch { return []; } });
  return { events, offset: offset + Buffer.byteLength(text.slice(0, end)) };
}

// ---- one pass ----

export interface ObserveOptions { agent?: boolean; as?: string; out?: (s: string) => void; children?: Set<ChildProcess> }

export async function observeOnce(root: string, opts: ObserveOptions = {}): Promise<ObserverState> {
  const out = opts.out || ((s: string) => console.log(s));
  const P = paths(root), O = observerPaths(root), config = loadConfig(root), cfg = observerConfig(config, opts);
  const state: ObserverState = { ...fresh(), ...(readJson(O.state, {}) as Partial<ObserverState>) };
  const { events, offset } = readNew(P.log, state.offset);
  state.offset = offset;
  const { features } = load(root);
  const byId = new Map(features.map((f) => [f.id, f]));

  // Files per branch tip, for resolving test names and the feature's own changes.
  const cache = new Map<string, { files: string[]; changed: string[] }>();
  // A merged feature's branch may be gone: then its merge commit on base tells what it changed.
  const filesOf = (f: Feature | undefined) => {
    const branch = f ? f.branch || config.branchPrefix + f.id : '';
    const tip = branch && git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).out;
    const merge = !tip && f ? git(['log', '-1', '--format=%H', '--fixed-strings', `--grep=merge ${f.id}:`, config.base], root).out : '';
    const key = tip || merge || config.base;
    if (!cache.has(key)) {
      const lines = (args: string[]) => git(args, root).out.split('\n').filter(Boolean);
      cache.set(key, tip ? { files: lines(['ls-tree', '-r', '--name-only', tip]), changed: lines(['diff', '--name-only', `${config.base}...${tip}`]) }
        : merge ? { files: lines(['ls-tree', '-r', '--name-only', merge]), changed: lines(['diff', '--name-only', `${merge}^1...${merge}^2`]) }
        : { files: lines(['ls-tree', '-r', '--name-only', config.base]), changed: [] });
    }
    return cache.get(key)!;
  };

  const latestStuck = new Map<string, Diagnosis>();
  for (const e of events) {
    if (!e.feature) continue;
    // A merge conflict right after a passing evaluation (its lesson may sit in between) sends finished work back.
    const prev = state.lastEvent[e.feature];
    if (e.event !== 'lesson') state.lastEvent[e.feature] = e.event;
    if (e.event === 'refreshed' && prev === 'evaluating' && /conflicts in: /.test(e.detail || ''))
      state.bounces.push({ ts: e.ts, feature: e.feature, files: e.detail.split('conflicts in: ')[1]!.split(', ').map((f) => f.trim()).filter(Boolean) });
    if (e.event === 'merge-failed') latestStuck.delete(e.feature);
    if (e.event !== 'stuck' && e.event !== 'failed') continue;
    const { files, changed } = filesOf(byId.get(e.feature));
    const tests = resolveTests(failingTests(e.detail || ''), files);
    const c = classify(e.detail || '', tests, changed, cfg.infraPatterns);
    const d: Diagnosis = { ts: e.ts, feature: e.feature, cause: c.cause, tests, evidence: c.evidence, action: e.event === 'failed' ? 'none: the foreman retries it' : '' };
    state.diagnoses.push(d);
    if (e.event === 'stuck') latestStuck.set(e.feature, d);
  }

  // Send back what got stuck for a reason outside the feature, once per failure signature.
  for (const [id, d] of latestStuck) {
    const sig = signature(d), done = state.retried[id] || [];
    if (byId.get(id)?.status !== 'stuck') { d.action = 'none: no longer stuck'; continue; }
    if (!cfg.retry || !retryable(d.cause)) { d.action = 'left for a person'; continue; }
    if (done.filter((s) => s === sig).length >= cfg.maxRetries) { d.action = 'left for a person: it already failed this way after a retry'; continue; }
    const ok = await mutate(root, 'features', (data) => {
      const f = data.features.find((x) => x.id === id);
      if (!f || f.status !== 'stuck') return false;
      Object.assign(f, { status: 'todo', attempts: 0, refreshes: 0, lastFeedback: retryNote(d, f.lastFeedback || ''), updatedAt: now() });
      return true;
    });
    if (!ok) { d.action = 'none: no longer stuck'; continue; }
    state.retried[id] = [...done, sig];
    d.action = 'sent back';
    log(root, id, 'observer-retry', `${d.cause}: ${d.evidence}`);
    out(`observer: sent back ${id} (${d.cause}: ${d.evidence})`);
  }

  // A merge that never started (e.g. a lock held for a moment) leaves the feature ready but not parked, so the
  // foreman never tries it again: park it.
  if (config.merge === 'auto') {
    const stale = events.filter((e) => e.event === 'merge-failed' && e.feature).map((e) => e.feature!);
    if (stale.length) await mutate(root, 'features', (data) => {
      for (const f of data.features) if (stale.includes(f.id) && f.status === 'ready' && !f.parked && f.sha) {
        f.parked = true; f.updatedAt = now();
        log(root, f.id, 'observer-parked', 'merge did not start; parked so the foreman retries it');
        out(`observer: parked ${f.id} for another merge attempt`);
      }
    });
  }

  // Alerts: things only a person (or the agent's proposals) can fix.
  const alert = (text: string, ts = now(), quietMs = 3600e3) => {
    if (Date.now() - Date.parse(ts) > DAY || state.alerts.some((a) => a.text === text && Date.now() - Date.parse(a.ts) < quietMs)) return;
    state.alerts.push({ ts, text });
    log(root, null, 'observer-alert', text);
    out(`observer: ALERT ${text}`);
  };
  const live = load(root).features;
  const foremanPid = parseInt((() => { try { return readFileSync(P.foreman, 'utf8'); } catch { return ''; } })(), 10);
  if (!pidAlive(foremanPid) && live.some((f) => !['merged', 'paused', 'stuck'].includes(f.status)))
    alert(`the foreman is not running and ${live.filter((f) => f.status !== 'merged').length} features are not merged`);
  for (const e of events) if (e.event === 'alert') alert(`foreman: ${e.detail}`, e.ts);
  const parked = live.filter((f) => f.status === 'ready' && f.parked);
  if (parked.length && Date.now() - Math.min(...parked.map((f) => Date.parse(f.updatedAt) || Date.now())) > 10 * 60e3) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', '.', `:(exclude)${P.name}`], root).out;
    alert(`${parked.length} features wait to merge for over 10 minutes${dirty ? `; uncommitted changes in the main checkout: ${dirty.split('\n').map((l) => l.slice(3)).join(', ')}` : ''}`);
  }

  for (const [file, n] of hotFiles(state.bounces.filter((b) => Date.now() - Date.parse(b.ts) < DAY)))
    if (n >= 5) alert(`merge conflicts in ${file} keep sending features that passed evaluation back to the builder (${n >= 10 ? '10+' : '5+'} in 24h); make it merge-friendly`, now(), DAY);
  if (cfg.agent) await agentPass(root, config, cfg, state, out, opts.children ?? new Set());
  if (cfg.agent) await curateLessons(root, config, cfg, state, out, opts.children ?? new Set());

  state.diagnoses = state.diagnoses.slice(-500);
  state.bounces = state.bounces.filter((b) => Date.now() - Date.parse(b.ts) < 7 * DAY);
  state.alerts = state.alerts.filter((a) => Date.now() - Date.parse(a.ts) < 7 * DAY);
  writeJsonAtomic(O.state, state);
  writeFileSync(O.report, renderReport(root, state, load(root).features, load(root).tasks, pidAlive(foremanPid)));
  return state;
}

// ---- the agent ----

async function agentPass(root: string, config: Config, cfg: ObserverConfig, state: ObserverState, out: (s: string) => void, children: Set<ChildProcess>): Promise<void> {
  if (state.agentAt && Date.now() - Date.parse(state.agentAt) < cfg.agentEveryMin * 60e3) return;
  const targets = recurringTests(state.diagnoses, Date.now() - DAY, cfg.recurring)
    .filter(([t]) => !state.agentTargets[t] || Date.now() - Date.parse(state.agentTargets[t]!) > DAY);
  const infra = state.alerts.filter((a) => Date.now() - Date.parse(a.ts) < DAY).map((a) => a.text);
  if (!targets.length) return;
  state.agentAt = now();
  for (const [t] of targets) state.agentTargets[t] = state.agentAt;

  const wt = resolve(root, config.worktreesDir, cfg.featureId), branch = `${NAME}-observer`;
  const add = existsSync(wt) ? (git(['reset', '--hard', '-q'], wt), git(['checkout', '-q', '-B', branch, config.base], wt))
    : git(['worktree', 'add', '-q', '-B', branch, wt, config.base], root);
  if (add.code) { out(`observer: agent worktree: ${add.err}`); log(root, null, 'observer-agent', `worktree: ${add.err}`); return; }
  const env = { ...process.env, ...featureEnv({ FEATURE: cfg.featureId }) };
  let setup = '';
  if (config.prepare) {
    const p = await exec('sh', ['-c', `exec 2>&1\n${config.prepare}`], { cwd: wt, env, children, timeoutMin: config.timeoutMin });
    setup = p.code === 0 ? '' : `The project's prepare command \`${config.prepare}\` failed here (exit ${p.code}):\n${tail(p.out + p.err, 1500)}\n`;
  }
  const examples = (t: string) => state.diagnoses.filter((d) => d.tests.includes(t)).slice(-2).map((d) => `${d.feature} at ${d.ts}`).join('; ');
  const detailOf = (t: string) => {
    const d = [...state.diagnoses].reverse().find((x) => x.tests.includes(t));
    const ev = d && [...readNew(paths(root).log, 0).events].reverse().find((e) => e.feature === d.feature && e.ts === d.ts);
    return ev ? tail(ev.detail, 2500) : '';
  };
  const prompt = [`You are the ${NAME} observer agent for this repository. Features are built in parallel by other agents; each`,
    'runs the test command before it may merge. The tests below keep failing in features that do not change them, so the',
    'problem is in the test, a shared fixture or the environment, not in those features.', '',
    ...targets.map(([t, fs]) => `## ${t}\nFailed in ${fs.length} features in the last 24 hours (${fs.join(', ')}; latest: ${examples(t)}).\nLatest failure output:\n\`\`\`\n${detailOf(t)}\n\`\`\``),
    infra.length ? `\n## Recent alerts\n${infra.map((a) => `- ${a}`).join('\n')}` : '', setup, '',
    `You work in a git worktree on branch ${branch}, created from ${config.base}. Find the root cause of each failure.`,
    'Rules:',
    '- You may change test files, test helpers and fixtures only. Never change product code, the test command, gate or CI scripts,',
    '  configuration, or anything outside this worktree.',
    '- Never skip, delete or weaken a test or an assertion. Raising a timeout is fine only when the evidence shows the code was',
    '  correct but slow under load; say so in the commit message.',
    '- Run each test file you change, more than once, and commit only what passes (git add + git commit on this branch). Do not',
    '  merge, push or switch branches.',
    '- When the cause is outside what you may change (database or machine settings, scripts, product code), change nothing for',
    '  it and describe it as a proposal for a person: what is wrong, the evidence, and the steps to fix it.', '',
    'Answer with ONLY a JSON object: {"fixed": [{"test": string, "summary": string}], "proposals": [{"title": string, "why": string, ' +
    '"steps": string[]}], "notes": string}.'].join('\n');

  out(`observer: agent looking at ${targets.map(([t]) => t).join(', ')}`);
  const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs({ ...config, builder: cfg.agent! }, 'builder', root),
    { cwd: wt, env, input: prompt, children, timeoutMin: config.timeoutMin });
  const p = parseClaudeOutput(r.out);
  const report = parseAgentReport(p.text);
  state.agentNotes = report.notes || (p.ok ? '' : `agent failed: ${p.error}`);
  log(root, null, 'observer-agent', `${p.ok ? 'done' : `failed: ${p.error}`}; $${p.cost.toFixed(2)}; ${report.fixed.length} fixed, ${report.proposals.length} proposals`);

  // Merge its commits into base only when they touch test files alone and the main checkout is clean.
  const changed = git(['diff', '--name-only', `${config.base}...${branch}`], root).out.split('\n').filter(Boolean);
  if (git(['rev-list', '--count', `${config.base}..${branch}`], root).out !== '0') {
    const summary = report.fixed.map((f) => f.summary).join('; ') || 'test fixes';
    const head = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out;
    const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', '.', `:(exclude)${paths(root).name}`], root).out;
    if (!testOnly(changed)) report.proposals.push({ title: `Review the observer's fix on branch ${branch}`, why: `It changes files other than tests (${changed.join(', ')}), so it was not merged: ${summary}`, steps: [`git diff ${config.base}...${branch}`, `git merge --no-ff ${branch} if it is right`] });
    else if (head !== config.base || dirty) out(`observer: fix on ${branch} not merged: the main checkout is ${head !== config.base ? `on ${head}` : 'dirty'}; next pass`);
    else {
      const m = git(['merge', '--no-ff', '-m', `${NAME}: observer fix: ${summary}`, branch], root);
      if (m.code) {
        if (git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], root).code === 0) git(['merge', '--abort'], root);
        out(`observer: merging ${branch} failed: ${firstLine(m.err)}`);
      } else {
        const commit = git(['rev-parse', '--short', 'HEAD'], root).out;
        state.fixes.push({ ts: now(), commit, summary });
        log(root, null, 'observer-fix', `${commit}: ${summary}`);
        out(`observer: merged fix ${commit}: ${summary}`);
      }
    }
  }
  if (report.proposals.length) await mutate(root, 'human', (d) => {
    for (const [i, pr] of report.proposals.entries()) {
      if (d.tasks.some((t) => t.status === 'open' && t.title === pr.title)) continue;
      const t: HumanTask = { id: `observer-${Date.now().toString(36)}-${i}`, title: pr.title, steps: [pr.why, ...pr.steps].filter(Boolean), unblocks: [], mockable: false, status: 'open' };
      d.tasks.push(t);
      log(root, null, 'observer-proposal', `${t.id}: ${t.title}`);
    }
  });
}

// ---- lessons ----

async function curateLessons(root: string, config: Config, cfg: ObserverConfig, state: ObserverState, out: (s: string) => void, children: Set<ChildProcess>): Promise<void> {
  const file = resolve(root, config.lessonsFile);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '', sec = lessonSection(text);
  if (!sec || Buffer.byteLength(sec.body) <= cfg.lessonsMaxBytes) return;
  if (state.lessonsAt && Date.now() - Date.parse(state.lessonsAt) < cfg.curateEveryHours * 3600e3) return;
  const tracked = git(['ls-files', '--error-unmatch', '--', file], root).code === 0;
  if (tracked && (git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root).out !== config.base || git(['status', '--porcelain', '--', file], root).out)) return;
  state.lessonsAt = now();
  const since = Date.now() - 7 * DAY, recent = state.diagnoses.filter((d) => Date.parse(d.ts) >= since);
  const causes = Object.entries(recent.reduce<Record<string, number>>((m, d) => ((m[d.cause] = (m[d.cause] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const prompt = [`You curate the lessons that every builder in this repository reads before it starts a feature. They were written`,
    'one per finished feature, so many repeat each other or only describe one feature. Rewrite them into a short set that helps',
    'the next builder most.', '',
    `- At most ${cfg.lessonsMaxBytes} bytes in total. Group them under 3 to 8 "### <topic>" headings.`,
    '- Merge duplicates and near-duplicates into one general rule. Keep concrete paths, commands and names when they make a',
    '  rule actionable. Drop lessons about one-off history or a single feature that will not come up again.',
    '- Favor lessons that prevent the failures below. Each bullet is one or two plain sentences, starting with "- ". No dates.',
    '- Do not use tools; answer from the text below.', '',
    causes.length ? `Why features failed in the last 7 days: ${causes.map(([c, n]) => `${c} ${n}`).join(', ')}.` : '',
    ...recurringTests(state.diagnoses, since, 2).slice(0, 10).map(([t, fs]) => `- ${t} failed in ${fs.length} features`), '',
    'The lessons:', '', sec.body.trim(), '', 'Answer with the curated lessons only, between <lessons> and </lessons>.'].join('\n');
  out(`observer: curating ${bulletsOf(sec.body).length} lessons (${Buffer.byteLength(sec.body)} bytes)`);
  const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs({ ...config, builder: cfg.agent! }, 'builder', root),
    { cwd: root, env: process.env, input: prompt, children, timeoutMin: config.timeoutMin });
  const p = parseClaudeOutput(r.out), c = p.ok ? parseCurated(p.text, cfg.lessonsMaxBytes) : { error: `agent failed: ${p.error}` };
  if ('error' in c) { log(root, null, 'observer-lessons', `not curated: ${c.error}`); out(`observer: lessons not curated: ${c.error}`); return; }

  // Lessons the foreman appended while the agent worked are kept after the curated ones.
  const nowText = readFileSync(file, 'utf8'), cur = lessonSection(nowText) ?? sec, had = new Set(bulletsOf(sec.body));
  const added = bulletsOf(cur.body).filter((b) => !had.has(b));
  const archive = file.replace(/(\.md)?$/, '.archive.md');
  appendFileSync(archive, `${existsSync(archive) ? '\n' : ''}## Archived ${now().slice(0, 10)} (${bulletsOf(sec.body).length} lessons)\n\n${sec.body.trim()}\n`);
  writeFileSync(file, [cur.before ? cur.before.replace(/\n*$/, '\n\n') : '', `${cur.heading}\n\n`, `<!-- Curated ${now().slice(0, 10)} by the ${NAME} observer; the full history is in ${archive.split('/').pop()}. -->\n\n`,
    c.body, added.length ? `\n\n${added.join('\n')}` : '', '\n', cur.after ? `\n${cur.after.replace(/^\n*/, '')}` : ''].join(''));
  if (tracked) { git(['add', '--', file], root); git(['commit', '-q', '-m', `${NAME}: curate lessons`, '--', file], root); }
  const size = Buffer.byteLength(lessonSection(readFileSync(file, 'utf8'))!.body);
  log(root, null, 'observer-lessons', `curated ${bulletsOf(sec.body).length} lessons into ${bulletsOf(c.body).length} (${size} bytes); $${p.cost.toFixed(2)}`);
  out(`observer: curated lessons: ${bulletsOf(sec.body).length} → ${bulletsOf(c.body).length + added.length}, ${size} bytes`);
}

// ---- report ----

const at = (iso: string): string => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const CAUSE: Record<Cause, string> = { untouched: 'a test the feature does not change', infra: 'infrastructure', own: 'its own code or tests',
  'conflict-loop': 'merge conflicts that keep coming back', setup: 'worktree or prepare setup', builder: 'the builder or evaluator run', unknown: 'unrecognized' };

export function renderReport(root: string, state: ObserverState, features: Feature[], tasks: HumanTask[], foreman: boolean): string {
  const count = (s: Feature['status'][]) => features.filter((f) => s.includes(f.status)).length;
  const since = Date.now() - DAY, recent = state.diagnoses.filter((d) => Date.parse(d.ts) >= since);
  const lastFor = (id: string) => [...state.diagnoses].reverse().find((d) => d.feature === id && d.action !== 'none: the foreman retries it');
  const stuck = features.filter((f) => f.status === 'stuck');
  const proposals = tasks.filter((t) => t.status === 'open' && t.id.startsWith('observer-'));
  const alerts = state.alerts.filter((a) => Date.parse(a.ts) >= since).reverse();
  const causes = Object.entries(recent.reduce<Record<string, number>>((m, d) => ((m[d.cause] = (m[d.cause] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const recurring = recurringTests(state.diagnoses, since, 2);
  const sent = recent.filter((d) => d.action === 'sent back');
  const bounces = state.bounces.filter((b) => Date.parse(b.ts) >= since), hot = hotFiles(bounces);
  return [`# ${NAME} observer: ${root.split('/').pop()}`, '',
    `Updated ${at(now())}. Foreman: ${foreman ? 'running' : '**not running**'}.`, '',
    '## Features', '',
    `${count(['merged'])} merged · ${count(['building', 'testing', 'evaluating', 'ready'])} in progress · ${count(['todo'])} to do · ${stuck.length} stuck · ${count(['paused'])} paused`, '',
    '## Needs you', '',
    ...(alerts.length || stuck.length || proposals.length ? [
      ...alerts.map((a) => `- ${at(a.ts)}: ${a.text}`),
      ...stuck.map((f) => { const d = lastFor(f.id); return `- ${f.id} is stuck: ${d ? `${CAUSE[d.cause]} (${d.evidence})` : firstLine(f.lastFeedback || '')}`; }),
      ...proposals.map((t) => `- Proposal ${t.id}: ${t.title}`)] : ['Nothing.']), '',
    '## Last 24 hours', '',
    `Failures: ${recent.length}. Sent back by the observer: ${sent.length}. Fixes merged: ${state.fixes.filter((f) => Date.parse(f.ts) >= since).length}.`, '',
    ...(causes.length ? ['| Cause | Failures |', '| --- | --- |', ...causes.map(([c, n]) => `| ${CAUSE[c as Cause]} | ${n} |`), ''] : []),
    ...(bounces.length ? [`Passed evaluation but sent back by a merge conflict: ${bounces.length}.`, '', ...hot.slice(0, 5).map(([f, n]) => `- ${f}: ${n}`), ''] : []),
    ...(recurring.length ? ['Tests failing in several features:', '', ...recurring.map(([t, fs]) => `- ${t}: ${fs.join(', ')}`), ''] : []),
    ...(state.fixes.length ? ['## Fixes merged by the observer', '', ...state.fixes.slice(-10).reverse().map((f) => `- ${at(f.ts)} ${f.commit}: ${f.summary}`), ''] : []),
    ...(state.agentNotes ? ['## Agent notes', '', state.agentNotes, ''] : []),
    '## Recent decisions', '',
    ...state.diagnoses.filter((d) => d.action && d.action !== 'none: the foreman retries it').slice(-15).reverse()
      .map((d) => `- ${at(d.ts)} ${d.feature}: ${CAUSE[d.cause]} (${d.evidence}) → ${d.action}`), ''].join('\n');
}

// ---- the loop ----

export async function observe(root: string, opts: ObserveOptions & { watch?: boolean } = {}): Promise<number> {
  const O = observerPaths(root), out = opts.out || ((s: string) => console.log(s));
  const other = parseInt((() => { try { return readFileSync(O.pid, 'utf8'); } catch { return ''; } })(), 10);
  if (other && other !== process.pid && pidAlive(other)) throw new Error(`another observer is running (pid ${other})`);
  writeFileSync(O.pid, String(process.pid));
  const children = new Set<ChildProcess>();
  let stopping = false;
  const onSignal = () => { if (stopping) process.exit(130); stopping = true; out('observer: stopping…'); for (const c of children) { try { process.kill(-c.pid!, 'SIGTERM'); } catch {} } };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    for (;;) {
      await observeOnce(root, { ...opts, out, children });
      if (!opts.watch || stopping) break;
      const cfg = observerConfig(loadConfig(root), opts);
      for (let t = 0; t < cfg.pollSec * 1000 && !stopping; t += 1000) await sleep(1000);
      if (stopping) break;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (parseInt((() => { try { return readFileSync(O.pid, 'utf8'); } catch { return ''; } })(), 10) === process.pid) unlinkSync(O.pid);
  }
  out(`observer: report at ${O.report}`);
  return 0;
}
