// multi-provider-codex FR-24 — the Accounts modal's Codex form.
//
// Deliberately the smallest form in this feature: a Codex account is a label and
// a CODEX_HOME, and nothing else. There is no base URL to normalize, no key to
// keep out of the store, and nothing to Test — `codex login` is the test, and it
// happens from the row afterwards (FR-25).
//
// Same shape as EndpointForm otherwise: opens inline above the list, reuses that
// form's CSS classes rather than inventing a parallel set, and every decision it
// makes is a pure function from accounts.ts.

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppError } from '../../../contract/common';
import { accountAddCodex } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { Button } from '../../ui/Button';
import './accounts.css';
import { codexAddPayload, codexSaveDisabled, endpointErrorLine } from './accounts';

interface Props {
  onCancel: () => void;
  onSaved: () => void;
}

export function CodexForm({ onCancel, onSaved }: Props) {
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const alive = useMounted();

  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await accountAddCodex(codexAddPayload(label));
      if (!alive.current) return;
      if (res.ok) onSaved();
      else setSaveError(res.error);
    } catch {
      if (alive.current) setSaveError({ code: 'INTERNAL', message: 'Could not reach the core' });
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  const resultLine = saveError !== null ? endpointErrorLine(saveError) : null;

  return (
    <div className="acc-endpoint-form">
      <div className="acc-endpoint-row">
        <label className="acc-endpoint-label" htmlFor="acc-codex-label-input">
          Label
        </label>
        <input
          id="acc-codex-label-input"
          ref={labelRef}
          className="acc-endpoint-input"
          value={label}
          placeholder="ChatGPT"
          onChange={(e) => {
            setLabel(e.target.value);
            setSaveError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !codexSaveDisabled(label, saving)) void save();
          }}
        />
        <span className="acc-endpoint-hint">sign in from the row once it exists</span>
      </div>

      <div
        className={`acc-endpoint-result acc-endpoint-result--${resultLine !== null ? 'error' : 'dim'}`}
        role="status"
        aria-live="polite"
      >
        {resultLine}
      </div>

      <div className="acc-endpoint-actions">
        <Button variant="primary" onClick={save} disabled={codexSaveDisabled(label, saving)}>
          {saving && <Loader2 size={13} strokeWidth={1.75} className="acc-endpoint-spin" />}
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
