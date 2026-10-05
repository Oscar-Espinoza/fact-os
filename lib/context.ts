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

// Every ref exists at `rev`, and each named symbol appears in its file there.
export function refsHold(refs: AtomRef[], rev: string, cwd: string, git: Git): string | null {
  for (const r of refs) {
    if (git(['cat-file', '-e', `${rev}:${r.path}`], cwd).code !== 0) return `${r.path} does not exist at ${rev.slice(0, 12)}`;
    if (r.symbol && git(['grep', '-q', '-F', '-e', r.symbol, rev, '--', r.path], cwd).code !== 0) return `${r.symbol} is not in ${r.path} at ${rev.slice(0, 12)}`;
  }
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

// ---- recap ----

// A counted failure's feedback for the next fresh try. Short feedback passes unchanged. Longer feedback keeps every line that
// names a failure (FAILED / BLOCKING / CHEATING / BASE DEFECT / Evaluator / test command) as one bounded line, in order, and points
// to the full text; nothing that caused the rejection is cut, only its detail beyond `lineMax` characters.
export function recap(feedback: string, fullFile: string | null, maxBytes = 4000, lineMax = 240): string {
  if (Buffer.byteLength(feedback) <= maxBytes) return feedback;
  const KEY = /^(FAILED |BLOCKING:|CHEATING:|BASE DEFECT|Evaluator:|test command `|The merge resolution|builder failed|Feedback)/;
  const lines = feedback.split('\n'), keys = lines.filter((l) => KEY.test(l));
  const kept = (keys.length ? keys : lines.filter((l) => l.trim()).slice(0, 12)).map((l) => (l.length > lineMax ? `${l.slice(0, lineMax)}… [${l.length - lineMax} more characters]` : l));
  const omitted = Buffer.byteLength(feedback) - Buffer.byteLength(kept.join('\n'));
  return [...kept, '', fullFile ? `The full feedback (${omitted} more characters of detail) is in ${fullFile}; read it before you change anything.`
    : `(${omitted} characters of detail omitted.)`].join('\n');
}

export const readIfExists = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
