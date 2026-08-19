// multi-provider-grok FR-20 — the Accounts modal's Grok form.
//
// The same shape as CodexForm, for the same reason: a Grok account is a label
// and a GROK_HOME, and nothing else. There is no base URL to normalize, no key
// to keep out of the store, and nothing to Test — `grok login` is the test,
// and it happens from the row afterwards (FR-21).

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppError } from '../../../contract/common';
import { accountAddGrok } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { Button } from '../../ui/Button';
import './accounts.css';
import { endpointErrorLine, grokAddPayload, grokSaveDisabled } from './accounts';

interface Props {
  onCancel: () => void;
  onSaved: () => void;
}

export function GrokForm({ onCancel, onSaved }: Props) {
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
      const res = await accountAddGrok(grokAddPayload(label));
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
        <label className="acc-endpoint-label" htmlFor="acc-grok-label-input">
          Label
        </label>
        <input
          id="acc-grok-label-input"
          ref={labelRef}
          className="acc-endpoint-input"
          value={label}
          placeholder="SuperGrok"
          onChange={(e) => {
            setLabel(e.target.value);
            setSaveError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !grokSaveDisabled(label, saving)) void save();
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
        <Button variant="primary" onClick={save} disabled={grokSaveDisabled(label, saving)}>
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
