// Scorecard: how each builder model and effort does, from the run ledger, for the observer's Models section.
// The unit is a build episode: one fresh builder session (a feature's first build of a try, or a relaunch), with the repairs it
// made in its own session, the reviews of its work and how that ended. Episodes are grouped by builder model, effort and the
// tier recorded at launch; history without a recorded tier stays "unknown", never today's tier backfilled.
// Rates are fractions of a stated denominator, with the number of distinct features behind them: episodes of one feature are
// not independent, and a cell with fewer than JUDGE_MIN features is "too few to judge". Comparing cells is only fair within one
// tier and one period; this projection never names a winner.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IssueKind, LogEvent, Verdict } from './types.ts';
import { parseClaudeOutput, parseVerdict } from './foreman.ts';

export const JUDGE_MIN = 8;          // distinct features before a cell's rates are worth reading
export interface RunFile { tag: string; role: 'build' | 'eval'; mtime: number; cost: number | null; verdict: Verdict | null; invalid: boolean }
export type Review = 'accepted' | 'rejected' | 'invalid' | 'none';
export interface Episode {
  feature: string; ts: string; model: string; effort: string; tier: string; escalated: boolean;
  firstReview: Review; finalReview: Review; repairs: number; kinds: IssueKind[]; cost: number | null; merged: boolean;
}

const tagKey = (t: string) => t.split('.').map(Number) as number[];
const tagCmp = (a: string, b: string) => { const x = tagKey(a), y = tagKey(b); return (x[0]! - y[0]!) || ((x[1] ?? 1) - (y[1] ?? 1)); };
const review = (r: RunFile | undefined): Review => (!r ? 'none' : r.invalid || !r.verdict ? 'invalid' : r.verdict.pass ? 'accepted' : 'rejected');
const FP = /^builder model=(\S+) effort=(\S+)/;

// One feature's episodes. A fresh build is a builder prompt event with run.phase "build", or (older logs) the first builder
// prompt after a launch; its run files are matched by tag (recorded) or by the prompt file written at that moment.
export function episodes(feature: string, events: LogEvent[], files: RunFile[], promptMtimes: { tag: string; mtime: number }[]): Episode[] {
  const out: (Episode & { tag: string | null; at: number })[] = [];
  let afterLaunch = false;
  for (const e of events) {
    if (e.feature !== feature) continue;
    if (e.event === 'launch') { afterLaunch = true; continue; }
    if (e.event === 'merged' && out.length) { out[out.length - 1]!.merged = true; continue; }
    if (e.event !== 'prompt') continue;
    const r = e.run, fp = FP.exec(e.detail || '');
    const fresh = r ? r.role === 'builder' && r.phase === 'build' : !!fp && afterLaunch;
    if (r?.role === 'builder' || fp) afterLaunch = false;
    if (!fresh) continue;
    const at = Date.parse(e.ts), byTime = promptMtimes.filter((p) => Math.abs(p.mtime - at) < 15000).sort((a, b) => Math.abs(a.mtime - at) - Math.abs(b.mtime - at))[0];
    out.push({ feature, ts: e.ts, at, tag: r?.tag ?? byTime?.tag ?? null, model: r ? r.model ?? '-' : fp![1]!, effort: r ? r.effort ?? '-' : fp![2]!, tier: r?.tier ?? 'unknown',
      escalated: !!r?.rule?.includes('→'), firstReview: 'none', finalReview: 'none', repairs: 0, kinds: [], cost: null, merged: false });
  }
  // The run files between one episode's tag and the next episode's are that episode's: its builds (the first and its repairs)
  // and its reviews, in tag order.
  const tagged = out.filter((x) => x.tag).sort((a, b) => tagCmp(a.tag!, b.tag!));
  for (let i = 0; i < tagged.length; i++) {
    const x = tagged[i]!, next = tagged[i + 1]?.tag;
    const mine = files.filter((f) => tagCmp(f.tag, x.tag!) >= 0 && (!next || tagCmp(f.tag, next) < 0)).sort((a, b) => tagCmp(a.tag, b.tag));
    const evals = mine.filter((f) => f.role === 'eval'), builds = mine.filter((f) => f.role === 'build');
    x.firstReview = review(evals[0]); x.finalReview = review(evals.at(-1)); x.repairs = Math.max(0, builds.length - 1);
    const v = evals[0]?.verdict;
    if (v && !v.pass) x.kinds = [...new Set([...v.findings.flatMap((f) => (f.kind ? [f.kind] : [])), ...(v.blockingKinds ?? []).filter((k): k is IssueKind => !!k)])];
    const costs = builds.map((b) => b.cost);
    x.cost = costs.length && costs.every((c) => c != null) ? Math.round(costs.reduce((s, c) => s + c!, 0) * 100) / 100 : null;
  }
  return out.map(({ tag: _t, at: _a, ...e }) => e);
}

export interface Cell {
  model: string; effort: string; tier: string; episodes: number; features: number; judged: boolean;
  reviewed: number; firstAccepted: number; finalAccepted: number; invalid: number; neverReviewed: number;
  merged: number; repairs: number; escalated: number; kinds: { kind: IssueKind; n: number }[]; medianCost: number | null; unpriced: number;
}
export interface Scorecard { at: string; since: string | null; episodes: number; features: number; tierRecorded: number; cells: Cell[]; verdict: string }

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export function scorecard(eps: Episode[], at = new Date().toISOString()): Scorecard {
  const groups = new Map<string, Episode[]>();
  for (const e of eps) { const k = `${e.model}\t${e.effort}\t${e.tier}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
  const cells: Cell[] = [...groups].map(([k, es]) => {
    const [model, effort, tier] = k.split('\t') as [string, string, string], features = new Set(es.map((e) => e.feature)).size, kinds = new Map<IssueKind, number>();
    for (const e of es) for (const x of e.kinds) kinds.set(x, (kinds.get(x) ?? 0) + 1);
    const reviewed = es.filter((e) => e.firstReview === 'accepted' || e.firstReview === 'rejected');
    return { model, effort, tier, episodes: es.length, features, judged: features >= JUDGE_MIN, reviewed: reviewed.length,
      firstAccepted: reviewed.filter((e) => e.firstReview === 'accepted').length, finalAccepted: es.filter((e) => e.finalReview === 'accepted').length,
      invalid: es.filter((e) => e.firstReview === 'invalid').length, neverReviewed: es.filter((e) => e.firstReview === 'none').length,
      merged: es.filter((e) => e.merged).length, repairs: es.reduce((n, e) => n + e.repairs, 0), escalated: es.filter((e) => e.escalated).length,
      kinds: [...kinds].map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n), medianCost: median(es.flatMap((e) => (e.cost == null ? [] : [e.cost]))), unpriced: es.filter((e) => e.cost == null).length };
  }).sort((a, b) => a.tier.localeCompare(b.tier) || b.episodes - a.episodes);
  // Comparable: two or more judged cells sharing a recorded tier.
  const byTier = new Map<string, Cell[]>();
  for (const c of cells) if (c.judged && c.tier !== 'unknown') (byTier.get(c.tier) ?? byTier.set(c.tier, []).get(c.tier)!).push(c);
  const comparable = [...byTier].filter(([, cs]) => cs.length >= 2).map(([t]) => t);
  const most = Math.max(0, ...cells.filter((c) => c.tier !== 'unknown').map((c) => c.features));
  const verdict = comparable.length ? `Comparable cells exist for ${comparable.join(', ')}; read them within each tier.`
    : `Insufficient comparable evidence: no recorded tier has two models with ${JUDGE_MIN}+ features each (largest tier-recorded cell: ${most} feature${most === 1 ? '' : 's'}). Routing stays as configured.`;
  return { at, since: eps.length ? eps.map((e) => e.ts).sort()[0]! : null, episodes: eps.length, features: new Set(eps.map((e) => e.feature)).size,
    tierRecorded: eps.filter((e) => e.tier !== 'unknown').length, cells, verdict };
}

// Every feature's episodes from a project's log and run directory (the observer computes this, never a dashboard poll).
export function loadEpisodes(runsDir: string, events: LogEvent[], sinceMs = 0): Episode[] {
  const ids = [...new Set(events.filter((e) => e.feature && e.event === 'prompt').map((e) => e.feature!))];
  return ids.flatMap((id) => {
    let names: string[] = [];
    try { names = readdirSync(join(runsDir, id)); } catch { return []; }
    const files: RunFile[] = [], prompts: { tag: string; mtime: number }[] = [];
    for (const n of names) {
      const m = /^(\d+(?:\.\d+)?)-(build|eval)\.(json|prompt\.md)$/.exec(n);
      if (!m) continue;
      const file = join(runsDir, id, n), mtime = statSync(file).mtimeMs;
      if (m[3] === 'prompt.md') { if (m[2] === 'build') prompts.push({ tag: m[1]!, mtime }); continue; }
      try {
        const raw = readFileSync(file, 'utf8'), p = parseClaudeOutput(raw), unpriced = /"cost_status":\s*"unpriced"/.test(raw);
        const verdict = m[2] === 'eval' && p.ok ? parseVerdict(p.text) : null;
        files.push({ tag: m[1]!, role: m[2] as 'build' | 'eval', mtime, cost: unpriced || !p.ok && !p.cost ? null : p.cost, verdict, invalid: m[2] === 'eval' && (!verdict || !!verdict.error) });
      } catch {}
    }
    return episodes(id, events, files, prompts).filter((e) => Date.parse(e.ts) >= sinceMs);
  });
}
