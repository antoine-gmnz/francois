import { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Attachment } from '../../../contract/session-attachments';
import { attachmentRef } from '../../../contract/session-attachments';
import { truncateMiddle } from './attachments';
import './conversation.css';

// session-attachments design §1 — the staged-image chip. DERIVED, never stored:
// it exists exactly while its `@ref` is in the prompt (FR-12), so the caller
// passes the already-filtered list. `src/ui/Chip.tsx` is a selectable option
// pill and is deliberately NOT reused here (design §1).

/**
 * The image is read off disk through Tauri's asset protocol (design "Data shown":
 * "the thumbnail rendered from `storedPath`"); a failure is a state, not a missing chip.
 *
 * `convertFileSrc` is a pure string builder — it grants nothing. The core (`src-tauri/`)
 * registers the scheme with `app.security.assetProtocol = { enable: true, scope: [] }` in
 * `tauri.conf.json` PLUS the `protocol-asset` cargo feature (the config flag alone does not
 * install the handler). There is no `core:asset` permission in Tauri 2.11 — the protocol is
 * not ACL-gated, and adding one to `capabilities/default.json` fails the build.
 *
 * The static scope is empty on purpose: the core grants it per file at runtime
 * (`attachments/asset_scope.rs` → `allow_file(storedPath)`) for `kind: "image"` records as
 * they are staged, so the webview reaches exactly this run's attached images and nothing else.
 * Thumbnails therefore resolve; the `▣` below is a real failure (file deleted, decode error),
 * not the default. The contract exposes no byte-reading channel, so there is no `invoke` +
 * object URL fallback without a contract change.
 */
function thumbSrc(storedPath: string): string {
  try {
    return convertFileSrc(storedPath);
  } catch {
    return '';
  }
}

export interface AttachmentChipProps {
  attachment: Attachment;
  onRemove: (attachment: Attachment) => void;
}

export default function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const [failed, setFailed] = useState(false);
  const src = failed ? '' : thumbSrc(attachment.storedPath);

  return (
    <span className="attachment-chip" title={attachment.refPath}>
      {src && !failed ? (
        <img className="attachment-chip__thumb" src={src} alt={attachment.name} onError={() => setFailed(true)} />
      ) : (
        <span className="attachment-chip__thumb attachment-chip__thumb--failed" aria-hidden="true">
          ▣
        </span>
      )}
      <span className="attachment-chip__name">{truncateMiddle(attachment.name, 18)}</span>
      <button
        type="button"
        className="attachment-chip__remove"
        aria-label={`Remove ${attachment.name}`}
        title={`Remove ${attachmentRef(attachment)}`}
        onClick={() => onRemove(attachment)}
      >
        ×
      </button>
    </span>
  );
}
