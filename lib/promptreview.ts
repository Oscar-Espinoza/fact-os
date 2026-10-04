// Prompt review: why did a pass fail, the prompt or the model? The observer finds the passes that ended badly (the evaluator
// rejected them, their own tests failed, a keep-lines check or a resolver failed, the builder failed), has a read-only agent
// (plan mode) classify each one's cause from the saved prompt and the outcome, and turns the answers into feedback:
//  - per-model notes (notes.ts) the foreman appends to that model's prompts in that role, merged from suggestions that recur or
//    that the reviewer is sure of (merged by code; the curator agent only tidies a notes file that outgrew its cap);
//  - a human task for a suggested change to a role's prompt template, which is never applied automatically;
//  - the report section "Why runs failed, by model" and the dashboard's "Prompts by model".
// The observer's other agents are in observe.ts. Everything the agent decides is data in observer.json (promptReviews).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { childEnv, paths, log, envVar, mutate, NAME } from './state.ts';
import { git, exec, claudeArgs, parseClaudeOutput, holdInputs } from './foreman.ts';
import { NOTE_MAX, clipNote, noteBullets, mergeNotes, fitNotes, overCap, renderNotes, parseNotes, notesFile, notesArchive, notesDir } from './notes.ts';
import { PROMPT_CAUSES, type Cause, type Config, type Feature, type HumanTask, type LogEvent, type PlanningHold, type PromptCause, type PromptReviewConfig, type Role, type RoleConfig } from './types.ts';

const DAY = 24 * 3600e3;
const now = (): string => new Date().toISOString();
const tail = (s: string, n: number): string => (s.length > n ? '…' + s.slice(-n) : s);
const firstLine = (s: string): string => s.split('\n')[0]!.slice(0, 200);
const REVIEW_WINDOW = 2 * DAY;   // passes older than this are never reviewed (a first run over an old log would spend the cap on history)
const KEEP = 14 * DAY;           // reviews are kept this long
const PARALLEL = 3;              // reviews running at once

// ---- passes: one attempt of a feature through the foreman, read from the log ----

export type PassKind = 'evaluator-rejected' | 'gate-failed' | 'keep-check' | 'resolver-failed' | 'builder-failed' | 'evaluator-run-failed';
export const KIND_WORDS: Record<PassKind, string> = {
  'evaluator-rejected': 'the independent evaluator did not pass it', 'gate-failed': 'the feature\'s own tests failed in the test gate',
  'keep-check': 'the merge resolution lost lines one side added (the keep-lines check)', 'resolver-failed': 'the merge resolver run failed',
  'builder-failed': 'the builder failed or did not commit', 'evaluator-run-failed': 'the evaluator run itself failed or gave no valid verdict' };

export interface PassPrompt { role: Role; model: string; effort: string; notes: string; ts: string; detail: string }
// outcome: ok = it passed (merged, ready, or passed evaluation and was sent back by a merge conflict); bad = it ended badly for a
// reason a prompt could be behind (`kind`, reviewed role `role`); other = anything else (an interruption, an infrastructure failure).
export interface Pass { feature: string; start: string; end: string; endEvent: string; detail: string; outcome: 'ok' | 'bad' | 'other'; kind?: PassKind; role?: Role; prompts: PassPrompt[] }

// Which failure kind a pass ended with (null: not one a prompt review is for). `cause` is the observer's classification of the
// failure (infrastructure, setup and merge-conflict loops are never a prompt's fault; a gate failure counts only on the feature's own tests).
export function passKind(detail: string, endEvent: string, cause: Cause): PassKind | null {
  if (endEvent === 'resolve-failed') return /^keep-check:/.test(detail) ? 'keep-check' : 'resolver-failed'; // a resolver run's own keep-lines check
  if (cause === 'infra' || cause === 'setup' || cause === 'conflict-loop' || cause === 'untouched' || cause === 'environment') return null;
  if (/^The merge resolution lost lines/.test(detail)) return 'keep-check';
  if (/^(builder failed|commit your work)/.test(detail)) return 'builder-failed'; // before the evaluator patterns: its stderr may have a line starting "FAILED "
  if (/^Evaluator: (evaluator failed|evaluator output is not|verdict needs|verdict\.)/.test(detail)) return 'evaluator-run-failed';
  if (/^(Evaluator:|FAILED |CHEATING:|BLOCKING:)/m.test(detail)) return 'evaluator-rejected';
  if (cause === 'own' && /^test command `/.test(detail)) return 'gate-failed';
  return null;
}
const roleOfKind = (k: PassKind, endEvent: string): Role => (endEvent === 'resolve-failed' ? 'resolver' : k === 'evaluator-run-failed' ? 'evaluator' : 'builder');

// The role, model, effort and notes version of a `prompt` event's fingerprint.
export function parseFingerprint(detail: string): { role: Role; model: string; effort: string; notes: string } | null {
  const m = /^(builder|evaluator|resolver) model=(\S+) effort=(\S+)/.exec(detail);
  return m ? { role: m[1] as Role, model: m[2]!, effort: m[3]!, notes: /\bnotes=(\S+)/.exec(detail)?.[1] ?? '-' } : null;
}

const ENDS = ['merged', 'ready', 'failed', 'stuck', 'resolve-failed', 'interrupted', 'merge-skipped', 'merge-failed', 'merge-hook-failed', 'error', 'recovered', 'unparked', 'refreshed'];

// The passes of every feature in `events` (a pass: `launch` up to its end event), those that ended after `since`. A refresh before
// the test that merged cleanly, or a conflict a resolver run takes over (`resolving` next), does not end the pass.
// `causeOf` classifies a failure's detail (observe.ts classify, with the repo's files for the feature's own tests).
export function passesOf(events: Pick<LogEvent, 'ts' | 'feature' | 'event' | 'detail'>[], causeOf: (feature: string, detail: string) => Cause, since = 0): Pass[] {
  const by = new Map<string, typeof events>();
  for (const e of events) if (e.feature) (by.get(e.feature) ?? by.set(e.feature, []).get(e.feature)!).push(e);
  const out: Pass[] = [];
  for (const [feature, evs] of by) {
    let cur: Pass | null = null, evaluated = false;
    const close = (end: string, endEvent: string, detail: string, outcome: Pass['outcome'], kind?: PassKind) => {
      if (!cur) return;
      const role = kind ? roleOfKind(kind, endEvent) : undefined, has = role && cur.prompts.some((p) => p.role === role);
      Object.assign(cur, { end, endEvent, detail, outcome: kind && has ? 'bad' : outcome === 'bad' ? 'other' : outcome, ...(kind && has ? { kind, role } : {}) });
      if (Date.parse(end) >= since) out.push(cur);
      cur = null;
    };
    for (const [i, e] of evs.entries()) {
      if (e.event === 'launch') { close(e.ts, 'launch', '', 'other'); cur = { feature, start: e.ts, end: '', endEvent: '', detail: '', outcome: 'other', prompts: [] }; evaluated = false; continue; }
      if (!cur) continue;
      if (e.event === 'prompt') { const f = parseFingerprint(e.detail); if (f) cur.prompts.push({ ...f, ts: e.ts, detail: e.detail }); continue; }
      if (e.event === 'evaluating') { evaluated = true; continue; }
      if (e.event === 'refreshed' && e.detail.startsWith('before build, ')) continue; // same builder pass continues
      if (!ENDS.includes(e.event)) continue;
      if (e.event === 'refreshed' && (e.detail === 'before test, conflict-free' || evs[i + 1]?.event === 'resolving')) continue;
      if (e.event === 'merged' || e.event === 'ready') close(e.ts, e.event, e.detail, 'ok');
      else if (e.event === 'refreshed') close(e.ts, e.event, e.detail, evaluated ? 'ok' : 'other');
      else if (e.event === 'failed' || e.event === 'stuck' || e.event === 'resolve-failed') {
        const k = Date.parse(e.ts) < since ? null : passKind(e.detail, e.event, e.event === 'resolve-failed' ? 'unknown' : causeOf(feature, e.detail)); // older passes are dropped: no classification (git) for them
        close(e.ts, e.event, e.detail, k ? 'bad' : 'other', k ?? undefined);
      } else close(e.ts, e.event, e.detail, 'other');
    }
  }
  return out.sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
}

// What the feature's next pass came to, in words, for the review ("unknown" when there is none yet).
export function nextResult(passes: Pass[], p: Pass): string {
  const n = passes.filter((x) => x.feature === p.feature && Date.parse(x.start) >= Date.parse(p.end)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  if (!n) return 'not known yet (no later pass)';
  const model = n.prompts.find((x) => x.role === 'builder');
  const by = model ? ` (builder ${model.model}, effort ${model.effort})` : '';
  if (n.outcome === 'ok') return `it passed${by}: ${n.endEvent === 'merged' ? 'merged' : n.endEvent === 'ready' ? 'ready to merge' : 'passed evaluation, then sent back by a merge conflict'}`;
  if (n.outcome === 'bad') return `it failed again${by}: ${KIND_WORDS[n.kind!]}; ${firstLine(n.detail)}`;
  return `it ended without a verdict${by}: ${n.endEvent}${n.detail ? ` (${firstLine(n.detail)})` : ''}`;
}

// Which failed passes to review now: bad, ended within `since`, not reviewed yet, newest first, at most `max`.
export function selectPasses(passes: Pass[], { since, max, reviewed }: { since: number; max: number; reviewed: (p: Pass) => boolean }): Pass[] {
  return passes.filter((p) => p.outcome === 'bad' && Date.parse(p.end) >= since && !reviewed(p)).sort((a, b) => Date.parse(b.end) - Date.parse(a.end)).slice(0, Math.max(0, max));
}

// ---- the saved prompt of a pass ----

// The run file holding a prompt (`<tag>-(build|eval|resolve).prompt.md`): the one of that role written at the time the foreman
// logged the `prompt` event (the foreman writes the file, then logs, within milliseconds).
const RUN_FILE: Record<Role, string> = { builder: 'build', evaluator: 'eval', resolver: 'resolve' };
export function promptFile(files: { name: string; mtime: number }[], role: Role, ts: string, slackMs = 10000): { tag: string; name: string } | null {
  let best: { tag: string; name: string; d: number } | null = null;
  for (const f of files) {
    const m = /^(.+)-(build|eval|resolve)\.prompt\.md$/.exec(f.name);
    if (!m || m[2] !== RUN_FILE[role]) continue;
    const d = Math.abs(f.mtime - Date.parse(ts));
    if (d <= slackMs && (!best || d < best.d)) best = { tag: m[1]!, name: f.name, d };
  }
  return best && { tag: best.tag, name: best.name };
}
const runFiles = (dir: string): { name: string; mtime: number }[] => { try { return readdirSync(dir).map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs })); } catch { return []; } };

// The key of a pass's review: `<feature>/<tag>` of its first saved prompt (a tag is one pass of an attempt); null when the
// prompts were not saved (the run files are gone).
export function reviewKey(runsDir: string, p: Pass): { key: string; tag: string; file: string } | null {
  const dir = join(runsDir, p.feature), files = runFiles(dir);
  const first = p.prompts[0], mine = p.role && p.prompts.filter((x) => x.role === p.role).at(-1);
  const a = first && promptFile(files, first.role, first.ts), b = mine && promptFile(files, mine.role, mine.ts);
  return a && b ? { key: `${p.feature}/${a.tag}`, tag: b.tag, file: join(dir, b.name) } : null;
}

// ---- the review: prompt and answer ----

export const CAUSE_WORDS: Record<PromptCause, string> = {
  'prompt-missing-info': 'the prompt left something out', 'prompt-ambiguous': 'the prompt could be read two ways', 'prompt-conflict': 'the prompt contradicted itself',
  'model-limitation': 'the model got it wrong despite a clear prompt', environment: 'infrastructure or a flaky test', 'spec-error': 'the feature spec was wrong' };
const CAUSE_HELP: Record<PromptCause, string> = {
  'prompt-missing-info': 'context the model needed was not in the prompt (a brief or a lesson was missing, the acceptance check was unclear)',
  'prompt-ambiguous': 'the prompt allowed two readings and the model took the other one',
  'prompt-conflict': 'instructions contradicted each other, or an acceptance check could not be met as written',
  'model-limitation': 'the prompt was clear and complete, and the model still got it wrong',
  environment: 'infrastructure, a flaky test or a merge conflict: neither the prompt nor the model',
  'spec-error': 'the feature\'s own description or acceptance checks were wrong' };
export const isPromptCause = (c: unknown): c is PromptCause => typeof c === 'string' && c.startsWith('prompt-') && (PROMPT_CAUSES as readonly string[]).includes(c);
export type Target = 'template' | 'briefs' | 'lessons';
export type Confidence = 'low' | 'medium' | 'high';

export interface ReviewInput { feature: string; title: string; role: Role; model: string; effort: string; kind: PassKind; outcome: string; diffStat: string; next: string; prompt: string; file: string }
const middle = (s: string, head: number, end: number): string => (s.length <= head + end ? s : `${s.slice(0, head)}\n\n[… ${s.length - head - end} characters omitted; the full prompt is in the file above …]\n\n${s.slice(-end)}`);

export function reviewPrompt(i: ReviewInput): string {
  return [`You review one failed pass of the ${NAME} software factory, to find out why it failed: was it the prompt the model was given, or the model?`,
    `A pass starts at one feature launch and can contain repeated role prompts. Below are the final prompt in the responsible role and how the pass ended.`,
    'Read the repository if you need to check what the prompt did or did not tell the model. You are read-only: change nothing.', '',
    `Feature: ${i.feature}: ${i.title}`, `Role: ${i.role}. Model: ${i.model}. Effort: ${i.effort}.`, `How it ended: ${KIND_WORDS[i.kind]}.`,
    `What happened in the feature's next pass: ${i.next}.`, '', 'The outcome:', '```', tail(i.outcome, 4000), '```', '',
    'What the feature\'s branch changes now (git diff --stat, as of now: it may have changed since this pass):', '```', i.diffStat || '(nothing)', '```', '',
    'Choose exactly ONE primary cause:', ...PROMPT_CAUSES.map((c) => `- ${c}: ${CAUSE_HELP[c]}`), '',
    'Be skeptical in both directions: do not blame the prompt for what it said clearly, and do not blame the model for what the prompt left out.',
    `For the three prompt-* causes, "suggestion" is the change to this model's prompt that would have prevented the failure: one or two plain sentences, ` +
    `addressed to ${i.model} as ${i.role}, at most ${NOTE_MAX} characters, an instruction to add or rewrite with the concrete paths, commands or names that matter. "target" says where it belongs: ` +
    '"template" (the fixed instructions of the role\'s prompt, which every feature gets), "briefs" (the project\'s brief files) or "lessons" (the lessons file). ' +
    'For the other causes the suggestion may be an empty string.', '',
    'Answer with ONLY a JSON object: {"cause": string, "evidence": string[], "confidence": "low" | "medium" | "high", "suggestion": string, "target": "template" | "briefs" | "lessons"}. ' +
    '"evidence" holds one to four short quotes, from the prompt and from the outcome, that show the cause.', '',
    `The prompt the ${i.role} was given (${i.file}):`, '', '````', middle(i.prompt, 16000, 6000), '````'].join('\n');
}

export interface ParsedReview { cause: PromptCause; evidence: string[]; confidence: Confidence; suggestion: string; target: Target | null }
// The agent's answer, or why it is refused: a JSON object with one of the six causes, quotes, a confidence, and for a prompt-*
// cause a suggestion and where it belongs.
export function parseReview(text: string): ParsedReview | { error: string } {
  const tryJson = (s: string | undefined): Record<string, unknown> | undefined => { try { const v = s && JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined; } catch { return undefined; } };
  const v = tryJson(text) ?? tryJson(text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]) ?? tryJson(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (!v) return { error: 'not a JSON object' };
  const cause = v.cause as PromptCause;
  if (!(PROMPT_CAUSES as readonly string[]).includes(cause)) return { error: `unknown cause ${JSON.stringify(v.cause)}` };
  if (!Array.isArray(v.evidence)) return { error: '"evidence" must be an array of quotes' };
  if (v.confidence !== 'low' && v.confidence !== 'medium' && v.confidence !== 'high') return { error: `unknown confidence ${JSON.stringify(v.confidence)}` };
  const suggestion = typeof v.suggestion === 'string' ? clipNote(v.suggestion) : '';
  const target = v.target === 'template' || v.target === 'briefs' || v.target === 'lessons' ? v.target : null;
  if (isPromptCause(cause) && (!suggestion || !target)) return { error: `a ${cause} answer needs a suggestion and a target (template, briefs or lessons)` };
  return { cause, evidence: v.evidence.map(String).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 4), confidence: v.confidence, suggestion, target };
}

// What the observer keeps of one review. A failed answer is kept too (`error`), so a pass is asked about once.
export interface PromptReview { ts: string; feature: string; tag: string; role: Role; model: string; effort: string; notes: string; kind: PassKind; next: string;
  cause: PromptCause | null; evidence: string[]; confidence: Confidence | null; suggestion: string; target: Target | null; cost: number; error?: string;
  noted?: boolean;   // its suggestion went into the model's notes
  filed?: boolean }  // its suggestion went into a human task (a change to the role's template)
export interface PromptRate { model: string; role: Role; notes: string; since: string; ok: number; bad: number }
export const PROMPT_RATES_UNIT = 'final-role-pass-v1';
// What the observer keeps beside the reviews: when the last batch ran and the start of every review run in the last 24 hours
// (the throttle), the running cost of review runs, and how often a pass's review run failed (it is asked again at most once).
export interface PromptState { promptReviews?: Record<string, PromptReview>; promptRates?: PromptRate[]; promptRatesUnit?: string; promptReviewAt?: string; promptReviewRuns?: string[];
  promptReviewCost?: number; promptReviewTries?: Record<string, { n: number; ts: string }> }
export const MAX_TRIES = 2;

// A prompt-* review whose suggestion is worth keeping: the reviewer is sure of it, or the same kind of failure came again
// (another review of the same cause for the same model and role; for a template change, any model in that role).
export function eligible(r: PromptReview, all: PromptReview[], scope: 'model' | 'role'): boolean {
  if (!isPromptCause(r.cause) || !r.suggestion || !r.target) return false;
  if (r.confidence === 'high') return true;
  return all.some((o) => o !== r && o.cause === r.cause && o.role === r.role && (scope === 'role' || o.model === r.model));
}

// ---- running reviews ----

// A review or tidying run is cut off after this many minutes (the foreman's timeoutMin is often null, and a hung agent would block the observer).
export const reviewTimeoutMin = (config: Pick<Config, 'timeoutMin'>): number => Math.min(config.timeoutMin ?? 20, 20);

// How many reviews may start now: none within `everyMinutes` of the last batch, and no more than `maxPerDay` review runs in 24 hours.
export function reviewBudget(cfg: PromptReviewConfig, st: Pick<PromptState, 'promptReviewAt' | 'promptReviewRuns'>, nowMs = Date.now()): { max: number; wait: boolean } {
  const runs = (st.promptReviewRuns ?? []).filter((t) => nowMs - Date.parse(t) < DAY).length;
  const wait = !!st.promptReviewAt && nowMs - Date.parse(st.promptReviewAt) < cfg.everyMinutes * 60e3;
  return { wait, max: wait ? 0 : Math.max(0, Math.min(cfg.maxPerPass, cfg.maxPerDay - runs)) };
}

// The agent's own model and effort for the review come from the caller (the `curator` role of the active profile); the run is
// always read-only (plan mode). `stopping`: the observer got a stop signal (no new batch; a run it killed is not counted as a failure).
type Out = (s: string) => void;
export interface Io { out: Out; children: Set<ChildProcess>; stopping: () => boolean }
export async function reviewFailures(root: string, config: Config, agent: RoleConfig, cfg: PromptReviewConfig, state: PromptState, passes: Pass[], feature: (id: string) => { title: string; branch: string }, io: Io): Promise<number> {
  const P = paths(root), { out, children, stopping } = io, reviews = state.promptReviews ??= {}, tries = state.promptReviewTries ??= {};
  for (const [k, r] of Object.entries(reviews)) if (Date.now() - Date.parse(r.ts) > KEEP) delete reviews[k];
  for (const [k, t] of Object.entries(tries)) if (Date.now() - Date.parse(t.ts) > KEEP) delete tries[k];
  state.promptReviewRuns = (state.promptReviewRuns ?? []).filter((t) => Date.now() - Date.parse(t) < DAY);
  const { max } = reviewBudget(cfg, state);
  if (!max || stopping()) return 0;
  const keyed = new Map<Pass, ReturnType<typeof reviewKey>>();
  const keyOf = (p: Pass) => { if (!keyed.has(p)) keyed.set(p, reviewKey(P.runs, p)); return keyed.get(p)!; };
  const todo = selectPasses(passes, { since: Date.now() - REVIEW_WINDOW, max, reviewed: (p) => !keyOf(p) || !!reviews[keyOf(p)!.key] || (tries[keyOf(p)!.key]?.n ?? 0) >= MAX_TRIES });
  if (!todo.length) return 0;
  out(`observer: reviewing ${todo.length} failed passes (${todo.map((p) => p.feature).join(', ')})`);
  let done = 0, started = false;
  const failed = (key: string) => { const t = tries[key] ?? { n: 0, ts: now() }; tries[key] = { n: t.n + 1, ts: now() }; };
  const one = async (p: Pass): Promise<void> => {
    try { await review(p); } catch (e) { // e.g. the prompt file vanished
      out(`observer: review of ${p.feature} failed: ${firstLine(String((e as Error).message ?? e))}`);
      const k = keyOf(p); if (k && !stopping()) failed(k.key);
    }
  };
  const review = async (p: Pass): Promise<void> => {
    if (stopping()) return;
    const k = keyOf(p)!, used = p.prompts.filter((x) => x.role === p.role).at(-1)!, branch = feature(p.feature).branch;
    const has = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root).code === 0;
    const input: ReviewInput = { feature: p.feature, title: feature(p.feature).title, role: p.role!, model: used.model, effort: used.effort, kind: p.kind!, outcome: p.detail || '(no detail logged)',
      diffStat: has ? git(['diff', '--stat=120', `${config.base}...${branch}`], root).out : '(the branch no longer exists)', next: nextResult(passes, p), prompt: readFileSync(k.file, 'utf8'), file: k.file };
    if (stopping()) return;
    if (!started) { state.promptReviewAt = now(); started = true; }
    state.promptReviewRuns!.push(now());
    const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs(config, { ...agent, permissionMode: 'plan' }, root), { cwd: root, env: childEnv(), input: reviewPrompt(input), children, timeoutMin: reviewTimeoutMin(config) });
    const c = parseClaudeOutput(r.out);
    state.promptReviewCost = Math.round(((state.promptReviewCost ?? 0) + c.cost) * 1e6) / 1e6;
    if (!c.ok) { // not recorded: asked again next time, at most MAX_TRIES runs in all (a run the observer's own stop killed does not count)
      out(`observer: review of ${k.key} failed: ${firstLine(c.error ?? '')}`);
      if (!stopping()) failed(k.key);
      return;
    }
    const a = parseReview(c.text), base = { ts: now(), feature: p.feature, tag: k.tag, role: p.role!, model: used.model, effort: used.effort, notes: used.notes, kind: p.kind!, next: input.next, cost: c.cost };
    reviews[k.key] = 'error' in a ? { ...base, cause: null, evidence: [], confidence: null, suggestion: '', target: null, error: `invalid answer: ${a.error}` } : { ...base, ...a };
    delete tries[k.key];
    log(root, null, 'observer-review', `${k.key} ${p.role} ${used.model}: ${'error' in a ? `invalid answer (${a.error})` : `${a.cause} (${a.confidence})`}; $${c.cost.toFixed(2)}`);
    if (!('error' in a)) await placeHold(root, config, p, k.key, a, input.prompt);
    done++;
  };
  for (let i = 0; i < todo.length && !stopping(); i += PARALLEL) await Promise.all(todo.slice(i, i + PARALLEL).map(one));
  out(`observer: reviewed ${done} of ${todo.length} failed passes`);
  return done;
}

// ---- planning holds ----

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;
// A quote's checkable fragments: wrapping quote marks removed, split at an ellipsis; a fragment under 8 characters proves nothing.
const fragments = (q: string): string[] => norm(q).replace(QUOTES, '').split(/\s*(?:…|\.\.\.)\s*/).map((x) => x.replace(QUOTES, '').trim()).filter((x) => x.length >= 8);
// Where each of a review's quotes is found, verbatim up to whitespace: in the saved prompt, in the pass's outcome, or nowhere.
export function locateEvidence(evidence: string[], prompt: string, outcome: string): { inPrompt: number; inOutcome: number; unverified: string[] } {
  const P = norm(prompt), O = norm(outcome), unverified: string[] = [];
  let inPrompt = 0, inOutcome = 0;
  for (const q of evidence) {
    const fr = fragments(q), p = fr.length > 0 && fr.every((x) => P.includes(x)), o = fr.length > 0 && fr.every((x) => O.includes(x));
    if (p) inPrompt++;
    if (o) inOutcome++;
    if (!p && !o) unverified.push(q);
  }
  return { inPrompt, inOutcome, unverified };
}
// Whether a review warrants a planning hold. A hold needs every quote found in the saved prompt or outcome, and the requirement
// itself quoted from the prompt: a high spec-error; a medium spec-error corroborated by the outcome too (at least two quotes);
// a high prompt-conflict quoting both sides from the prompt. Anything else of those causes at medium or high is only an alert.
export function holdDecision(r: Pick<PromptReview, 'cause' | 'confidence' | 'evidence'>, prompt: string, outcome: string): 'hold' | 'alert' | null {
  if ((r.cause !== 'spec-error' && r.cause !== 'prompt-conflict') || (r.confidence !== 'high' && r.confidence !== 'medium')) return null;
  const e = locateEvidence(r.evidence, prompt, outcome), verified = r.evidence.length > 0 && e.unverified.length === 0;
  if (r.cause === 'spec-error' && verified && e.inPrompt >= 1 && (r.confidence === 'high' || (r.evidence.length >= 2 && e.inOutcome >= 1))) return 'hold';
  if (r.cause === 'prompt-conflict' && r.confidence === 'high' && verified && e.inPrompt >= 2) return 'hold';
  return 'alert';
}
// The saved prompt still carries the feature's current description and acceptance (it was not edited since that pass).
const specIn = (prompt: string, f: Pick<Feature, 'description' | 'acceptance'>): boolean => {
  const P = norm(prompt);
  return [f.description || '', ...(f.acceptance || [])].map(norm).filter(Boolean).every((x) => P.includes(x));
};
const launchedSince = (root: string, id: string, since: string): boolean => {
  let text = ''; try { text = readFileSync(paths(root).log, 'utf8'); } catch { return false; }
  return text.split('\n').some((l) => { if (!l.includes('"launch"')) return false; try { const e = JSON.parse(l) as LogEvent; return e.feature === id && e.event === 'launch' && Date.parse(e.ts) > Date.parse(since); } catch { return false; } });
};
// Places a planning hold for a review of `p`, rechecked under the state lock after the paid review: the feature is todo with
// attempts left and no hold, `p` is its latest pass (no launch since it started), and the spec is the one that pass was given.
async function placeHold(root: string, config: Config, p: Pass, key: string, r: ParsedReview, prompt: string): Promise<void> {
  const d = holdDecision(r, prompt, p.detail || '');
  if (!d) return;
  const quotes = r.evidence.join(' | ');
  if (d === 'alert') { log(root, p.feature, 'planning-alert', `${r.cause} (${r.confidence}) in review ${key}, not held: its evidence was not verified against the saved prompt and outcome: ${quotes}`); return; }
  const placed = await mutate(root, 'features', (data) => {
    const f = data.features.find((x) => x.id === p.feature);
    if (!f || f.status !== 'todo' || f.planningHold || (f.attempts || 0) >= config.maxAttempts) return null;
    if (launchedSince(root, p.feature, p.start) || !specIn(prompt, f)) return null;
    const hold: PlanningHold = { cause: r.cause as PlanningHold['cause'], confidence: r.confidence as PlanningHold['confidence'], evidence: r.evidence, review: key, passEnd: p.end,
      inputs: holdInputs(root, config, f), ts: new Date().toISOString() };
    f.planningHold = hold;
    return hold;
  });
  if (placed) log(root, p.feature, 'planning-hold', `${r.cause} (${r.confidence}), review ${key}: ${quotes}. Edit the feature's description or acceptance ` +
    `(or the briefs) to release it, or \`${NAME} release ${p.feature}\` to launch it unchanged.`);
}

// ---- notes ----

// Merges the eligible, not yet used suggestions of each model and role into its notes file. Within the cap it is plain code; when
// the merged notes outgrow it the curator agent rewrites them shorter (as lessons are curated), and when it cannot, the oldest
// bullets go to the archive. Template suggestions are skipped here: they are for a person (fileTemplateTasks).
export async function updateNotes(root: string, config: Config, agent: RoleConfig, cfg: PromptReviewConfig, state: PromptState, io: Io): Promise<void> {
  const { out, children, stopping } = io;
  if (stopping()) return;
  const all = Object.values(state.promptReviews ?? {}), groups = new Map<string, PromptReview[]>();
  for (const r of all) {
    if (r.noted || r.target === 'template' || !eligible(r, all, 'model')) continue;
    const k = `${r.model}\n${r.role}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  for (const [g, rs] of groups) {
    if (stopping()) return;
    const [model, role] = g.split('\n') as [string, Role], file = notesFile(root, model, role), before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    let bullets = mergeNotes(noteBullets(before), rs.map((r) => r.suggestion));
    const added = bullets.length - noteBullets(before).length;
    if (added > 0) {
      mkdirSync(notesDir(root), { recursive: true });
      let note = `${added} added`;
      if (overCap(bullets, cfg.notesMaxBytes)) {
        if (stopping()) return;
        const kept = await tidyNotes(root, config, agent, cfg, model, role, bullets, children);
        if (stopping()) return;
        if (kept) { archive(root, model, role, `${noteBullets(before).length} notes before tidying`, noteBullets(before)); bullets = kept; note += ', tidied by the curator'; }
        else { const f = fitNotes(bullets, cfg.notesMaxBytes); archive(root, model, role, `${f.dropped.length} oldest notes dropped`, f.dropped); bullets = f.kept; note += `, ${f.dropped.length} oldest archived`; }
      }
      writeFileSync(file, renderNotes(bullets));
      log(root, null, 'observer-notes', `${model} as ${role}: ${note}; ${bullets.length} notes, ${Buffer.byteLength(renderNotes(bullets))} bytes`);
      out(`observer: notes for ${model} as ${role}: ${note}`);
    }
    for (const r of rs) r.noted = true;
  }
}

function archive(root: string, model: string, role: Role, what: string, bullets: string[]): void {
  if (!bullets.length) return;
  const f = notesArchive(root, model, role);
  appendFileSync(f, `${existsSync(f) ? '\n' : ''}## Archived ${now().slice(0, 10)} (${what})\n\n${bullets.join('\n')}\n`);
}

async function tidyNotes(root: string, config: Config, agent: RoleConfig, cfg: PromptReviewConfig, model: string, role: Role, bullets: string[], children: Set<ChildProcess>): Promise<string[] | null> {
  const prompt = [`You tidy the prompt notes for ${model} as ${role} in ${NAME}, a software factory. The factory appends these notes to every prompt it gives ${model} in that role.`,
    `They were collected one by one from reviews of failed runs, so some repeat each other. Rewrite them into a shorter set that helps ${model} most.`, '',
    `- At most ${cfg.notesMaxBytes} bytes in total, each note one or two plain sentences starting with "- ". No headings, no dates.`,
    '- Merge duplicates and near-duplicates into one rule. Keep concrete paths, commands and names. Drop notes that only describe one feature.',
    '- Do not use tools; answer from the text below.', '', 'The notes:', '', bullets.join('\n'), '', 'Answer with the notes only, between <notes> and </notes>.'].join('\n');
  const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs(config, agent, root), { cwd: root, env: childEnv(), input: prompt, children, timeoutMin: reviewTimeoutMin(config) });
  const p = parseClaudeOutput(r.out), n = p.ok ? parseNotes(p.text, cfg.notesMaxBytes) : { error: p.error };
  return 'bullets' in n ? n.bullets : null;
}

// One open human task per role for suggested changes to its prompt template (never applied by the observer). New suggestions
// join the open task; once it is done, later ones open another.
export async function fileTemplateTasks(root: string, state: PromptState, out: Out, stopping: () => boolean = () => false): Promise<void> {
  const all = Object.entries(state.promptReviews ?? {}), roles = new Map<Role, [string, PromptReview][]>();
  for (const [k, r] of all) if (!r.filed && r.target === 'template' && eligible(r, all.map(([, x]) => x), 'role')) (roles.get(r.role) ?? roles.set(r.role, []).get(r.role)!).push([k, r]);
  for (const [role, rs] of roles) {
    if (stopping()) return;
    const title = `Prompt template change suggested for ${role}`;
    const head = (n: number) => `The review agent found ${n} failed ${role} pass${n === 1 ? '' : 'es'} where the ${role} prompt template itself was the problem. The template is fixed text in ${NAME} (lib/foreman.ts), so it needs a person.`;
    const steps = [head(rs.length),
      ...rs.flatMap(([k, r]) => [`Suggested change (${r.model}, ${r.confidence} confidence, ${CAUSE_WORDS[r.cause!]}): ${r.suggestion}`,
        `Evidence from ${k}: ${r.evidence.length ? r.evidence.join(' | ') : 'none given'}`])];
    const filed = await mutate(root, 'human', (d) => {
      if (stopping()) return false;
      const open = d.tasks.find((t) => t.status === 'open' && t.title === title);
      if (open) { // the new suggestions join it, and the count in its first step follows
        const n = rs.length + (Number(/found (\d+) failed/.exec(open.steps[0] ?? '')?.[1]) || 0);
        open.steps.splice(0, 1, head(n)); open.steps.push(...steps.slice(1));
      }
      else d.tasks.push({ id: `observer-prompt-${role}-${Date.now().toString(36)}`, title, steps, unblocks: [], mockable: false, status: 'open' } satisfies HumanTask);
      return true;
    });
    if (!filed) return;
    for (const [, r] of rs) r.filed = true;
    log(root, null, 'observer-proposal', `${title} (${rs.length} reviews)`);
    out(`observer: proposal: ${title}`);
  }
}

// ---- rates by notes version ----

// For each model, role and notes version, how many passes ended well and how many badly (a bad pass counts for the role the
// review is about; a good pass once per role, using that role's final prompt), oldest version first.
export function promptRates(passes: Pass[]): PromptRate[] {
  const m = new Map<string, PromptRate>();
  const at = (model: string, role: Role, notes: string, ts: string) => {
    const k = `${model}\n${role}\n${notes}`, r = m.get(k) ?? m.set(k, { model, role, notes, since: ts, ok: 0, bad: 0 }).get(k)!;
    if (Date.parse(ts) < Date.parse(r.since)) r.since = ts;
    return r;
  };
  for (const p of passes) {
    if (p.outcome === 'ok') for (const x of new Map(p.prompts.map((x) => [x.role, x])).values()) at(x.model, x.role, x.notes, x.ts).ok++;
    else if (p.outcome === 'bad') { const x = p.prompts.filter((y) => y.role === p.role).at(-1); if (x) at(x.model, x.role, x.notes, x.ts).bad++; }
  }
  return [...m.values()].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

// Did a notes version change the failure rate? Both sides need at least 5 passes and the rates 15 points apart.
export function trend(prev: { ok: number; bad: number } | undefined, cur: { ok: number; bad: number }): 'better' | 'worse' | 'about the same' | 'too few passes to say' {
  const n = (x: { ok: number; bad: number }) => x.ok + x.bad;
  if (!prev || n(prev) < 5 || n(cur) < 5) return 'too few passes to say';
  const d = cur.bad / n(cur) - prev.bad / n(prev);
  return d <= -0.15 ? 'better' : d >= 0.15 ? 'worse' : 'about the same';
}

// ---- summary: the report and the dashboard ----

export interface PromptRow { model: string; role: Role; reviewed: number; causes: { cause: PromptCause; n: number }[]; suggestions: { text: string; n: number; target: Target }[];
  notes: { text: string; bytes: number } | null; versions: { notes: string; since: string; ok: number; bad: number; trend: string }[] }
export interface PromptSummary { reviewed: number; invalid: number; cost: number; runs24h: number; rows: PromptRow[]; ratesPending?: boolean } // cost: all review runs so far

// Per model and role: the causes of the reviewed failures in the last 7 days, the suggestions most often made, the notes in force
// and the results by notes version. `readNotesText` reads a model's notes ('' when none).
export function promptSummary(state: PromptState, readNotesText: (model: string, role: Role) => string): PromptSummary {
  const since = Date.now() - 7 * DAY, rs = Object.values(state.promptReviews ?? {}).filter((r) => Date.parse(r.ts) >= since && r.cause), cachedRates = state.promptRates ?? [];
  // Legacy invocation totals cannot be converted without the event log. Keep
  // reviews/notes visible, but wait for the observer to regenerate rates.
  const ratesPending = state.promptRates != null && state.promptRatesUnit !== PROMPT_RATES_UNIT, rates = ratesPending ? [] : cachedRates;
  const keys = new Map<string, { model: string; role: Role }>();
  for (const r of rs) keys.set(`${r.model}\n${r.role}`, { model: r.model, role: r.role });
  for (const r of cachedRates) if (r.notes !== '-') keys.set(`${r.model}\n${r.role}`, { model: r.model, role: r.role });
  const rows = [...keys.values()].map(({ model, role }): PromptRow => {
    const mine = rs.filter((r) => r.model === model && r.role === role), count = new Map<PromptCause, number>(), sug = new Map<string, { text: string; n: number; target: Target }>();
    for (const r of mine) {
      count.set(r.cause!, (count.get(r.cause!) ?? 0) + 1);
      if (isPromptCause(r.cause) && r.suggestion) { const k = r.suggestion.toLowerCase(), s = sug.get(k); if (s) s.n++; else sug.set(k, { text: r.suggestion, n: 1, target: r.target! }); }
    }
    const text = readNotesText(model, role).trim(), vs = rates.filter((x) => x.model === model && x.role === role);
    return { model, role, reviewed: mine.length, causes: [...count].map(([cause, n]) => ({ cause, n })).sort((a, b) => b.n - a.n),
      suggestions: [...sug.values()].sort((a, b) => b.n - a.n).slice(0, 3), notes: text ? { text, bytes: Buffer.byteLength(text) } : null,
      versions: vs.map((x, i) => ({ notes: x.notes, since: x.since, ok: x.ok, bad: x.bad, trend: i ? trend(vs[i - 1], x) : '' })) };
  }).sort((a, b) => b.reviewed - a.reviewed || a.model.localeCompare(b.model) || a.role.localeCompare(b.role));
  return { reviewed: rs.length, invalid: Object.values(state.promptReviews ?? {}).filter((r) => !r.cause && Date.parse(r.ts) >= since).length, cost: state.promptReviewCost ?? 0,
    runs24h: (state.promptReviewRuns ?? []).filter((t) => Date.now() - Date.parse(t) < DAY).length, rows, ...(ratesPending ? { ratesPending: true } : {}) };
}

export function renderPromptSection(s: PromptSummary, at: (iso: string) => string): string[] {
  if (!s.rows.length && !s.cost && !s.ratesPending) return [];
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–');
  return ['## Why runs failed, by model', '',
    `The review agent read ${s.reviewed} failed passes from the last 7 days (the saved prompt and how the pass ended) and named one main cause for each. Review cost so far: $${s.cost.toFixed(2)} (${s.runs24h} review runs in the last 24 hours).`, '',
    'Each successful pass counts once per role, using its final prompt. A reviewable failure counts only for the responsible role. Other outcomes are excluded.', '',
    ...(s.ratesPending ? ['Rates will update after the next observer pass.', ''] : []),
    ...s.rows.flatMap((r) => [`### ${r.model} as ${r.role}`, '',
      r.causes.length ? `Causes: ${r.causes.map((c) => `${CAUSE_WORDS[c.cause]} ${c.n}`).join(', ')}.` : 'No failed passes reviewed yet.',
      ...(r.suggestions.length ? ['', 'Suggested prompt changes, most often first:', ...r.suggestions.map((x) => `- ${x.n > 1 ? `${x.n}× ` : ''}${x.text} (${x.target === 'template' ? 'the role template: a task for you' : x.target})`)] : []),
      '', r.notes ? `Notes in force: ${noteBullets(r.notes.text).length}, ${r.notes.bytes} bytes.` : 'No notes yet.',
      ...(r.versions.some((v) => v.notes !== '-') ? ['', '| Notes version | Since | Passes | Failed | Against the version before |', '| --- | --- | --- | --- | --- |',
        ...r.versions.map((v) => `| ${v.notes === '-' ? 'no notes' : v.notes} | ${at(v.since)} | ${v.ok + v.bad} | ${v.bad} (${pct(v.bad, v.ok + v.bad)}) | ${v.trend ? `${v.trend}` : '–'} |`)] : []), ''])];
}
