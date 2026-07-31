// session-attachments — the pure half of the composer pipeline (spec §4).
// Everything the feature decides (where a ref lands in the text, which chips
// exist, what a refusal reads like) is a function of strings + the contract's
// Attachment, so it is all exercised here; the React wiring in
// useSessionAttachments/Composer only calls into these.

import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../../contract/session-attachments';
import { ATTACHMENT_MAX_BYTES, attachmentRef } from '../../../contract/session-attachments';
import {
  addStaged,
  bytesToBase64,
  clearReport,
  composerErrorBanners,
  containsRef,
  dropOverlayState,
  firstImageItem,
  formatFileSize,
  imageChips,
  insertRefsAtCaret,
  pathLooksLikeDirectory,
  refusalLine,
  removeStaged,
  removeFirstRef,
  resolveClearProjectId,
  truncateMiddle,
} from './attachments';

const MIB = 1024 * 1024;

function att(over: Partial<Attachment> = {}): Attachment {
  const refPath = over.refPath ?? '.francois/attachments/a3f9c1e2/pasted-20260730-142530.png';
  return {
    id: 'a1',
    sessionId: 's1',
    kind: 'image',
    storedPath: 'C:\\repo\\' + refPath,
    refPath,
    name: refPath.slice(refPath.lastIndexOf('/') + 1),
    bytes: 1024,
    copied: true,
    state: 'staged',
    createdAt: 1,
    ...over,
  };
}

// ---------- FR-11: ref insertion at the caret ----------

describe('insertRefsAtCaret', () => {
  it('inserts into an empty composer and leaves the caret past a trailing space', () => {
    const r = insertRefsAtCaret('', 0, 0, ['@a.png']);
    expect(r.text).toBe('@a.png ');
    expect(r.caret).toBe(7);
  });

  it('separates from surrounding text with exactly one space on each side', () => {
    const r = insertRefsAtCaret('look here', 4, 4, ['@a.png']);
    expect(r.text).toBe('look @a.png here');
    expect(r.caret).toBe('look @a.png '.length);
  });

  it('does not double a space that is already there', () => {
    const r = insertRefsAtCaret('look  here', 5, 5, ['@a.png']);
    expect(r.text).toBe('look @a.png here');
  });

  it('replaces the selection', () => {
    const r = insertRefsAtCaret('drop THIS out', 5, 9, ['@a.png']);
    expect(r.text).toBe('drop @a.png out');
  });

  it('appends several refs in drop order, single-space separated (FR-9 multi-drop)', () => {
    const r = insertRefsAtCaret('', 0, 0, ['@a.png', '@b/c.pdf', '@d.gif']);
    expect(r.text).toBe('@a.png @b/c.pdf @d.gif ');
  });

  it('is a no-op for an empty ref list', () => {
    expect(insertRefsAtCaret('hi', 2, 2, [])).toEqual({ text: 'hi', caret: 2 });
  });

  it('clamps an out-of-range caret to the end of the text', () => {
    const r = insertRefsAtCaret('hi', 99, 99, ['@a.png']);
    expect(r.text).toBe('hi @a.png ');
  });
});

// ---------- FR-12/FR-13: finding and removing a ref ----------

describe('containsRef', () => {
  it('finds a ref surrounded by whitespace', () => {
    expect(containsRef('see @a/b.png please', '@a/b.png')).toBe(true);
  });

  it('finds a ref at either end of the text', () => {
    expect(containsRef('@a/b.png', '@a/b.png')).toBe(true);
    expect(containsRef('x @a/b.png', '@a/b.png')).toBe(true);
    expect(containsRef('@a/b.png x', '@a/b.png')).toBe(true);
  });

  it('accepts trailing punctuation', () => {
    expect(containsRef('what about @a/b.png, then?', '@a/b.png')).toBe(true);
  });

  it('does not match a longer path that merely starts with it', () => {
    expect(containsRef('@a/b.png.bak', '@a/b.png')).toBe(false);
  });

  it('does not match mid-word (an email-looking token is not a ref)', () => {
    expect(containsRef('me@a/b.png', '@a/b.png')).toBe(false);
  });

  it('is false once the text no longer holds the ref', () => {
    expect(containsRef('nothing here', '@a/b.png')).toBe(false);
  });
});

describe('removeFirstRef', () => {
  it('removes the ref and the space it introduced', () => {
    expect(removeFirstRef('look @a.png here', '@a.png')).toBe('look here');
  });

  it('empties a composer holding only the ref', () => {
    expect(removeFirstRef('@a.png ', '@a.png')).toBe('');
  });

  it('eats the leading space when the ref ends the text', () => {
    expect(removeFirstRef('hello @a.png', '@a.png')).toBe('hello');
  });

  it('removes only the FIRST occurrence (FR-13)', () => {
    expect(removeFirstRef('@a.png and @a.png', '@a.png')).toBe('and @a.png');
  });

  it('leaves the text untouched when the ref is absent', () => {
    expect(removeFirstRef('hello', '@a.png')).toBe('hello');
  });
});

// ---------- FR-12: chips are derived from (text, staged) ----------

describe('imageChips', () => {
  const png = att({ id: 'i1', kind: 'image', refPath: 'shots/a.png' });
  const pdf = att({ id: 'f1', kind: 'file', refPath: 'docs/report.pdf' });
  const gif = att({ id: 'i2', kind: 'image', refPath: 'shots/b.gif' });

  it('renders one chip per image attachment whose ref is in the text', () => {
    const text = `${attachmentRef(png)} ${attachmentRef(pdf)}`;
    expect(imageChips(text, [png, pdf]).map((a) => a.id)).toEqual(['i1']);
  });

  it('drops the chip as soon as the ref is edited out of the text', () => {
    expect(imageChips('nothing', [png])).toEqual([]);
  });

  it('never gives a non-image file a chip, even when its ref is present', () => {
    expect(imageChips(attachmentRef(pdf), [pdf])).toEqual([]);
  });

  it('keeps staged order', () => {
    const text = `${attachmentRef(gif)} ${attachmentRef(png)}`;
    expect(imageChips(text, [png, gif]).map((a) => a.id)).toEqual(['i1', 'i2']);
  });
});

// ---------- staged list bookkeeping ----------

describe('addStaged / removeStaged', () => {
  it('appends in arrival order', () => {
    const a = att({ id: 'a' });
    const b = att({ id: 'b' });
    expect(addStaged([a], [b]).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('replaces an id already staged rather than duplicating it', () => {
    const a = att({ id: 'a', bytes: 1 });
    const a2 = att({ id: 'a', bytes: 2 });
    const out = addStaged([a], [a2]);
    expect(out).toHaveLength(1);
    expect(out[0].bytes).toBe(2);
  });

  it('drops one attachment by id', () => {
    expect(removeStaged([att({ id: 'a' }), att({ id: 'b' })], 'a').map((x) => x.id)).toEqual(['b']);
  });
});

// ---------- design §1: chip name ----------

describe('truncateMiddle', () => {
  it('leaves a short name alone', () => {
    expect(truncateMiddle('a.png', 18)).toBe('a.png');
  });

  it('keeps the extension visible when it truncates', () => {
    const out = truncateMiddle('pasted-20260730-142530.png', 18);
    expect(out).toHaveLength(18);
    expect(out).toContain('…');
    expect(out.endsWith('.png')).toBe(true);
    expect(out.startsWith('pasted')).toBe(true);
  });

  it('truncates harder on a narrow composer (design §Responsive)', () => {
    expect(truncateMiddle('pasted-20260730-142530.png', 10)).toHaveLength(10);
  });
});

// ---------- §7 / design §3: refusal copy ----------

describe('formatFileSize', () => {
  it('renders the 10 MiB cap as 10 MB', () => {
    expect(formatFileSize(ATTACHMENT_MAX_BYTES)).toBe('10 MB');
  });

  it('rounds whole megabytes past 10 MB', () => {
    expect(formatFileSize(24 * MIB)).toBe('24 MB');
  });

  it('keeps one decimal below 10 MB', () => {
    expect(formatFileSize(1.5 * MIB)).toBe('1.5 MB');
  });

  it('falls back to KB and B', () => {
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(12)).toBe('12 B');
  });
});

describe('refusalLine', () => {
  it('is null when nothing was refused', () => {
    expect(refusalLine([])).toBeNull();
  });

  it('names the file and both sizes for a single too-large refusal', () => {
    const line = refusalLine([
      {
        name: 'payload.zip',
        error: { code: 'ATTACHMENT_TOO_LARGE', message: 'too large', detail: { bytes: 24 * MIB, cap: ATTACHMENT_MAX_BYTES } },
      },
    ]);
    expect(line).toBe('payload.zip is 24 MB — the limit is 10 MB.');
  });

  it('falls back to the cap-only wording when the core sent no byte count', () => {
    const line = refusalLine([{ name: 'payload.zip', error: { code: 'ATTACHMENT_TOO_LARGE', message: 'too large' } }]);
    expect(line).toBe('payload.zip is too large — the limit is 10 MB.');
  });

  it('uses the folder wording for a directory refusal', () => {
    const line = refusalLine([{ name: 'src', error: { code: 'ATTACHMENT_IS_DIRECTORY', message: 'is a directory' } }]);
    expect(line).toBe("Folders can't be attached — drop the files instead.");
  });

  it('surfaces any other error message verbatim', () => {
    const line = refusalLine([{ name: 'a.txt', error: { code: 'ATTACHMENT_IO_FAILED', message: 'disk full' } }]);
    expect(line).toBe('disk full');
  });

  it('collapses several refusals into one counted line (design §3)', () => {
    const line = refusalLine([
      { name: 'a.zip', error: { code: 'ATTACHMENT_TOO_LARGE', message: 'x' } },
      { name: 'b.zip', error: { code: 'ATTACHMENT_TOO_LARGE', message: 'x' } },
      { name: 'src', error: { code: 'ATTACHMENT_IS_DIRECTORY', message: 'x' } },
    ]);
    expect(line).toBe('3 files skipped — 2 too large, 1 folder.');
  });

  it('counts folders and unclassified failures separately', () => {
    const line = refusalLine([
      { name: 'src', error: { code: 'ATTACHMENT_IS_DIRECTORY', message: 'x' } },
      { name: 'lib', error: { code: 'ATTACHMENT_IS_DIRECTORY', message: 'x' } },
      { name: 'a.txt', error: { code: 'ATTACHMENT_IO_FAILED', message: 'x' } },
    ]);
    expect(line).toBe('3 files skipped — 2 folders, 1 failed.');
  });
});

// ---------- FR-14: clipboard ----------

describe('firstImageItem', () => {
  it('picks the first image item on the clipboard', () => {
    const items = [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png' },
      { kind: 'file', type: 'image/jpeg' },
    ];
    expect(firstImageItem(items)).toBe(items[1]);
  });

  it('ignores an image/* item that is not a file entry', () => {
    expect(firstImageItem([{ kind: 'string', type: 'image/png' }])).toBeNull();
  });

  it('returns null for a text-only clipboard — the default paste must not regress', () => {
    expect(firstImageItem([{ kind: 'string', type: 'text/plain' }])).toBeNull();
    expect(firstImageItem([])).toBeNull();
  });
});

describe('bytesToBase64', () => {
  it('encodes bytes the way the core will decode them', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  it('encodes an empty buffer', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
  });

  it('handles high bytes (a PNG header) without corrupting them', () => {
    expect(bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('iVBORw==');
  });

  it('survives a buffer larger than one chunk (a real screenshot is megabytes)', () => {
    const big = new Uint8Array(70000).fill(65); // 'A' * 70000 -> 'QUFB' * 23333 + 'QQ=='
    const out = bytesToBase64(big);
    expect(out).toHaveLength(Math.ceil(70000 / 3) * 4);
    expect(out.startsWith('QUFBQUFB')).toBe(true);
    expect(out.endsWith('QQ==')).toBe(true);
  });
});

// ---------- design §2: drop overlay ----------

describe('dropOverlayState', () => {
  it('is hidden when nothing is being dragged', () => {
    expect(dropOverlayState(false, [])).toBe('hidden');
  });

  it('is active during a drag carrying files', () => {
    expect(dropOverlayState(true, ['C:\\tmp\\a.png'])).toBe('active');
  });

  it('is active during a drag whose payload is not yet known', () => {
    expect(dropOverlayState(true, [])).toBe('active');
  });

  it('rejects a drag carrying only directory-looking entries', () => {
    expect(dropOverlayState(true, ['C:\\repo\\src', '/home/u/lib'])).toBe('rejecting');
  });

  it('stays active when at least one entry looks like a file', () => {
    expect(dropOverlayState(true, ['C:\\repo\\src', 'C:\\repo\\a.png'])).toBe('active');
  });
});

describe('pathLooksLikeDirectory', () => {
  it('treats a dotless basename as a directory', () => {
    expect(pathLooksLikeDirectory('C:\\repo\\src')).toBe(true);
    expect(pathLooksLikeDirectory('/home/u/lib/')).toBe(true);
  });

  it('treats anything with an extension as a file', () => {
    expect(pathLooksLikeDirectory('/home/u/a.png')).toBe(false);
    expect(pathLooksLikeDirectory('C:\\repo\\report.pdf')).toBe(false);
  });

  it('does not mistake a dot in a parent folder for an extension', () => {
    expect(pathLooksLikeDirectory('/home/u/.francois/attachments')).toBe(true);
  });

  it('treats a dotfile as a file — a leading dot is the name, not a missing extension', () => {
    expect(pathLooksLikeDirectory('/home/u/.gitignore')).toBe(false);
    expect(pathLooksLikeDirectory('C:\\repo\\.env')).toBe(false);
    expect(pathLooksLikeDirectory('.npmrc')).toBe(false);
  });

  it('treats the relative markers and a bare root as directories', () => {
    expect(pathLooksLikeDirectory('.')).toBe(true);
    expect(pathLooksLikeDirectory('/home/u/..')).toBe(true);
    expect(pathLooksLikeDirectory('/')).toBe(true);
  });

  it('keeps a dotfile drop out of the rejecting overlay state', () => {
    expect(dropOverlayState(true, ['/home/u/.gitignore'])).toBe('active');
  });

  it('recognizes known extensionless filenames as files, case-insensitively', () => {
    expect(pathLooksLikeDirectory('C:\\repo\\Dockerfile')).toBe(false);
    expect(pathLooksLikeDirectory('/repo/makefile')).toBe(false);
    expect(pathLooksLikeDirectory('/repo/LICENSE')).toBe(false);
    expect(pathLooksLikeDirectory('C:\\repo\\Readme')).toBe(false);
  });

  it('keeps a known extensionless filename drop out of the rejecting overlay state', () => {
    expect(dropOverlayState(true, ['/repo/Dockerfile'])).toBe('active');
  });

  it('still treats an unlisted extensionless basename as a directory (documented false positive)', () => {
    expect(pathLooksLikeDirectory('/repo/some_extensionless_tool')).toBe(true);
  });
});

// ---------- FR-18: "Clear project attachments" ----------

describe('resolveClearProjectId', () => {
  const sessions = [
    { id: 's1', projectId: 'p9' },
    { id: 's2' },
  ];

  it('prefers the active project', () => {
    expect(resolveClearProjectId('p1', 's1', sessions)).toBe('p1');
  });

  it('falls back to the active session\u2019s project when "All projects" is selected', () => {
    expect(resolveClearProjectId(null, 's1', sessions)).toBe('p9');
  });

  it('is null when neither the selection nor the session names a project', () => {
    expect(resolveClearProjectId(null, 's2', sessions)).toBeNull();
    expect(resolveClearProjectId(null, null, sessions)).toBeNull();
  });
});

describe('clearReport', () => {
  it('reports the count and the reclaimed size', () => {
    expect(clearReport({ removedFiles: 14, removedBytes: 32 * MIB, failed: 0 })).toBe('Removed 14 files (32 MB).');
  });

  it('singularizes one file', () => {
    expect(clearReport({ removedFiles: 1, removedBytes: 2048, failed: 0 })).toBe('Removed 1 file (2 KB).');
  });

  it('states the zero case', () => {
    expect(clearReport({ removedFiles: 0, removedBytes: 0, failed: 0 })).toBe('No attachments to clear.');
  });

  it('appends the failures it could not delete', () => {
    expect(clearReport({ removedFiles: 2, removedBytes: 1024, failed: 3 })).toBe(
      'Removed 2 files (1 KB). 3 could not be deleted.',
    );
  });

  it('reports failures even when nothing was removed', () => {
    expect(clearReport({ removedFiles: 0, removedBytes: 0, failed: 2 })).toBe('No attachments to clear. 2 could not be deleted.');
  });
});

describe('composerErrorBanners', () => {
  it('has nothing to show when neither source failed', () => {
    expect(composerErrorBanners(null, null)).toEqual([]);
  });

  it('shows a send failure on its own', () => {
    expect(composerErrorBanners('Session is not running.', null)).toEqual(['Session is not running.']);
  });

  it('shows an attachment refusal on its own', () => {
    expect(composerErrorBanners(null, 'shot.png is 12 MB — the limit is 10 MB.')).toEqual(['shot.png is 12 MB — the limit is 10 MB.']);
  });

  it('keeps both visible when they overlap, send failure first', () => {
    expect(composerErrorBanners('Session is not running.', 'shot.png is 12 MB — the limit is 10 MB.')).toEqual([
      'Session is not running.',
      'shot.png is 12 MB — the limit is 10 MB.',
    ]);
  });

  it('collapses the same message reported by both sources into one line', () => {
    expect(composerErrorBanners('IPC unavailable.', 'IPC unavailable.')).toEqual(['IPC unavailable.']);
  });

  it('ignores an empty message', () => {
    expect(composerErrorBanners('', 'shot.png was refused.')).toEqual(['shot.png was refused.']);
  });
});
