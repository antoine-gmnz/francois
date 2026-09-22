// Run settings popover — redesign "Graphite & Signal", Figma "20 · Run settings
// (model · effort · permissions)" (139:7373; light 142:16053). Opened by the run
// chip in the composer. Three sections in order: Model (one radio row per model
// FAMILY — Opus/Sonnet/… — with a compact segmented version track on the
// selected family, newest version first), Effort (the SELECTED model's own
// levels, in its own section rather than nested in the model row — a model
// with no effort setting still gets the section, with a muted "no effort
// setting" line), then the four permission modes, `bypass` tinted with a line
// saying how long it has been on and in which tree.
//
// Every pick goes through the existing switch verbs (session_switch_model /
// _effort / _permission_mode); the session.meta event that comes back is the
// single update path, so nothing here writes the session into the store. A
// setting the session's runtime cannot change renders disabled, titled with the
// capability's own reason (settingCapability — the same gate the settings
// sheet uses). Response mode is not in the design; it stays in the session
// settings sheet (session header name / palette "Session settings…").

import { useState } from 'react';
import type { ModelInfo, PermissionMode, SessionMeta } from '../../../contract/common';
import { sessionSwitchEffort, sessionSwitchModel, sessionSwitchPermissionMode } from '../../lib/api';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { useModelCatalog } from '../../lib/hooks/useModelCatalog';
import { useMounted } from '../../lib/hooks/useMounted';
import { useTimedError } from '../../lib/hooks/useTimedError';
import { useStore } from '../../lib/store';
import { LoaderCaret } from '../../ui/Loader';
import { Radio } from '../../ui/Radio';
import { Tab, TabGroup } from '../../ui/Tab';
import { effortLevels } from './run-chip';
import { bypassSinceLine, effortSurvivesSwitch, familyNote, groupModelFamilies, permissionRows } from './run-settings';
import { settingCapability } from './session-settings';

type SwitchResult = { ok: true } | { ok: false; error: { message: string } };

export function RunSettingsPopover({
  session,
  onClose,
  position,
}: {
  session: SessionMeta;
  onClose: () => void;
  /** Runtime placement (run-settings.ts `runSettingsPlacement`) — fixed px. */
  position: { right: number; top: number } | null;
}) {
  const [pending, setPending] = useState(false);
  const alive = useMounted();
  const { error, setError, schedule } = useTimedError();
  const project = useStore((s) => s.projects.find((p) => p.id === session.projectId) ?? null);
  const { models } = useModelCatalog(session.accountId);
  // The bypass line reads "On for N min" — keep it current while it is showing.
  useElapsedClock(session.permissionMode === 'bypassPermissions', 30_000);

  // The session's own ModelInfo is always the truth about what is selected; the
  // catalogue may not have resolved yet (or may not list a hand-set id).
  const catalog: ModelInfo[] = models.length > 0 ? models : [session.model];
  const families = groupModelFamilies(catalog);
  const selectedModel = catalog.find((m) => m.id === session.model.id) ?? session.model;
  const levels = effortLevels(selectedModel);
  const modelCap = settingCapability(session, 'modelId');
  const modeCap = settingCapability(session, 'permissionMode');
  const bypassLine = bypassSinceLine(session, Date.now());

  async function run(call: Promise<SwitchResult>): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    const res = await call.catch((): SwitchResult => ({ ok: false, error: { message: 'Could not reach the core' } }));
    if (!alive.current) return false;
    setPending(false);
    if (!res.ok) {
      setError(res.error.message);
      schedule(() => setError(null), 4000);
      return false;
    }
    return true;
  }

  const pickModel = async (model: ModelInfo) => {
    if (!modelCap.available || model.id === session.model.id) return;
    if (!(await run(sessionSwitchModel(session.id, model.id)))) return;
    if (!effortSurvivesSwitch(session.effort, model)) await run(sessionSwitchEffort(session.id, null));
  };

  const pickEffort = (level: string) => {
    if (!modelCap.available) return;
    // Re-picking the level in force hands the model back its own default.
    void run(sessionSwitchEffort(session.id, level === session.effort ? null : level));
  };

  const pickMode = async (mode: PermissionMode) => {
    if (!modeCap.available || mode === session.permissionMode) return;
    if (await run(sessionSwitchPermissionMode(session.id, mode))) onClose();
  };

  return (
    <div
      role="dialog"
      aria-label="Run settings"
      className="run-settings"
      style={position ? { right: position.right, top: position.top } : { visibility: 'hidden' }}
    >
      <div className="run-settings__section">Model</div>
      <div role="radiogroup" aria-label="Model" className="run-settings__group" title={modelCap.available ? undefined : modelCap.reason}>
        {families.map((family) => {
          const selectedVersion = family.versions.find((v) => v.model.id === session.model.id) ?? null;
          const on = selectedVersion !== null;
          const note = familyNote(family, project?.defaults.modelId, session.model.id);
          return (
            <div key={family.family} className={on ? 'run-settings__option run-settings__option--on' : 'run-settings__option'}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!modelCap.available}
                className="run-settings__head"
                onClick={() => void pickModel((selectedVersion ?? family.versions[0]!).model)}
              >
                <Radio on={on} />
                <span className="run-settings__label">{family.family}</span>
                {note && <span className="run-settings__note truncate">{note}</span>}
              </button>
              {on && family.versions.length > 1 && (
                <div className="run-settings__versions">
                  <TabGroup label={`${family.family} version`} className="run-settings__version-track">
                    {family.versions.map((v) => (
                      <Tab key={v.model.id} selected={v.model.id === session.model.id} onSelect={() => void pickModel(v.model)} title={v.model.label}>
                        {v.label}
                      </Tab>
                    ))}
                  </TabGroup>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="run-settings__rule" />
      <div className="run-settings__section">Effort</div>
      <div className="run-settings__group" title={modelCap.available ? undefined : modelCap.reason}>
        <div className="run-settings__effort-row">
          {levels.length > 0 ? (
            <TabGroup label="Effort" className="run-settings__effort-track">
              {levels.map((level) => (
                <Tab
                  key={level}
                  selected={level === (session.effort ?? selectedModel.defaultEffort)}
                  onSelect={() => pickEffort(level)}
                  title={level === session.effort ? `${level} — pick again for the model default` : `Run at ${level} effort`}
                >
                  {level}
                </Tab>
              ))}
            </TabGroup>
          ) : (
            <span className="run-settings__note--muted">This model has no effort setting</span>
          )}
        </div>
      </div>

      <div className="run-settings__rule" />
      <div className="run-settings__section">Permission mode</div>
      <div role="radiogroup" aria-label="Permission mode" className="run-settings__group" title={modeCap.available ? undefined : modeCap.reason}>
        {permissionRows().map((row) => {
          const on = row.mode === session.permissionMode;
          const cls = ['run-settings__option'];
          if (on) cls.push('run-settings__option--selected');
          if (on && row.danger) cls.push('run-settings__option--danger');
          return (
            <div key={row.mode} className={cls.join(' ')}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!modeCap.available}
                className="run-settings__head"
                onClick={() => void pickMode(row.mode)}
              >
                <Radio on={on} />
                <span className="run-settings__label">{row.label}</span>
                <span className="run-settings__note truncate">{row.note}</span>
              </button>
              {on && row.danger && bypassLine && <div className="run-settings__since">{bypassLine}</div>}
            </div>
          );
        })}
      </div>

      <div className="run-settings__footer">
        <span className={error ? 'run-settings__footer-text run-settings__footer-text--error' : 'run-settings__footer-text'}>
          {error ?? (pending ? <LoaderCaret label="applying" /> : 'Applies to this session only')}
        </span>
      </div>
    </div>
  );
}
