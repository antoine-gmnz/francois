// pi-provider-auth FR-1/FR-4/FR-5 — the Accounts modal's "+ Add Pi account"
// form: reference an existing, user-owned `PI_CODING_AGENT_DIR`. Unlike
// CodexForm/GrokForm there is no interactive login to follow — registering
// IS pointing at a directory (FR-3), and trusting it is the separate,
// explicit step FR-4 requires because that directory's provider
// configuration can contain executable credential helpers.
//
// The environment (native vs. WSL + distro) is DERIVED from the chosen path
// the same way `useDirectoryPicker` already derives a session's runtime from
// its cwd — a WSL UNC path names its own distro, so this form never asks a
// Windows user to pick it by hand, and every other machine stays native.

import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppError, ClaudeRuntime } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import { accountAddPi, sessionPickDirectory } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { Button } from '../../ui/Button';
import './accounts.css';
import {
  PI_INHERIT_NOTE,
  PI_TRUST_CONSENT,
  piAddPayload,
  piConfigDirError,
  piDeriveEnvironment,
  piEnvironmentLabel,
  piErrorMessage,
  piSaveDisabled,
} from './pi';

export interface PiFormProps {
  onCancel: () => void;
  /** The FRESH full list `account_add_pi` resolved. */
  onSaved: (accounts: Account[]) => void;
}

export function PiForm({ onCancel, onSaved }: PiFormProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [configDir, setConfigDir] = useState('');
  const [runtime, setRuntime] = useState<ClaudeRuntime>('native');
  const [distro, setDistro] = useState('');
  const [inherit, setInherit] = useState(false);
  const [trust, setTrust] = useState(false);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const alive = useMounted();

  const applyConfigDir = (path: string) => {
    setConfigDir(path);
    const derived = piDeriveEnvironment(path);
    setRuntime(derived.runtime);
    setDistro(derived.distro);
    setSaveError(null);
  };

  const browse = async () => {
    if (picking) return;
    setPicking(true);
    const res = await sessionPickDirectory();
    if (!alive.current) return;
    setPicking(false);
    if (!res.ok || res.data === null) return; // cancelled, or a picker failure with nothing to show here
    applyConfigDir(res.data.path);
  };

  const busy = saving || picking;

  const save = () => {
    setSaving(true);
    setSaveError(null);
    void accountAddPi(piAddPayload({ label, configDir, runtime, distro, inheritEnvironmentCredentials: inherit, trustConfiguration: trust }))
      .then((res) => {
        if (!alive.current) return;
        setSaving(false);
        if (res.ok) onSaved(res.data);
        else setSaveError(res.error);
      })
      .catch(() => {
        if (alive.current) {
          setSaving(false);
          setSaveError({ code: 'INTERNAL', message: 'Could not reach the core' });
        }
      });
  };

  const configDirHasError = saveError?.code === 'INVALID_INPUT' && piConfigDirError(configDir) === null;

  return (
    <div className="acc-endpoint-form">
      <div className="acc-endpoint-row">
        <label className="acc-endpoint-label" htmlFor="acc-pi-label-input">
          Label
        </label>
        <input
          id="acc-pi-label-input"
          ref={labelRef}
          className="acc-endpoint-input"
          value={label}
          placeholder="Work Pi"
          onChange={(e) => {
            setLabel(e.target.value);
            setSaveError(null);
          }}
        />
      </div>

      <div className="acc-endpoint-row">
        <label className="acc-endpoint-label" htmlFor="acc-pi-dir-input">
          Configuration directory
        </label>
        <div className="acc-endpoint-key-row">
          <input
            id="acc-pi-dir-input"
            className={`acc-endpoint-input acc-endpoint-input--mono${configDirHasError ? ' acc-endpoint-input--error' : ''}`}
            value={configDir}
            placeholder="~/.pi/agent"
            onChange={(e) => applyConfigDir(e.target.value)}
          />
          <button type="button" className="acc-endpoint-clear-key" disabled={picking} onClick={() => void browse()}>
            {picking ? 'Browsing…' : 'Browse'}
          </button>
        </div>
        <span className="acc-endpoint-hint">{piEnvironmentLabel({ runtime, distro })}</span>
      </div>

      <label className="acc-pi-check-row">
        <input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} />
        <span>Inherit environment credentials</span>
      </label>
      <span className="acc-pi-check-note">{PI_INHERIT_NOTE}</span>

      <label className="acc-pi-check-row">
        <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
        <span>I trust this configuration</span>
      </label>
      <span className="acc-pi-check-note acc-pi-check-note--warn">{PI_TRUST_CONSENT}</span>
      {!trust && <span className="acc-pi-check-note">Saved without trust; you can trust it later from the card.</span>}

      {saveError && (
        <div className="acc-endpoint-result acc-endpoint-result--error" role="status" aria-live="polite">
          {piErrorMessage(saveError)}
        </div>
      )}

      <div className="acc-endpoint-actions">
        <Button
          variant="primary"
          onClick={save}
          disabled={piSaveDisabled(label, configDir, runtime, distro, busy)}
        >
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
