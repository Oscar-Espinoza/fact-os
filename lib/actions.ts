// Feature actions a person takes (CLI and dashboard): pause, resume, retry. The foreman never pauses anything.
import { mutate, log, loadConfig } from './state.ts';
import type { Feature } from './types.ts';

export type Action = 'pause' | 'resume' | 'retry';
export const ACTIONS: Action[] = ['pause', 'resume', 'retry'];
export const PAST: Record<Action, string> = { pause: 'paused', resume: 'resumed', retry: 'retrying' };
const now = () => new Date().toISOString();

// Applies one action to f in place; returns why it can't, or null. In-flight features belong to the foreman.
export function apply(f: Feature, action: Action, maxAttempts: number): string | null {
  if (action === 'pause') {
    if (f.status !== 'todo' && f.status !== 'stuck') return `only todo or stuck features can be paused (is ${f.status})`;
    Object.assign(f, { status: 'paused', pausedAt: now(), updatedAt: now() });
  } else if (action === 'resume') {
    if (f.status !== 'paused') return `not paused (is ${f.status})`;
    // A feature paused from stuck would be stuck again on its next failure; give it a fresh set of attempts.
    Object.assign(f, { status: 'todo', updatedAt: now(), ...(f.attempts >= maxAttempts ? { attempts: 0 } : {}) });
    delete f.pausedAt;
  } else {
    if (f.status !== 'stuck') return `only stuck features can be retried (is ${f.status})`;
    Object.assign(f, { status: 'todo', attempts: 0, refreshes: 0, updatedAt: now() }); // lastFeedback kept: the next build sees it
  }
  return null;
}

// Applies action to each id under the lock; result maps id → error (null when applied).
export async function act(root: string, action: Action, ids: string[]): Promise<Record<string, string | null>> {
  const { maxAttempts } = loadConfig(root);
  const r = await mutate(root, 'features', (d) => Object.fromEntries(ids.map((id) => {
    const f = d.features.find((x) => x.id === id);
    return [id, f ? apply(f, action, maxAttempts) : `unknown feature`];
  })));
  for (const [id, err] of Object.entries(r)) if (!err) log(root, id, PAST[action], 'by a person');
  return r;
}
