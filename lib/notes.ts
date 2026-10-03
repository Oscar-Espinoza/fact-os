// Per-model prompt notes: short advice for one model in one role (for example "sonnet as builder"), learned from the observer's
// reviews of failed passes (promptreview.ts) and appended by the foreman to that role's prompt when it launches that model.
// One file per model and role under <state dir>/prompt-notes/. Pure helpers plus the one read the foreman needs: no agent here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './state.ts';
import type { Role } from './types.ts';

export const notesDir = (root: string): string => join(paths(root).dir, 'prompt-notes');
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_');
export const notesFile = (root: string, model: string, role: Role): string => join(notesDir(root), `${safe(model)}-${role}.md`);
export const notesArchive = (root: string, model: string, role: Role): string => notesFile(root, model, role).replace(/\.md$/, '.archive.md');

// The notes this model gets in this role, or null (no model named, no file, nothing in it).
export function readNotes(root: string, model: string | undefined, role: Role): string | null {
  if (!model) return null;
  try { return readFileSync(notesFile(root, model, role), 'utf8').trim() || null; } catch { return null; }
}

// What the foreman appends to the prompt ('' without notes).
export const notesBlock = (model: string | undefined, role: Role, notes: string | null): string =>
  model && notes?.trim() ? `\n## Notes for ${model} as ${role}\n\nWhat earlier runs of ${model} in this role got wrong here, and how to avoid it:\n\n${notes.trim()}\n` : '';

// Short hash of a notes text, as it appears in a prompt fingerprint (`notes=<hash>`) so agent stats split by notes version.
export const notesHash = (notes: string): string => createHash('sha256').update(notes.trim()).digest('hex').slice(0, 8);

export const noteBullets = (text: string): string[] => text.split('\n').filter((l) => /^- /.test(l));
const bytes = (bullets: string[]): number => Buffer.byteLength(bullets.join('\n') + '\n');
const sameNote = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A suggestion as one bullet: one line, plain, at most NOTE_MAX characters. A longer one keeps its leading whole sentences:
// a mid-sentence cut used to drop the concrete instruction at the end (the paths, the commit-message format).
export const NOTE_MAX = 600;
export function clipNote(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= NOTE_MAX) return t;
  const head = t.slice(0, NOTE_MAX), end = Math.max(...['. ', '! ', '? '].map((p) => head.lastIndexOf(p)));
  if (end > 0) return head.slice(0, end + 1);
  const word = head.lastIndexOf(' ', NOTE_MAX - 1);
  return `${word > 0 ? head.slice(0, word) : head.slice(0, NOTE_MAX - 1)}…`;
}
export function noteBullet(s: string): string {
  const t = clipNote(s.replace(/\s+/g, ' ').trim().replace(/^[-*•]\s*/, ''));
  return t ? `- ${t}` : '';
}

// The existing bullets followed by the incoming ones that are not already there (compared ignoring case and punctuation).
export function mergeNotes(existing: string[], incoming: string[]): string[] {
  const out = [...existing], seen = new Set(existing.map(sameNote));
  for (const raw of incoming) {
    const b = noteBullet(raw), k = sameNote(b);
    if (b && !seen.has(k)) { out.push(b); seen.add(k); }
  }
  return out;
}

// Within the size cap by dropping the oldest bullets (the front); `dropped` goes to the archive.
export function fitNotes(bullets: string[], maxBytes: number): { kept: string[]; dropped: string[] } {
  let n = 0;
  while (n < bullets.length - 1 && bytes(bullets.slice(n)) > maxBytes) n++;
  return { kept: bullets.slice(n), dropped: bullets.slice(0, n) };
}
export const overCap = (bullets: string[], maxBytes: number): boolean => bytes(bullets) > maxBytes;
export const renderNotes = (bullets: string[]): string => bullets.join('\n') + '\n';

// The agent's curated notes, or why they are refused: between <notes> tags, only bullets, at least one, within the cap.
export function parseNotes(text: string, maxBytes: number): { bullets: string[] } | { error: string } {
  const m = text.match(/<notes>\s*([\s\S]*?)\s*<\/notes>/);
  if (!m) return { error: 'no <notes> block' };
  const lines = m[1]!.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.some((l) => !/^- /.test(l))) return { error: 'lines other than bullets' };
  const bullets = lines.map(noteBullet);
  if (!bullets.length) return { error: 'no bullets' };
  if (bytes(bullets) > maxBytes) return { error: `${bytes(bullets)} bytes, over the limit` };
  return { bullets };
}
