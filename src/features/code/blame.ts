// code-editor-workspace FR-7 — inline blame: the caret line's `Author, <relative time>
// · <summary>` from `editor_blame`, cached per (path, version, line), and the palette
// toggle (default on) persisted to localStorage.

import { create } from 'zustand';
import type { EditorRoot, FileVersion } from '../../../contract/code-editor';
import type { EditorBlameLine } from '../../../contract/code-editor-workspace';
import { editorBlame } from '../../lib/api';

export const BLAME_SETTLE_MS = 400;
export const INLINE_BLAME_KEY = 'francois.code.inlineBlame';

const UNITS: Array<[string, number]> = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['week', 7 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
];

/** '2 days ago' — the largest whole unit; under a minute (or in the future) is 'just now'. */
export function blameAgo(time: number, now: number): string {
  const ms = now - time;
  for (const [unit, size] of UNITS) {
    const n = Math.floor(ms / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** `Antoine G, 2 days ago · fix(auth): …` (Figma 53). */
export function formatBlame(line: EditorBlameLine, now: number): string {
  const head = `${line.author}, ${blameAgo(line.time, now)}`;
  return line.summary ? `${head} · ${line.summary}` : head;
}

/** (path, version, line) → the core's answer, null included; insertion-ordered eviction. */
export class BlameCache {
  private entries = new Map<string, EditorBlameLine | null>();
  constructor(private readonly capacity = 500) {}

  private static key(path: string, version: FileVersion, line: number): string {
    return `${version}\u0000${line}\u0000${path}`;
  }

  has(path: string, version: FileVersion, line: number): boolean {
    return this.entries.has(BlameCache.key(path, version, line));
  }

  get(path: string, version: FileVersion, line: number): EditorBlameLine | null | undefined {
    return this.entries.get(BlameCache.key(path, version, line));
  }

  set(path: string, version: FileVersion, line: number, value: EditorBlameLine | null): void {
    this.entries.set(BlameCache.key(path, version, line), value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

/** The caret line's blame: the cache first, else `editor_blame` (an error is null, uncached). */
export async function fetchBlame(cache: BlameCache, root: EditorRoot, path: string, version: FileVersion, line: number): Promise<EditorBlameLine | null> {
  if (cache.has(path, version, line)) return cache.get(path, version, line) ?? null;
  const res = await editorBlame({ root, path, line });
  if (!res.ok) return null;
  cache.set(path, version, line, res.data);
  return res.data;
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(INLINE_BLAME_KEY) !== '0';
  } catch {
    return true;
  }
}

export const useBlameStore = create<{ enabled: boolean; toggle: () => void }>((set, get) => ({
  enabled: readEnabled(),
  toggle: () => {
    const enabled = !get().enabled;
    set({ enabled });
    try {
      localStorage.setItem(INLINE_BLAME_KEY, enabled ? '1' : '0');
    } catch {
      // unwritable storage: the toggle still holds for this run
    }
  },
}));
