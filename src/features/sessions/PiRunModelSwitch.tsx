// pi-models-metrics FR-5/FR-6 — the run chip's LIVE Pi model/effort switch.
// Bypasses `session_update_settings` entirely: the Pi adapter's own `.models()`
// always answers empty (session-settings-sheet's batched patch has nothing to
// validate a Pi modelId against), and Pi's connection is live rather than
// respawned per turn, so a model/effort change is its own round trip —
// `session_switch_model`/`session_switch_effort` — not a locally-applied field
// that would silently never reach the runtime.
//
// No optimistic update (FR-5): the picker always reads the session's
// last-CONFIRMED selection off the store (`session.model`/`session.runtimeModel`/
// `session.effort`) — a failed switch leaves those exactly where they were.
// Effort levels come from `session.model.efforts`, which the store clears to
// `undefined` on the `model.changed` projection and only refills once the
// authoritative `session.meta` lands (contract/common.ts `ModelRuntimePayload`
// doc comment) — so there is never a stale effort track rendered in between.

import { useState } from 'react';
import type { RuntimeModelRef, SessionMeta } from '../../../contract/common';
import { modelPickerProviderHeading } from '../../lib/account-selection';
import { sessionSwitchEffort, sessionSwitchRuntimeModel } from '../../lib/api';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { useStore } from '../../lib/store';
import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { PiModelField } from './PiModelField';
import { recordRecentModel } from './runtime-model-favorites';
import { piModelSwitchBlockedReason } from './runtime-metrics';
import { useRuntimeModelCatalog } from './useRuntimeModelCatalog';

export function PiRunModelSwitch({ session }: { session: SessionMeta }): JSX.Element {
  const accounts = useStore((s) => s.accounts);
  const catalog = useRuntimeModelCatalog(session.accountId);
  const [switching, setSwitching] = useState(false);
  const { error, setError, schedule } = useTimedError();

  const blockedReason = piModelSwitchBlockedReason(session);
  const disabled = blockedReason !== null || switching;
  const efforts = session.model.efforts ?? [];

  const runGuarded = async (call: () => ReturnType<typeof sessionSwitchRuntimeModel>) => {
    setSwitching(true);
    setError(null);
    const res = await call();
    setSwitching(false);
    if (!res.ok) {
      setError(res.error.message);
      schedule(() => setError(null), 4000);
    }
    return res;
  };

  const onSelect = async (ref: RuntimeModelRef) => {
    if (disabled) return;
    const res = await runGuarded(() => sessionSwitchRuntimeModel(session.id, ref));
    if (res.ok) recordRecentModel(session.accountId, ref);
  };

  const onEffortChange = async (effort: string) => {
    if (disabled) return;
    await runGuarded(() => sessionSwitchEffort(session.id, effort || null));
  };

  const effortOptions: ChipOption<string>[] = [
    { value: '', label: session.model.defaultEffort ? `Model default · ${session.model.defaultEffort}` : 'Model default' },
    ...efforts.map((e) => ({ value: e, label: e })),
  ];

  return (
    <fieldset disabled={disabled} className="pi-run-model-switch">
      <PiModelField
        accountId={session.accountId}
        catalog={catalog}
        selected={session.runtimeModel}
        onSelect={(ref) => void onSelect(ref)}
        providerHeading={modelPickerProviderHeading(accounts, session.accountId)}
      />
      {efforts.length > 0 && (
        <div>
          <label className="new-session-modal__label">EFFORT</label>
          <div className="new-session-modal__chip-row new-session-modal__chip-row--wrap">
            <ChipGroup options={effortOptions} value={session.effort ?? ''} onChange={(v) => void onEffortChange(v)} />
          </div>
        </div>
      )}
      {(blockedReason || error) && (
        <div className="new-session-modal__hint new-session-modal__hint--below-chips">{error ?? blockedReason}</div>
      )}
    </fieldset>
  );
}
