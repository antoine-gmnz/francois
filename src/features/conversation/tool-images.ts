// tool-images: pure helpers behind the thumbnail strip a tool row grows when
// its result carried images (a `Read` of a PNG, an MCP screenshot). The bytes
// live in a file the core decoded; the block only carries `ToolImage` refs.

import type { ToolImage } from '../../../contract/common';

const SHORT_MIME: Record<ToolImage['mime'], string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WEBP',
};

/** `1.2 MB`, `14 KB`, `512 B` — the size as a glance, not a figure to audit. */
export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `PNG · 14 KB` — the caption under a thumbnail and the viewer's subtitle. */
export function imageCaption(image: ToolImage): string {
  return `${SHORT_MIME[image.mime] ?? 'IMAGE'} · ${formatImageBytes(image.bytes)}`;
}

/** The file name the core wrote, for the viewer's title and the alt text. */
export function imageFileName(image: ToolImage): string {
  const parts = image.path.split(/[\\/]/);
  return parts[parts.length - 1] || image.path;
}

/** The viewer's next index for an arrow key, wrapping; null when there is nowhere to go. */
export function stepImage(index: number, count: number, key: string): number | null {
  if (count < 2) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  return null;
}
