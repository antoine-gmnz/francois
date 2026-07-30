// session-attachments §5.2 — the six contract-typed invoke wrappers. Each binds
// francois:session:<verb> to the Tauri command `session_<verb>` (snake_case) and
// resolves a Result<T>; none of them ever rejects for a domain failure.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '../../../contract/session-attachments';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import {
  sessionAttachClipboardImage,
  sessionAttachFile,
  sessionClearAttachments,
  sessionCommitAttachments,
  sessionPickAttachments,
  sessionReleaseAttachment,
} from '../../lib/api';

const ATTACHMENT: Attachment = {
  id: 'a1',
  sessionId: 's1',
  kind: 'image',
  storedPath: 'C:\\repo\\.francois\\attachments\\a3f9c1e2\\pasted-20260730-142530.png',
  refPath: '.francois/attachments/a3f9c1e2/pasted-20260730-142530.png',
  name: 'pasted-20260730-142530.png',
  bytes: 2048,
  copied: true,
  state: 'staged',
  createdAt: 1,
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe('session-attachments invoke wrappers', () => {
  it('attachFile → session_attach_file { sessionId, path }', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: ATTACHMENT });
    const res = await sessionAttachFile('s1', 'C:\\tmp\\shot.png');
    expect(invokeMock).toHaveBeenCalledWith('session_attach_file', { sessionId: 's1', path: 'C:\\tmp\\shot.png' });
    expect(res).toEqual({ ok: true, data: ATTACHMENT });
  });

  it('attachFile surfaces a refusal as ok:false rather than throwing', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'ATTACHMENT_IS_DIRECTORY', message: 'is a directory' } });
    const res = await sessionAttachFile('s1', 'C:\\repo\\src');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ATTACHMENT_IS_DIRECTORY');
  });

  it('attachClipboardImage → session_attach_clipboard_image { sessionId, mime, dataBase64 }', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: ATTACHMENT });
    await sessionAttachClipboardImage('s1', 'image/png', 'aGk=');
    expect(invokeMock).toHaveBeenCalledWith('session_attach_clipboard_image', {
      sessionId: 's1',
      mime: 'image/png',
      dataBase64: 'aGk=',
    });
  });

  it('pickAttachments → session_pick_attachments { sessionId }; a cancel is ok:true with both arrays empty', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { attached: [], failed: [] } });
    const res = await sessionPickAttachments('s1');
    expect(invokeMock).toHaveBeenCalledWith('session_pick_attachments', { sessionId: 's1' });
    expect(res).toEqual({ ok: true, data: { attached: [], failed: [] } });
  });

  it('pickAttachments carries successes and per-file refusals together (FR-9)', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      data: { attached: [ATTACHMENT], failed: [{ name: 'huge.psd', error: { code: 'ATTACHMENT_TOO_LARGE', message: 'too large' } }] },
    });
    const res = await sessionPickAttachments('s1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.attached).toEqual([ATTACHMENT]);
      expect(res.data.failed[0].name).toBe('huge.psd');
    }
  });

  it('releaseAttachment → session_release_attachment { sessionId, attachmentId }', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: null });
    await sessionReleaseAttachment('s1', 'a1');
    expect(invokeMock).toHaveBeenCalledWith('session_release_attachment', { sessionId: 's1', attachmentId: 'a1' });
  });

  it('commitAttachments → session_commit_attachments { sessionId, text }', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { sent: ['a1'], released: ['a2'] } });
    const res = await sessionCommitAttachments('s1', 'look @a.png');
    expect(invokeMock).toHaveBeenCalledWith('session_commit_attachments', { sessionId: 's1', text: 'look @a.png' });
    expect(res).toEqual({ ok: true, data: { sent: ['a1'], released: ['a2'] } });
  });

  it('clearAttachments → session_clear_attachments { scope }', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { removedFiles: 3, removedBytes: 10, failed: 0 } });
    await sessionClearAttachments({ kind: 'project', projectId: 'p1' });
    expect(invokeMock).toHaveBeenCalledWith('session_clear_attachments', { scope: { kind: 'project', projectId: 'p1' } });
  });
});
