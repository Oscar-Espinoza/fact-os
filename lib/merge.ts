// The merge process (docs/merge-process.md): hot files and file claims for scheduling, the both-sides brief a conflict
// resolution gets, and the keep-lines check of a committed resolution. Pure functions first (unit tested), then the
// few git reads they need. Self-contained (own git runner) so foreman.ts and observe.ts can both import it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from './state.ts';
import type { ClaimsConfig, Feature, LogEvent } from './types.ts';

export const DEFAULT_CLAIMS: ClaimsConfig = { hot: [], minScore: 3, days: 7 };

// ---- hot files (from history) ----

// Files listed by a `refreshed` event: "conflicts in: a, b" ([] for a conflict-free refresh).
export const conflictFiles = (detail: string): string[] =>
  /conflicts in: /.test(detail) ? detail.split('conflicts in: ')[1]!.split(', ').map((f) => f.trim()).filter(Boolean) : [];

// How often each file sent work back since `since`: 1 per conflicting refresh, +1 more when that refresh came right after
// `evaluating` (a bounce: finished, gated and evaluated work went back; a `lesson` in between is allowed).
export function hotScores(events: LogEvent[], since: number): Map<string, number> {
  const scores = new Map<string, number>(), last = new Map<string, string>();
  for (const e of events) {
    if (!e.feature) continue;
    const prev = last.get(e.feature);
    if (e.event !== 'lesson') last.set(e.feature, e.event);
    if (e.event !== 'refreshed' || Date.parse(e.ts) < since) continue;
    for (const f of conflictFiles(e.detail || '')) scores.set(f, (scores.get(f) ?? 0) + (prev === 'evaluating' ? 2 : 1));
  }
  return scores;
}

// A pattern is a repo path, or a directory prefix ending in "/".
export const matches = (file: string, pattern: string): boolean => (pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern);

// The narrower shared file/directory prefix, or null when paths do not overlap.
export const sharedPath = (a: string, b: string): string | null => matches(a, b) ? a : matches(b, a) ? b : null;

// Known protected paths for directory checks and precise builder hints. With a
// zero threshold even unrecorded paths are hot; callers handle that separately.
export const hotPaths = (scores: Map<string, number>, c: ClaimsConfig): string[] =>
  [...new Set([...c.hot, ...[...scores].filter(([, n]) => n >= c.minScore).map(([f]) => f)])].sort();

// A file keeps exact score/listed-pattern semantics. A declared directory also
// contains hot paths when a listed/scored descendant overlaps it.
export const hotTest = (scores: Map<string, number>, c: ClaimsConfig) => {
  const known = hotPaths(scores, c);
  return (file: string): boolean => (scores.get(file) ?? 0) >= c.minScore || c.hot.some((p) => matches(file, p)) ||
    (file.endsWith('/') && known.some((p) => sharedPath(file, p) !== null));
};

// The first hot intersection with a holder, or null. The caller supplies in-flight
// holders in order; candidate and held paths are sorted/deduplicated. A hot sibling
// outside the actual intersection must not make a shared cold path block.
export function claimBlock(candidate: string[], held: [string, string[]][], hot: (f: string) => boolean): { file: string; by: string } | null {
  const mine = [...new Set(candidate)].sort();
  for (const [by, files] of held) {
    const theirs = [...new Set(files)].sort();
    for (const f of mine) for (const g of theirs) {
      const shared = sharedPath(f, g);
      if (shared !== null && hot(shared)) return { file: shared, by };
    }
  }
  return null;
}

// ---- the keep-lines check ----

// A line "means something" when it has a letter or digit; lines of only brackets and punctuation (`],`, `});`) are
// structure, and each side that added one needs its own copy (a union merge that kept one lost a closer).
const meaningful = (l: string) => /[\p{L}\p{N}]/u.test(l);
export function lineCounts(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const raw of text.split('\n')) { const l = raw.trim(); if (l) m.set(l, (m.get(l) ?? 0) + 1); }
  return m;
}

export interface Missing { line: string; missing: number; side: 'ours' | 'theirs' | 'both' }
export interface Changed { line: string; now: string }
// Comment-only lines carry no behaviour (rewrapping a doc comment is no loss): //, /*, *, #, <!--, "-- " (SQL).
const comment = (l: string) => /^(\/\/|\/\*|\*|#|<!--|-- )/.test(l);
// The shape of a line: numbers as #, no trailing , or ;, single spaces. A renumbered key or a list's moved `;` keeps it.
const shape = (l: string) => l.replace(/\d+/g, '#').replace(/[,;]+$/, '').replace(/\s+/g, ' ');
const bigrams = (l: string) => { const m = new Map<string, number>(); for (let i = 0; i < l.length - 1; i++) m.set(l.slice(i, i + 2), (m.get(l.slice(i, i + 2)) ?? 0) + 1); return m; };
const words = (l: string) => new Set(l.match(/[\p{L}\p{N}_]+/gu) ?? []);
// `now` keeps every word of `l` (at least 3): one side's edit of a line both sides edited, combined into `now`.
const within = (l: string, now: string) => { const w = words(l), n = words(now); return w.size >= 3 && [...w].every((x) => n.has(x)); };
const dice = (a: string, b: string) => { // 0..1 similarity of two lines (Sørensen–Dice over character bigrams)
  const A = bigrams(a), B = bigrams(b); let n = 0;
  for (const [k, v] of A) n += Math.min(v, B.get(k) ?? 0);
  return a.length + b.length > 2 ? (2 * n) / (a.length + b.length - 2) : a === b ? 1 : 0;
};

// The keep-lines check on one file. For each trimmed, non-blank, non-comment line, the result must hold at least
//   base + (ours - base) + (theirs - base)   copies (each side's additions and deletions kept), except that a meaningful line
//   both sides added is expected max(ours, theirs) times (the same import or call added twice is one change).
// A line short of that is `changed` when the result has a new line (one neither side had) of the same shape, at least 85%
// alike, or keeping all its words (3+): a key renumbered because both sides took the number, a list's `;` that moved, two
// edits of one line combined. Each new line excuses at most one line of each side. Otherwise the line is `lost`. Order and
// indentation are free. Only counts and line pairs, so it is cheap and never fooled by formatting.
export function checkLines(base: string, ours: string, theirs: string, result: string): { lost: Missing[]; changed: Changed[] } {
  const B = lineCounts(base), O = lineCounts(ours), T = lineCounts(theirs), R = lineCounts(result), short: Missing[] = [];
  const fresh: { line: string; ours: boolean; theirs: boolean }[] = []; // new lines, and which side's line each already excused
  const want = (l: string) => { const b = B.get(l) ?? 0, dO = (O.get(l) ?? 0) - b, dT = (T.get(l) ?? 0) - b;
    return { b, dO, dT, n: dO > 0 && dT > 0 && meaningful(l) ? b + Math.max(dO, dT) : b + dO + dT, most: b + Math.max(0, dO) + Math.max(0, dT) }; };
  for (const l of new Set([...O.keys(), ...T.keys()])) {
    const w = want(l);
    if ((w.dO <= 0 && w.dT <= 0) || comment(l)) continue; // neither side added it: deletions are the resolver's call (the gate sees them)
    const miss = w.n - (R.get(l) ?? 0);
    if (miss > 0) short.push({ line: l, missing: miss, side: w.dO > 0 && w.dT > 0 ? 'both' : w.dO > 0 ? 'ours' : 'theirs' });
  }
  for (const [l, n] of R) if (!comment(l)) for (let k = n - want(l).most; k > 0; k--) fresh.push({ line: l, ours: false, theirs: false });
  const lost: Missing[] = [], changed: Changed[] = [];
  for (const m of short.sort((a, b) => a.line.localeCompare(b.line))) {
    let left = m.missing;
    const sides = (m.side === 'both' ? ['ours', 'theirs'] : [m.side]) as ('ours' | 'theirs')[];
    while (left > 0) {
      const free = fresh.map((f) => ({ f, s: sides.find((x) => !f[x]) })).filter((x) => x.s);
      let pick = free.find((x) => shape(x.f.line) === shape(m.line));
      if (!pick && meaningful(m.line)) { const best = free.map((x) => dice(x.f.line, m.line)), top = Math.max(-1, ...best); if (top >= 0.85) pick = free[best.indexOf(top)]; }
      if (!pick) pick = free.find((x) => within(m.line, x.f.line));
      if (!pick) break;
      pick.f[pick.s!] = true;
      changed.push({ line: m.line, now: pick.f.line });
      left--;
    }
    if (left > 0) lost.push({ ...m, missing: left });
  }
  return { lost, changed };
}
export const missingLines = (base: string, ours: string, theirs: string, result: string): Missing[] => checkLines(base, ours, theirs, result).lost;

// Lines a resolution drops on purpose, declared in a commit message as `dropped: <file>: <line>` (one per line).
export function declaredDrops(messages: string): Set<string> {
  const s = new Set<string>();
  for (const m of messages.matchAll(/^dropped: ([^:\n]+): (.*)$/gm)) s.add(`${m[1]!.trim()}\n${m[2]!.trim()}`);
  return s;
}

// ---- conflict hunks ----

// The conflict blocks of a file with markers (diff3 style shows the base too), with `context` lines around each, at most
// `max` chars. "" when the file has no markers (e.g. modify/delete).
export function conflictHunks(text: string, context = 3, max = 4000): string {
  const lines = text.split('\n'), keep = new Set<number>();
  let start = -1;
  lines.forEach((l, i) => {
    if (l.startsWith('<<<<<<< ')) start = i;
    else if (l.startsWith('>>>>>>> ') && start >= 0) { for (let j = Math.max(0, start - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j); start = -1; }
  });
  let out = '', prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) { out += (i !== prev + 1 && out ? '…\n' : '') + `${lines[i]}\n`; prev = i; }
  return out.length > max ? out.slice(0, max) + `… (${out.length - max} more chars: open the file)\n` : out;
}

// ---- git reads ----

const git = (args: string[], cwd: string): { code: number; out: string } => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, env: childEnv() });
  return { code: r.status ?? 1, out: (r.stdout || '').trimEnd() };
};
const lines = (args: string[], cwd: string) => git(args, cwd).out.split('\n').filter(Boolean);
const show = (cwd: string, rev: string, file: string) => { const r = git(['show', `${rev}:${file}`], cwd); return r.code ? '' : r.out; };

// What a feature changes or is about to change: its declared `touches`, the committed diff base...branch, and the
// uncommitted edits in its worktree (a builder "declares" a file the moment it edits it). While a base refresh is in
// progress the index holds base's changes too, so then only unmerged files and edits not yet staged count.
export function featureFiles(root: string, f: Pick<Feature, 'touches'>, base: string, branch: string, wt: string | null): string[] {
  const s = new Set(f.touches || []);
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).code === 0)
    for (const x of lines(['diff', '--name-only', '--no-renames', `${base}...${branch}`], root)) s.add(x);
  if (!wt) return [...s];
  const merging = git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], wt).code === 0;
  for (const x of lines(['status', '--porcelain', '--no-renames', '--untracked-files=all'], wt))
    if (!merging || x[1] !== ' ' || /U|AA|DD/.test(x.slice(0, 2))) s.add(x.slice(3));
  return [...s];
}

// The commit subject of the foreman's merge into base (also the pre-rename "shipyard:" prefix).
export const MERGE_SUBJECT = /^(?:fact-os|shipyard): merge (\S+): (.*)$/;

export interface BaseSide { sha: string; id: string | null; title: string; files: string[] }
// The commits base gained since `mergeBase` (first-parent line, oldest first) that touch any of `files`: the foreman's
// feature merges (id + title from the subject), or any other commit (id null, title = subject).
export function baseSide(cwd: string, mergeBase: string, theirs: string, files: string[]): BaseSide[] {
  const out: BaseSide[] = [];
  for (const l of lines(['log', '--first-parent', '--reverse', '--format=%H%x09%s', theirs, `^${mergeBase}`], cwd)) {
    const [sha, subject = ''] = l.split('\t');
    const touched = lines(['diff', '--name-only', '--no-renames', `${sha}^1`, sha!, '--', ...files], cwd);
    if (!touched.length) continue;
    const m = MERGE_SUBJECT.exec(subject);
    out.push({ sha: sha!, id: m ? m[1]! : null, title: m ? m[2]! : subject, files: touched });
  }
  return out;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const about = (f: Pick<Feature, 'description' | 'acceptance'>, n: number) =>
  [cap((f.description || '').trim(), n), ...(f.acceptance?.length ? ['Acceptance:', ...f.acceptance.map((a) => `- ${cap(a, 300)}`)] : [])].join('\n');

// The both-sides brief for a conflicted merge of `theirs` (base) into `ours` (the branch), read from the worktree while
// the merge is in progress: this feature, every feature merged into base since the last merge base that touched a
// conflicting file (with its description and acceptance checks from features.json), and the conflict hunks.
export function conflictBrief(o: { wt: string; base: string; branch: string; ours: string; theirs: string; files: string[];
  feature: Pick<Feature, 'id' | 'title' | 'description' | 'acceptance'>; features: Pick<Feature, 'id' | 'title' | 'description' | 'acceptance'>[]; max?: number }): { text: string; others: string } {
  const mb = git(['merge-base', o.ours, o.theirs], o.wt).out;
  const sides = mb ? baseSide(o.wt, mb, o.theirs, o.files) : [];
  const byId = new Map(o.features.map((f) => [f.id, f]));
  const st = new Map(lines(['status', '--porcelain', '--no-renames'], o.wt).map((l) => [l.slice(3), l.slice(0, 2)]));
  const out = [`## Merge conflict: keep both sides`, '',
    `The foreman merged ${o.base} (${o.theirs.slice(0, 12)}) into ${o.branch} and it conflicts in: ${o.files.join(', ')}.`,
    `Resolve it so that this feature AND every feature below that changed the same files on ${o.base} keep working as their acceptance checks say.`, '',
    `### This branch: ${o.feature.id}: ${o.feature.title}`, about(o.feature, 1500), '',
    `### Merged into ${o.base} since this branch last had it (${mb.slice(0, 12) || 'unknown'}), touching the conflicting files`];
  if (!sides.length) out.push('(none found: the conflicting change on base came from outside the foreman\'s feature merges)');
  for (const s of sides) {
    const f = s.id ? byId.get(s.id) : undefined;
    out.push(s.id ? `- ${s.id}: ${s.title} (${s.sha.slice(0, 12)}; files: ${s.files.join(', ')})` : `- commit ${s.sha.slice(0, 12)} "${s.title}" (files: ${s.files.join(', ')})`);
    if (f) out.push(about(f, 800).replace(/^/gm, '  '));
  }
  out.push('', '### Conflict hunks (ours = this branch, ||||||| = common ancestor, theirs = ' + o.base + ')');
  for (const file of o.files) {
    let text = ''; try { text = readFileSync(join(o.wt, file), 'utf8'); } catch {}
    const h = conflictHunks(text);
    out.push('', `#### ${file} (${st.get(file) || 'U'})`, h ? '```\n' + h + '```' : '(no conflict markers: one side deleted or renamed the file; see `git status`)');
  }
  // For the evaluator: which features on base the resolution must not break, with their checks.
  const others = sides.filter((x) => x.id).map((x) => { const f = byId.get(x.id!); return `- ${x.id}: ${x.title} (${x.files.join(', ')})` +
    (f?.acceptance?.length ? '\n' + f.acceptance.map((a) => `  - ${cap(a, 300)}`).join('\n') : ''); }).join('\n');
  return { text: cap(out.join('\n'), o.max ?? 16000), others: cap(others || `(no feature merges found; files: ${o.files.join(', ')})`, 6000) };
}

// The keep-lines check of a committed resolution: `tip` contains both `ours` and `theirs`; for each conflicted file,
// lines either side added must still be in tip, unless a commit message on the branch since `ours` declares them dropped.
export function keepCheck(cwd: string, ours: string, theirs: string, tip: string, files: string[]): { ok: boolean; missing: (Missing & { file: string })[]; changed: (Changed & { file: string })[] } {
  const mb = git(['merge-base', ours, theirs], cwd).out;
  const declared = declaredDrops(git(['log', '--first-parent', '--format=%B', tip, `^${ours}`], cwd).out);
  const missing: (Missing & { file: string })[] = [], changed: (Changed & { file: string })[] = [];
  // Lines the resolution wrote into other files (neither side had them there): a lost line found among them was moved,
  // e.g. when base split a shared registry into one file per entry and the resolution moved this branch's entry over.
  const moved = new Map<string, { n: number; file: string }>();
  const touched = new Set([ours, theirs].flatMap((r) => git(['diff', '--name-only', r, tip], cwd).out.split('\n').filter(Boolean)));
  for (const f of touched) {
    if (files.includes(f)) continue;
    const before = new Set([show(cwd, ours, f), show(cwd, theirs, f)].flatMap((t) => t.split('\n')).map((l) => l.trim()));
    for (const l of show(cwd, tip, f).split('\n')) {
      const t = l.trim();
      if (t && !before.has(t)) { const m = moved.get(t); if (m) m.n++; else moved.set(t, { n: 1, file: f }); }
    }
  }
  for (const file of files) {
    const c = checkLines(mb ? show(cwd, mb, file) : '', show(cwd, ours, file), show(cwd, theirs, file), show(cwd, tip, file));
    const left: typeof c.lost = [], movedTo = new Map<string, string>(); // side → where most of its block went
    let movedN = 0;
    for (const m of c.lost) {
      if (declared.has(`${file}\n${m.line}`)) continue;
      const mv = moved.get(m.line.trim());
      if (mv && mv.n >= m.missing) { mv.n -= m.missing; movedN++; movedTo.set(m.side, mv.file); changed.push({ file, line: m.line, now: `(moved to ${mv.file})` } as Changed & { file: string }); continue; }
      left.push(m);
    }
    // A block moved to a new layout often changes its first line (a registry key becoming a module): when most of one
    // side's lost lines in this file were moved, its few remaining ones travelled with the block.
    for (const m of left) {
      const to = movedTo.get(m.side);
      if (to && movedN >= 3 && left.length * 2 <= movedN) changed.push({ file, line: m.line, now: `(moved with its block to ${to}, rewritten)` } as Changed & { file: string });
      else missing.push({ file, ...m });
    }
    for (const x of c.changed) changed.push({ file, ...x });
  }
  return { ok: !missing.length, missing, changed };
}

// For the evaluator: lines the resolution changed instead of keeping.
export const changedNote = (changed: (Changed & { file: string })[], max = 15): string => !changed.length ? '' :
  ['Lines the resolution changed rather than kept as either side wrote them (check each is intended):',
    ...changed.slice(0, max).map((c) => `- ${c.file}: \`${cap(c.line, 160)}\` → \`${cap(c.now, 160)}\``), ...(changed.length > max ? [`… ${changed.length - max} more`] : [])].join('\n');

export function keepFeedback(base: string, missing: (Missing & { file: string })[], max = 40): string {
  const who = { ours: 'this branch', theirs: base, both: 'both sides' };
  return [`The merge resolution lost lines that one side added. Put them back (keep both sides' behaviour), or, if a line must go or change ` +
    `(a duplicate, a key or number both sides used), add a commit whose message lists it as \`dropped: <file>: <line>\` with the reason:`,
    ...missing.slice(0, max).map((m) => `- ${m.file}: \`${cap(m.line, 200)}\` (added by ${who[m.side]}${m.missing > 1 ? `, ${m.missing} copies` : ''})`),
    ...(missing.length > max ? [`… ${missing.length - max} more`] : [])].join('\n');
}
