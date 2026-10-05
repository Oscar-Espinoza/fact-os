// Spec-writing notes: what the factory learns about writing specs from the specs it had to correct. A spec fix applied (or a
// person's edit after a review blamed the spec) is distilled by the curator into at most one general rule for spec writers, kept
// in `<state dir>/spec-notes.md` (merged, capped, oldest archived). The intake skill reads them before writing features; a
// pre-launch check holds a never-launched feature that clearly breaks one (the rule quoted, the offending text quoted word for
// word), so the spec-fix flow corrects it before a build is spent. A rule whose holds a person releases unchanged twice is retired.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { claudeArgs, exec, holdInputs, parseClaudeOutput } from './foreman.ts';
import { fitNotes, mergeNotes, noteBullet, noteBullets, renderNotes } from './notes.ts';
import { childEnv, envVar, mutateWithAudit, paths } from './state.ts';
import type { Config, Feature, LogEvent, PlanningHold, RoleConfig } from './types.ts';

export const SPEC_NOTES_MAX = 3000;     // bytes of rules
export const RULE_MAX = 250;            // characters of one rule
export const DISTILL_PER_PASS = 2, CHECKS_PER_PASS = 3, CHECKS_PER_DAY = 30, RETIRE_AFTER = 2;
export const specNotesFile = (root: string): string => join(paths(root).dir, 'spec-notes.md');
const archiveFile = (root: string) => join(paths(root).dir, 'spec-notes.archive.md');
export const readSpecNotes = (root: string): string[] => (existsSync(specNotesFile(root)) ? noteBullets(readFileSync(specNotesFile(root), 'utf8')) : []);
const now = () => new Date().toISOString();
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
export const PRECHECK = 'precheck:';
const HEADER = '# Spec-writing notes\n\nLearned from specs the factory had to correct. Follow them when writing or editing features.\n\n';
const write = (root: string, bullets: string[]) => writeFileSync(specNotesFile(root), HEADER + renderNotes(bullets));
const archive = (root: string, why: string, bullets: string[]) => { if (bullets.length) appendFileSync(archiveFile(root), `\n## ${now()} — ${why}\n\n${renderNotes(bullets)}`); };

// ---- learning a rule ----

export interface Lesson { key: string; feature: Feature; change: string; why: string; evidence: string[] }
// The events a rule may be learned from, oldest first: an applied spec fix, or a person's requirements change on a feature whose
// spec a review blamed. Each once (`done` holds their keys).
export function lessonsToLearn(events: LogEvent[], features: Feature[], done: Set<string>): Lesson[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const blamed = new Set(events.filter((e) => e.event === 'planning-hold' && /spec-error|spec-conflict/.test(e.detail || '')).map((e) => e.feature));
  return events.flatMap((e) => {
    const key = `${e.ts}|${e.feature}|${e.event}`, f = e.feature ? byId.get(e.feature) : undefined;
    if (!f || done.has(key)) return [];
    if (e.event === 'spec-fix-applied') {
      const id = (e.detail || '').split(' ')[0], r = f.specFixes?.find((x) => x.id === id);
      return r ? [{ key, feature: f, change: `${r.target === 'description' ? 'The description' : `Acceptance item ${r.target}`} changed from "${r.old}" to "${r.new}".`, why: r.why,
        evidence: (r.evidence ?? []).map((x) => x.quote) }] : [];
    }
    if (e.event === 'acceptance-changed' && /^by a person/.test(e.detail || '') && blamed.has(f.id))
      return [{ key, feature: f, change: (e.detail || '').replace(/^by a person[^:]*:\s*/, ''), why: '', evidence: [] }];
    return [];
  });
}

export function distillPrompt(l: Lesson, notes: string[]): string {
  return ['A feature spec in a software factory had to be corrected after it failed. Decide whether its mistake teaches ONE general rule',
    'that people writing OTHER feature specs should follow. You are read-only: change nothing.', '',
    `Feature: ${l.feature.title}`, `What changed: ${l.change}`, l.why ? `Why: ${l.why}` : '', l.evidence.length ? `Evidence: ${l.evidence.map((q) => `"${q}"`).join('; ')}` : '', '',
    notes.length ? `Rules already known (do not repeat them):\n${notes.join('\n')}` : 'No rules are known yet.', '',
    `The rule must be one sentence of at most ${RULE_MAX} characters, an instruction a spec writer can apply to a different feature,`,
    'with no feature ids and nothing only this feature needs. If the mistake was specific to this feature, or a known rule already covers it, there is no rule.',
    'Answer with ONLY a JSON object: {"rule": string | null, "why": one short sentence}.'].filter((x) => x !== null).join('\n');
}
export function parseRule(text: string): { rule: string | null; why: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const v = m && JSON.parse(m[0]);
    if (!v || typeof v.why !== 'string' || (v.rule !== null && typeof v.rule !== 'string')) return null;
    const rule = typeof v.rule === 'string' ? v.rule.replace(/\s+/g, ' ').trim() : null;
    if (rule !== null && (!rule || rule.length > RULE_MAX || /\b[A-Z]\d+-\d+\b/.test(rule))) return null; // too long, or names a feature
    return { rule, why: v.why.slice(0, 300) };
  } catch { return null; }
}

// Adds a rule (merged with the known ones; over the cap, the oldest are archived). Returns whether it was new.
export function addRule(root: string, rule: string): boolean {
  const before = readSpecNotes(root), merged = mergeNotes(before, [rule]);
  if (merged.length === before.length) return false;
  const { kept, dropped } = fitNotes(merged, SPEC_NOTES_MAX);
  archive(root, `${dropped.length} oldest dropped over the ${SPEC_NOTES_MAX}-byte cap`, dropped);
  write(root, kept);
  return true;
}
export function retireRule(root: string, rule: string, why: string): boolean {
  const before = readSpecNotes(root), kept = before.filter((b) => norm(b) !== norm(noteBullet(rule)) && norm(b) !== norm(rule));
  if (kept.length === before.length) return false;
  archive(root, `retired: ${why}`, before.filter((b) => !kept.includes(b)));
  write(root, kept);
  return true;
}

// ---- the pre-launch check ----

export interface CheckIssue { note: string; quote: string; why: string }
export function checkPrompt(f: Feature, notes: string[]): string {
  return ['Check one feature spec against the spec-writing rules a software factory learned from its own mistakes. You are read-only.',
    'Report only a CLEAR break of a rule, quoting the spec text that breaks it word for word; when in doubt, report nothing.', '',
    '## Rules', ...notes.map((n, i) => `${i + 1}. ${n.replace(/^- /, '')}`), '',
    `## Feature: ${f.title}`, '', '### Description', f.description || '(none)', '', '### Acceptance', ...(f.acceptance ?? []).map((a, i) => `${i + 1}. ${a}`), '',
    'Answer with ONLY a JSON object: {"issues": [{"rule": the rule number, "quote": exact contiguous text from the spec, "why": one sentence}]} ({"issues": []} when none).'].join('\n');
}
// The issues that hold up: a real rule number, and a quote found word for word in the spec (no ellipsis).
export function parseIssues(text: string, f: Feature, notes: string[]): CheckIssue[] | null {
  const m = text.match(/\{[\s\S]*\}/);
  let v: { issues?: unknown };
  try { v = m ? JSON.parse(m[0]) : null; } catch { return null; }
  if (!v || !Array.isArray(v.issues)) return null;
  const spec = norm([f.title, f.description ?? '', ...(f.acceptance ?? [])].join('\n'));
  return v.issues.flatMap((x) => {
    const i = x as { rule?: unknown; quote?: unknown; why?: unknown };
    const n = Number(i.rule), note = Number.isInteger(n) && n >= 1 ? notes[n - 1] : undefined, q = typeof i.quote === 'string' ? norm(i.quote) : '';
    return note && q.length >= 8 && !/\.\.\.|…/.test(q) && spec.includes(q) && typeof i.why === 'string' ? [{ note: note.replace(/^- /, ''), quote: q, why: i.why.slice(0, 300) }] : [];
  }).slice(0, 3);
}

// ---- the observer's pass ----

export interface SpecNotesState { specNotesDone?: string[]; specCheckRuns?: string[]; specNoteReleases?: Record<string, string[]> }
interface Io { out: (s: string) => void; children: Set<ChildProcess>; stopping: () => boolean }
const launched = (events: Pick<LogEvent, 'feature' | 'event'>[]) => new Set(events.filter((e) => e.event === 'launch').map((e) => e.feature));

// Learns from new spec corrections, retires rules whose holds people keep releasing, and checks never-launched features.
export async function specNotesPass(root: string, config: Config, agent: RoleConfig, state: SpecNotesState, events: LogEvent[], io: Io, save: () => void = () => {}): Promise<void> {
  const run = async (input: string) => {
    const r = await exec(envVar('CLAUDE') || 'claude', claudeArgs(config, { ...agent, permissionMode: 'plan' }, root), { cwd: root, env: childEnv(), input, children: io.children, timeoutMin: 10 });
    const c = parseClaudeOutput(r.out); return c.ok ? c.text : null;
  };
  const readFeatures = () => (JSON.parse(readFileSync(paths(root).features, 'utf8')) as { features: Feature[] }).features;
  // 1. Learn. Each source once; a failed answer is retried on a later pass.
  const done = new Set(state.specNotesDone ?? []);
  for (const l of lessonsToLearn(events, readFeatures(), done).slice(0, DISTILL_PER_PASS)) {
    if (io.stopping()) return;
    const text = await run(distillPrompt(l, readSpecNotes(root)));
    if (io.stopping()) return;
    const r = text ? parseRule(text) : null;
    if (!r) continue;
    done.add(l.key);
    if (r.rule && addRule(root, r.rule)) { await mutateWithAudit(root, (_d, emit) => emit({ feature: l.feature.id, event: 'spec-note-added', detail: r.rule! })); io.out(`observer: learned a spec-writing rule from ${l.feature.id}`); }
  }
  state.specNotesDone = [...done].slice(-500); save();
  // 2. Retire a rule whose pre-launch holds a person released unchanged RETIRE_AFTER times.
  const rel = state.specNoteReleases ??= {}, features = readFeatures();
  for (const e of events.filter((x) => x.event === 'released')) {
    const f = features.find((x) => x.id === e.feature);
    for (const i of f?.specCheck?.issues ?? []) {
      const seen = rel[i.note] ??= [];
      if (seen.includes(`${e.ts}|${e.feature}`)) continue;
      seen.push(`${e.ts}|${e.feature}`);
      if (seen.length >= RETIRE_AFTER && retireRule(root, i.note, `a person released ${seen.length} holds it caused`))
        await mutateWithAudit(root, (_d, emit) => emit({ feature: e.feature!, event: 'spec-note-retired', detail: i.note }));
    }
  }
  save();
  // 3. Check never-launched features against the rules, once per spec.
  const notes = readSpecNotes(root);
  if (!notes.length) return;
  const day = Date.now() - 864e5, runs = state.specCheckRuns = (state.specCheckRuns ?? []).filter((t) => Date.parse(t) > day);
  const went = launched(events);
  const todo = readFeatures().filter((f) => f.status === 'todo' && !(f.attempts || 0) && !f.planningHold && !went.has(f.id) && f.specCheck?.inputs !== holdInputs(root, config, f));
  for (const f of todo.slice(0, CHECKS_PER_PASS)) {
    if (io.stopping() || runs.length >= CHECKS_PER_DAY) return;
    const inputs = holdInputs(root, config, f);
    runs.push(now()); save(); // reserved before the run starts
    const text = await run(checkPrompt(f, notes));
    if (io.stopping()) return;
    const issues = text ? parseIssues(text, f, notes) : null;
    if (!issues) continue; // asked again next pass
    await mutateWithAudit(root, (d, emit) => {
      const x = d.features.find((y) => y.id === f.id);
      // Still the same never-launched, unheld spec: anything else and the check no longer applies.
      if (!x || x.status !== 'todo' || x.attempts || x.planningHold || holdInputs(root, config, x) !== inputs || launched(readLog(root, f.id)).has(f.id)) return;
      x.specCheck = { inputs, ts: now(), issues };
      if (!issues.length) return;
      const hold: PlanningHold = { cause: 'spec-error', confidence: 'high', evidence: issues.flatMap((i) => [i.quote, `breaks the learned rule: ${i.note}`]), review: `${PRECHECK}${inputs.slice(0, 12)}`,
        passEnd: '', inputs, ts: now() };
      x.planningHold = hold;
      emit({ feature: f.id, event: 'planning-hold', detail: `spec-error (high), pre-launch check: ${issues.map((i) => `"${i.quote}" breaks "${i.note}"`).join('; ')}. A spec fix will be drafted; ` +
        `edit the spec yourself, or \`fact-os release ${f.id}\` to launch it unchanged.` });
    });
    if (io.stopping()) return;
  }
  save();
}
const readLog = (root: string, id: string): LogEvent[] => {
  let t = ''; try { t = readFileSync(paths(root).log, 'utf8'); } catch { return []; }
  return t.split('\n').flatMap((l) => { if (!l.includes(`"${id}"`)) return []; try { const e = JSON.parse(l) as LogEvent; return e.feature === id ? [e] : []; } catch { return []; } });
};
