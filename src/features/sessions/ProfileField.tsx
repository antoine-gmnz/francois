// session-profiles — the New Session modal's PROFILE row (story 2/4). Selecting
// a profile carries its systemPrompt/extraArgs silently through to
// session_create, and touches nothing else: a profile carries no model / effort
// / permission mode, because the PROJECT's session defaults own those three.
// Renders nothing until at least one profile exists — the pre-feature form is
// untouched until one is authored.

import { newSessionProfileOptions } from '../profiles/profiles';
import type { SessionProfile } from '../../../contract/session-profiles';

export interface ProfileFieldProps {
  profiles: SessionProfile[];
  profileId: string;
  onChange: (profileId: string) => void;
}

export function ProfileField({ profiles, profileId, onChange }: ProfileFieldProps): JSX.Element | null {
  if (profiles.length === 0) return null;
  const selected = profiles.find((p) => p.id === profileId) ?? null;
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
          actually applies to this session, not just where it was authored. */}
      {selected?.systemPrompt && selected.systemPrompt.trim() !== '' && (
        <div className="new-session-modal__hint">replaces the system prompt — the controls below are unaffected</div>
      )}
    </div>
  );
}
