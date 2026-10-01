#!/usr/bin/env bun
// Replays a project's real merge conflicts against the merge process (docs/merge-process.md), read-only: `git show`,
// `git merge-file` on temp files and the state dir's log; never a checkout, never a write in the repo.
//   bun scripts/replay-conflicts.ts <repo> [--since ISO] [--json out.json] [--examples N] [--only claims]
// A. Resolver context: every "merge main into <branch>" commit whose parents conflict when merged again with
//    `git merge-file`; per conflicting file, would the both-sides brief have named a feature (with description and
//    acceptance checks) behind base's side? And the keep-lines check on the resolution actually committed, and on what
//    the reverted union driver would have produced (with Bun's parser as the referee for .ts/.json files).
// B. Claims: every conflicting refresh in the log; would claims (hot files scored from the log, files known from branch
//    commits and earlier conflicts) have kept the two features apart? And how many launches would have waited.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { baseSide, checkLines, conflictFiles, hotScores, MERGE_SUBJECT, missingLines } from '../lib/merge.ts';
import { STATE_DIRS } from '../lib/state.ts';
import type { Feature, LogEvent } from '../lib/types.ts';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { since: { type: 'string' }, json: { type: 'string' }, examples: { type: 'string' }, only: { type: 'string' } } });
const repo = positionals[0];
if (!repo) { console.error('usage: bun scripts/replay-conflicts.ts <repo> [--since ISO] [--json out.json] [--examples N]'); process.exit(1); }
const g = (args: string[], input?: string) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 512 << 20, input });
const out = (args: string[]) => (g(args).stdout || '').trimEnd();
const lines = (args: string[]) => out(args).split('\n').filter(Boolean);
const stateDir = STATE_DIRS.map((d) => join(repo, d)).find(existsSync)!;
const features = new Map((JSON.parse(readFileSync(join(stateDir, 'features.json'), 'utf8')).features as Feature[]).map((f) => [f.id, f]));
const events: LogEvent[] = readFileSync(join(stateDir, 'log.jsonl'), 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
// The factory era starts at the foreman's first merge into main, unless --since says otherwise.
const firstMerge = lines(['log', '--first-parent', '--reverse', '--format=%cI %s', 'main']).find((l) => MERGE_SUBJECT.test(l.slice(26)))?.slice(0, 25);
const since = Date.parse(o.since ?? firstMerge ?? '1970-01-01');
const nEx = Number(o.examples ?? 5);
const tmp = mkdtempSync(join(tmpdir(), 'replay-'));
const show = (rev: string, f: string) => { const r = g(['show', `${rev}:${f}`]); return r.status === 0 ? r.stdout : null; };
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');

// Does it parse? Only for what Bun can check without dependencies; null = cannot tell.
function parses(file: string, text: string): boolean | null {
  try {
    if (/\.(ts|tsx|mts|js|mjs)$/.test(file)) { new Bun.Transpiler({ loader: file.endsWith('x') ? 'tsx' : 'ts' }).transformSync(text); return true; }
    if (file.endsWith('.json')) { JSON.parse(text); return true; }
  } catch { return false; }
  return null;
}

// ---- A. resolver context and keep-lines check ----

const INTO = /^(?:(?:fact-os|shipyard): )?merge (?:branch )?'?main'?(?: \(.*?\))? into /i;
const merges = lines(['log', '--all', '--merges', '--format=%H %P%x09%cI%x09%s', `--since=${new Date(since).toISOString()}`])
  .map((l) => { const [hp, ts, subject] = l.split('\t'); const [sha, p1, p2, ...more] = hp!.split(' '); return { sha: sha!, p1: p1!, p2: p2!, more: more.length, ts: ts!, subject: subject! }; })
  .filter((m) => !m.more && INTO.test(m.subject));
type Conflict = { merge: string; file: string; kind: 'text' | 'modify/delete'; covered: 'feature' | 'commit-only' | 'none'; ids: string[];
  keep: string[]; changed: number; markers: boolean; unionMissing: number; unionParses: boolean | null; resolutionParses: boolean | null };
const conflicts: Conflict[] = [];
const sideCache = new Map<string, ReturnType<typeof baseSide>>();
let mergesConflicted = 0, briefChars: number[] = [];
for (const m of o.only === 'claims' ? [] : merges) { // --only claims skips this part (it takes minutes)
  const mb = out(['merge-base', m.p1, m.p2]);
  if (!mb) continue;
  const changed = (rev: string) => new Set(lines(['diff', '--name-only', '--no-renames', mb, rev]));
  const ours = changed(m.p1), theirs = changed(m.p2);
  const found: { file: string; kind: Conflict['kind']; union: string | null; b: string; o: string; t: string }[] = [];
  for (const file of [...ours].filter((f) => theirs.has(f))) {
    const b = show(mb, file), os = show(m.p1, file), ts = show(m.p2, file);
    if (os === ts) continue; // the same change on both sides
    if (os == null || ts == null) { found.push({ file, kind: 'modify/delete', union: null, b: b ?? '', o: os ?? '', t: ts ?? '' }); continue; }
    const [fb, fo, ft] = ['b', 'o', 't'].map((k) => join(tmp, k));
    writeFileSync(fb!, b ?? ''); writeFileSync(fo!, os); writeFileSync(ft!, ts);
    const r = spawnSync('git', ['merge-file', '-p', fo!, fb!, ft!], { encoding: 'utf8', maxBuffer: 512 << 20 });
    if ((r.status ?? 0) <= 0) continue; // clean (0), or binary/error (<0)
    const u = spawnSync('git', ['merge-file', '-p', '--union', fo!, fb!, ft!], { encoding: 'utf8', maxBuffer: 512 << 20 });
    found.push({ file, kind: 'text', union: u.stdout, b: b ?? '', o: os, t: ts });
  }
  if (!found.length) continue;
  mergesConflicted++;
  const key = `${mb} ${m.p2} ${found.map((f) => f.file).join(' ')}`;
  if (!sideCache.has(key)) sideCache.set(key, baseSide(repo, mb, m.p2, found.map((f) => f.file)));
  const sides = sideCache.get(key)!;
  let chars = 0;
  for (const f of found) {
    const mine = sides.filter((s) => s.files.includes(f.file)), ids = mine.flatMap((s) => (s.id ? [s.id] : []));
    const known = ids.filter((id) => features.has(id));
    for (const id of known) chars += (features.get(id)!.description || '').slice(0, 800).length + (features.get(id)!.acceptance || []).join('').length;
    const res = show(m.sha, f.file) ?? '';
    conflicts.push({ merge: m.sha, file: f.file, kind: f.kind, covered: known.length ? 'feature' : mine.length ? 'commit-only' : 'none', ids,
      ...(() => { const c = checkLines(f.b, f.o, f.t, res); return { keep: c.lost.map((x) => x.line), changed: c.changed.length }; })(), markers: /^(<<<<<<< |>>>>>>> )/m.test(res),
      unionMissing: f.union == null ? 0 : missingLines(f.b, f.o, f.t, f.union).length,
      unionParses: f.union == null ? null : parses(f.file, f.union), resolutionParses: parses(f.file, res) });
  }
  briefChars.push(chars);
}
rmSync(tmp, { recursive: true, force: true });

const files = (c: Conflict[]) => [...c.reduce((m, x) => m.set(x.file, (m.get(x.file) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
const by = (k: Conflict['covered']) => conflicts.filter((c) => c.covered === k).length;
const keepFlag = conflicts.filter((c) => c.keep.length), unionChecked = conflicts.filter((c) => c.unionParses !== null);
const unionBroken = unionChecked.filter((c) => c.unionParses === false), caught = unionBroken.filter((c) => c.unionMissing > 0);
const unionFlagParses = unionChecked.filter((c) => c.unionParses && c.unionMissing > 0);
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[a.length >> 1]! : 0; };

// ---- B. claims ----

const t = (e: { ts: string }) => Date.parse(e.ts);
const inWindow = events.filter((e) => t(e) >= since);
// Feature merges on main: when (log), which files (git), and each feature's own commits touching a file (branch history).
const mergeOf = new Map<string, { sha: string; files: Set<string> }>();
for (const l of lines(['log', '--first-parent', '--format=%H%x09%s', 'main', `--since=${new Date(since - 30 * 86400e3).toISOString()}`])) {
  const [sha, s] = l.split('\t'), m = MERGE_SUBJECT.exec(s ?? '');
  if (m && !mergeOf.has(m[1]!)) mergeOf.set(m[1]!, { sha: sha!, files: new Set(lines(['diff', '--name-only', '--no-renames', `${sha}^1`, sha!])) });
}
const tipOf = (id: string) => { const m = mergeOf.get(id); if (m) return { tip: `${m.sha}^2`, not: `${m.sha}^1` };
  for (const r of [`refs/heads/task/${id}`, `refs/tags/archive/task/${id}`]) if (g(['rev-parse', '--verify', '--quiet', r]).status === 0) return { tip: r, not: 'main' };
  return null; };
const ownCache = new Map<string, number[]>(); // "<id> <file>" → commit times (ms) of the feature's own commits touching it
const ownTimes = (id: string, file: string) => {
  const k = `${id} ${file}`;
  if (!ownCache.has(k)) { const r = tipOf(id); ownCache.set(k, r ? lines(['log', '--no-merges', '--format=%ct', r.tip, `^${r.not}`, '--', file]).map((x) => Number(x) * 1000) : []); }
  return ownCache.get(k)!;
};
// Known at time T that `id` changes `file`: one of its own commits touching it, or an earlier conflict of it on that file.
const conflictsOf = new Map<string, { ts: number; files: string[] }[]>();
for (const e of events) if (e.feature && e.event === 'refreshed' && conflictFiles(e.detail).length) (conflictsOf.get(e.feature) ?? conflictsOf.set(e.feature, []).get(e.feature)!).push({ ts: t(e), files: conflictFiles(e.detail) });
const knownAt = (id: string, file: string, T: number) => ownTimes(id, file).some((x) => x < T) || (conflictsOf.get(id) ?? []).some((c) => c.ts < T && c.files.includes(file));
// In-flight intervals per feature, from the log: launch → the event that ends the pass.
const END = new Set(['merged', 'failed', 'stuck', 'interrupted', 'recovered', 'ready', 'merge-skipped', 'error', 'refresh-skipped', 'merge-hook-failed', 'merge-failed']);
const flights: { id: string; from: number; to: number }[] = [];
{ const open = new Map<string, number>();
  for (const e of events) {
    if (!e.feature) continue;
    if (e.event === 'launch') { if (open.has(e.feature)) flights.push({ id: e.feature, from: open.get(e.feature)!, to: t(e) }); open.set(e.feature, t(e)); continue; }
    const ends = END.has(e.event) || (e.event === 'refreshed' && !/^before test/.test(e.detail));
    if (ends && open.has(e.feature)) { flights.push({ id: e.feature, from: open.get(e.feature)!, to: t(e) }); open.delete(e.feature); }
  }
  for (const [id, from] of open) flights.push({ id, from, to: Date.now() }); }
const flightAt = (id: string, T: number) => flights.find((f) => f.id === id && f.from <= T && T < f.to);
const lastLaunch = (id: string, T: number) => Math.max(-Infinity, ...events.filter((e) => e.feature === id && e.event === 'launch' && t(e) <= T).map(t));
// Hot at T: scored at least 3 over the 7 days before T (the default claims config, nothing listed by hand).
const hotList = (T: number) => [...hotScores(events.filter((e) => t(e) < T), T - 7 * 86400e3)].filter(([, n]) => n >= 3).map(([f]) => f);
const hotAt = (T: number) => { const s = new Set(hotList(T)); return (f: string) => s.has(f); };

// One scenario: `known(id, file, T)` says whether the foreman would know at T that `id` changes `file`; files for which
// `fixed` holds are assumed fixed structurally (their conflicts gone, never claimed); only `claimable` hot files are claimed.
type Known = (id: string, file: string, T: number) => boolean;
const refreshes = inWindow.filter((e) => e.feature && e.event === 'refreshed' && conflictFiles(e.detail).length);
const launches = inWindow.filter((e) => e.feature && e.event === 'launch');
function simulate(known: Known, fixed: (f: string) => boolean = () => false, claimable: (f: string) => boolean = () => true) {
  const why = new Map<string, number>(), add = (k: string) => why.set(k, (why.get(k) ?? 0) + 1);
  let pairs = 0, separated = 0, left = 0, avoided = 0, waited = 0;
  const waits: number[] = []; // minutes until the passes holding its files ended, as they happened without claims
  for (const e of refreshes) {
    const files = conflictFiles(e.detail).filter((f) => !fixed(f));
    if (!files.length) continue; // only structurally fixed files conflicted
    left++;
    const X = e.feature!, T = t(e), t0 = lastLaunch(X, T), hot0 = hotAt(t0), hot = (f: string) => hot0(f) && claimable(f);
    const prev = Math.max(-Infinity, ...(conflictsOf.get(X) ?? []).map((c) => c.ts).filter((x) => x < T),
      ...events.filter((x) => x.feature === X && x.event === 'refreshed' && t(x) < T).map(t));
    const from = Number.isFinite(prev) ? prev : t0; // base was last merged into the branch at its previous refresh
    const merged = events.filter((x) => x.event === 'merged' && x.feature && x.feature !== X && t(x) > from && t(x) <= T);
    let all = true;
    for (const file of files) {
      pairs++;
      const Ys = merged.filter((x) => mergeOf.get(x.feature!)?.files.has(file)).map((x) => ({ id: x.feature!, at: t(x) }));
      const ok = Ys.length > 0 && hot(file) && Ys.every((y) => { const yl = lastLaunch(y.id, y.at);
        return yl <= t0 ? !!flightAt(y.id, t0) && known(y.id, file, t0) : known(X, file, yl); });
      add(!claimable(file) ? 'not claimed' : !Ys.length ? 'no feature merge on base touched it since the last refresh' : !hot(file) ? 'not hot yet' : ok ? 'kept apart' : 'not known in time');
      if (ok) separated++; else all = false;
    }
    if (all) avoided++;
  }
  for (const L of launches) { // would it have waited: a hot file it is known to change is known to be changed by one in flight
    const X = L.feature!, T = t(L), mine = hotList(T).filter((f) => !fixed(f) && claimable(f) && known(X, f, T));
    const holders = mine.length ? flights.filter((b) => b.id !== X && b.from < T && T < b.to && mine.some((f) => known(b.id, f, T))) : [];
    if (holders.length) { waited++; waits.push((Math.max(...holders.map((b) => b.to)) - T) / 60e3); } // until every current holder's pass ended
  }
  const m = median(waits);
  return { refreshesLeft: left, refreshesAvoided: avoided, fileConflicts: pairs, keptApart: separated, why: [...why], launches: launches.length, launchesThatWait: waited, medianWaitMin: Math.round(m) };
}
// What the foreman can know: the feature's own commits and earlier conflicts (no planning step) ...
const observed: Known = knownAt;
// ... and the ceiling with perfect `touches` (every file its final merge touched, or it conflicted on, known from the start).
const perfect: Known = (id, file, T) => !!mergeOf.get(id)?.files.has(file) || knownAt(id, file, Infinity);
const PROV = 'packages/platform/src/provisioning.ts', gen = (f: string) => f === PROV || /^packages\/contracts\/(src\/generated|fixtures)\//.test(f);
const scenarios: Record<string, ReturnType<typeof simulate>> = { observed: simulate(observed), perfect: simulate(perfect),
  afterProvisioningSplit: simulate(observed, (f) => f === PROV), afterSplitAndRegen: simulate(observed, gen), afterSplitAndRegenPerfect: simulate(perfect, gen) };
// Claiming one file only (the rest left to the resolver): what each hot file buys and costs on its own.
for (const [f] of [...hotScores(inWindow, since)].sort((a, b) => b[1] - a[1]).slice(0, 8)) scenarios[`only ${f}`] = simulate(observed, () => false, (x) => x === f);

// ---- report ----

const report = {
  since: new Date(since).toISOString(), mergesReplayed: merges.length, mergesConflicted,
  resolverContext: { conflicts: conflicts.length, coveredByFeature: by('feature'), commitOnly: by('commit-only'), none: by('none'),
    medianBriefChars: median(briefChars), files: files(conflicts).slice(0, 12) },
  keepCheck: { resolutions: conflicts.length, flagged: keepFlag.length, changedOnly: conflicts.filter((c) => !c.keep.length && c.changed).length, leftMarkers: conflicts.filter((c) => c.markers).length,
    flaggedFiles: files(keepFlag).slice(0, 8), resolutionsThatDoNotParse: conflicts.filter((c) => c.resolutionParses === false).length,
    examples: keepFlag.slice(0, nEx).map((c) => ({ merge: c.merge.slice(0, 12), file: c.file, lines: c.keep.slice(0, 4) })) },
  unionDriver: { checkable: unionChecked.length, wouldNotParse: unionBroken.length, caughtByKeepCheck: caught.length, flaggedButParses: unionFlagParses.length },
  claims: { conflictingRefreshes: refreshes.length, scenarios },
};
if (o.json) writeFileSync(o.json, JSON.stringify({ report, conflicts }, null, 2));
const r = report, A = r.resolverContext, K = r.keepCheck, U = r.unionDriver, C = r.claims;
console.log([`Replay of ${repo} since ${r.since}`, '',
  `A. Resolver context: ${r.mergesReplayed} "merge main into <branch>" commits, ${r.mergesConflicted} conflict when replayed (${A.conflicts} conflicting files).`,
  `   The brief names a feature (description + acceptance) behind base's side for ${A.coveredByFeature}/${A.conflicts} (${pct(A.coveredByFeature, A.conflicts)}); ` +
  `only non-feature commits for ${A.commitOnly}; nothing for ${A.none}. Median feature text per brief: ${A.medianBriefChars} chars.`,
  ...A.files.map(([f, n]) => `     ${n}  ${f}`),
  `   Keep-lines check on the resolutions actually committed: ${K.flagged}/${K.resolutions} flagged (${pct(K.flagged, K.resolutions)}), ${K.changedOnly} with changed lines only; ` +
  `${K.leftMarkers} kept conflict markers; ${K.resolutionsThatDoNotParse} do not parse.`,
  ...K.examples.map((x) => `     ${x.merge} ${x.file}: ${x.lines.map((l) => JSON.stringify(l.slice(0, 80))).join(', ')}`),
  `   The reverted union driver on the same conflicts: ${U.wouldNotParse}/${U.checkable} parseable-type files would not parse; the keep-lines check ` +
  `flags ${U.caughtByKeepCheck}/${U.wouldNotParse} of those, and ${U.flaggedButParses} union results that do parse.`, '',
  `B. Claims over ${C.conflictingRefreshes} conflicting refreshes and ${C.scenarios.observed.launches} launches (hot = scored 3+ in the 7 days before):`,
  ...Object.entries(C.scenarios).map(([k, x]) => `   ${k}: refreshes left ${x.refreshesLeft}, avoided ${x.refreshesAvoided} (${pct(x.refreshesAvoided, x.refreshesLeft)}); ` +
    `file conflicts kept apart ${x.keptApart}/${x.fileConflicts} (${pct(x.keptApart, x.fileConflicts)}); launches that wait ${x.launchesThatWait}/${x.launches} (${pct(x.launchesThatWait, x.launches)}, median ${x.medianWaitMin} min)\n` +
    `     ${x.why.map(([w, n]) => `${w}: ${n}`).join('; ')}`)].join('\n'));
