// The human story of a feature, for the dashboard: its retry cycles, tries and steps, each step with one plain sentence.
// Pure: built from the feature, its log events (oldest first) and its run artifacts. State comes from recorded events and
// validated verdicts only; an agent's own words supply a sentence, never a pass or a fail. What the records do not say is
// not invented: a step without a recorded result says so.
import type { Feature, LogEvent, Verdict } from './types.ts';

export type StepKind = 'build' | 'reused' | 'save' | 'resolve' | 'test' | 'diagnose' | 'review' | 'fix' | 'merge' | 'ready' | 'end' | 'stop' | 'hold' | 'note';
export type StepState = 'done' | 'running' | 'needs-changes' | 'failed' | 'interrupted' | 'reused' | 'info';
export interface Reason { title: string; detail?: string }
export interface Step { kind: StepKind; label: string; state: StepState; text: string; note?: string; reasons?: Reason[]; start?: string; end?: string; tag?: string; who?: string }
export type TryOutcome = 'running' | 'merged' | 'ready' | 'failed' | 'stuck' | 'held' | 'stopped' | 'interrupted';
export interface Try { n: number; outcome: TryOutcome; summary: string; steps: Step[]; start?: string; end?: string }
export interface Cycle { tries: Try[]; endedBy?: string }
export interface StoryRun { tag: string; role: 'build' | 'eval' | 'resolve' | 'diagnose'; at: string; text: string; verdict?: Verdict | null }
export interface StoryState { word: string; tone: 'run' | 'fix' | 'ok' | 'queue' | 'hold' | 'bad' | 'idle'; why: string | null; next: string | null }
export interface Story {
  title: string; goal: string | null; state: StoryState; needsYou: { what: string; why: string } | null;
  current: Try | null; earlier: Try[]; archive: { label: string; tries: Try[] }[];
  problems: { active: { title: string; reasons: Reason[] } | null; earlier: { when: string; text: string }[] };
  nextTry: number | null;
  status: Feature['status'];          // the feature status this story was built from
  version: string;                    // status|attempts it was built from (the page can tell when it is stale; updatedAt changes too often mid-run)
}
export interface StoryInput {
  feature: Feature; events: LogEvent[]; runs: StoryRun[]; maxAttempts: number; base: string;
  manualMerge?: boolean; openTasks?: { title: string; mockable: boolean }[]; unmetDeps?: { id: string; title: string }[];
  goal?: { goal: string; shortTitle?: string } | null;
}

// ---- who ran it ----

const MODEL_NAME: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku', fable: 'Fable' };
// A model id as a person reads it: "sonnet" → Sonnet, "gpt-6.1-sol" → GPT-6.1 Sol, "claude-opus-5-5" → Opus 5.5.
export function modelName(m: string | null | undefined): string {
  if (!m) return 'an unrecorded model';
  if (MODEL_NAME[m]) return MODEL_NAME[m]!;
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m); if (c) return `${MODEL_NAME[c[1]!] ?? c[1]} ${c[2]}.${c[3]}`;
  const g = /^gpt-([\d.]+)(?:-([a-z]+))?/.exec(m); if (g) return `GPT-${g[1]}${g[2] ? ` ${g[2][0]!.toUpperCase()}${g[2].slice(1)}` : ''}`;
  return m;
}
// Who an invocation was, from its run record (or, for older logs, its prompt fingerprint).
export function whoOf(e: LogEvent): { role: string; who: string } | null {
  if (e.event !== 'prompt') return null;
  const r = e.run, fp = /^(\w+) model=(\S+) effort=(\S+)/.exec(e.detail || '');
  const role = r?.role ?? fp?.[1]; if (!role) return null;
  const model = r ? r.model : fp![2] === '-' ? null : fp![2]!, effort = r ? r.effort : fp![3] === '-' ? null : fp![3]!;
  const extras = [r?.fallback ? 'fallback' : '', r?.resumed ? 'same session' : ''].filter(Boolean);
  return { role, who: `${modelName(model)}${effort ? ` · ${effort}` : ''}${extras.length ? ` (${extras.join(', ')})` : ''}` };
}

// ---- plain sentences ----

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
// The first sentence of agent prose, without Markdown or code, or null when it reads like a dump rather than a sentence.
export function firstSentence(text: string, n = 170): string | null {
  const t = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(t), s = (m ? m[1]! : t).trim();
  if (s.length < 12 || /^[{[(<$]|^(diff|commit|at |error:)/i.test(s)) return null;
  return clip(s, n);
}
// A builder's (or resolver's) result: its "Summary:" line, else what it reported first, else a pointer to the logs.
export function builderText(text: string | undefined): string {
  const sum = /^\s*\**summary:?\**\s*(.+)$/im.exec(text || '');
  if (sum) return clip(sum[1]!.replace(/[*`]/g, '').trim(), 200);
  const s = firstSentence(text || '');
  return s ? `Builder reported: ${s}` : 'Builder finished; its output is in the logs.';
}
const sentence = (s: string, n = 140) => clip((/^(.+?[.!?])(\s|$)/.exec(s.trim())?.[1] ?? s.trim()), n);
// A review's reasons, failed findings and blocking entries first; a passing check is never a reason.
export function reviewReasons(v: Verdict): Reason[] {
  const out: Reason[] = [];
  for (const b of v.blocking) out.push({ title: sentence(b.replace(/^[A-Z][\w /-]{2,40}:\s*/, (m) => m), 140), detail: b });
  for (const c of v.cheating) out.push({ title: `Weakened or fake test: ${sentence(c, 120)}`, detail: c });
  for (const f of v.findings) if (f.ok !== true) out.push({ title: `Check failed: ${clip(f.check, 110)}`, detail: f.evidence });
  for (const d of v.baseDefects ?? []) out.push({ title: `Defect already on main: ${clip(d.signature, 110)}`, detail: d.evidence });
  if (v.error && !out.length) out.push({ title: /^evaluator failed/.test(v.error) ? 'The review run itself failed' : 'The review answer was not valid', detail: v.error });
  return out;
}
// One line for a review outcome: the evaluator's summary when it agrees with the verdict, else the first reason.
export function reviewHeadline(v: Verdict): string {
  const failed = v.findings.filter((f) => f.ok !== true).length, n = v.findings.length;
  if (v.pass) return `Passed all ${n} checks.`;
  // A rejection's headline comes from its structured reasons, never from the evaluator's own prose (which could contradict it).
  const rs = reviewReasons(v), r = rs[0];
  const lead = r ? r.title.replace(/^Check failed: /, '') : 'see the review details';
  void failed; void n;
  return `${clip(lead.replace(/\.$/, ''), 120)}${rs.length > 1 ? ` (+${rs.length - 1} more)` : ''}.`;
}
// Failure details as the foreman logs them (FAILED/BLOCKING lines, a gate tail, a builder error), as one short reason.
export function reasonOf(detail: string | undefined): string {
  const d = (detail || '').replace(/\n*\[diagnosis\][\s\S]*?(\[\/diagnosis\]|$)/g, '').trim();
  if (!d) return 'no reason was recorded';
  const lines = d.split('\n');
  const blocking = lines.find((l) => l.startsWith('BLOCKING: ')), failed = lines.find((l) => l.startsWith('FAILED ')), cheat = lines.find((l) => l.startsWith('CHEATING: '));
  if (blocking) return sentence(blocking.slice(10), 150).replace(/\.$/, '');
  if (cheat) return `a test was weakened or faked: ${sentence(cheat.slice(10), 110).replace(/\.$/, '')}`;
  if (failed) return `check failed: ${clip(failed.slice(7).split(/: /)[0]!, 110)}`;
  if (/^test command `/.test(d)) { const t = testFailure(d); return t.file ? `checks failed in ${t.file}` : 'the checks failed'; }
  if (/^The merge resolution lost lines/.test(d)) return 'the merge lost lines one side added';
  if (/^no progress:/.test(d)) return 'the build left the rejected work unchanged';
  if (/^builder failed: .*budget/.test(d)) return 'the builder ran out of budget';
  if (/^builder failed: .*timed out/.test(d)) return 'the builder timed out';
  if (/^builder failed/.test(d)) return 'the builder run failed';
  if (/^commit your work/.test(d)) return 'the builder left its work uncommitted';
  if (/^prepare `/.test(d)) return 'workspace setup failed';
  if (/^worktree:/.test(d)) return 'the workspace could not be prepared';
  if (/too many base refreshes/.test(d)) return 'merge conflicts kept coming back';
  if (/^Evaluator: /.test(d)) return 'the review answer was not valid';
  return clip(sentence(lines[0]!, 130).replace(/\.$/, ''), 130);
}
// The failing test file and error line in a gate's output tail, when they are there.
export function testFailure(detail: string): { file: string | null; error: string | null } {
  const lines = (detail || '').split('\n');
  const failLine = lines.find((l) => /\bFAIL\b|×|✗|\bnot ok\b|\(fail\)|\|\s*fail\s*\|/i.test(l) && /[\w@.+-]+(?:\/[\w@.+-]+)*\.(?:test|spec)\.[cm]?[jt]sx?/.test(l));
  const file = failLine ? /([\w@.+-]+(?:\/[\w@.+-]+)*\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(failLine)![1]!.split('/').pop()! : null;
  const err = lines.find((l) => /\b\w*Error\b:|AssertionError|timed out/i.test(l));
  return { file, error: err ? clip(err.replace(/\x1b\[[0-9;]*m/g, '').trim(), 140) : null };
}
const testFailText = (e: LogEvent | undefined, detail?: string): string => {
  const t = e?.test ?? (detail ? { ...testFailure(detail), code: null } : null) ?? null;
  if (t && (t.file || t.error)) return `Checks failed${t.file ? ` in ${t.file}` : ''}${t.error ? `: ${t.error}` : ''}.`;
  return 'Checks failed; no specific failing test was recorded.';
};

// Why work went back to the queue without spending a try, in plain words.
const departure = (d: string): string => /config\.json changed/.test(d) ? 'the factory settings changed during the run'
  : /left in flight by a dead foreman/.test(d) ? 'the factory restarted during the run'
  : /tamper|changed on disk/.test(d) ? 'factory files changed during the run' : clip(sentence(d.replace(/; back to todo$/, ''), 120).replace(/\.$/, ''), 120);

// ---- the projection ----

const COUNTED_LEGACY = (e: LogEvent) => !/no attempt spent|without using a retry/.test(e.detail || '') && !/^merge conflict with \S+: too many base refreshes \(\d+\)$/.test(e.detail || '') && !/^previous child still running/.test(e.detail || '');
const counted = (e: LogEvent) => (e.stop && typeof e.stop.counted === 'boolean' ? e.stop.counted : COUNTED_LEGACY(e));
const CYCLE_START: Record<string, string> = { retrying: 'before a person retried it', 'observer-retry': 'before the observer sent it back', 'acceptance-changed': 'before the requirements update', superseded: 'before it was split' };

export function buildStory(inp: StoryInput): Story {
  const f = inp.feature, runs = [...inp.runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), used = new Set<StoryRun>();
  const cycles: Cycle[] = [{ tries: [] }];
  let pendingWho: string | null = null;
  let tr: Try | null = null, pendingNote: string | null = null, testsInTry = 0, reviewsInTry = 0, envRetest = false, lateMerge: string | null = null;
  const cyc = () => cycles[cycles.length - 1]!, orphans: { when: string; text: string }[] = []; // failures logged outside any recorded try
  const st = { open: null as Step | null }; // the running step (a holder: closures reassign it)
  // The artifact of a step that ended at `end`: the newest unused one of `roles` written during the step. The foreman writes
  // a run's output before logging the event that ends the step, so a later repair's output never belongs to it.
  const artifact = (roles: StoryRun['role'][], start: string | undefined, end: string, peek = false) => {
    const s = start ? Date.parse(start) - 5e3 : -Infinity, e = Date.parse(end); // never after the event that ends the step
    const hit = runs.filter((r) => roles.includes(r.role) && !used.has(r) && Date.parse(r.at) >= s && Date.parse(r.at) <= e).pop();
    if (hit && !peek) used.add(hit);
    return hit;
  };
  const push = (s: Step) => { if (!tr) return; if (pendingNote && s.kind !== 'note') { s.note = s.note ? `${pendingNote} ${s.note}` : pendingNote; pendingNote = null; } tr.steps.push(s); if (s.state === 'running') st.open = s; };
  // Closes the running step: builder steps take their artifact's sentence; a review takes its verdict.
  const close = (ts: string, state: StepState, text?: string) => {
    const s = st.open; if (!s) return; st.open = null; s.end = ts; s.state = state;
    if (text) s.text = text;
    else if (s.kind === 'build' || s.kind === 'fix' || s.kind === 'resolve') {
      const a = artifact(s.kind === 'resolve' ? ['resolve'] : ['build', 'resolve'], s.start, ts);
      if (a) { s.text = builderText(a.text); s.tag = a.tag; }
      else if (state === 'done') s.text = s.kind === 'resolve' ? 'Combined the changes; no output was recorded.' : 'Builder finished; its output was not recorded for this step.';
    }
  };
  const closeReview = (ts: string, state: StepState, lead: string) => {
    const s = st.open; if (!s || s.kind !== 'review') return close(ts, state);
    const a = artifact(['eval'], s.start, ts), v = a?.verdict;
    st.open = null; s.end = ts; s.state = state; if (a) s.tag = a.tag;
    if (v) { s.text = state === 'done' ? reviewHeadline(v) : `${lead}: ${reviewHeadline(v)}`; if (!v.pass) s.reasons = reviewReasons(v); }
    else s.text = state === 'done' ? 'Review passed.' : `${lead}; the review details were not recorded.`;
  };
  const endTry = (ts: string, outcome: TryOutcome, summary: string) => { if (!tr) return; tr.outcome = outcome; tr.summary = summary; tr.end = ts; tr = null; st.open = null; testsInTry = 0; reviewsInTry = 0; };

  for (const e of inp.events) {
    const d = e.detail || '';
    if (CYCLE_START[e.event] || (e.event === 'resumed' && e.attemptsReset)) {
      if (tr) endTry(e.ts, tr.steps.some((s) => s.state === 'running') ? 'interrupted' : tr.outcome, tr.summary || 'Ended when it was reset.');
      if (cyc().tries.length) { cyc().endedBy = CYCLE_START[e.event] ?? 'before it was resumed with fresh tries'; cycles.push({ tries: [] }); }
      continue;
    }
    if (e.event === 'launch') {
      if (st.open) close(e.ts, 'interrupted', `${(st.open as Step).text.replace(/\.$/, '')} (interrupted).`);
      const prev = cyc().tries.at(-1);
      if (!tr && prev && (prev.outcome === 'held' || prev.outcome === 'stopped')) { // no retry was spent: the same try resumes
        tr = prev; tr.outcome = 'running'; tr.summary = ''; delete tr.end;
        push({ kind: 'note', label: 'Resumed', state: 'info', text: 'Work resumed on the same try (no retry was used).', start: e.ts });
      } else if (!tr) { tr = { n: cyc().tries.length + 1, outcome: 'running', summary: '', steps: [], start: e.ts }; cyc().tries.push(tr); }
      else push({ kind: 'note', label: 'Resumed', state: 'info', text: 'Work resumed on the same try.', start: e.ts });
      push({ kind: 'build', label: 'Build', state: 'running', text: 'Building.', start: e.ts, ...(d === 'onMock' ? { note: 'Mocked providers allowed for capabilities still pending.' } : {}) });
      continue;
    }
    if (!tr && e.event === 'merged') { // a merge after the try closed: a ready feature merging, or a merge recorded outside the factory
      const prev = cyc().tries.at(-1);
      if (prev?.outcome === 'ready') { prev.steps.push({ kind: 'merge', label: 'Merge', state: 'done', text: `Merged into ${inp.base}.`, start: e.ts, end: e.ts }); prev.outcome = 'merged'; prev.summary = `Merged into ${inp.base}.`; prev.end = e.ts; }
      else lateMerge = e.ts;
      continue;
    }
    if (tr && e.event === 'prompt') {
      const w = whoOf(e), s = st.open;
      if (w && s) {
        const fits = w.role === 'builder' ? ['build', 'fix', 'save', 'reused'].includes(s.kind) : w.role === 'resolver' ? s.kind === 'resolve' : w.role === 'evaluator' ? s.kind === 'review' : false;
        if (fits) s.who = `${w.role === 'evaluator' ? 'Reviewed by' : w.role === 'resolver' ? 'Combined by' : 'Built by'} ${w.who}`;
        if (w.role === 'diagnoser') pendingWho = `Diagnosed by ${w.who}`;
      }
      continue;
    }
    if (!tr) { if (e.event === 'failed' || e.event === 'stuck') orphans.push({ when: e.ts, text: `A failure whose try was not recorded: ${reasonOf(e.detail)}.` }); continue; }
    switch (e.event) {
      case 'build-skipped': if (st.open && st.open.kind === 'build') { st.open.kind = 'reused'; st.open.label = 'Build'; close(e.ts, 'reused', /held after an environmental/.test(d) ? 'Reused the build held after an environment fault.' : /revalidating/.test(d) ? 'Reused the build that already passed review; checking it again on the newer main.' : 'Reused the build made before the factory stopped.'); } break;
      case 'refreshed':
        if (/conflicts in: /.test(d)) { close(e.ts, 'done'); push({ kind: 'resolve', label: 'Combine', state: 'running', text: 'Changes overlap with newer work on main.', start: e.ts }); }
        else if (/^before test|^before build|conflict-free/.test(d)) pendingNote = 'Updated from main first.';
        break;
      case 'resolving': if (!st.open || st.open.kind !== 'resolve') { close(e.ts, 'done'); push({ kind: 'resolve', label: 'Combine', state: 'running', text: 'Combining the overlapping changes.', start: e.ts }); } break;
      case 'resolved': if (st.open?.kind === 'resolve') close(e.ts, 'done', 'Combined the overlapping changes.'); break;
      case 'resolve-failed': if (st.open?.kind === 'resolve') close(e.ts, 'failed', 'Combining lost lines one side added; the builder takes over.'); break;
      case 'commit-fix': close(e.ts, 'done'); push({ kind: 'save', label: 'Save', state: 'running', text: 'The builder left work uncommitted; saving it before the checks.', start: e.ts }); break;
      case 'keep-fix': close(e.ts, 'failed', 'The merge lost lines one side added.'); push({ kind: 'fix', label: 'Fix', state: 'running', text: 'Restoring the lines the merge lost.', start: e.ts }); break;
      case 'progress-fix': close(e.ts, 'done'); push({ kind: 'fix', label: 'Fix', state: 'running', text: 'The rejected work was still unchanged; the builder is making the change.', start: e.ts }); break;
      case 'testing': {
        if (st.open) close(e.ts, st.open.kind === 'save' ? 'done' : 'done');
        testsInTry++;
        push({ kind: 'test', label: testsInTry > 1 ? 'Test again' : 'Test', state: 'running', text: 'Running the configured checks.', start: e.ts, ...(envRetest ? { note: 'Same code, after a diagnosed environment fault.' } : {}) });
        envRetest = false; break;
      }
      case 'evaluating': if (st.open?.kind === 'test') close(e.ts, 'done', 'Configured checks passed.'); reviewsInTry++; push({ kind: 'review', label: reviewsInTry > 1 ? 'Review again' : 'Review', state: 'running', text: 'The reviewer is checking the work.', start: e.ts }); break;
      case 'gate-fix': if (st.open?.kind === 'test') close(e.ts, 'failed', testFailText(e)); else close(e.ts, 'done'); push({ kind: 'fix', label: 'Fix', state: 'running', text: /diagnosis/.test(d) ? 'Fixing the failed checks, with the diagnosis.' : 'Fixing the failed checks.', start: e.ts }); break;
      case 'diagnosis': {
        if (st.open?.kind === 'test') close(e.ts, 'failed', testFailText(undefined, ''));
        const m = /^(code|test|environment): (.*)$/.exec(d);
        push({ kind: 'diagnose', label: 'Diagnose', state: m ? 'done' : 'info', text: m ? `Found a ${m[1]} problem: ${sentence(m[2]!, 150)}` : 'The diagnosis did not produce a usable answer.', start: e.ts, end: e.ts, ...(pendingWho ? { who: pendingWho } : {}) });
        pendingWho = null;
        st.open = null; break;
      }
      case 'env-rerun': if (st.open?.kind === 'test') close(e.ts, 'failed', testFailText(e)); envRetest = true; break;
      case 'review-fix': closeReview(e.ts, 'needs-changes', 'Needs changes'); push({ kind: 'fix', label: 'Fix', state: 'running', text: 'Addressing the review findings in the same session.', note: 'No retry used for this repair.', start: e.ts }); break;
      case 'revalidate': closeReview(e.ts, 'done', ''); push({ kind: 'note', label: 'Main moved', state: 'info', text: 'Main changed after the review; checking the combined work again.', start: e.ts }); break;
      case 'ready': closeReview(e.ts, 'done', ''); push({ kind: 'ready', label: 'Ready', state: 'done', text: inp.manualMerge ? 'Ready for you to merge.' : 'Ready to merge.', start: e.ts }); endTry(e.ts, 'ready', 'Passed review; ready to merge.'); break;
      case 'merged': {
        if (st.open?.kind === 'review') closeReview(e.ts, 'done', ''); else close(e.ts, 'done');
        const fixed = tr.steps.some((s) => s.kind === 'fix');
        push({ kind: 'merge', label: 'Merge', state: 'done', text: `Merged into ${inp.base}.`, start: e.ts, end: e.ts });
        endTry(e.ts, 'merged', `Merged into ${inp.base}${fixed ? ' after a same-session fix' : ''}.`); break;
      }
      case 'merge-failed': case 'merge-hook-failed': case 'merge-skipped':
        if (st.open?.kind === 'review') closeReview(e.ts, 'done', '');
        push({ kind: 'merge', label: 'Merge', state: 'failed', text: e.event === 'merge-hook-failed' ? 'The merge check failed; the work went back to the queue.' : `The merge could not finish: ${reasonOf(d)}.`, start: e.ts, end: e.ts }); st.open = null; break;
      case 'builder-blocked': if (st.open) st.open.note = `${st.open.note ? st.open.note + ' ' : ''}The builder reported it was blocked (${e.detail.replace(/^([\w-]+): /, (_, r) => r.replace('-', ' ') + ': ')}); not yet verified.`; break;
      case 'codex-fallback': if (st.open) st.open.note = `${st.open.note ? st.open.note + ' ' : ''}Codex was unavailable; a Claude model stood in.`; break;
      case 'interrupted': if (st.open) close(e.ts, 'interrupted', `${st.open.text.replace(/\.$/, '')} (interrupted).`);
        push({ kind: 'stop', label: 'Sent back', state: 'info', text: 'The factory stopped mid-step; the feature went back to the queue on the same try (no retry used).', start: e.ts, end: e.ts }); break;
      case 'refresh-skipped': case 'recovered':
        if (e.event === 'recovered' && !/back to todo/.test(d)) break;
        if (st.open) close(e.ts, 'interrupted', `${st.open.text.replace(/\.$/, '')} (interrupted).`);
        push({ kind: 'stop', label: 'Sent back', state: 'info', text: `Sent back to the queue on the same try (no retry used): ${departure(d)}.`, start: e.ts, end: e.ts }); break;
      case 'planning-hold': push({ kind: 'hold', label: 'On hold', state: 'info', text: /^base/.test(d) ? 'On hold.' : `On hold: the ${/prompt-conflict/.test(d) ? 'instructions conflict' : 'spec cannot be met as written'}; it needs a clarification.`, start: e.ts, end: e.ts }); break;
      case 'planning-hold-released': push({ kind: 'note', label: 'Released', state: 'info', text: /base changed|recheck/.test(d) ? 'Main changed the implicated code; checking again.' : 'Hold released.', start: e.ts }); break;
      case 'failed': case 'stuck': {
        const isCounted = counted(e), stuck = e.event === 'stuck';
        if (e.cause === 'environment') {
          if (st.open?.kind === 'test') close(e.ts, 'failed', testFailText(e, d));
          push({ kind: 'stop', label: stuck ? 'Stopped' : 'Waiting', state: 'info', text: stuck ? 'Stopped after repeated environment faults; no retry used. It needs a person.' : 'Waiting to retry the same build after an environment fault; no retry used.', start: e.ts, end: e.ts });
          if (stuck) endTry(e.ts, 'stuck', 'Stopped after repeated environment faults.');
          break;
        }
        if (e.cause === 'base-defect') {
          if (st.open?.kind === 'review') closeReview(e.ts, 'failed', 'Rejected only for a defect already on main');
          push({ kind: 'hold', label: 'On hold', state: 'info', text: `On hold: the same failure happens on ${inp.base}. It is checked again when ${inp.base} changes that code; no retry used.`, start: e.ts, end: e.ts });
          endTry(e.ts, 'held', `On hold for a defect already on ${inp.base}.`); break;
        }
        const reason = reasonOf(d);
        const passedReview = st.open?.kind === 'review' && !!artifact(['eval'], st.open.start, e.ts, true)?.verdict?.pass;
        const stage = passedReview ? 'merge' : st.open?.kind;
        if (passedReview) { closeReview(e.ts, 'done', ''); push({ kind: 'merge', label: 'Merge', state: 'failed', text: `Merging stopped: ${reason}.`, start: e.ts, end: e.ts }); st.open = null; }
        else if (st.open?.kind === 'review') closeReview(e.ts, 'failed', 'Rejected');
        else if (st.open?.kind === 'test') close(e.ts, 'failed', testFailText(e, d));
        else if (st.open) close(e.ts, 'failed', `${st.open.label === 'Build' ? 'The build' : 'This step'} did not finish: ${reason}.`);
        const what = stage === 'merge' ? 'Merging stopped' : stage === 'review' ? 'Review rejected' : stage === 'test' ? 'Checks failed' : stage === 'resolve' ? 'Combining changes failed' : 'Did not finish';
        if (!isCounted) { push({ kind: 'stop', label: 'Stopped', state: 'info', text: `Stopped without using a retry: ${reason}.`, start: e.ts, end: e.ts }); if (stuck) endTry(e.ts, 'stopped', `Stopped without using a retry: ${reason}.`); break; }
        if (e.stop?.counted && e.stop.attempt) tr.n = e.stop.attempt; // the recorded attempt number wins over row counting
        const last = tr.n >= inp.maxAttempts || stuck;
        push({ kind: 'end', label: last ? 'Stuck' : 'Try ended', state: 'failed', text: last ? `No retries left: ${reason}.` : `Try ${tr.n} of ${inp.maxAttempts} used; it goes back to the queue for try ${tr.n + 1}.`, start: e.ts, end: e.ts });
        endTry(e.ts, stuck ? 'stuck' : 'failed', /^(the )?checks failed/.test(reason) ? `${reason.replace(/^the /, '').replace(/^./, (c) => c.toUpperCase())}.` : `${what}: ${reason}.`); break;
      }
    }
  }
  // A step still st.open belongs to work in flight only while the feature is in flight.
  const flight = ['building', 'testing', 'evaluating'].includes(f.status);
  if (tr && st.open && !flight) close(f.updatedAt, 'interrupted', `${(st.open as Step).text.replace(/\.$/, '')} (not finished).`);
  if (tr && !flight && tr.outcome === 'running') tr.outcome = 'interrupted';

  const cur = cyc(), current = cur.tries.find((t) => t.outcome === 'running') ?? cur.tries.at(-1) ?? null;
  const earlier = cur.tries.filter((t) => t !== current).reverse();
  const archive = cycles.slice(0, -1).filter((c) => c.tries.length).map((c) => ({ label: `${c.tries.length} earlier ${c.tries.length === 1 ? 'try' : 'tries'} ${c.endedBy ?? 'before a reset'}`, tries: [...c.tries].reverse() })).reverse();
  const d = describe(inp, current, cur);
  d.problems.earlier.push(...orphans.reverse());
  if (f.status === 'merged' && current?.outcome !== 'merged') d.state = { word: 'Merged', tone: 'ok', why: `Merged into ${inp.base}${lateMerge ? ' outside a factory try' : ''}; the earlier tries are kept below as history.`, next: null };
  return { title: inp.goal?.shortTitle || f.shortTitle || f.title, goal: f.goal ?? inp.goal?.goal ?? null, ...d, current, earlier, archive, status: f.status, version: `${f.status}|${f.attempts || 0}` };
}

// The header: one state word, why, what happens next, whether a person must act, and the problems.
function describe(inp: StoryInput, current: Try | null, cyc: Cycle): Pick<Story, 'state' | 'needsYou' | 'problems' | 'nextTry'> {
  const f = inp.feature, last = current?.steps.at(-1), counts = cyc.tries.filter((t) => t.outcome === 'failed' || t.outcome === 'stuck').length;
  const lastEnded = [...cyc.tries].reverse().find((t) => t.outcome === 'failed' || t.outcome === 'stuck' || t.outcome === 'stopped' || t.outcome === 'held');
  const problemOf = (t: Try | null | undefined) => { const steps = t ? [...t.steps].reverse() : []; const s = steps.find((x) => x.reasons?.length) ?? steps.find((x) => (x.state === 'failed' || x.state === 'needs-changes') && x.kind !== 'end'); return s ? { title: s.text, reasons: s.reasons ?? [] } : null; };
  const earlierProblems = [...cyc.tries].filter((t) => t !== current && t.summary).map((t) => ({ when: t.end ?? '', text: `Try ${t.n}: ${t.summary}` })).reverse();
  let state: StoryState = { word: 'Queued', tone: 'queue', why: null, next: 'Starts when a lane is free.' }, needsYou: Story['needsYou'] = null, active = null as Story['problems']['active'], nextTry: number | null = null;
  const blocking = (inp.openTasks ?? []).filter((t) => !t.mockable);
  switch (f.status) {
    case 'building': case 'testing': case 'evaluating': {
      const fixing = last?.kind === 'fix' && last.state === 'running';
      const prev = current ? [...current.steps].reverse().find((s) => s.state === 'needs-changes' || s.state === 'failed') : undefined;
      state = fixing ? { word: prev?.kind === 'review' ? 'Fixing review feedback' : prev?.kind === 'test' ? 'Fixing failed checks' : 'Fixing', tone: 'fix', why: prev ? prev.text : null, next: 'Run the checks, then review again.' }
        : f.status === 'testing' ? { word: 'Running checks', tone: 'run', why: null, next: 'Review, then merge.' }
        : f.status === 'evaluating' ? { word: 'Under review', tone: 'run', why: null, next: inp.manualMerge ? 'Waits for you to merge.' : 'Merge if it passes.' }
        : { word: 'Building', tone: 'run', why: null, next: 'Run the checks, then review.' };
      if (fixing) active = problemOf(current);
      break;
    }
    case 'merged': state = { word: 'Merged', tone: 'ok', why: current?.summary || null, next: null }; break;
    case 'ready': state = { word: inp.manualMerge ? 'Ready for you to merge' : 'Ready to merge', tone: 'ok', why: 'Passed review.', next: inp.manualMerge ? 'Review and merge it.' : 'Merges on its own.' }; if (inp.manualMerge) needsYou = { what: 'Review and merge this feature', why: 'It passed review, and this project merges by hand.' }; break;
    case 'stuck': {
      const why = lastEnded?.summary ?? (f.lastFeedback ? `${reasonOf(f.lastFeedback)}.` : null);
      state = { word: 'Stuck', tone: 'bad', why, next: null };
      needsYou = { what: 'Retry it, or change the spec', why: why ?? 'It used all its tries.' };
      active = problemOf(lastEnded) ?? (f.lastFeedback ? { title: reasonOf(f.lastFeedback), reasons: [] } : null);
      break;
    }
    case 'paused': state = { word: 'Paused', tone: 'idle', why: 'Paused by a person.', next: 'Resume it to continue.' }; break;
    default: { // todo
      if (f.planningHold) {
        const h = f.planningHold;
        state = h.cause === 'base-defect' ? { word: 'On hold', tone: 'hold', why: `The same failure happens on ${inp.base}: ${h.evidence[0] ?? ''}`.trim(), next: `Checked again when ${inp.base} changes that code.` }
          : { word: 'On hold', tone: 'hold', why: `The ${h.cause === 'prompt-conflict' ? 'instructions conflict' : 'spec cannot be met as written'}: ${h.evidence[0] ?? ''}`.trim(), next: 'Edit the spec, or release the hold to launch it as it is.' };
        if (h.cause !== 'base-defect') needsYou = { what: 'Clarify the conflicting requirement', why: state.why ?? '' };
        break;
      }
      if (f.envRetryAt && Date.parse(f.envRetryAt) > Date.now()) { state = { word: 'Waiting to retry', tone: 'hold', why: 'A diagnosed test-environment fault; no retry used.', next: `Retries the same build at ${new Date(f.envRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` }; break; }
      if (f.setupRetryAt && Date.parse(f.setupRetryAt) > Date.now()) { state = { word: 'Waiting to retry', tone: 'hold', why: 'Workspace setup failed; no retry used.', next: `Retries at ${new Date(f.setupRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` }; break; }
      if (blocking.length) { state = { word: 'Needs you', tone: 'hold', why: `Waiting on: ${blocking[0]!.title}`, next: null }; needsYou = { what: blocking[0]!.title, why: 'This feature cannot start until it is done.' }; break; }
      if (inp.unmetDeps?.length) { state = { word: 'Waiting', tone: 'idle', why: `Waiting on ${inp.unmetDeps[0]!.title}${inp.unmetDeps.length > 1 ? ` and ${inp.unmetDeps.length - 1} more` : ''} to merge first.`, next: null }; break; }
      if (last?.label === 'Sent back' && current?.outcome !== 'failed') { state = { word: (f.attempts || 0) > 0 ? `Queued for try ${(f.attempts || 0) + 1} of ${inp.maxAttempts}` : 'Queued', tone: 'queue', why: last.text, next: 'Starts again when a lane is free.' }; break; }
      if (counts > 0 || (f.attempts || 0) > 0) {
        nextTry = (f.attempts || counts) + 1;
        state = { word: `Queued for try ${nextTry} of ${inp.maxAttempts}`, tone: 'queue', why: lastEnded?.summary ?? (f.lastFeedback ? `${reasonOf(f.lastFeedback)}.` : null), next: 'Starts when a lane is free; the builder gets the last problems as its brief.' };
        active = problemOf(lastEnded);
      }
    }
  }
  return { state, needsYou, problems: { active, earlier: earlierProblems.filter((p) => !active || !p.text.endsWith(active.title)) }, nextTry };
}

// ---- the main screen: recent meaningful changes, one line each ----

export interface Transition { ts: string; id: string; title: string; text: string; badge: string; tone: StoryState['tone']; needsYou: boolean }
// One line per meaningful change: a try ending (and where it went), a same-session fix, a hold, a merge, a start. Built from
// recorded events and their stop metadata; `titles` gives each feature's display title.
export function transitions(events: LogEvent[], titles: Record<string, string>, maxAttempts: number, base: string, limit = 10): Transition[] {
  const out: Transition[] = [], tryOf = new Map<string, number>(), fixedInTry = new Set<string>();
  for (const e of events) {
    const id = e.feature; if (!id) continue;
    const title = titles[id] ?? id, d = e.detail || '', t = (text: string, badge: string, tone: StoryState['tone'], needsYou = false) => out.push({ ts: e.ts, id, title, text, badge, tone, needsYou });
    if (CYCLE_START[e.event] || (e.event === 'resumed' && e.attemptsReset)) { tryOf.delete(id); continue; }
    if (e.event === 'launch') {
      if (tryOf.has(`${id}#open`)) t(`Resumed try ${tryOf.get(id) ?? 1}.`, 'Running', 'run'); // the same try: no retry was spent
      else { const n = (tryOf.get(id) ?? 0) + 1; tryOf.set(id, n); tryOf.set(`${id}#open`, 1); t(`Started try ${n}.`, 'Running', 'run'); fixedInTry.delete(id); }
      continue;
    }
    const n = e.stop?.counted && e.stop.attempt ? e.stop.attempt : tryOf.get(id) ?? 1; // a recorded attempt number wins
    if (e.event === 'review-fix') { fixedInTry.add(id); t('The review asked for changes; fixing them in the same session (no retry used).', 'Fixing', 'fix'); }
    else if (e.event === 'gate-fix') { fixedInTry.add(id); t('Checks failed; fixing them in the same session (no retry used).', 'Fixing', 'fix'); }
    else if (e.event === 'merged') { tryOf.delete(`${id}#open`); t(`Merged into ${base}${fixedInTry.has(id) ? ' after a same-session fix' : ''}.`, 'Merged', 'ok'); }
    else if (e.event === 'ready') { tryOf.delete(`${id}#open`); t('Passed review; ready to merge.', 'Ready', 'ok'); }
    else if (e.event === 'refresh-skipped' || (e.event === 'recovered' && /back to todo/.test(d)) || e.event === 'interrupted') {
      t(`Sent back to the queue on the same try (no retry used): ${e.event === 'interrupted' ? 'the factory stopped mid-step' : departure(d)}.`, 'Queued', 'queue'); // the try stays open
    }
    else if (e.event === 'planning-hold' && !/base/.test(d)) t('On hold: the spec cannot be met as written; it needs a clarification.', 'On hold · needs you', 'hold', true);
    else if (e.event === 'failed' || e.event === 'stuck') {
      const reason = reasonOf(d), stuck = e.event === 'stuck';
      if (e.cause === 'environment') { t(stuck ? 'Stopped after repeated environment faults; needs a person.' : 'Test-environment fault; waiting to retry the same build (no retry used).', stuck ? 'Stuck · needs you' : 'Waiting to retry', stuck ? 'bad' : 'hold', stuck); }
      else if (e.cause === 'base-defect') { t(`On hold: the same failure happens on ${base}; no retry used.`, 'On hold', 'hold'); }
      else if (!counted(e)) t(`Stopped without using a retry: ${reason}.`, stuck ? 'Stuck · needs you' : 'Waiting', stuck ? 'bad' : 'hold', stuck);
      else { tryOf.delete(`${id}#open`); t(stuck || n >= maxAttempts ? `Stuck after ${n} ${n === 1 ? 'try' : 'tries'}: ${reason}.` : `Try ${n} ended: ${reason}. Queued for try ${n + 1}.`, stuck || n >= maxAttempts ? 'Stuck · needs you' : `Queued · try ${n + 1} of ${maxAttempts}`, stuck || n >= maxAttempts ? 'bad' : 'fix', stuck || n >= maxAttempts); }
    }
  }
  return out.slice(-limit).reverse();
}

// A queued or waiting feature's one-line reason, for the board and the factory queue (no artifacts needed).
export function queueNote(f: Feature, maxAttempts: number, base: string, unmetDeps: { title: string }[], blockingTask?: string): string | null {
  if (f.status !== 'todo') return null;
  if (f.planningHold) return f.planningHold.cause === 'base-defect' ? `On hold: the same failure happens on ${base}.` : 'On hold: the spec needs a clarification.';
  if (f.envRetryAt && Date.parse(f.envRetryAt) > Date.now()) return 'Waiting to retry after a test-environment fault (no retry used).';
  if (f.setupRetryAt && Date.parse(f.setupRetryAt) > Date.now()) return 'Waiting to retry after a setup failure (no retry used).';
  if (blockingTask) return `Needs you first: ${blockingTask}.`;
  if (unmetDeps.length) return `Waiting on ${unmetDeps[0]!.title}${unmetDeps.length > 1 ? ` and ${unmetDeps.length - 1} more` : ''} to merge first.`;
  if ((f.attempts || 0) > 0) return `Queued for try ${(f.attempts || 0) + 1} of ${maxAttempts} · ${reasonOf(f.lastFeedback).replace(/^./, (c) => c.toUpperCase())}.`;
  return null;
}
