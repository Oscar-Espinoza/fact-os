// Readiness rule: pure functions over features + human tasks.
import type { Feature, HumanTask, MergeMode } from './types.ts';

export const SLUG = /^[a-z0-9][a-z0-9._-]*$/i; // ids become paths and branch names

export interface Analysis { ready: string[]; waiting: string[]; mock: Set<string>; bad: Set<string>; held: string[] }

// Transitive deps of each feature (unknown ids included as-is).
function reachability(features: Feature[]) {
  const byId = new Map(features.map((f) => [f.id, f]));
  const reach = new Map<string, Set<string>>();
  for (const f of features) {
    const seen = new Set<string>(), stack = [...(f.deps || [])];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(byId.get(d)?.deps || []));
    }
    reach.set(f.id, seen);
  }
  return { byId, reach };
}

export function validate(features: Feature[], tasks: HumanTask[] = []): string[] {
  const errors: string[] = [];
  const { byId, reach } = reachability(features);
  const seen = new Set<string>();
  for (const f of features) {
    if (seen.has(f.id)) errors.push(`duplicate feature id: ${f.id}`);
    seen.add(f.id);
    for (const d of f.deps || []) if (!byId.has(d)) errors.push(`${f.id}: unknown dep ${d}`);
    if (reach.get(f.id)!.has(f.id)) errors.push(`${f.id}: dependency cycle (${f.id} → … → ${f.id})`);
  }
  for (const t of tasks) for (const u of t.unblocks || []) if (!byId.has(u)) errors.push(`human task ${t.id}: unknown feature ${u}`);
  return errors;
}

// Number of features that transitively depend on each id.
export function dependents(features: Feature[]): Map<string, number> {
  const { reach } = reachability(features);
  const n = new Map(features.map((f) => [f.id, 0]));
  for (const [id, deps] of reach) for (const d of deps) if (d !== id && n.has(d)) n.set(d, n.get(d)! + 1);
  return n;
}

// Features a human task unblocks, directly or through deps.
export function taskReach(task: HumanTask, features: Feature[]): number {
  const { reach } = reachability(features);
  const direct = new Set(task.unblocks || []);
  return features.filter((f) => direct.has(f.id) || [...reach.get(f.id)!].some((d) => direct.has(d))).length;
}

// The human tasks a launch of `id` may build against a mock of: the open mockable tasks that name it, plus the open mockable
// tasks that name any of its declared dependencies, transitively (`via`: those dependencies), each task once. An open task
// that is not mockable blocks only the features it names (`blocked`); one on a dependency neither blocks nor grants. The
// allowance is exactly these named capabilities, never every unavailable integration.
export type MockTask = HumanTask & { via?: string[] };
export function mockTasksFor(id: string, features: Feature[], tasks: HumanTask[], reach = reachability(features).reach): { tasks: MockTask[]; blocked: boolean } {
  const open = tasks.filter((t) => t.status === 'open'), deps = reach.get(id) ?? new Set<string>();
  const direct = open.filter((t) => (t.unblocks || []).includes(id));
  if (direct.some((t) => !t.mockable)) return { tasks: [], blocked: true };
  const copy = (t: HumanTask, via?: string[]): MockTask => ({ ...t, steps: [...(t.steps || [])], unblocks: [...(t.unblocks || [])], ...(via ? { via } : {}) });
  const inherited = open.filter((t) => t.mockable && !direct.includes(t)).map((t) => ({ t, via: (t.unblocks || []).filter((u) => deps.has(u)).sort() }))
    .filter((x) => x.via.length).map((x) => copy(x.t, x.via));
  return { tasks: [...direct.map((t) => copy(t)), ...inherited], blocked: false };
}

// Keep the mode argument compatible with existing callers; both modes require
// merged dependencies because worktrees start from base, not unmerged branches.
export function analyze(features: Feature[], tasks: HumanTask[], _mergeMode: MergeMode = 'auto'): Analysis {
  const { byId, reach } = reachability(features);
  const count = new Map<string, number>();
  for (const f of features) count.set(f.id, (count.get(f.id) || 0) + 1);
  const bad = new Set(features.filter((f) => typeof f.id !== 'string' || !SLUG.test(f.id) || count.get(f.id)! > 1 || reach.get(f.id)!.has(f.id) ||
    [...reach.get(f.id)!].some((d) => !byId.has(d))).map((f) => f.id));
  const done = new Set<string | undefined>(['merged']);
  const open = tasks.filter((t) => t.status === 'open');
  const ready: Feature[] = [], waiting: string[] = [], mock = new Set<string>(), held: string[] = [];
  for (const f of features) {
    if (f.status !== 'todo' || bad.has(f.id)) continue;
    if (f.planningHold) { held.push(f.id); continue; } // a planning hold: the spec or prompt needs a change first
    const m = mockTasksFor(f.id, features, open, reach);
    if (m.blocked) { waiting.push(f.id); continue; }
    if (!(f.deps || []).every((d) => done.has(byId.get(d)?.status))) continue;
    if (m.tasks.length) mock.add(f.id);
    ready.push(f);
  }
  const dep = dependents(features);
  ready.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || dep.get(b.id)! - dep.get(a.id)! || (a.id < b.id ? -1 : 1));
  return { ready: ready.map((f) => f.id), waiting, mock, bad, held };
}
