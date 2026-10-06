// The planner: one read-only run before a feature's first build. It checks every acceptance line against the code it depends on;
// a spec that cannot be met as written stops the feature before any builder is paid for (a `spec-conflict` planning hold), a plan
// over config.planner.splitWords words does too (a `needs-split` hold: the spec probably needs splitting), and
// otherwise it writes a short plan the builder follows and the evaluator sees as context. Fail soft: a crash, a timeout or an
// answer that breaks the contract never blocks a build, it only goes without a plan.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIERS, type Config, type Feature, type LogEvent, type PlanSummary } from './types.ts';

export const PLAN_MAX_WORDS = 600; // the contract asks for under 600; a little over is tolerated (up to config.planner.splitWords)
export const PLAN_FILE = 'plan.json', PLAN_TEXT = 'plan.md', PLAN_REVISED = 'plan-revised-spec.md'; // under runs/<feature>/, never in the repository

// One conflict of an INFEASIBLE answer: its text (with its file:line evidence), its severity (`protected`: resolving it touches
// money, auth/sessions, tenant isolation, grants/RLS, migrations, production behaviour or an existing test; `spec-only`: wording
// that can be relaxed or clarified without touching any of those; null: not stated, treated as protected) and the recommended
// resolution (exact replacement text), when given.
export type Severity = 'protected' | 'spec-only';
export interface Conflict { text: string; severity: Severity | null; resolution: string | null }
// The planner's COMPLETE REVISED SPEC: description sentences replaced (old, exactly as in the description, by new) and the whole
// revised acceptance list, plus its AUTO line (yes only when every conflict is spec-only).
export interface RevisedSpec { description: { old: string; new: string }[]; acceptance: string[]; auto: boolean }
export type Plan =
  | { verdict: 'FEASIBLE'; effort: 'medium' | 'high'; split: string | null; plan: string; words: number }
  | { verdict: 'INFEASIBLE'; effort: 'medium' | 'high'; split: string | null; conflicts: string[]; items: Conflict[]; revised: RevisedSpec | null;
      auto: boolean; malformed: string[] };

// The first three non-empty lines are `VERDICT: FEASIBLE|INFEASIBLE`, `EFFORT: medium|high` and `SPLIT: no` or `SPLIT: yes: <the cut>`,
// in that order. FEASIBLE needs a plan body (its word count is returned; the foreman holds a plan over config.planner.splitWords);
// a broken FEASIBLE answer is an error (the build goes on without a plan). INFEASIBLE always holds the feature (fail soft): its
// numbered CONFLICTS (each with file:line evidence, a [protected|spec-only] tag and a Resolution), the COMPLETE REVISED SPEC and
// its AUTO line are parsed as far as they go, and whatever is missing or off the contract is listed in `malformed` (a conflict
// without a tag counts as protected; no usable revised spec, or any protected conflict, means auto false). An answer whose header
// is broken but that says VERDICT: INFEASIBLE is held too, with its raw text as the only conflict.
const FILE_LINE = /[\w@.\/-]+\.[A-Za-z0-9]+:\d+/;
const REVISED_HEAD = /^[#*\s]*(?:COMPLETE\s+)?REVISED\s+SPEC\b/i;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
export function parsePlan(text: unknown): Plan | { error: string } {
  const raw = String(text ?? '').replace(/\r/g, ''), lines = raw.split('\n'), at: number[] = [];
  for (let i = 0; i < lines.length && at.length < 3; i++) if (lines[i]!.trim()) at.push(i);
  const head = at.map((i) => lines[i]!.trim());
  const rawHold = (why: string): Plan => { const item: Conflict = { text: clip(raw.trim(), 4000), severity: null, resolution: null };
    return { verdict: 'INFEASIBLE', effort: 'medium', split: null, conflicts: [conflictLine(item)], items: [item], revised: null, auto: false, malformed: [why] }; };
  const v = /^VERDICT: (FEASIBLE|INFEASIBLE)$/.exec(head[0] ?? '');
  const saysInfeasible = /^[\W_]*VERDICT:[\W_]*INFEASIBLE\b/m.test(raw);
  if (!v) return saysInfeasible ? rawHold('the first line is not "VERDICT: INFEASIBLE"') : { error: 'the first line is not "VERDICT: FEASIBLE" or "VERDICT: INFEASIBLE"' };
  const e = /^EFFORT: (medium|high)$/.exec(head[1] ?? '');
  if (!e) return v[1] === 'INFEASIBLE' ? rawHold('the second line is not "EFFORT: medium" or "EFFORT: high"') : { error: 'the second line is not "EFFORT: medium" or "EFFORT: high"' };
  const s = /^SPLIT: (?:(no)|yes: (.+))$/.exec(head[2] ?? '');
  if (!s) return v[1] === 'INFEASIBLE' ? rawHold('the third line is not "SPLIT: no" or "SPLIT: yes: <the cut>"') : { error: 'the third line is not "SPLIT: no" or "SPLIT: yes: <the cut>"' };
  const effort = e[1] as 'medium' | 'high', split = s[1] ? null : s[2]!.trim().slice(0, 500);
  const body = lines.slice(at[2]! + 1).join('\n').trim();
  if (v[1] === 'INFEASIBLE') return { effort, split, ...parseInfeasible(body) };
  if (!body) return { error: 'FEASIBLE without a plan' };
  const words = body.split(/\s+/).filter(Boolean).length;
  return { verdict: 'FEASIBLE', effort, split, plan: body, words };
}

function parseInfeasible(body: string): Omit<Extract<Plan, { verdict: 'INFEASIBLE' }>, 'effort' | 'split'> {
  const malformed: string[] = [], bl = body.split('\n');
  const r = bl.findIndex((l) => REVISED_HEAD.test(l));
  const conflictLines = r >= 0 ? bl.slice(0, r) : bl, revisedLines = r >= 0 ? bl.slice(r + 1) : [];
  const chunks: string[] = [];
  for (const l of conflictLines) {
    const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(l);
    if (m) chunks.push(m[2]!.trim());
    else if (chunks.length && l.trim()) chunks[chunks.length - 1] += `\n${l.trim()}`;
  }
  const items: Conflict[] = chunks.slice(0, 20).map((c, i) => {
    const sev = /\[\s*(protected|spec-only)\s*\]|\bseverity:\s*\**\s*(protected|spec-only)\b/i.exec(c);
    const res = /^(?:\*\*)?(?:recommended\s+)?resolutions?(?:\*\*)?:\s*([^]*)$/im.exec(c);
    if (!sev) malformed.push(`conflict ${i + 1} has no [protected] or [spec-only] tag (treated as protected)`);
    if (!FILE_LINE.test(c)) malformed.push(`conflict ${i + 1} quotes no file:line evidence`);
    if (!res || !res[1]!.trim()) malformed.push(`conflict ${i + 1} gives no Resolution`);
    const text = (res ? c.slice(0, res.index) : c).replace(/\[\s*(?:protected|spec-only)\s*\]\s*/i, '').trim();
    return { text: clip(text || c, 1500), severity: sev ? ((sev[1] ?? sev[2])!.toLowerCase() as Severity) : null, resolution: res ? clip(res[1]!.trim(), 1500) || null : null };
  });
  if (!items.length) { malformed.push('INFEASIBLE without a numbered CONFLICTS list'); items.push({ text: clip(body || '(no text)', 4000), severity: null, resolution: null }); }
  let revised: RevisedSpec | null = null;
  if (r < 0) malformed.push('no COMPLETE REVISED SPEC section');
  else {
    const description: { old: string; new: string }[] = [], acceptance: string[] = [];
    let where: 'none' | 'desc' | 'acc' = 'none', pending: string | null = null, autoLine: string | null = null;
    for (const l of revisedLines) {
      const t = l.trim();
      const a = /^[*_]*AUTO:[*_]*\s*(yes|no)\b/i.exec(t);
      if (a) { autoLine = a[1]!.toLowerCase(); continue; }
      if (/^[#*\s]*description\b[^:]*:/i.test(t) && !/^[-*]\s/.test(t)) { where = 'desc'; continue; }
      if (/^[#*\s]*acceptance\b[^:]*:/i.test(t) && !/^[-*]\s/.test(t)) { where = 'acc'; continue; }
      if (where === 'desc') {
        const o = /^(?:[-*]\s*)?OLD:\s*(.*)$/.exec(t), n = /^(?:[-*]\s*)?NEW:\s*(.*)$/.exec(t);
        if (o) pending = unquote(o[1]!);
        else if (n && pending !== null) { description.push({ old: pending, new: unquote(n[1]!) }); pending = null; }
      } else if (where === 'acc') {
        const m = /^(\d+)[.)]\s+(.*)$/.exec(t);
        if (m) acceptance.push(m[2]!.trim());
        else if (acceptance.length && t) acceptance[acceptance.length - 1] += ` ${t}`;
      }
    }
    if (pending !== null) malformed.push('a revised description sentence has OLD but no NEW');
    if (!autoLine) malformed.push('no "AUTO: yes|no" line (treated as no)');
    if (!acceptance.length) malformed.push('the revised spec has no numbered acceptance list');
    else if (acceptance.length > 40 || acceptance.some((x) => x.length > 2000)) malformed.push('the revised acceptance list is out of bounds (over 40 lines or a line over 2000 characters)');
    else if (description.some((d) => !d.old || d.old.length > 2000 || d.new.length > 2000)) malformed.push('a revised description sentence is empty or over 2000 characters');
    else revised = { description, acceptance, auto: autoLine === 'yes' };
  }
  const protectedOnes = items.filter((c) => c.severity !== 'spec-only').length;
  if (revised?.auto && protectedOnes) malformed.push(`AUTO: yes, but ${protectedOnes} conflict${protectedOnes === 1 ? ' is' : 's are'} not tagged spec-only (treated as AUTO: no)`);
  const auto = !!revised?.auto && !protectedOnes;
  return { verdict: 'INFEASIBLE', conflicts: items.map(conflictLine), items, revised, auto, malformed };
}
const unquote = (s: string) => { const t = s.trim(); return /^".*"$/.test(t) || /^“.*”$/.test(t) ? t.slice(1, -1) : t; };
// A conflict as one readable entry: its severity tag, its text and its resolution.
export const conflictLine = (c: Conflict): string =>
  `[${c.severity ?? 'protected?'}] ${c.text}${c.resolution ? `\nResolution: ${c.resolution}` : ''}`;
// The revised spec as a person reads it (runs/<id>/plan-revised-spec.md, the hold and the dashboard).
export function revisedText(r: RevisedSpec): string {
  return [...(r.description.length ? ['Description changes:', ...r.description.flatMap((d) => [`- OLD: ${d.old}`, `  NEW: ${d.new || '(removed)'}`]), ''] : ['Description: unchanged', '']),
    'Acceptance:', ...r.acceptance.map((a, i) => `${i + 1}. ${a}`), '', `AUTO: ${r.auto ? 'yes' : 'no'}`].join('\n');
}
// Why `r` cannot be applied to `f` as it stands (null: it can): every OLD description sentence must be in the description verbatim.
export function revisionProblem(f: Pick<Feature, 'description'>, r: RevisedSpec): string | null {
  const d = f.description ?? '';
  for (const x of r.description) if (!d.includes(x.old)) return `the description has no sentence "${clip(x.old, 80)}"`;
  if (!r.acceptance.length) return 'the revised acceptance list is empty';
  return null;
}
// The feature as the revised spec leaves it (description sentences replaced in order, acceptance replaced).
export function revise(f: Pick<Feature, 'description'>, r: RevisedSpec): { description: string; acceptance: string[] } {
  let description = f.description ?? '';
  for (const x of r.description) description = description.replace(x.old, () => x.new).replace(/[ \t]{2,}/g, ' ');
  return { description: description.trim(), acceptance: [...r.acceptance] };
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
// INFEASIBLE: `items` (conflicts with severity and resolution), `revised` (the planner's complete revised spec, also in
// runs/<id>/plan-revised-spec.md), `auto` (applying it needs no person: every conflict spec-only) and `malformed` (what broke the contract).
export interface SavedPlan extends PlanSummary { tag: string; model: string | null; plannerEffort: string | null; text: string; conflicts?: string[]; words?: number; oversize?: boolean;
  items?: Conflict[]; revised?: RevisedSpec | null; auto?: boolean; malformed?: string[] }
export function cachedPlan(runDir: string, inputs: string): SavedPlan | null {
  try {
    const p = JSON.parse(readFileSync(join(runDir, PLAN_FILE), 'utf8')) as SavedPlan;
    return p && p.inputs === inputs && typeof p.verdict === 'string' ? p : null;
  } catch { return null; }
}
export function savePlan(runDir: string, p: SavedPlan): void {
  writeFileSync(join(runDir, PLAN_FILE), JSON.stringify(p, null, 2) + '\n');
  writeFileSync(join(runDir, PLAN_TEXT), p.verdict === 'FEASIBLE' ? p.text + '\n' : p.verdict === 'INFEASIBLE' ? infeasibleText(p) + '\n' : `(no plan: ${p.error ?? 'unknown'})\n`);
  if (p.verdict === 'INFEASIBLE' && p.revised) writeFileSync(join(runDir, PLAN_REVISED), revisedText(p.revised) + '\n');
  else rmSync(join(runDir, PLAN_REVISED), { force: true }); // never a revised spec of an earlier answer beside this one
}
// An INFEASIBLE answer as a person reads it: the conflicts first, then the proposed revised spec (and what broke the contract).
export function infeasibleText(p: Pick<SavedPlan, 'conflicts' | 'revised' | 'malformed' | 'auto'>): string {
  return [...(p.conflicts ?? []).map((c, i) => `${i + 1}. ${c}`),
    ...(p.revised ? ['', 'Proposed revised spec', revisedText({ ...p.revised, auto: !!p.auto })] : ['', 'No usable revised spec was proposed.']),
    ...(p.malformed?.length ? ['', `Off the answer format: ${p.malformed.join('; ')}`] : [])].join('\n');
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
    'Step 1 Feasibility: find EVERY conflict in this one pass before you answer; never stop at the first. A person resolves them all at ' +
    'once from your answer, and each conflict you leave for a later pass costs another hold. Check each acceptance line, one by one, against:',
    '  (a) the code it depends on (a named function, file or behaviour that is absent or different is a conflict);',
    "  (b) the repository's permission model and constraints: database grants and row-level security (e.g. packages/platform/src/grants and " +
    "the migrations), every nested AGENTS.md rule above the files it touches, and any 'must not change' or 'do not touch' list;",
    "  (c) every OTHER acceptance line and the description's 'What to change' and 'Do not' text, pairwise (line 1 with 2, 1 with 3, ... " +
    "and each with the description): two requirements that cannot both hold (e.g. a cleanup rule that deletes rows vs an ownership rule " +
    'or a grant that forbids that delete) are a conflict.',
    'Also a conflict: something needing a provider account, a live call or a decision the spec does not give. Mark each line OK, CONFLICT ' +
    'or UNVERIFIABLE; quote file:line for every CONFLICT.',
    'Step 2: if there is any CONFLICT, answer VERDICT: INFEASIBLE listing ALL of them, and stop. Do not plan around a conflict.',
    'Step 3: otherwise answer VERDICT: FEASIBLE with the plan. Grep for existing helpers; never recall them from memory.', '',
    'Answer in exactly this format, nothing before it:',
    'VERDICT: FEASIBLE | INFEASIBLE',
    'EFFORT: medium | high   (the builder effort this needs)',
    'SPLIT: no | yes: <the cut>   (yes only when the feature is clearly two features; name where to cut)',
    'Then, for INFEASIBLE:',
    'CONFLICTS',
    '1. [protected | spec-only] <the two (or more) things that cannot both hold, each named (acceptance N, the description\'s ' +
    "sentence, a grant, an AGENTS.md rule)>, with quoted file:line evidence (path/to/file.ts:42 \"the quoted code\").",
    '   Resolution: <ONE recommended resolution: acceptance N -> "exact replacement text", or description "exact old sentence" -> "exact new sentence">',
    '2. ... (every conflict, numbered)',
    '   Tag [protected] when resolving it would touch money, auth or sessions, tenant isolation, grants or RLS, migrations, production ' +
    'behaviour, or would weaken an existing test; [spec-only] when it is wording that can be relaxed or clarified without touching any of those.',
    'COMPLETE REVISED SPEC   (one spec that resolves ALL the conflicts above consistently: applied once, no known conflict remains)',
    'Description changes:',
    '- OLD: <a sentence copied exactly from the description>',
    '  NEW: <its replacement>',
    '(one OLD/NEW pair per changed sentence; "Description changes: none" when the description stays)',
    'Acceptance:',
    '1. <the full revised acceptance list, every line, changed or not>',
    'AUTO: yes | no   (yes only if every conflict is spec-only)',
    `For FEASIBLE: the plan, under ${PLAN_MAX_WORDS} words: the files to change or add, each with the existing helper to reuse (with the rg ` +
    'evidence); the production composition points and how each acceptance check will be proven; for each guard, the mutation that must ' +
    'make a named test fail; what NOT to touch; the risks; the order of work.',
  ].join('\n');
}
