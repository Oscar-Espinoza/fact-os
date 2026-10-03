// Observer: a second loop beside the foreman. It reads log.jsonl, sorts every stuck feature by cause, sends back
// the ones stuck for a reason outside the feature (a failing test the feature does not change, an infrastructure
// error) with a note for the next build, re-parks features whose merge never started, and writes a report.
// With an agent it also acts on what it saw: the improver turns recurring causes of lost work into improvement
// features (built, gated, evaluated and merged by the foreman like any other) and human tasks for what lies outside
// the repo, and the lessons builders read are kept short by curating them (the full text goes to an archive). It also reviews
// each failed pass (promptreview.ts) to learn whether the prompt or the model was at fault, and keeps per-model prompt notes
// from that. The observer itself never changes code: every code change goes through the factory's own checks.
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { paths, load, loadConfig, mutate, log, readJson, writeJsonAtomic, pidAlive, withSupervisor, withCheckoutLock, errCode, errMsg, sleep, envVar, featureEnv, readControlFile, NAME } from './state.ts';
import { resolveRole } from './profiles.ts';
import { git, exec, claudeArgs, parseClaudeOutput, HEADING, OLD_HEADINGS } from './foreman.ts';
import { SLUG } from './ready.ts';
import { passesOf, promptRates, reviewFailures, updateNotes, fileTemplateTasks, promptSummary, renderPromptSection, type PromptState } from './promptreview.ts';
import { readNotes } from './notes.ts';
import type { Cause, Config, Diagnosis, Feature, HumanTask, LogEvent, ObserverConfig, RoleConfig } from './types.ts';

export const DEFAULT_OBSERVER: ObserverConfig = { pollSec: 60, retry: true, maxRetries: 1, infraPatterns: [], recurring: 2,
  agent: null, lessonsMaxBytes: 12000, curateEveryHours: 4,
  improve: true, improveEveryHours: 6, maxOpenImprovements: 2, promptReview: { enabled: true, maxPerPass: 6, notesMaxBytes: 3000, everyMinutes: 30, maxPerDay: 24 } };
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

// Ids for improvement features in the project's own id style: "<L>99-<nn>-<slug>" when every id looks like
// "<L><dd>-<dd>…" (so per-feature tooling that parses ids keeps working), else "imp-<nn>-<slug>".
export function improvementId(existing: string[], title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'improvement';
  const style = existing.length && existing.every((id) => /^[A-Z]\d\d-\d\d/.test(id)) ? `${existing[0]![0]}99-` : 'imp-';
  const used = new Set(existing.map((id) => id.startsWith(style) ? id.slice(style.length, style.length + 2) : '').filter(Boolean));
  let n = 1;
  while (used.has(String(n).padStart(2, '0'))) n++;
  return `${style}${String(n).padStart(2, '0')}-${slug}`;
}

export interface ImproverAnswer { features: { title: string; description: string; acceptance: string[] }[]; humanTasks: { title: string; why: string; steps: string[] }[]; notes: string }
export function parseImprover(text: string): ImproverAnswer {
  const tryJson = (s: string | undefined): Record<string, unknown> | undefined => { try { const v = s && JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; } };
  const v = tryJson(text) ?? tryJson(text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]) ?? tryJson(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) ?? {};
  const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter((e) => e && typeof e === 'object') : []);
  const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map(String).map((t) => t.trim()).filter(Boolean) : []);
  return {
    features: arr(v.features).map((f) => ({ title: String(f.title ?? '').trim(), description: String(f.description ?? '').trim(), acceptance: strs(f.acceptance) }))
      .filter((f) => f.title && f.description && f.acceptance.length),
    humanTasks: arr(v.humanTasks).map((t) => ({ title: String(t.title ?? '').trim(), why: String(t.why ?? ''), steps: strs(t.steps) })).filter((t) => t.title),
    notes: typeof v.notes === 'string' ? v.notes : '',
  };
}

// ---- agent effectiveness ----

export interface RunCost { ts: string; role: 'build' | 'eval'; cost: number; ms: number }
export interface Era { since: string; change: string; launches: number; setup: number; built: number; gated: number; evaluated: number; passed: number;
  bounced: number; merged: number; resolves: number; resolvedMerged: number; buildMin: number | null; gateMin: number | null; evalMin: number | null; costBuild: number; costEval: number;
  rejections: [string, number][]; builderFailures: [string, number][] }

const median = (xs: number[]): number | null => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };
const top = (xs: string[], n = 5): [string, number][] => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, n);

// A builder fingerprint as a prompt-version key: without the lessons hash (a curation is its own change) and with a risky
// feature's escalation undone (` risk=high effortBase=<e>` → effort=<e>), so risky launches neither split nor skip versions.
export const versionKey = (detail: string): string => {
  const base = / risk=high(?: effortBase=(\S+))?/.exec(detail);
  const d = detail.replace(/ lessons=\S+/, '').replace(/ risk=high(?: effortBase=\S+)?/, '');
  return base?.[1] ? d.replace(/ effort=\S+/, ` effort=${base[1]}`) : d;
};

// How the agents did, per prompt version. A version starts at a lessons curation or when the builder's model, effort,
// briefs or model profile change (each launch keyed by its own pass's builder `prompt`; a risky feature's effortHigh does not
// start one). Each `launch` is one pass: did the build reach the test, the test pass, the
// evaluator pass, and did it merge or bounce on a merge conflict. Costs come from the run files, by completion time.
// A resolver run (`resolving`) continues the pass that hit the conflict, in that launch's version: counted in `resolves`,
// and a merge after it in `merged` and `resolvedMerged`; its gate and evaluation are not counted again.
// Clean revalidation also continues the launch, without a bounce or resolver count. Stage
// counts and timings describe the initial validation; subsequent run costs still count.
export function agentStats(events: LogEvent[], runs: RunCost[], since: number): Era[] {
  const t = (e: { ts: string }) => Date.parse(e.ts);
  // Each launch's version is its own pass's builder fingerprint (the first builder `prompt` of that feature after the launch),
  // not whatever was logged last: a pass still in prepare when the profile switches logs its prompt after newer launches.
  // A launch with no builder prompt (build skipped, setup failed) stays in the version in force. Versions change, in launch
  // order, when a launch's key differs from the one before, or at a lessons curation.
  const keyOf = new Map<LogEvent, string>(), pending = new Map<string, LogEvent>();
  for (const e of events) {
    if (!e.feature) continue;
    if (e.event === 'launch') pending.set(e.feature, e);
    else if (e.event === 'prompt' && e.detail.startsWith('builder ') && pending.has(e.feature)) { keyOf.set(pending.get(e.feature)!, versionKey(e.detail)); pending.delete(e.feature); }
  }
  const starts = [{ ts: new Date(since).toISOString(), change: 'start of the window' }], eraOfLaunch = new Map<LogEvent, number>();
  let key = '';
  for (const e of events) {
    const inWindow = t(e) >= since;
    if (e.event === 'observer-lessons' && /^curated /.test(e.detail) && inWindow) starts.push({ ts: e.ts, change: `lessons ${e.detail.split(';')[0]}` });
    if (e.event !== 'launch' || !e.feature) continue;
    const k = keyOf.get(e) ?? key;
    if (k !== key && key && inWindow) starts.push({ ts: e.ts, change: k });
    key = k;
    if (inWindow) eraOfLaunch.set(e, starts.length - 1);
  }
  const eraOf = (ms: number) => { let i = 0; while (i + 1 < starts.length && t(starts[i + 1]!) <= ms) i++; return i; };
  const eras: (Era & { b: number[]; g: number[]; v: number[]; rej: string[]; bf: string[] })[] = starts.map((s) => ({ since: s.ts, change: s.change, launches: 0, setup: 0, built: 0, gated: 0,
    evaluated: 0, passed: 0, bounced: 0, merged: 0, resolves: 0, resolvedMerged: 0, buildMin: null, gateMin: null, evalMin: null, costBuild: 0, costEval: 0, rejections: [], builderFailures: [], b: [], g: [], v: [], rej: [], bf: [] }));
  const open = new Map<string, { era: number; stage: 'build' | 'test' | 'eval' | 'resolve' | 'revalidate'; at: number }>(), lastEra = new Map<string, number>();
  const min = (a: number, b: number) => (b - a) / 60e3;
  for (const e of events) {
    if (!e.feature) continue;
    if (e.event === 'refreshed' && e.detail.startsWith('before build, ')) continue; // dependency import belongs to this builder
    const ms = t(e), cur = open.get(e.feature);
    if (e.event === 'launch') { if (ms >= since) { const era = eraOfLaunch.get(e)!; eras[era]!.launches++; open.set(e.feature, { era, stage: 'build', at: ms }); lastEra.set(e.feature, era); } else { open.delete(e.feature); lastEra.delete(e.feature); } continue; }
    if (e.event === 'resolving' && lastEra.has(e.feature)) { const era = lastEra.get(e.feature)!; eras[era]!.resolves++; open.set(e.feature, { era, stage: 'resolve', at: ms }); continue; }
    if (!cur) continue;
    const E = eras[cur.era]!;
    if (e.event === 'revalidate' && cur.stage === 'eval') {
      E.evaluated++; E.passed++; E.v.push(min(cur.at, ms));
      Object.assign(cur, { stage: 'revalidate', at: ms });
      continue;
    }
    if (cur.stage === 'resolve' || cur.stage === 'revalidate') { // only how continuation ends counts
      if (e.event === 'refreshed' && e.detail === 'before test, conflict-free') continue;
      if (e.event === 'merged') { E.merged++; if (cur.stage === 'resolve') E.resolvedMerged++; }
      if (cur.stage === 'revalidate' && e.event === 'refreshed') E.bounced++;
      if (['merged', 'ready', 'failed', 'stuck', 'interrupted', 'resolve-failed', 'refreshed', 'merge-skipped'].includes(e.event)) open.delete(e.feature);
      continue;
    }
    if (e.event === 'testing' && cur.stage === 'build') { E.built++; E.b.push(min(cur.at, ms)); Object.assign(cur, { stage: 'test', at: ms }); }
    else if (e.event === 'evaluating' && cur.stage === 'test') { E.gated++; E.g.push(min(cur.at, ms)); Object.assign(cur, { stage: 'eval', at: ms }); }
    else if ((e.event === 'failed' || e.event === 'stuck') && cur.stage === 'build') {
      if (/^(prepare `|worktree:)/.test(e.detail)) E.setup++; // the environment, not the agent
      else if (/^test command `/.test(e.detail)) E.built++;    // an older log without the testing event: built, failed the gate
      else E.bf.push(firstLine(e.detail).replace(/[:(].*$/, '').slice(0, 60));
      open.delete(e.feature);
    }
    else if (e.event === 'refreshed' && cur.stage === 'build') { if (/conflicts in: /.test(e.detail)) { E.bf.push('merge conflict before the test'); open.delete(e.feature); } }
    else if ((e.event === 'failed' || e.event === 'stuck') && cur.stage === 'test') open.delete(e.feature);
    else if (cur.stage === 'eval' && ['failed', 'stuck', 'refreshed', 'merged', 'ready', 'merge-skipped'].includes(e.event)) {
      E.evaluated++; E.v.push(min(cur.at, ms));
      if (e.event === 'failed' || e.event === 'stuck') { const f = e.detail.split('\n').find((l) => /^(FAILED |CHEATING|Evaluator:)/.test(l)); E.rej.push((f ?? firstLine(e.detail)).replace(/^FAILED /, '').slice(0, 80)); }
      else { E.passed++; if (e.event === 'refreshed') E.bounced++; if (e.event === 'merged') E.merged++; }
      open.delete(e.feature);
    } else if (e.event === 'interrupted' || e.event === 'refreshed') open.delete(e.feature);
  }
  for (const r of runs) { const ms = t(r); if (ms < since) continue; const E = eras[eraOf(ms)]!; if (r.role === 'build') E.costBuild += r.cost; else E.costEval += r.cost; }
  return eras.map(({ b, g, v, rej, bf, ...e }) => ({ ...e, buildMin: median(b), gateMin: median(g), evalMin: median(v), rejections: top(rej), builderFailures: top(bf),
    costBuild: Math.round(e.costBuild * 100) / 100, costEval: Math.round(e.costEval * 100) / 100 }));
}

// Costs of every run file under runs/, by its completion time.
export function runCosts(runsDir: string): RunCost[] {
  const out: RunCost[] = [];
  let feats: string[] = [];
  try { feats = readdirSync(runsDir); } catch { return out; }
  for (const f of feats) {
    let names: string[] = [];
    try { names = readdirSync(join(runsDir, f)); } catch { continue; }
    for (const n of names) {
      const m = /-(build|eval|resolve)\.json$/.exec(n); // a resolver run is making code: counted with the builds
      if (!m) continue;
      try {
        const file = join(runsDir, f, n), j = JSON.parse(readFileSync(file, 'utf8')) as { total_cost_usd?: unknown; duration_ms?: unknown };
        out.push({ ts: new Date(statSync(file).mtimeMs).toISOString(), role: m[1] === 'eval' ? 'eval' : 'build', cost: Number(j.total_cost_usd) || 0, ms: Number(j.duration_ms) || 0 });
      } catch {}
    }
  }
  return out;
}

// ---- state ----

export interface ObserverState extends PromptState {
  offset: number;                               // bytes of log.jsonl already read
  retried: Record<string, string[]>;            // feature → signatures it was sent back for
  diagnoses: Diagnosis[];                       // newest last, capped
  alerts: { ts: string; text: string }[];
  lastEvent: Record<string, string>;            // feature → its previous log event, across passes
  bounces: { ts: string; feature: string; files: string[] }[]; // passed evaluation, then sent back by a merge conflict
  agentNotes?: string;
  lessonsAt?: string;                           // last curation
  improveAt?: string;                           // last improver run
  improvements: string[];                       // feature ids the improver queued
  agents?: Era[];                               // agent effectiveness per prompt version, last 7 days
}
const fresh = (): ObserverState => ({ offset: 0, retried: {}, diagnoses: [], alerts: [], lastEvent: {}, bounces: [], improvements: [] });
export const observerPaths = (root: string) => { const d = paths(root).dir; return { state: join(d, 'observer.json'), report: join(d, 'observer-report.md'), pid: join(d, '.observer') }; };

export function observerConfig(config: Config, opts: { agent?: boolean } = {}): ObserverConfig {
  const c: ObserverConfig = { ...DEFAULT_OBSERVER, ...(config.observer || {}), promptReview: { ...DEFAULT_OBSERVER.promptReview, ...(config.observer?.promptReview || {}) } };
  if (opts.agent && !c.agent) c.agent = { ...DEFAULT_AGENT, permissionMode: config.builder?.permissionMode };
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

// `profile`: the observe loop's memory of the last valid control.json profile, kept when the file turns invalid.
// `stopping`: true once the observer got a stop signal: no new provider starts or agent proposals apply.
export interface ObserveOptions { agent?: boolean; out?: (s: string) => void; children?: Set<ChildProcess>; profile?: { last: string | null }; stopping?: () => boolean }

export async function observeOnce(root: string, opts: ObserveOptions = {}): Promise<ObserverState> {
  const out = opts.out || ((s: string) => console.log(s));
  const P = paths(root), O = observerPaths(root), config = loadConfig(root), cfg = observerConfig(config, opts);
  // The model profile (control.json), re-read every pass; it only picks the agent's model and effort, never turns it on.
  const cr = readControlFile(root, config), mem = opts.profile ?? { last: null };
  if (cr.ok) mem.last = cr.control.profile ?? null;
  const profile = mem.last;
  const state: ObserverState = { ...fresh(), ...(readJson(O.state, {}) as Partial<ObserverState>) };
  const { events, offset } = readNew(P.log, state.offset);
  state.offset = offset;
  const { features } = load(root);
  const byId = new Map(features.map((f) => [f.id, f]));

  // Files per branch tip, for resolving test names and the feature's own changes.
  const cache = new Map<string, { files: string[]; changed: string[] }>();
  // A merged feature's branch may be gone: then its merge commit on base tells what it changed.
  const perFeature = new Map<string, { files: string[]; changed: string[] }>(); // one rev-parse / log per feature per pass
  const filesOf = (f: Feature | undefined) => {
    const id = f?.id ?? '';
    if (!perFeature.has(id)) perFeature.set(id, filesAt(f));
    return perFeature.get(id)!;
  };
  const filesAt = (f: Feature | undefined) => {
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
    if (n >= 5) alert(`merge conflicts in ${file} keep sending features that passed evaluation back to the builder (5 or more in 24h); make it merge-friendly`, now(), DAY);
  // Failed passes: review each once (the curator's role model, read-only), then fold the answers into per-model notes and human
  // tasks. The reviews are saved before anything else can fail: they cost money. A failing step is reported, not fatal.
  const all = readNew(P.log, 0), feat = (id: string) => ({ title: byId.get(id)?.title ?? id, branch: byId.get(id)?.branch || config.branchPrefix + id });
  const passes = passesOf(all.events, (id, detail) => { // only gate failures need the repo's files (filesOf: once per feature)
    // An evaluator's feedback or a keep-check report may quote anything (ECONNREFUSED): only a gate failure and the foreman's own
    // failures are read for infrastructure patterns.
    const gate = /^test command `/.test(detail);
    const { files, changed } = gate ? filesOf(byId.get(id)) : { files: [], changed: [] };
    return !gate && /^(Evaluator:|FAILED |CHEATING:|BLOCKING:)/m.test(detail) ? 'own' : /^The merge resolution lost lines/.test(detail) ? 'unknown'
      : classify(detail, resolveTests(failingTests(detail), files), changed, cfg.infraPatterns).cause;
  }, Date.now() - 7 * DAY); // the rates need a week; classification stops at the window
  const children = opts.children ?? new Set<ChildProcess>(), stopping = opts.stopping ?? (() => false), step = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { out(`observer: ${what} failed: ${firstLine(String((e as Error).message ?? e))}`); log(root, null, 'observer-error', `${what}: ${firstLine(String((e as Error).message ?? e))}`); }
  };
  if (cfg.agent && cfg.promptReview.enabled) {
    const curator = resolveRole(config, profile, 'curator', { agent: cfg.agent }), io = { out, children, stopping };
    await step('prompt review', () => reviewFailures(root, config, curator, cfg.promptReview, state, passes, feat, io));
    writeJsonAtomic(O.state, state);
    if (!stopping()) await step('prompt notes', () => updateNotes(root, config, curator, cfg.promptReview, state, io));
    if (!stopping()) await step('template tasks', () => fileTemplateTasks(root, state, out, stopping));
  }
  state.promptRates = promptRates(passes);
  if (cfg.agent && !stopping()) await step('lesson curation', () => curateLessons(root, config, resolveRole(config, profile, 'curator', { agent: cfg.agent }), cfg, state, out, children, stopping));
  if (cfg.agent && cfg.improve && !stopping()) await step('improver', () => improvePass(root, config, resolveRole(config, profile, 'observer', { agent: cfg.agent }), cfg, state, out, children, stopping));

  state.agents = agentStats([...all.events, ...readNew(P.log, all.offset).events], runCosts(P.runs), Date.now() - 7 * DAY); // what this pass logged too
  state.diagnoses = state.diagnoses.slice(-500);
  state.bounces = state.bounces.filter((b) => Date.now() - Date.parse(b.ts) < 7 * DAY);
  state.alerts = state.alerts.filter((a) => Date.now() - Date.parse(a.ts) < 7 * DAY);
  writeJsonAtomic(O.state, state);
  writeFileSync(O.report, renderReport(root, state, load(root).features, load(root).tasks, pidAlive(foremanPid)));
  return state;
}

// ---- lessons ----

// Reserve a paid stage before launching it. Apply/report failures must not cause
// another paid call next poll; a failed checkpoint must not launch or retain a stamp.
function checkpointAgentStart(root: string, state: ObserverState, key: 'lessonsAt' | 'improveAt'): void {
  const previous = state[key];
  state[key] = now();
  try { writeJsonAtomic(observerPaths(root).state, state); } catch (e) {
    if (previous === undefined) delete state[key]; else state[key] = previous;
    throw e;
  }
}

// `agent`: the curator's resolved model/effort (the observer agent config, or the active profile's `curator` entry).
async function curateLessons(root: string, config: Config, agent: RoleConfig, cfg: ObserverConfig, state: ObserverState, out: (s: string) => void, children: Set<ChildProcess>, stopping: () => boolean): Promise<void> {
  if (stopping()) return;
  const file = resolve(root, config.lessonsFile);
  if (state.lessonsAt && Date.now() - Date.parse(state.lessonsAt) < cfg.curateEveryHours * 3600e3) return;
  const refuse = (why: string) => { log(root, null, 'observer-lessons', `not curated: ${why}`); out(`observer: lessons not curated: ${why}`); };
  // A slow main-checkout hook may outlast the lock's bounded wait. Defer curation
  // without disrupting the observer or touching the lessons/archive/index.
  const checkout = async <R>(fn: () => R): Promise<R | undefined> => {
    try { return await withCheckoutLock(root, fn); } catch (e) {
      if (!errMsg(e).startsWith(`timed out waiting for lock ${join(paths(root).dir, '.checkout-lock')} `)) throw e;
      refuse('checkout is busy; retry on a later curation pass'); return undefined;
    }
  };
  const safety = (): { tracked: boolean } | { error: string } => {
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
    if (branch.code !== 0 || branch.out !== config.base) return { error: 'checkout branch changed or is not on base' };
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      const path = git(['rev-parse', '--git-path', marker], root);
      if (path.code !== 0 || existsSync(resolve(root, path.out))) return { error: 'checkout has a Git operation in progress' };
    }
    const listed = git(['ls-files', '--error-unmatch', '--', file], root);
    if (listed.code !== 0 && listed.code !== 1) return { error: 'cannot determine lessons tracking status' };
    const tracked = listed.code === 0;
    if (tracked) {
      const status = git(['status', '--porcelain', '--', file], root);
      if (status.code !== 0 || status.out) return { error: 'tracked lessons file is not clean' };
    }
    return { tracked };
  };
  const logStat = () => { try { return statSync(paths(root).log); } catch (e) { if (errCode(e) === 'ENOENT') return null; throw e; } };
  const snapshot = await checkout(() => {
    if (stopping()) return null;
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '', sec = lessonSection(text);
    if (!sec || Buffer.byteLength(sec.body) <= cfg.lessonsMaxBytes) return null;
    const safe = safety(); if ('error' in safe) { refuse(safe.error); return null; }
    return { text, sec, tracked: safe.tracked, log: logStat() };
  });
  if (!snapshot || stopping()) return;
  const { sec, tracked } = snapshot;
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
  const args = claudeArgs(config, agent, root);
  if (stopping()) return;
  checkpointAgentStart(root, state, 'lessonsAt');
  const r = await exec(envVar('CLAUDE') || 'claude', args,
    { cwd: root, env: process.env, input: prompt, children, timeoutMin: config.timeoutMin });
  if (stopping()) return;
  const p = parseClaudeOutput(r.out), c = p.ok ? parseCurated(p.text, cfg.lessonsMaxBytes) : { error: `agent failed: ${p.error}` };
  if ('error' in c) { log(root, null, 'observer-lessons', `not curated: ${c.error}`); out(`observer: lessons not curated: ${c.error}`); return; }

  await checkout(() => {
    if (stopping()) return;
    const safe = safety(); if ('error' in safe) { refuse(safe.error); return; }
    if (safe.tracked !== tracked || !existsSync(file)) { refuse('lessons tracking status or file changed'); return; }
    const nowText = readFileSync(file, 'utf8'), cur = lessonSection(nowText);
    if (!cur) { refuse('lessons section changed or was removed'); return; }
    if (nowText !== snapshot.text) {
      const currentLog = logStat();
      if (snapshot.log && (!currentLog || currentLog.dev !== snapshot.log.dev || currentLog.ino !== snapshot.log.ino || currentLog.size < snapshot.log.size)) {
        refuse('lesson append log changed or was truncated'); return;
      }
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      let expected = hash(snapshot.text);
      for (const e of readNew(paths(root).log, snapshot.log?.size ?? 0).events) {
        const proof = e.lessonAppend;
        if (e.event !== 'lesson' || !e.feature || !proof || proof.file !== file) continue;
        if (!/^[a-f0-9]{64}$/.test(proof.before) || !/^[a-f0-9]{64}$/.test(proof.after) || proof.before !== expected) {
          refuse('lessons changed outside recognized foreman appends'); return;
        }
        expected = proof.after;
      }
      if (expected !== hash(nowText)) { refuse('lessons changed outside recognized foreman appends'); return; }
    }
    // Full-file provenance is established before computing the appended bullets.
    const had = new Set(bulletsOf(sec.body)), added = bulletsOf(cur.body).filter((b) => !had.has(b));
    const archive = file.replace(/(\.md)?$/, '.archive.md');
    appendFileSync(archive, `${existsSync(archive) ? '\n' : ''}## Archived ${now().slice(0, 10)} (${bulletsOf(sec.body).length} lessons)\n\n${sec.body.trim()}\n`);
    writeFileSync(file, [cur.before ? cur.before.replace(/\n*$/, '\n\n') : '', `${cur.heading}\n\n`, `<!-- Curated ${now().slice(0, 10)} by the ${NAME} observer; the full history is in ${archive.split('/').pop()}. -->\n\n`,
      c.body, added.length ? `\n\n${added.join('\n')}` : '', '\n', cur.after ? `\n${cur.after.replace(/^\n*/, '')}` : ''].join(''));
    const commit = tracked ? git(['commit', '-q', '-m', `${NAME}: curate lessons`, '--', file], root) : null;
    const size = Buffer.byteLength(lessonSection(readFileSync(file, 'utf8'))!.body);
    log(root, null, 'observer-lessons', `curated ${bulletsOf(sec.body).length} lessons into ${bulletsOf(c.body).length} (${size} bytes); $${p.cost.toFixed(2)}` +
      (commit && commit.code !== 0 ? `; commit failed: ${commit.err}` : ''));
    out(`observer: curated lessons: ${bulletsOf(sec.body).length} → ${bulletsOf(c.body).length + added.length}, ${size} bytes` +
      (commit && commit.code !== 0 ? `; commit failed: ${commit.err}` : ''));
  });
}

// ---- the improver ----

// Turns what the observer saw into work: improvement features the foreman builds like any other (test gate,
// evaluator, merge) and human tasks for what lies outside the repo. The analysis runs read-only (plan mode).
// `agent`: the improver's resolved model/effort (the observer agent config, or the active profile's `observer` entry).
async function improvePass(root: string, config: Config, agent: RoleConfig, cfg: ObserverConfig, state: ObserverState, out: (s: string) => void, children: Set<ChildProcess>, stopping: () => boolean): Promise<void> {
  if (stopping()) return;
  if (state.improveAt && Date.now() - Date.parse(state.improveAt) < cfg.improveEveryHours * 3600e3) return;
  const { features, tasks } = load(root);
  const open = features.filter((f) => state.improvements.includes(f.id) && f.status !== 'merged');
  if (open.length >= cfg.maxOpenImprovements) return;
  const since = Date.now() - DAY, recent = state.diagnoses.filter((d) => Date.parse(d.ts) >= since);
  const bounces = state.bounces.filter((b) => Date.parse(b.ts) >= since), alerts = state.alerts.filter((a) => Date.parse(a.ts) >= since);
  const recurring = recurringTests(state.diagnoses, since, cfg.recurring);
  if (!bounces.length && !alerts.length && !recurring.length && !recent.some((d) => d.cause !== 'own' && features.some((f) => f.id === d.feature && f.status !== 'merged'))) return; // nothing systemic to fix
  // Failures of features that have merged since are history; count and show only what is still open.
  const status = new Map(features.map((f) => [f.id, f.status])), live = recent.filter((d) => status.get(d.feature) !== 'merged');
  const causes = Object.entries(live.reduce<Record<string, number>>((m, d) => ((m[d.cause] = (m[d.cause] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const examples = live.filter((d) => d.cause !== 'own').slice(-8).map((d) => `- ${d.ts} ${d.feature} (now ${status.get(d.feature) ?? 'gone'}): ${d.cause} (${d.evidence})`);
  const prompt = [`You improve the ${NAME} software factory that builds this repository: many builders work on features in parallel`,
    'worktrees, each feature passes a test gate and an independent evaluator, then merges into ' + config.base + '. Below is what',
    'the observer saw in the last 24 hours. Find the causes that waste the most work across features and decide what would remove',
    'them. Read the repository as needed. Do not modify anything: your answer is a plan that others carry out.', '',
    `Failures by cause, features not merged yet: ${causes.map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}. Features that merged since are resolved;`,
    'never propose acting on them.',
    `Finished features sent back by merge conflicts: ${bounces.length}.`, ...hotFiles(bounces).slice(0, 8).map(([f, n]) => `- ${f}: ${n}`),
    recurring.length ? 'Tests failing in several features that do not change them:' : '', ...recurring.slice(0, 8).map(([t, fs]) => `- ${t}: ${fs.join(', ')}`),
    alerts.length ? 'Alerts:' : '', ...alerts.map((a) => `- ${a.text}`),
    examples.length ? 'Recent failures outside the features\' own code:' : '', ...examples, '',
    'Already queued or waiting (do not repeat them):', ...open.map((f) => `- feature ${f.id}: ${f.title}`),
    ...tasks.filter((t) => t.status === 'open' && t.id.startsWith('observer-')).map((t) => `- human task: ${t.title}`), '',
    'Answer with at most two improvements, the ones that would save the most work, as:',
    '- "features": changes inside this repository (tests, tooling, structure of shared files). Each is built by a builder and',
    '  checked by an evaluator, so write it like a feature: a title, a description with the evidence above, what to change and',
    '  what must not change, and acceptance checks an independent evaluator can verify (always including that the existing',
    '  tests and checks still pass). Never propose skipping, deleting or weakening tests or checks.',
    '- "humanTasks": anything outside the repository (machine or database settings, CI or gate scripts, the factory\'s own',
    '  config): a title, why (with the evidence), and the steps.', '',
    'Answer with ONLY a JSON object: {"features": [{"title": string, "description": string, "acceptance": string[]}], ' +
    '"humanTasks": [{"title": string, "why": string, "steps": string[]}], "notes": string}.'].filter((l) => l !== '').join('\n');
  out('observer: improver looking at the last 24 hours');
  const args = claudeArgs(config, { ...agent, permissionMode: 'plan' }, root);
  if (stopping()) return;
  checkpointAgentStart(root, state, 'improveAt');
  const r = await exec(envVar('CLAUDE') || 'claude', args,
    { cwd: root, env: process.env, input: prompt, children, timeoutMin: config.timeoutMin });
  if (stopping()) return;
  const p = parseClaudeOutput(r.out), a = parseImprover(p.ok ? p.text : '');
  const room = cfg.maxOpenImprovements - open.length, queued: string[] = [];
  if (a.features.length && room > 0) await mutate(root, 'features', (d) => {
    if (stopping()) return;
    for (const f of a.features.slice(0, room)) {
      if (d.features.some((x) => x.title.toLowerCase() === f.title.toLowerCase() && x.status !== 'merged')) continue;
      const id = improvementId(d.features.map((x) => x.id), f.title);
      if (!SLUG.test(id)) continue;
      const priority = Math.min(0, ...d.features.map((x) => x.priority ?? 0)) - 1; // ahead of everything else
      d.features.push({ id, title: f.title, description: `${f.description}\n\n(Queued by the ${NAME} observer from what it saw in the factory.)`,
        acceptance: f.acceptance, surface: 'any', deps: [], priority, status: 'todo', attempts: 0, updatedAt: now() });
      queued.push(id);
    }
  });
  for (const id of queued) { state.improvements.push(id); log(root, id, 'observer-improve', 'queued as an improvement feature'); out(`observer: queued improvement ${id}`); }
  if (a.humanTasks.length && !stopping()) await mutate(root, 'human', (d) => {
    if (stopping()) return;
    for (const [i, t] of a.humanTasks.entries()) {
      if (d.tasks.some((x) => x.status === 'open' && x.title === t.title)) continue;
      const task: HumanTask = { id: `observer-${Date.now().toString(36)}-${i}`, title: t.title, steps: [t.why, ...t.steps].filter(Boolean), unblocks: [], mockable: false, status: 'open' };
      d.tasks.push(task);
      log(root, null, 'observer-proposal', `${task.id}: ${task.title}`);
    }
  });
  if (!stopping() && a.notes) state.agentNotes = a.notes;
  log(root, null, 'observer-agent', `improver ${p.ok ? 'done' : `failed: ${p.error}`}; $${p.cost.toFixed(2)}; ${queued.length} features, ${a.humanTasks.length} human tasks`);
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
    `Failures: ${recent.length}. Sent back by the observer: ${sent.length}. Improvements queued: ${state.improvements.length}.`, '',
    ...(causes.length ? ['| Cause | Failures |', '| --- | --- |', ...causes.map(([c, n]) => `| ${CAUSE[c as Cause]} | ${n} |`), ''] : []),
    ...(bounces.length ? [`Passed evaluation but sent back by a merge conflict: ${bounces.length}.`, '', ...hot.slice(0, 5).map(([f, n]) => `- ${f}: ${n}`), ''] : []),
    ...(recurring.length ? ['Tests failing in several features:', '', ...recurring.map(([t, fs]) => `- ${t}: ${fs.join(', ')}`), ''] : []),
    ...(state.improvements.length ? ['## Improvements queued by the observer', '', ...state.improvements.slice(-10).reverse().map((id) => { const f = features.find((x) => x.id === id); return `- ${id}: ${f ? `${f.title} (${f.status})` : 'removed'}`; }), ''] : []),
    ...(state.agentNotes ? ['## Agent notes', '', state.agentNotes, ''] : []),
    ...renderPromptSection(promptSummary(state, (model, role) => readNotes(root, model, role) ?? ''), at),
    ...(state.agents?.length ? ['## Agents (last 7 days, by prompt version)', '',
      '| Since | Change | Builds (setup failed) | Reached test | Passed gate | Passed evaluator | Bounced | Merged | Build / gate / eval (median min) | Cost build + eval |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...state.agents.map((e) => { const pc = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–'), m = (x: number | null) => (x == null ? '–' : x.toFixed(0));
        return `| ${at(e.since)} | ${e.change} | ${e.launches} (${e.setup}) | ${pc(e.built, e.launches - e.setup)} | ${pc(e.gated, e.built)} | ${pc(e.passed, e.evaluated)} | ${pc(e.bounced, e.passed)} | ${e.merged}${e.resolvedMerged ? ` (${e.resolvedMerged} after a resolver)` : ''} | ${m(e.buildMin)} / ${m(e.gateMin)} / ${m(e.evalMin)} | $${e.costBuild.toFixed(0)} + $${e.costEval.toFixed(0)} |`; }), '',
      ...(state.agents.at(-1)!.rejections.length ? ['Why the evaluator rejected (latest version):', '', ...state.agents.at(-1)!.rejections.map(([r, n]) => `- ${n}× ${r}`), ''] : [])] : []),
    '## Recent decisions', '',
    ...state.diagnoses.filter((d) => d.action && d.action !== 'none: the foreman retries it').slice(-15).reverse()
      .map((d) => `- ${at(d.ts)} ${d.feature}: ${CAUSE[d.cause]} (${d.evidence}) → ${d.action}`), ''].join('\n');
}

// ---- the loop ----

export function observe(root: string, opts: ObserveOptions & { watch?: boolean } = {}): Promise<number> {
  return withSupervisor(root, 'observer', () => observeOwned(root, opts));
}

async function observeOwned(root: string, opts: ObserveOptions & { watch?: boolean }): Promise<number> {
  const O = observerPaths(root), out = opts.out || ((s: string) => console.log(s));
  const children = new Set<ChildProcess>();
  let stopping = false;
  const killOwned = (signal: NodeJS.Signals) => { for (const c of children) { try { process.kill(-c.pid!, signal); } catch {} } };
  const onSignal = () => {
    if (stopping) { killOwned('SIGKILL'); process.exit(130); }
    stopping = true;
    killOwned('SIGTERM');
    out('observer: stopping… (again to force)');
  };
  try {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const profile = { last: null as string | null };
    let pollSec = DEFAULT_OBSERVER.pollSec;
    for (;;) {
      try { await observeOnce(root, { ...opts, out, children, profile, stopping: () => stopping }); } catch (e) {
        if (!opts.watch) throw e;
        const why = firstLine(String((e as Error).message ?? e)); // a bad pass must not end a watching observer: report it and try again at the next poll
        out(`observer: pass failed: ${why}`);
        try { log(root, null, 'observer-error', `pass: ${why}`); } catch {}
      }
      if (!opts.watch || stopping) break;
      try { pollSec = observerConfig(loadConfig(root), opts).pollSec; } catch {} // a broken config.json keeps the last poll interval
      for (let t = 0; t < pollSec * 1000 && !stopping; t += 1000) await sleep(1000);
      if (stopping) break;
    }
  } finally {
    // Retain ownership and signal handlers until every still-owned child closes.
    // Ordinary passes already drain exec(); exceptional exits need this backstop.
    const drained = [...children].map((c) => new Promise<void>((r) => c.once('close', () => r())));
    killOwned('SIGKILL');
    await Promise.all(drained);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  out(`observer: report at ${O.report}`);
  return 0;
}
