// Feature actions a person takes (CLI and dashboard): pause, resume, retry. The foreman never pauses anything.
import { mutate, log, loadConfig } from './state.ts';
import type { Feature } from './types.ts';

export type Action = 'pause' | 'resume' | 'retry' | 'release';
export const ACTIONS: Action[] = ['pause', 'resume', 'retry', 'release'];
export const PAST: Record<Action, string> = { pause: 'paused', resume: 'resumed', retry: 'retrying', release: 'released' };
const now = () => new Date().toISOString();

// Applies one action to f in place; returns why it can't, or null. In-flight features belong to the foreman.
export function apply(f: Feature, action: Action, maxAttempts: number): string | null {
  if (action === 'pause') {
    if (f.status !== 'todo' && f.status !== 'stuck') return `only todo or stuck features can be paused (is ${f.status})`;
    Object.assign(f, { status: 'paused', pausedAt: now(), updatedAt: now() });
  } else if (action === 'release') { // a person overrides the observer's planning hold: launch it as it is
    if (!f.planningHold) return 'no planning hold to release';
    delete f.planningHold;
    f.updatedAt = now();
  } else if (action === 'resume') {
    if (f.status !== 'paused') return `not paused (is ${f.status})`;
    // A feature paused from stuck would be stuck again on its next failure; give it a fresh set of attempts.
    Object.assign(f, { status: 'todo', updatedAt: now(), ...(f.attempts >= maxAttempts ? { attempts: 0 } : {}) });
    delete f.pausedAt;
    delete f.stop;
  } else {
    if (f.status !== 'stuck') return `only stuck features can be retried (is ${f.status})`;
    Object.assign(f, { status: 'todo', attempts: 0, refreshes: 0, updatedAt: now() }); // lastFeedback kept: the next build sees it
    delete f.setupFailures; delete f.setupRetryAt; delete f.envFailures; delete f.envRetryAt;
    delete f.stop;
  }
  return null;
}

// Applies action to each id under the lock; result maps id → error (null when applied).
export async function act(root: string, action: Action, ids: string[]): Promise<Record<string, string | null>> {
  const { maxAttempts } = loadConfig(root);
  const resets = new Map<string, boolean>();
  const r = await mutate(root, 'features', (d) => Object.fromEntries(ids.map((id) => {
    const f = d.features.find((x) => x.id === id);
    if (!f) return [id, 'unknown feature'];
    const before = f.attempts, err = apply(f, action, maxAttempts);
    if (!err && action !== 'pause') resets.set(id, action === 'retry' || before >= maxAttempts);
    return [id, err];
  })));
  for (const [id, err] of Object.entries(r)) if (!err) log(root, id, PAST[action], 'by a person', undefined,
    resets.has(id) ? { attemptsReset: resets.get(id)! } : undefined);
  return r;
}
