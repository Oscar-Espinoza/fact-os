// The planner: one read-only run before a feature's first build. It checks every acceptance line against the code it depends on;
// a spec that cannot be met as written stops the feature before any builder is paid for (a `spec-conflict` planning hold), a plan
// over config.planner.splitWords words does too (a `needs-split` hold: the spec probably needs splitting), and
// otherwise it writes a short plan the builder follows and the evaluator sees as context. Fail soft: a crash, a timeout or an
// answer that breaks the contract never blocks a build, it only goes without a plan.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIERS, type Config, type Feature, type LogEvent, type PlanSummary } from './types.ts';

export const PLAN_MAX_WORDS = 600; // the contract asks for under 600; a little over is tolerated (up to config.planner.splitWords)
export const PLAN_FILE = 'plan.json', PLAN_TEXT = 'plan.md'; // under runs/<feature>/, never in the repository

export type Plan =
  | { verdict: 'FEASIBLE'; effort: 'medium' | 'high'; split: string | null; plan: string; words: number }
  | { verdict: 'INFEASIBLE'; effort: 'medium' | 'high'; split: string | null; conflicts: string[] };

// Strict: the first three non-empty lines are `VERDICT: FEASIBLE|INFEASIBLE`, `EFFORT: medium|high` and `SPLIT: no` or
// `SPLIT: yes: <the cut>`, in that order. INFEASIBLE needs a numbered CONFLICTS list whose every item quotes file:line evidence;
// FEASIBLE needs a plan body (its word count is returned; the foreman holds a plan over config.planner.splitWords). Anything else is
// an error (the build goes on without a plan).
const FILE_LINE = /[\w@.\/-]+\.[A-Za-z0-9]+:\d+/;
export function parsePlan(text: unknown): Plan | { error: string } {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n'), at: number[] = [];
  for (let i = 0; i < lines.length && at.length < 3; i++) if (lines[i]!.trim()) at.push(i);
  const head = at.map((i) => lines[i]!.trim());
  const v = /^VERDICT: (FEASIBLE|INFEASIBLE)$/.exec(head[0] ?? '');
  if (!v) return { error: 'the first line is not "VERDICT: FEASIBLE" or "VERDICT: INFEASIBLE"' };
  const e = /^EFFORT: (medium|high)$/.exec(head[1] ?? '');
  if (!e) return { error: 'the second line is not "EFFORT: medium" or "EFFORT: high"' };
  const s = /^SPLIT: (?:(no)|yes: (.+))$/.exec(head[2] ?? '');
  if (!s) return { error: 'the third line is not "SPLIT: no" or "SPLIT: yes: <the cut>"' };
  const effort = e[1] as 'medium' | 'high', split = s[1] ? null : s[2]!.trim().slice(0, 500);
  const body = lines.slice(at[2]! + 1).join('\n').trim();
  if (v[1] === 'INFEASIBLE') {
    const conflicts: string[] = [];
    for (const l of body.split('\n')) {
      const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(l);
      if (m) conflicts.push(m[2]!.trim());
      else if (conflicts.length && l.trim()) conflicts[conflicts.length - 1] += `\n${l.trim()}`;
    }
    if (!conflicts.length) return { error: 'INFEASIBLE without a numbered CONFLICTS list' };
    const bad = conflicts.findIndex((c) => !FILE_LINE.test(c));
    if (bad >= 0) return { error: `conflict ${bad + 1} quotes no file:line evidence` };
    return { verdict: 'INFEASIBLE', effort, split, conflicts: conflicts.map((c) => c.slice(0, 1500)).slice(0, 10) };
  }
  if (!body) return { error: 'FEASIBLE without a plan' };
  const words = body.split(/\s+/).filter(Boolean).length;
  return { verdict: 'FEASIBLE', effort, split, plan: body, words };
}

// Why this launch runs no planner (null: it plans). A plan already made for these inputs is reused instead (see cachedPlan).
export function planSkip(config: Pick<Config, 'planner'>, f: Pick<Feature, 'tier'>, runsToday: number): string | null {
  const p = config.planner;
  if (!p?.enabled) return 'the planner is off (config.planner.enabled)';
  if (p.skipBelow && f.tier && TIERS.indexOf(f.tier) < TIERS.indexOf(p.skipBelow)) return `tier ${f.tier} is below config.planner.skipBelow (${p.skipBelow})`;
  if (runsToday >= p.maxPerDay) return `the daily cap is reached (${runsToday} of config.planner.maxPerDay ${p.maxPerDay} in 24 hours)`;
  return null;
}
// Planner runs started in the 24 hours before `now` (their `prompt` events), for the daily cap.
export const plannerRunsSince = (events: Pick<LogEvent, 'ts' | 'event' | 'run'>[], now = Date.now()): number =>
  events.filter((e) => e.event === 'prompt' && e.run?.phase === 'plan' && now - Date.parse(e.ts) < 864e5).length;

// The saved answer for exactly these inputs (holdInputs: the spec, deps, briefs and role instructions), or null.
// `oversize`: a FEASIBLE plan over config.planner.splitWords, saved with a needs-split hold; found again, the hold was released.
export interface SavedPlan extends PlanSummary { tag: string; model: string | null; plannerEffort: string | null; text: string; conflicts?: string[]; words?: number; oversize?: boolean }
export function cachedPlan(runDir: string, inputs: string): SavedPlan | null {
  try {
    const p = JSON.parse(readFileSync(join(runDir, PLAN_FILE), 'utf8')) as SavedPlan;
    return p && p.inputs === inputs && typeof p.verdict === 'string' ? p : null;
  } catch { return null; }
}
export function savePlan(runDir: string, p: SavedPlan): void {
  writeFileSync(join(runDir, PLAN_FILE), JSON.stringify(p, null, 2) + '\n');
  writeFileSync(join(runDir, PLAN_TEXT), p.verdict === 'FEASIBLE' ? p.text + '\n' : p.verdict === 'INFEASIBLE' ? (p.conflicts ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n' : `(no plan: ${p.error ?? 'unknown'})\n`);
}
export const summaryOf = (p: SavedPlan): PlanSummary => ({ inputs: p.inputs, ts: p.ts, verdict: p.verdict, ...(p.effort ? { effort: p.effort } : {}),
  ...(p.split !== undefined ? { split: p.split } : {}), ...(p.error ? { error: p.error } : {}) });

// The planner's prompt. `mocks`: the launch's on-mock brief (a capability built against a mock is not a missing provider account).
export function plannerPrompt(f: Feature, branch: string, config: Pick<Config, 'base' | 'briefFiles'>, mocks = ''): string {
  return [`You are the planner for feature ${f.id}: ${f.title}`,
    `You are in its git worktree on branch ${branch} (from ${config.base}). Read-only: do not edit, create or delete files, do not commit, ` +
    'and run only read-only commands (rg, git log/show/diff, cat).', '',
    'Read first: the root AGENTS.md (and CLAUDE.md), every nested AGENTS.md the feature names or that sits above a file it names, ' +
    `tasks/${f.id}.md if it exists${(config.briefFiles || []).length ? `, the project briefs (${config.briefFiles.join(', ')})` : ''}, and the code the spec names.`, '',
    f.description || '', '', 'Acceptance checks:', ...(f.acceptance || []).map((a, i) => `${i + 1}. ${a}`), '',
    mocks,
    'Step 1 Feasibility: for EACH acceptance line find the code it depends on and mark it OK, CONFLICT or UNVERIFIABLE. A CONFLICT is: two ' +
    "requirements that cannot both hold (e.g. 'no runtime change' vs 'must fail safely' where the code does not); a spec claim the code " +
    'contradicts (a named function, file or behaviour that is absent or different); something needing a provider account, a live call or ' +
    'a decision the spec does not give. Quote file:line for every CONFLICT.',
    'Step 2: if there is any CONFLICT, answer VERDICT: INFEASIBLE with the conflicts and their resolutions, and stop. Do not plan around a conflict.',
    'Step 3: otherwise answer VERDICT: FEASIBLE with the plan. Grep for existing helpers; never recall them from memory.', '',
    'Answer in exactly this format, nothing before it:',
    'VERDICT: FEASIBLE | INFEASIBLE',
    'EFFORT: medium | high   (the builder effort this needs)',
    'SPLIT: no | yes: <the cut>   (yes only when the feature is clearly two features; name where to cut)',
    'Then, for INFEASIBLE: CONFLICTS, a numbered list ("1. ..."), each item quoting its file:line evidence and giving 1-2 resolutions.',
    `For FEASIBLE: the plan, under ${PLAN_MAX_WORDS} words: the files to change or add, each with the existing helper to reuse (with the rg ` +
    'evidence); the production composition points and how each acceptance check will be proven; for each guard, the mutation that must ' +
    'make a named test fail; what NOT to touch; the risks; the order of work.',
  ].join('\n');
}
