---
id: session-attachments
title: Session attachments
status: frozen
created: 2026-07-30
depends_on: [session-engine, conversation-view, session-worktree, command-palette]
---

# Session attachments

## 1. Summary

Attach files and screenshots to a running Claude Code session by drag & drop, clipboard paste, or a
`+` button. Francois gets the bytes to a path the session can read, then inserts `@<path>` into the
composer. Claude Code's own `Read` tool reads image files, so nothing multimodal ever touches the
stdio stream: every gesture collapses to the same two steps — (1) put the bytes at a readable path,
(2) insert the ref. Every read still goes through Claude Code's tooling, so `permission-guardrails`
keeps seeing it.

## 2. Goals & non-goals

- **Goals**
  - Three gestures — drop on the SESSION tab, paste an image in the composer, `+` native picker —
    landing in one pipeline.
  - Three origins — already under the session cwd (referenced in place, no copy), outside it
    (copied in), clipboard bytes (written out).
  - Worktree-correct: every path decision keys off the **session's own cwd**, never the project root.
  - Never auto-send. Attaching stages a ref; the human presses Enter.
  - No orphan accumulation: copies that are never sent are removed.

- **Non-goals**
  - **Remote control.** `remote-control` continues a thread on a phone, which cannot resolve a local
    path. Upload-to-cloud is explicitly not built. Attachments are local-session-only.
  - Multimodal content blocks on the stdio stream (deliberately replaced by path-insertion).
  - Folder / directory attachment — refused, not deferred.
  - Inlining file content into the prompt — bypasses Claude Code's permission model.
  - Editing the user's `.gitignore`; automatic GC, quotas, or age-based expiry.

## 3. User stories / flows

**Screenshot (the high-frequency case).** Copy a screenshot → focus the composer → ⌘V/Ctrl+V. The
core writes `pasted-20260730-142530.png` into the session's attachments dir; the composer inserts
`@.francois/attachments/a3f9c1e2/pasted-20260730-142530.png` at the caret and shows a thumbnail chip
above the textarea. Type "the header wraps here", press Enter.

**Drop.** Drag files anywhere over the SESSION tab → a full-tab overlay reads "Drop files to
attach" → release. Each file is referenced in place or copied in, and its ref is appended at the
caret in drop order. Images also get a chip.

**Picker.** Click `+` in the composer → native multi-select file dialog → same as a drop. Cancelling
returns an empty list and changes nothing.

**Removal.** Press `×` on a chip, or delete the `@ref` text by hand. Either way the ref leaves the
prompt; the chip is derived from the text, so the two can never disagree.

**Purge.** ⌘K → "Clear project attachments" → confirm → every attachments dir belonging to that
project's sessions is emptied, and the count of removed files is reported.

## 4. Functional requirements

**Ingestion**

- **FR-1** `attachFile` resolves the origin against the session's cwd. Already under the cwd (after
  normalization) ⇒ `copied: false`, `storedPath` unchanged, `refPath` = the path relative to cwd.
  Otherwise ⇒ copy into the attachments dir, `copied: true`.
- **FR-2** The attachments dir is `<session-cwd>/.francois/attachments/<short8>/`, where `<short8>`
  is the first 8 characters of the session id. It is created lazily on the first attachment.
- **FR-3** On creating `<session-cwd>/.francois/`, the core writes `.francois/.gitignore` containing
  a single line `*`. That ignores the folder's contents *including the `.gitignore` itself*, so the
  tree is invisible to `git status` and therefore to `diff-view` with no ignore-list change anywhere.
  Francois never edits the user's own `.gitignore`.
- **FR-4** `refPath` is always **relative to the session cwd, POSIX-separated**, so it is free of
  Windows/WSL dialect. This is why the feature needs no `/mnt/c`-style translation: a Windows core
  writes into a `\\wsl$\…` cwd as an ordinary file copy, and the ref that reaches Claude is relative.
- **FR-5** `kind` is `image` when the extension is `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp`
  (case-insensitive); `file` otherwise.
- **FR-6** Clipboard images are written as `pasted-<YYYYMMDD>-<HHMMSS>.<ext>` in local time, `ext`
  derived from the mime type (default `png`).
- **FR-7** A copy whose target name already exists gets a `-2`, `-3`, … suffix before the extension
  (`report.pdf` → `report-2.pdf`). Nothing is ever overwritten.
- **FR-8** Files larger than **10 MiB** are refused with `ATTACHMENT_TOO_LARGE`; directories are
  refused with `ATTACHMENT_IS_DIRECTORY`. Neither creates a dir or a partial copy.
- **FR-9** A multi-file drop or pick attaches each entry independently: one refusal does not abort
  the rest. `pickAttachments` returns only the successes; the frontend reports the refusals it was
  told about per-file.

**Composer**

- **FR-10** The textarea is the **single source of truth** for the outgoing prompt. `sessionSend`
  transmits the textarea verbatim; there is no send-time assembly step.
- **FR-11** Every attachment's ref is inserted as `@<refPath>` text at the caret, images included.
  Refs are separated from surrounding text by a single space when one is not already present.
- **FR-12** Chips are **derived**, not stored: for each staged attachment of `kind: 'image'` whose
  `@<refPath>` occurs in the current textarea, one chip renders (thumbnail, name, `×`). Editing the
  text away removes the chip; there is no state that can desync from the prompt.
- **FR-13** `×` on a chip removes the first occurrence of that `@<refPath>` from the textarea **and**
  calls `releaseAttachment`, which deletes the copied file immediately (`copied: false` origins are
  never touched). `×` is unambiguous intent, so it acts at once; hand-editing is ambiguous mid-typing
  and is instead reconciled at send (FR-15).
- **FR-14** Paste attaches when the clipboard carries **any** image; the default text paste is then
  suppressed. A clipboard with no image pastes text exactly as it does today — this path must not
  regress.
- **FR-15** On a successful send the frontend calls `commitAttachments` with the sent text. Staged
  attachments whose ref appears in it become `sent`; the rest are released (copies deleted). Sent
  attachments are never swept — the transcript references them and Claude may re-read them.

**Retention**

- **FR-16** Deleting a session deletes every file that session created under its attachments dir,
  then removes the dir if empty.
- **FR-17** At app start the core deletes the file of every persisted attachment still in `staged`.
  Composer drafts do not persist across a restart, so a surviving `staged` record is by definition
  abandoned. This is also what sweeps a session the user simply switched away from, and it is
  crash-proof in a way a shutdown hook is not.
- **FR-18** The command palette exposes **"Clear project attachments"**, which sweeps the attachments
  dirs of every session registered under the active project — including sessions running in
  worktrees, which is why the sweep is driven by the session registry and not by a filesystem crawl.
  It asks for confirmation and reports the number of files removed.

## 5. API contract

`contract/session-attachments.ts`. No new `SessionEvent` member — this feature is request/response
only, so nothing is added to `contract/common.ts` except the error codes in §5.3.

### 5.1 Types

```ts
import type { Result, SessionId, ProjectId } from './common';

export type AttachmentKind = 'image' | 'file';

/** Lifecycle of a staged ref. 'sent' is terminal — sent attachments are never swept. */
export type AttachmentState = 'staged' | 'sent';

export interface Attachment {
  id: string;               // uuid v4
  sessionId: SessionId;
  kind: AttachmentKind;     // FR-5
  /** Absolute source path the bytes came from; absent for clipboard images. */
  originPath?: string;
  /** Absolute path on disk, HOST dialect. Equals originPath when copied === false. */
  storedPath: string;
  /** POSIX-separated, relative to the session cwd. The composer inserts '@' + this (FR-4). */
  refPath: string;
  name: string;             // basename of storedPath
  bytes: number;
  /** false ⇔ the file already lived under the session cwd and is referenced in place (FR-1). */
  copied: boolean;
  state: AttachmentState;
  createdAt: number;        // epoch ms
}

export interface CommitAttachmentsResult {
  sent: string[];           // attachment ids now in state 'sent'
  released: string[];       // attachment ids dropped, copies deleted
}

export interface ClearAttachmentsResult {
  removedFiles: number;
  removedBytes: number;
  failed: number;           // files that could not be deleted (locked, permissions)
}

export type ClearScope =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'project'; projectId: ProjectId };
```

### 5.2 Channels

All are request/response on the `session` domain; per PIPELINE.md §Conventions each binds to a Tauri
command `<domain>_<verb>` in snake_case and resolves to `Result<T>` — never rejects.

| logical channel | command | payload | data | errors |
|---|---|---|---|---|
| `francois:session:attachFile` | `session_attach_file` | `{ sessionId, path: string }` | `Attachment` | `SESSION_NOT_FOUND`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_IS_DIRECTORY`, `ATTACHMENT_IO_FAILED`, `INVALID_INPUT` |
| `francois:session:attachClipboardImage` | `session_attach_clipboard_image` | `{ sessionId, mime: string, dataBase64: string }` | `Attachment` | `SESSION_NOT_FOUND`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_IO_FAILED`, `INVALID_INPUT` |
| `francois:session:pickAttachments` | `session_pick_attachments` | `{ sessionId }` | `Attachment[]` (empty ⇒ cancelled) | `SESSION_NOT_FOUND`, `ATTACHMENT_IO_FAILED` |
| `francois:session:releaseAttachment` | `session_release_attachment` | `{ sessionId, attachmentId: string }` | `null` | `SESSION_NOT_FOUND`, `ATTACHMENT_NOT_FOUND` |
| `francois:session:commitAttachments` | `session_commit_attachments` | `{ sessionId, text: string }` | `CommitAttachmentsResult` | `SESSION_NOT_FOUND` |
| `francois:session:clearAttachments` | `session_clear_attachments` | `{ scope: ClearScope }` | `ClearAttachmentsResult` | `SESSION_NOT_FOUND`, `PROJECT_NOT_FOUND` |

`pickAttachments` opens the native dialog **in the core** via `tauri-plugin-dialog` (already a
dependency, already registered in `main.rs`, already granted `dialog:default` in
`capabilities/default.json`) and ingests each pick through the FR-1 pipeline, so the frontend needs
no new npm dependency and stays entirely on `invoke`.

### 5.3 Additions to `contract/common.ts`

Four members appended to `ErrorCode`:

```ts
  | 'ATTACHMENT_TOO_LARGE'    // session-attachments FR-8: over the 10 MiB cap (detail: { bytes, cap })
  | 'ATTACHMENT_IS_DIRECTORY' // session-attachments FR-8: folders are refused, not walked
  | 'ATTACHMENT_NOT_FOUND'    // session-attachments: release addressed an unknown attachment id
  | 'ATTACHMENT_IO_FAILED'    // session-attachments: copy/write/delete failed (detail: { path })
```

## 6. Data & state

**Core.** Per session, a `Vec<Attachment>` held on the session's state and persisted alongside it
(same store as `SessionMeta`), so FR-17's start-up sweep survives a crash. The attachments dir path
is derived, never stored: `<cwd>/.francois/attachments/<first 8 of session id>/`.

**Frontend.** `ConversationView` holds the staged list in component state next to `input`. It is
component-local and the component is keyed by `sessionId`, so a session switch drops it — matching
FR-17, which treats those records as abandoned. Chips are computed from `(input, staged)` on every
render (FR-12); nothing about a chip is stored.

**Short-id collision.** Two sessions in the same cwd sharing an 8-hex-char prefix would share a
folder. Harmless by construction: names are collision-suffixed (FR-7) and FR-16 deletes only the
files a session actually created before trying to remove the dir.

## 7. Edge cases & errors

| situation | behavior |
|---|---|
| Dropped item is a folder | `ATTACHMENT_IS_DIRECTORY`; inline composer error "Folders can't be attached — drop the files instead." No dir is created. |
| File over 10 MiB | `ATTACHMENT_TOO_LARGE`; "That file is 24 MB — the limit is 10 MB." No partial copy is left behind. |
| Multi-file drop, some refused | Successes attach and insert refs; refusals are listed in one composer error line. |
| Target name taken | FR-7 suffix. Never an overwrite, so a ref already sent keeps pointing at the bytes it named. |
| Session cwd is read-only / disk full | `ATTACHMENT_IO_FAILED`; nothing is inserted into the textarea. |
| Session cwd is not a git repo | Works unchanged — `.francois/` is a plain directory and the `.gitignore` is inert. |
| Clipboard has image **and** text | Image wins (FR-14); the text paste is suppressed. |
| Clipboard has no image | Default paste, untouched. Non-negotiable. |
| Picker cancelled | `Ok([])`. No error surface. |
| User deletes a ref by hand after sending | Nothing happens — the attachment is `sent` and the sent transcript already carries the ref. |
| User deletes a staged ref by hand, then sends | FR-15 releases it at commit and deletes the copy. |
| Paste while the session is not running | Same as typing: staging is allowed, sending is gated by the existing composer `disabled` rule. |
| Attachment file deleted outside Francois | The ref reaches Claude and its `Read` fails — Claude reports it. Francois does not pre-validate. |

**Prompt injection.** This is a direct funnel for untrusted file content, and path-insertion
*mitigates* rather than solves it: every read goes through Claude Code's own tooling, so
`permission-guardrails` sees the call and can gate it. Stated as a known property, not a safety claim.

## 8. Design brief

Two new composer affordances and one overlay, all inside the SESSION tab's existing footer row
(`ConversationView.tsx`, the `›` + textarea + hint-span flex row): a `+` button left of the `›`
prompt glyph, a chips row above the textarea, and a full-tab drop overlay on dragover. Tokens come
from `src/styles.css` — `--accent` for the active drop border, `--bg-raised`/`--border` for chips,
`--error` for refusal lines. Chips are ~28px tall with a 22px thumbnail, the filename in
`--text-dim`, and a `×` that brightens to `--text-bright` on hover.

> full brief: `specs/design/session-attachments.md`

## 9. Acceptance criteria

- [ ] Pasting a screenshot writes `pasted-<ts>.png` under `.francois/attachments/<short8>/`, inserts
      its ref at the caret, and renders a thumbnail chip (FR-6, FR-11, FR-12).
- [ ] Pasting text with no image on the clipboard behaves exactly as before (FR-14).
- [ ] Dropping a file already inside the session cwd inserts a relative ref and copies nothing
      (FR-1) — verified by asserting the attachments dir was not created.
- [ ] Dropping a file from outside the cwd copies it in and the ref resolves from the session cwd
      (FR-1, FR-4).
- [ ] In a session running in a git worktree, the file lands under the **worktree**, not the project
      root, and the ref resolves (FR-2 + session-worktree).
- [ ] `.francois/.gitignore` is created with `*`, and `git status` in the repo reports nothing new —
      so `diff-view` shows no attachment noise (FR-3).
- [ ] `+` opens the native multi-select dialog; cancelling returns `Ok([])` and changes nothing
      (FR-9).
- [ ] A 12 MB file is refused with `ATTACHMENT_TOO_LARGE` and leaves no partial copy (FR-8).
- [ ] A dropped folder is refused with `ATTACHMENT_IS_DIRECTORY` (FR-8).
- [ ] Dropping `report.pdf` twice yields `report.pdf` and `report-2.pdf` (FR-7).
- [ ] Deleting a chip's ref text by hand removes the chip; the prompt sent is the textarea verbatim
      (FR-10, FR-12).
- [ ] `×` on a chip removes the ref text and deletes the copied file immediately; an in-place
      (`copied: false`) origin is left on disk (FR-13).
- [ ] Sending with one staged ref deleted from the text marks the kept one `sent` and deletes the
      dropped one's copy (FR-15).
- [ ] Restarting the app deletes files left in `staged` and keeps every `sent` one (FR-17).
- [ ] Deleting a session removes its attachment files and the dir (FR-16).
- [ ] "Clear project attachments" sweeps every session of the project, worktree sessions included,
      and reports the file count (FR-18).

## Remediation

(Empty until a review returns findings.)
