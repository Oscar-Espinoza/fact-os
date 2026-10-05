// Context: what a builder is told beyond the spec, kept small. Three pieces:
// - the candidate map: a cheap, deterministic prediction of where the work lives (declared touches, files that mention the
//   spec's own identifiers, and what those files already export), so a builder reuses instead of re-implementing;
// - context atoms: one-line, verified pointers into the repository, learned from rejected builds (the observer proposes them,
//   deterministic checks and a curator verify them), composed only when their scope matches the candidate files, whole atoms
//   ranked by relevance within a byte budget, with what was left out recorded;
// - the recap: a counted failure's feedback for the next fresh try, every unresolved blocker kept as one line, the full text
//   one file away.
// A map is a prediction, not a scope: it never authorizes or forbids a file. A pointer delivered is not a pointer read.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Feature } from './types.ts';
import { readJson, writeJsonAtomic } from './state.ts';

type Git = (args: string[], cwd: string) => { code: number; out: string };

// ---- candidate map ----

const STOP = new Set(['make', 'with', 'from', 'into', 'that', 'this', 'when', 'only', 'each', 'every', 'full', 'should', 'have', 'over', 'after', 'before', 'without', 'their', 'them', 'more', 'less', 'keep', 'fix', 'add', 'support']);
const TEST = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const PATH = /(?:^|[\s`'"(])((?:[\w@.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|ya?ml|md|prisma|graphql))\b/g;
// Identifiers the spec names itself: backticked code, camelCase/PascalCase words, snake_case and kebab-case names. Generic
// English never qualifies, and an identifier too common in the repository is dropped by the caller.
export function specIdentifiers(f: Pick<Feature, 'title' | 'description' | 'acceptance'>, max = 15): string[] {
  const text = [f.title, f.description, ...(f.acceptance ?? [])].join('\n'), seen = new Set<string>();
  const add = (s: string) => { const t = s.trim().replace(/[.,;:]+$/, ''); if (t.length >= 4 && t.length <= 80 && !/\s/.test(t)) seen.add(t); };
  for (const m of text.matchAll(/`([^`\n]{3,80})`/g)) { const t = m[1]!.replace(/\(.*$/, ''); if (/^[\w$@./:-]+$/.test(t) && !/^\d/.test(t)) add(t); }
  for (const m of text.matchAll(/\b([a-z]+[A-Z][\w]{2,}|[A-Z][a-z]+[A-Z][\w]{2,}|[a-z]+_[a-z_]{3,}|[a-z]+(?:-[a-z]+){2,})\b/g)) add(m[1]!);
  return [...seen].slice(0, max);
}

export interface MapFile { path: string; hits: string[]; declared?: boolean; exports?: string[]; count?: number } // count: a directory standing for that many files
export interface CandidateMap { files: MapFile[]; identifiers: string[]; dropped: string[] } // dropped: identifiers too common to locate anything

// `git grep` over tracked files at the worktree's HEAD. An identifier matching more than `common` files says nothing; one that
// matches no file may be new (the feature creates it).
export function candidateMap(f: Feature, wt: string, git: Git, opts: { maxFiles?: number; common?: number } = {}): CandidateMap {
  const maxFiles = opts.maxFiles ?? 8, common = opts.common ?? 25, ids = specIdentifiers(f), dropped: string[] = [];
  const score = new Map<string, MapFile>();
  const file = (p: string) => score.get(p) ?? score.set(p, { path: p, hits: [] }).get(p)!;
  for (const t of f.touches ?? []) if (!t.endsWith('/')) file(t).declared = true;
  const named = [...[f.description, ...(f.acceptance ?? [])].join('\n').matchAll(PATH)].map((m) => m[1]!);
  for (const p of new Set(named)) if (git(['cat-file', '-e', `HEAD:${p}`], wt).code === 0) file(p).hits.push('named in the spec');
  // Paths named after the title's word pairs ("exception queue" → exception-queue, exceptionQueue, exception_queue).
  const words = f.title.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? [];
  const pairs = words.slice(0, -1).map((w, i) => [w, words[i + 1]!] as const);
  if (pairs.length) {
    const tracked = git(['ls-files'], wt).out.split('\n');
    for (const [a, b] of pairs) {
      const forms = [`${a}-${b}`, `${a}_${b}`, `${a}${b}`], hits = tracked.filter((t) => forms.some((x) => t.toLowerCase().replace(/[^a-z_/-]/g, '').includes(x)));
      if (hits.length && hits.length <= common) for (const h of hits) file(h).hits.push(`path: ${a} ${b}`);
    }
  }
  for (const id of ids) {
    const r = git(['grep', '-l', '-F', '-e', id, 'HEAD', '--', '.', ':!*.lock', ':!*lock.yaml', ':!*.snap', ':!*.min.*', ':!**/generated/**'], wt);
    const hits = r.code === 0 ? r.out.split('\n').filter(Boolean).map((l) => l.replace(/^HEAD:/, '')) : [];
    if (hits.length > common) { dropped.push(id); continue; }
    for (const h of hits) file(h).hits.push(id);
  }
  const rank = (m: MapFile) => (m.declared ? 100 : 0) + m.hits.length * 2 - (TEST.test(m.path) ? 1 : 0);
  // A file counts when declared, named, or matched by two identifiers (one rare identifier is enough when it matched few files).
  const rare = new Set(ids.filter((id) => [...score.values()].filter((m) => m.hits.includes(id)).length <= 3));
  let kept = [...score.values()].filter((m) => m.declared || m.hits.some((h) => h === 'named in the spec' || h.startsWith('path: ')) || m.hits.length >= 2 || m.hits.some((h) => rare.has(h)));
  // Three or more files in one directory matched only by their names (fixtures, generated variants) become that directory.
  const nameOnly = (m: MapFile) => !m.declared && m.hits.every((h) => h.startsWith('path: '));
  const byDir = new Map<string, MapFile[]>();
  for (const m of kept.filter(nameOnly)) { const d = m.path.slice(0, m.path.lastIndexOf('/') + 1); (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(m); }
  for (const [d, ms] of byDir) if (d && ms.length >= 3) {
    kept = kept.filter((m) => !ms.includes(m));
    kept.push({ path: d, hits: [...new Set(ms.flatMap((m) => m.hits))], count: ms.length });
  }
  const files = kept.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path)).slice(0, maxFiles);
  for (const m of files.filter((x) => !TEST.test(x.path) && !x.path.endsWith('/')).slice(0, 3)) {
    const src = git(['show', `HEAD:${m.path}`], wt);
    if (src.code !== 0) continue;
    const ex = [...src.out.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)].map((x) => x[1]!);
    if (ex.length) m.exports = [...new Set(ex)].slice(0, 8);
  }
  return { files, identifiers: ids, dropped };
}

// ---- context atoms ----

export type AtomStatus = 'proposed' | 'verified' | 'quarantined' | 'retired';
export interface AtomRef { path: string; symbol?: string }
export interface Atom {
  id: string; text: string; refs: AtomRef[]; scope: string[]; role: 'builder';
  status: AtomStatus; source: { feature: string; review: string; ts: string };
  verifiedAt?: string; checkedAt?: string; why?: string; // why: the last verification's or quarantine's reason
  prints?: string[]; verifiedRev?: string; // per ref, the fingerprint of the code it was verified against (refPrints), and where
}
export interface AtomStore { version: 1; atoms: Atom[] }
export const ATOM_MAX = 300;          // characters of one atom's text
export const ATOM_REVALIDATE_DAYS = 30;
export const atomsFile = (dir: string): string => join(dir, 'atoms.json');
export function readAtoms(dir: string): AtomStore {
  const s = existsSync(atomsFile(dir)) ? readJson(atomsFile(dir), null) as AtomStore | null : null;
  return s && Array.isArray(s.atoms) ? s : { version: 1, atoms: [] };
}
export const writeAtoms = (dir: string, s: AtomStore): void => writeJsonAtomic(atomsFile(dir), s);
export const atomId = (refs: AtomRef[], text: string): string =>
  'A' + createHash('sha256').update(JSON.stringify([refs.map((r) => `${r.path}#${r.symbol ?? ''}`).sort(), text.toLowerCase().replace(/\W+/g, ' ').trim()])).digest('hex').slice(0, 8);

export interface Pointer { text: string; refs: AtomRef[]; scope: string[] }
// A pointer as the observer's reviewer proposed it, bounded; anything malformed is no pointer.
export function parsePointer(v: unknown): Pointer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const safe = (p: unknown): p is string => typeof p === 'string' && !!p && p.length <= 200 && !p.startsWith('/') && !p.split('/').includes('..');
  const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim() : '';
  const refs = (Array.isArray(o.refs) ? o.refs : []).flatMap((r) => {
    const x = r as Record<string, unknown>;
    return x && safe(x.path) ? [{ path: x.path, ...(typeof x.symbol === 'string' && /^[\w$.]{2,80}$/.test(x.symbol) ? { symbol: x.symbol } : {}) }] : [];
  }).slice(0, 3);
  const scope = (Array.isArray(o.scope) ? o.scope : []).filter(safe).filter((s) => s.length >= 3).slice(0, 4);
  return text && text.length <= ATOM_MAX && refs.length && scope.length ? { text, refs, scope } : null;
}

// Every ref is a regular file tracked at `rev` (never a symlink or submodule, which could lead outside the repository), and
// each named symbol is defined there (a declaration or a definition, not a mention in a comment).
export function refsHold(refs: AtomRef[], rev: string, cwd: string, git: Git): string | null {
  for (const r of refs) {
    const e = git(['ls-tree', rev, '--', r.path], cwd).out.split('\n')[0] ?? '';
    if (!e) return `${r.path} does not exist at ${rev.slice(0, 12)}`;
    if (!/^100(644|755) blob /.test(e)) return `${r.path} is not a regular file at ${rev.slice(0, 12)}`;
    if (r.symbol && symbolSection(git(['show', `${rev}:${r.path}`], cwd).out, r.symbol) == null) return `${r.symbol} is not defined in ${r.path} at ${rev.slice(0, 12)}`;
  }
  return null;
}

// The lines that define `symbol`: its declaration (or, failing that, a definition like `name(`, `name:` or `name =` outside
// comments) through the end of its block. Null when the file does not define it.
export function symbolSection(src: string, symbol: string): string | null {
  const lines = src.split('\n'), sym = symbol.replace(/[$.]/g, (c) => `\\${c}`);
  const decl = new RegExp(`^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(async\\s+)?(function\\*?|const|let|var|class|interface|type|enum)\\s+${sym}\\b`);
  const def = new RegExp(`^\\s*(public |private |protected |static |async |readonly )*${sym}\\s*(\\(|:|=|<)`);
  let at = lines.findIndex((l) => decl.test(l));
  if (at < 0) at = lines.findIndex((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && def.test(l));
  if (at < 0) return null;
  const indent = /^\s*/.exec(lines[at]!)![0].length;
  let end = at;
  for (let i = at + 1; i < Math.min(lines.length, at + 300); i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const ind = /^\s*/.exec(l)![0].length;
    if (ind < indent || (ind === indent && !/^\s*[)}\]]/.test(l))) break;
    end = i;
  }
  return lines.slice(at, end + 1).join('\n');
}

// What each ref's verification covered: the defining section of a symbol, or the whole file. A change there means the advice
// must be checked again; an unrelated change elsewhere in the file does not.
export function refPrints(refs: AtomRef[], rev: string, cwd: string, git: Git): string[] {
  return refs.map((r) => {
    const src = git(['show', `${rev}:${r.path}`], cwd).out, part = r.symbol ? symbolSection(src, r.symbol) ?? '' : src;
    return createHash('sha256').update(part).digest('hex').slice(0, 16);
  });
}

// Why a verified atom may not be used against `rev` now (null: usable): its refs no longer hold, its code changed since it was
// verified, or its verification is older than ATOM_REVALIDATE_DAYS.
export function atomStale(a: Atom, rev: string, cwd: string, git: Git, nowMs = Date.now()): string | null {
  const why = refsHold(a.refs, rev, cwd, git);
  if (why) return why;
  if (!a.prints || a.prints.length !== a.refs.length) return 'it has no verified fingerprint';
  if (refPrints(a.refs, rev, cwd, git).some((p, i) => p !== a.prints![i])) return 'its code changed since it was verified';
  if (!a.verifiedAt || nowMs - Date.parse(a.verifiedAt) > ATOM_REVALIDATE_DAYS * 864e5) return `its verification is over ${ATOM_REVALIDATE_DAYS} days old`;
  return null;
}

export interface AtomPick { included: Atom[]; deferred: { id: string; why: string }[]; bytes: number }
// The verified atoms whose scope covers a candidate file, ranked by how many candidates they cover, then newest verification;
// whole atoms only, up to `budget` bytes. An atom whose refs no longer hold at the worktree's HEAD is left out (the observer
// quarantines it); one over budget is deferred. Both are recorded, never silently dropped.
export function pickAtoms(atoms: Atom[], candidates: string[], budget: number, holds: (a: Atom) => string | null): AtomPick {
  const covers = (a: Atom) => candidates.filter((c) => a.scope.some((s) => c === s || c.startsWith(s.endsWith('/') ? s : s + '/'))).length;
  const ranked = atoms.filter((a) => a.status === 'verified').map((a) => ({ a, n: covers(a) })).filter((x) => x.n > 0)
    .sort((x, y) => y.n - x.n || (y.a.verifiedAt ?? '').localeCompare(x.a.verifiedAt ?? ''));
  const out: AtomPick = { included: [], deferred: [], bytes: 0 };
  for (const { a } of ranked) {
    const why = holds(a);
    if (why) { out.deferred.push({ id: a.id, why }); continue; }
    const size = Buffer.byteLength(atomLine(a)) + 1;
    if (out.bytes + size > budget) { out.deferred.push({ id: a.id, why: 'over the context budget' }); continue; }
    out.included.push(a); out.bytes += size;
  }
  return out;
}
const atomLine = (a: Atom) => `- ${a.text} (${a.refs.map((r) => r.symbol ? `${r.symbol} in ${r.path}` : r.path).join('; ')})`;

// The builder's "Map" section: at most ~25 lines, or nothing when the map found nothing confident and no atom applies.
export function renderContext(map: CandidateMap, pick: AtomPick): string {
  const lines: string[] = [];
  if (map.files.length) {
    lines.push('Likely places (a prediction from the spec, not a limit: change what the feature needs):');
    for (const m of map.files) lines.push(`- ${m.path}${m.count ? ` (${m.count} files)` : ''}${m.declared ? ' (declared)' : ''}${m.hits.length ? ` — ${m.hits.slice(0, 3).map((h) => h === 'named in the spec' ? h : h.startsWith('path: ') ? `named like "${h.slice(6)}"` : `mentions \`${h}\``).join(', ')}` : ''}` +
      `${m.exports ? `; exports ${m.exports.map((e) => `\`${e}\``).join(', ')}` : ''}`);
  }
  if (pick.included.length) lines.push('Verified pointers from earlier reviews of this area (reuse these; read the code before relying on them):', ...pick.included.map(atomLine));
  return lines.length ? `\n## Map\n\n${lines.join('\n')}\n` : '';
}

// ---- lessons ----

// The lessons file, shortened for one build when it is over `budget` bytes: its bullets ranked by relevance (a path or prefix the
// bullet names that a candidate file falls under, then words it shares with the spec), then in the file's own order, whole
// bullets only, under their section headings, with the count left out and where the full file is. Under budget: unchanged.
export function selectLessons(text: string, candidates: string[], spec: string, budget: number, fullFile: string | null): { text: string; included: number; total: number } {
  const lines = text.split('\n'), bullets: { head: string; text: string; i: number; score: number }[] = [];
  let head = '';
  for (const l of lines) {
    if (/^#{2,4} /.test(l)) { head = l; continue; }
    if (/^- /.test(l)) bullets.push({ head, text: l, i: bullets.length, score: 0 });
    else if (bullets.length && /^\s+\S/.test(l) && bullets.at(-1)!.head === head) bullets.at(-1)!.text += '\n' + l;
  }
  if (Buffer.byteLength(text) <= budget || !bullets.length) return { text, included: bullets.length, total: bullets.length };
  const words = new Set((spec.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
  for (const b of bullets) {
    const refs = [...b.text.matchAll(/`([\w@.-]+\/[\w@./<>*-]*)`/g)].map((m) => m[1]!.replace(/<.*$|\*.*$/, ''));
    b.score = 3 * refs.filter((r) => r.length >= 3 && candidates.some((c) => c.startsWith(r))).length + new Set((b.text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => words.has(w))).size * 0.2;
  }
  const footer = (n: number) => `\n(${n} more lesson${n === 1 ? '' : 's'} not shown here${fullFile ? `; all ${bullets.length} are in ${fullFile}` : ''}.)`;
  const picked = new Set<number>();
  let used = Buffer.byteLength(footer(bullets.length));
  for (const b of [...bullets].sort((x, y) => y.score - x.score || x.i - y.i)) {
    const size = Buffer.byteLength(b.text) + 1 + (picked.size && [...picked].some((i) => bullets[i]!.head === b.head) ? 0 : Buffer.byteLength(b.head) + 2);
    if (used + size > budget) continue;
    picked.add(b.i); used += size;
  }
  const out: string[] = [];
  let last: string | null = null;
  for (const b of bullets) if (picked.has(b.i)) { if (b.head !== last) { if (b.head) out.push('', b.head); last = b.head; } out.push(b.text); }
  return { text: out.join('\n').trim() + footer(bullets.length - picked.size), included: picked.size, total: bullets.length };
}

// ---- recap ----

// A counted failure's feedback for the next fresh try. Short feedback passes unchanged. Longer feedback keeps the lines that
// name a failure (FAILED / BLOCKING / CHEATING / BASE DEFECT / Evaluator / test command …), in order, each shortened to fit, within
// `maxBytes` (UTF-8, footer included) and `maxLines`; failures that still do not fit are counted, never silently dropped, and
// the full text is one file away.
export function recap(feedback: string, fullFile: string | null, maxBytes = 4000, maxLines = 15): string {
  if (Buffer.byteLength(feedback) <= maxBytes) return feedback;
  const KEY = /^(FAILED |BLOCKING:|CHEATING:|BASE DEFECT|Evaluator:|test command `|The merge resolution|builder failed|no progress|merge conflict)/;
  const lines = feedback.split('\n'), keys = lines.filter((l) => KEY.test(l)), pick = keys.length ? keys : lines.filter((l) => l.trim()).slice(0, maxLines);
  const total = Buffer.byteLength(feedback);
  const footer = (more: number) => [more ? `… and ${more} more failure line${more === 1 ? '' : 's'}, listed in full in the file below.` : '',
    fullFile ? `The full feedback (${total} bytes) is in ${fullFile}; read it before you change anything.` : `(${total} bytes of feedback, shortened here.)`].filter(Boolean).join('\n');
  const clipBytes = (l: string, n: number) => { if (Buffer.byteLength(l) <= n) return l; let t = l; while (Buffer.byteLength(t) > Math.max(0, n - 4)) t = t.slice(0, Math.floor(t.length * 0.9)); return t + ' […]'; };
  // As many failure lines as the line cap allows, each given an equal share of the bytes left after the footer.
  for (let n = Math.min(pick.length, maxLines - 2); n >= 1; n--) {
    const more = pick.length - n, foot = footer(more), share = Math.floor((maxBytes - Buffer.byteLength(foot) - n) / n);
    if (share < 60) continue;
    const out = [...pick.slice(0, n).map((l) => clipBytes(l, share)), foot].join('\n');
    if (Buffer.byteLength(out) <= maxBytes) return out;
  }
  return clipBytes(footer(pick.length), maxBytes);
}

export const readIfExists = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
