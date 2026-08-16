// multi-provider-endpoint FR-13/FR-15/FR-16 — the Accounts modal's endpoint
// form: add a new 'openai-compatible' account, or edit an existing one.
// Design brief §2: opens inline above the list (not a nested dialog), the
// modal's own header/footer stay put.
//
// The key field is `type="password"`, NEVER prefilled (FR-15): its draft
// lives ONLY in this component's own state and is handed straight to
// `invoke` on Test/Save — it is never written into a store, a log, or even
// this component's own derived state beyond the input itself.
//
// Every payload/copy decision is a pure function imported from accounts.ts
// (vitest-covered there); this component is the thin renderer over them,
// matching every other piece of this feature.

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AppError } from '../../../contract/common';
import type { Account, EndpointProbe } from '../../../contract/multi-account';
import { accountAddEndpoint, accountTestEndpoint, accountUpdateEndpoint } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { Button } from '../../ui/Button';
import './accounts.css';
import {
  endpointAddPayload,
  endpointBaseUrlHasError,
  endpointErrorLine,
  endpointKeyPlaceholder,
  endpointProbeSuccessLine,
  endpointSaveDisabled,
  endpointTestPayload,
  endpointUpdatePayload,
  formatModelIds,
  middleTruncate,
} from './accounts';

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; probe: EndpointProbe }
  | { kind: 'error'; error: AppError };

export interface EndpointFormProps {
  /** Present ⇒ editing that account; absent ⇒ adding a new endpoint account. */
  account?: Account;
  onCancel: () => void;
  /** The FRESH full list account_add_endpoint/account_update_endpoint resolved. */
  onSaved: (accounts: Account[]) => void;
}

export function EndpointForm({ account, onCancel, onSaved }: EndpointFormProps): JSX.Element {
  const [label, setLabel] = useState(account?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(account?.endpoint?.baseUrl ?? '');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState(formatModelIds(account?.endpoint?.modelIds));
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const alive = useMounted();

  // Design brief §1 flow: focus lands on Label the moment the form opens.
  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  const hasStoredKey = (account?.endpoint?.hasKey ?? false) && !clearKey;
  const busy = probe.kind === 'testing' || saving;

  // FR-16: any field edit wipes a stale result line — a green from a previous
  // URL must never survive a change.
  const clearResult = () => {
    setProbe({ kind: 'idle' });
    setSaveError(null);
  };

  const onApiKeyChange = (value: string) => {
    setApiKeyDraft(value);
    setClearKey(false); // typing a new key supersedes a pending "Clear key"
    clearResult();
  };

  const onClearKey = () => {
    setApiKeyDraft('');
    setClearKey(true);
    clearResult();
  };

  const runTest = () => {
    setSaveError(null);
    setProbe({ kind: 'testing' });
    const payload = endpointTestPayload(baseUrl.trim(), apiKeyDraft, account?.id);
    void accountTestEndpoint(payload)
      .then((res) => {
        if (!alive.current) return;
        setProbe(res.ok ? { kind: 'ok', probe: res.data } : { kind: 'error', error: res.error });
      })
      .catch(() => {
        if (alive.current) setProbe({ kind: 'error', error: { code: 'INTERNAL', message: 'Could not reach the core' } });
      });
  };

  const save = () => {
    setSaving(true);
    setSaveError(null);
    const req = account
      ? accountUpdateEndpoint(endpointUpdatePayload(account.id, label, baseUrl, apiKeyDraft, clearKey, models))
      : accountAddEndpoint(endpointAddPayload(label, baseUrl, apiKeyDraft, models));
    void req
      .then((res) => {
        if (!alive.current) return;
        setSaving(false);
        // Edge case (§7): a write failure leaves the form open, fields intact.
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

  const resultLine =
    saveError !== null
      ? endpointErrorLine(saveError)
      : probe.kind === 'testing'
        ? 'probing…'
        : probe.kind === 'ok'
          ? endpointProbeSuccessLine(probe.probe)
          : probe.kind === 'error'
            ? endpointErrorLine(probe.error)
            : null;
  const resultTone = saveError !== null || probe.kind === 'error' ? 'error' : probe.kind === 'ok' ? 'ok' : 'dim';
  // Round-2 review MEDIUM: account_test_endpoint can also fail INVALID_INPUT
  // (FR-8), so the Base URL border must fire on that path too, not Save alone.
  const baseUrlHasError = endpointBaseUrlHasError(saveError, probe.kind === 'error' ? probe.error : null);

  return (
    <div className="acc-endpoint-form">
      <div className="acc-endpoint-row">
        <label className="acc-endpoint-label" htmlFor="acc-endpoint-label-input">
          Label
        </label>
        <input
          id="acc-endpoint-label-input"
          ref={labelRef}
          className="acc-endpoint-input"
          value={label}
          placeholder="OpenAI"
          onChange={(e) => {
            setLabel(e.target.value);
            clearResult();
          }}
        />
      </div>

      <div className="acc-endpoint-row">
        <label className="acc-endpoint-label" htmlFor="acc-endpoint-baseurl-input">
          Base URL
        </label>
        <input
          id="acc-endpoint-baseurl-input"
          className={`acc-endpoint-input acc-endpoint-input--mono${
            baseUrlHasError ? ' acc-endpoint-input--error' : ''
          }`}
          value={baseUrl}
          placeholder="https://api.openai.com/v1"
          onChange={(e) => {
            setBaseUrl(e.target.value);
            clearResult();
          }}
        />
        <span className="acc-endpoint-hint">usually ends in /v1</span>
      </div>

      <div className="acc-endpoint-row">
        <label className="acc-endpoint-label" htmlFor="acc-endpoint-key-input">
          API key
        </label>
        <div className="acc-endpoint-key-row">
          <input
            id="acc-endpoint-key-input"
            type="password"
            className="acc-endpoint-input"
            value={apiKeyDraft}
            placeholder={endpointKeyPlaceholder(hasStoredKey)}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          {/* FR-15: absent whenever there is no stored key to clear. */}
          {account?.endpoint?.hasKey && !clearKey && (
            <button type="button" className="acc-endpoint-clear-key" onClick={onClearKey}>
              Clear key
            </button>
          )}
        </div>
      </div>

      <div className="acc-endpoint-row">
        <label className="acc-endpoint-label" htmlFor="acc-endpoint-models-input">
          Models
        </label>
        <input
          id="acc-endpoint-models-input"
          className="acc-endpoint-input acc-endpoint-input--mono"
          value={models}
          placeholder="gpt-4o, gpt-4o-mini"
          onChange={(e) => {
            setModels(e.target.value);
            clearResult();
          }}
        />
        <span className="acc-endpoint-hint">leave empty to use the endpoint's own list</span>
      </div>

      {/* §Accessibility: a polite live region, so a screen reader announces
          the probe outcome without the form needing to steal focus. */}
      <div
        className={`acc-endpoint-result acc-endpoint-result--${resultTone}`}
        role="status"
        aria-live="polite"
        title={resultLine ?? undefined}
      >
        {resultLine !== null ? middleTruncate(resultLine, 70) : null}
      </div>

      <div className="acc-endpoint-actions">
        <Button variant="ghost" onClick={runTest} disabled={busy || baseUrl.trim() === ''}>
          {probe.kind === 'testing' && <Loader2 size={13} strokeWidth={1.75} className="acc-endpoint-spin" />}
          Test
        </Button>
        <Button variant="primary" onClick={save} disabled={endpointSaveDisabled(label, baseUrl, busy)}>
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
