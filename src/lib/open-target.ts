export interface TargetPart { text: string; target?: string }

export function isOpenModifier(e: { button: number; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.button === 0 && (e.ctrlKey || e.metaKey);
}

/** Conservative autolinks: explicit paths and HTTP(S), never arbitrary prose. */
export function targetParts(text: string): TargetPart[] {
  const re = /(?:https?|file):\/\/[^\s<>"`]+|(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|[\w.-]+\/)[^\s<>"`]+/g;
  const parts: TargetPart[] = [];
  let end = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index!;
    // Don't turn the tail of an unsupported scheme into a file reference.
    if (start > 0 && /[\w:]/.test(text[start - 1])) continue;
    const target = trimTargetPunctuation(match[0]);
    if (!target) continue;
    if (start > end) parts.push({ text: text.slice(end, start) });
    parts.push({ text: target, target });
    end = start + target.length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}

/** A standalone inline-code filename is unambiguous enough to offer opening. */
export function codeTarget(text: string): string | null {
  return /^(?:[\w .-]+\.[A-Za-z][\w-]*)(?::\d+(?::\d+)?|#L\d+)?$/.test(text) ? text : null;
}

function trimTargetPunctuation(text: string): string {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let target = text;
  while (target) {
    const last = target[target.length - 1];
    if (/[.,;!?]/.test(last)) {
      target = target.slice(0, -1);
      continue;
    }
    const opening = pairs[last];
    if (!opening) break;
    const balance = [...target].reduce((total, ch) => total + (ch === opening ? 1 : ch === last ? -1 : 0), 0);
    if (balance >= 0) break;
    target = target.slice(0, -1);
  }
  return target;
}
