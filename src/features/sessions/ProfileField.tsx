// session-profiles — the New Session modal's PROFILE row (story 2/4). Selecting
// a profile carries its systemPrompt/extraArgs (legacy) or its typed settings
// (pi-migration-rollout: piProfile) silently through to session_create, and
// touches nothing else: a profile carries no model / effort / permission mode,
// because the PROJECT's session defaults own those three. Renders nothing
// until at least one profile exists — the pre-feature form is untouched until
// one is authored.

import type { AccountId } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import type { SessionProfile } from '../../../contract/session-profiles';
import { newSessionProfileOptions } from '../profiles/profiles';
import { profileRuntimeMismatch } from './new-session-form';
import { profileIsRetired } from '../../lib/runtimeCapability';

export interface ProfileFieldProps {
  profiles: SessionProfile[];
  profileId: string;
  onChange: (profileId: string) => void;
  /** pi-migration-rollout §7: the chosen account, to warn on a kind mismatch before submit. */
  accounts?: Account[];
  accountId?: AccountId;
  /** Legacy profile + Pi account only (§7's one documented recovery). */
}

export function ProfileField({ profiles, profileId, onChange, accounts, accountId }: ProfileFieldProps): JSX.Element | null {
  if (profiles.length === 0 && !profileId) return null;
  const selected = profiles.find((p) => p.id === profileId) ?? null;
  const account = accounts && accountId ? (accounts.find((a) => a.id === accountId) ?? null) : null;
  const mismatch = profileRuntimeMismatch(selected, account);
  return (
    <div>
      <label className="new-session-modal__label">PROFILE</label>
      {/* The caret is ours, not the platform's — see __field--select. */}
      <div className="new-session-modal__select">
        <select
          className="new-session-modal__field new-session-modal__field--select"
          value={profileId}
          onChange={(e) => onChange(e.target.value)}
        >
          {!selected && profileId && <option value={profileId} disabled>{profileId} · Unavailable</option>}
          {newSessionProfileOptions(profiles).map((opt) => (
            <option key={opt.value} value={opt.value} disabled={profileIsRetired(profiles.find((p) => p.id === opt.value))}>
              {opt.label}{profileIsRetired(profiles.find((p) => p.id === opt.value)) ? ' · Unavailable' : ''}
            </option>
          ))}
        </select>
        <span className="new-session-modal__select-caret">▾</span>
      </div>
      {/* §2 accepted consequence (FR-23), stated again here — the moment it
          actually applies to this session, not just where it was authored.
          A Pi profile has no systemPrompt field to read at all: its own
          prompt-mode note lives in the mismatch/hint block below instead. */}
      {selected?.kind === 'legacy' && selected.systemPrompt && selected.systemPrompt.trim() !== '' && (
        <div className="new-session-modal__hint">replaces the system prompt — the controls below are unaffected</div>
      )}
      {/* §7: a legacy profile on a Pi account (or the reverse) is refused by
          the core as PROFILE_RUNTIME_MISMATCH — named here before the round
          trip, in the same words the submit banner falls back to if the user
          proceeds anyway. */}
      {mismatch && (
        <div className="new-session-modal__hint new-session-modal__hint--error">
          {mismatch.reason}
        </div>
      )}
    </div>
  );
}
