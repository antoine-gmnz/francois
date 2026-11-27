import { describe, expect, it } from 'vitest';
import { formatImageBytes, imageCaption, imageFileName, stepImage } from './tool-images';
import { transcriptReducer } from './conversation-blocks';
import { compactBlocks } from './tool-runs';
import type { ToolImage } from '../../../contract/common';
import type { ToolConversationBlock } from '../../../contract/conversation-view';

const png: ToolImage = { path: 'C:\\data\\tool-images\\s1\\b1-0.png', mime: 'image/png', bytes: 14_336 };

describe('tool-images helpers', () => {
  it('formats sizes as a glance', () => {
    expect(formatImageBytes(512)).toBe('512 B');
    expect(formatImageBytes(14_336)).toBe('14 KB');
    expect(formatImageBytes(1_258_291)).toBe('1.2 MB');
  });

  it('captions with the short mime and the size', () => {
    expect(imageCaption(png)).toBe('PNG · 14 KB');
  });

  it('names the file from either separator', () => {
    expect(imageFileName(png)).toBe('b1-0.png');
    expect(imageFileName({ ...png, path: '/a/b/shot.webp' })).toBe('shot.webp');
  });

  it('steps through images with the arrows, wrapping', () => {
    expect(stepImage(0, 3, 'ArrowRight')).toBe(1);
    expect(stepImage(2, 3, 'ArrowRight')).toBe(0);
    expect(stepImage(0, 3, 'ArrowLeft')).toBe(2);
    expect(stepImage(0, 1, 'ArrowRight')).toBeNull();
    expect(stepImage(0, 3, 'Enter')).toBeNull();
  });
});

describe('tool.done with images', () => {
  const start = transcriptReducer(
    { blocks: [], windowSize: 200 },
    { t: 'toolStart', blockId: 'b1', tool: 'Read', summary: 'shot.png' },
  );

  it('lands the refs on the settled block', () => {
    const next = transcriptReducer(start, { t: 'toolDone', blockId: 'b1', meta: 'image', images: [png] });
    const b = next.blocks[0] as ToolConversationBlock;
    expect(b.images).toEqual([png]);
    expect(b.isStreaming).toBe(false);
  });

  it('leaves the block without an images key when the result had none', () => {
    const next = transcriptReducer(start, { t: 'toolDone', blockId: 'b1', meta: '3 lines' });
    expect('images' in next.blocks[0]!).toBe(false);
  });

  it('never folds an image-bearing row into a run', () => {
    const row = (id: string, images?: ToolImage[]): ToolConversationBlock => ({
      kind: 'tool',
      blockId: id,
      isStreaming: false,
      tool: 'Read',
      glyph: '⧉',
      glyphColor: '#8b93a3',
      bodyColor: '#8b93a3',
      summary: 'shot.png',
      meta: 'image',
      ...(images ? { images } : {}),
    });
    const out = compactBlocks([row('a', [png]), row('b', [{ ...png, path: '/x/b.png' }])]);
    expect(out).toHaveLength(2);
    expect((out[0] as ToolConversationBlock).images).toEqual([png]);
  });
});
