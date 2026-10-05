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

const review = (r: RunFile | undefined): Review => (!r ? 'none' : r.invalid || !r.verdict ? 'invalid' : r.verdict.pass ? 'accepted' : 'rejected');
const FP = /^builder model=(\S+) effort=(\S+)/;

// One feature's episodes. A fresh build is a builder prompt event with run.phase "build", or (older logs) the first builder
// prompt after a launch. Its run files are the ones written from its prompt until the next fresh build's prompt, in time order:
// attempt tags restart after a reset and a held build can be reviewed under a later tag, so tag order is not a timeline. A
// review of a reused build (no fresh prompt) belongs to the episode that built it, the latest one before it.
export function episodes(feature: string, events: LogEvent[], files: RunFile[]): Episode[] {
  const out: (Episode & { at: number })[] = [];
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
    // The tier recorded at launch: the run record's, or an older fingerprint's `tier=`; never today's feature tier.
    const tier = r ? r.tier ?? 'unknown' : /\btier=(\w+)/.exec(e.detail || '')?.[1] ?? 'unknown';
    out.push({ feature, ts: e.ts, at: Date.parse(e.ts), model: r ? r.model ?? '-' : fp![1]!, effort: r ? r.effort ?? '-' : fp![2]!, tier,
      escalated: !!r?.rule?.includes('→'), firstReview: 'none', finalReview: 'none', repairs: 0, kinds: [], cost: null, merged: false });
  }
  for (let i = 0; i < out.length; i++) {
    const x = out[i]!, next = out[i + 1]?.at ?? Infinity;
    // Exact boundaries: an artifact is written after its run's prompt event, so it belongs to the latest prompt before it.
    const mine = files.filter((f) => f.mtime >= x.at && f.mtime < next).sort((a, b) => a.mtime - b.mtime);
    const evals = mine.filter((f) => f.role === 'eval'), builds = mine.filter((f) => f.role === 'build');
    x.firstReview = review(evals[0]); x.finalReview = review(evals.at(-1)); x.repairs = Math.max(0, builds.length - 1);
    const v = evals[0]?.verdict;
    if (v && !v.pass) x.kinds = [...new Set([...v.findings.flatMap((f) => (f.kind ? [f.kind] : [])), ...(v.blockingKinds ?? []).filter((k): k is IssueKind => !!k)])];
    const costs = builds.map((b) => b.cost);
    x.cost = costs.length && costs.every((c) => c != null) ? Math.round(costs.reduce((s, c) => s + c!, 0) * 100) / 100 : null;
  }
  return out.map(({ at: _a, ...e }) => e);
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
  // Two or more judged cells sharing a recorded tier.
  const byTier = new Map<string, Cell[]>();
  for (const c of cells) if (c.judged && c.tier !== 'unknown') (byTier.get(c.tier) ?? byTier.set(c.tier, []).get(c.tier)!).push(c);
  const comparable = [...byTier].filter(([, cs]) => cs.length >= 2).map(([t]) => t);
  const most = Math.max(0, ...cells.filter((c) => c.tier !== 'unknown').map((c) => c.features));
  // Same tier and enough features make rows worth reading side by side; they do not make them comparable (reviewer, prompts,
  // period and attempt position are not controlled), so this never claims a comparison, and routing never changes from it.
  const verdict = comparable.length ? `Same-tier rows with ${JUDGE_MIN}+ features each: ${comparable.join(', ')}. Read them side by side as description only; reviewers, prompts, period and try number differ, so they are not a fair comparison. Routing stays as configured.`
    : `Insufficient comparable evidence: no recorded tier has two rows with ${JUDGE_MIN}+ features each (largest tier-recorded row: ${most} feature${most === 1 ? '' : 's'}). Routing stays as configured.`;
  return { at, since: eps.length ? eps.map((e) => e.ts).sort()[0]! : null, episodes: eps.length, features: new Set(eps.map((e) => e.feature)).size,
    tierRecorded: eps.filter((e) => e.tier !== 'unknown').length, cells, verdict };
}

// Every feature's episodes from a project's log and run directory (the observer computes this, never a dashboard poll).
export function loadEpisodes(runsDir: string, events: LogEvent[], sinceMs = 0): Episode[] {
  const ids = [...new Set(events.filter((e) => e.feature && e.event === 'prompt').map((e) => e.feature!))];
  return ids.flatMap((id) => {
    let names: string[] = [];
    try { names = readdirSync(join(runsDir, id)); } catch { return []; }
    const files: RunFile[] = [];
    for (const n of names) {
      const m = /^(\d+(?:\.\d+)?)-(build|eval)\.json$/.exec(n);
      if (!m) continue;
      const file = join(runsDir, id, n), mtime = statSync(file).mtimeMs;
      try {
        const raw = readFileSync(file, 'utf8'), p = parseClaudeOutput(raw), unpriced = /"cost_status":\s*"unpriced"/.test(raw);
        const verdict = m[2] === 'eval' && p.ok ? parseVerdict(p.text) : null;
        files.push({ tag: m[1]!, role: m[2] as 'build' | 'eval', mtime, cost: unpriced || !p.ok && !p.cost ? null : p.cost, verdict, invalid: m[2] === 'eval' && (!verdict || !!verdict.error) });
      } catch {}
    }
    return episodes(id, events, files).filter((e) => Date.parse(e.ts) >= sinceMs);
  });
}
