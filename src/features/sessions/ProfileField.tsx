// session-profiles — the New Session modal's PROFILE row (story 2/4). Selecting
// a profile carries its systemPrompt/extraArgs (legacy) or its typed settings
// (pi-migration-rollout: piProfile) silently through to session_create, and
// touches nothing else: a profile carries no model / effort / permission mode,
// because the PROJECT's session defaults own those three. Renders nothing
// until at least one profile exists — the pre-feature form is untouched until
// one is authored.

import { newSessionProfileOptions } from '../profiles/profiles';
import type { Account } from '../../../contract/multi-account';
import type { AccountId } from '../../../contract/common';
import type { SessionProfile } from '../../../contract/session-profiles';
import { profileRuntimeMismatch } from './new-session-form';
import { Action } from '../../ui/Action';

export interface ProfileFieldProps {
  profiles: SessionProfile[];
  profileId: string;
  onChange: (profileId: string) => void;
  /** pi-migration-rollout §7: the chosen account, to warn on a kind mismatch before submit. */
  accounts?: Account[];
  accountId?: AccountId;
  /** Legacy profile + Pi account only (§7's one documented recovery). */
  onCreatePiCopy?: () => void;
}

export function ProfileField({ profiles, profileId, onChange, accounts, accountId, onCreatePiCopy }: ProfileFieldProps): JSX.Element | null {
  if (profiles.length === 0) return null;
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
          {newSessionProfileOptions(profiles).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
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
      {selected?.kind === 'pi' && !mismatch && (
        <div className="new-session-modal__hint">runs with its own Pi prompt/tool/skill settings — no system prompt override here</div>
      )}
      {/* §7: a legacy profile on a Pi account (or the reverse) is refused by
          the core as PROFILE_RUNTIME_MISMATCH — named here before the round
          trip, in the same words the submit banner falls back to if the user
          proceeds anyway. */}
      {mismatch && (
        <div className="new-session-modal__hint new-session-modal__hint--error">
          {mismatch.reason}
          {mismatch.offerCreatePiCopy && onCreatePiCopy && (
            <>
              {' — '}
              <Action color="var(--text)" hoverColor="var(--accent)" onClick={onCreatePiCopy}>
                Create Pi copy…
              </Action>
            </>
          )}
        </div>
      )}
    </div>
  );
}
