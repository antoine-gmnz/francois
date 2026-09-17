import type { SecondaryStep } from '../../../contract/command-palette';
import { sessionModels, sessionSwitchModel } from '../../lib/api';
import { createModelCatalogController } from '../../lib/model-catalog';
import { useStore } from '../../lib/store';
import { showToast, usePaletteState } from './palette';

let stopCurrent: (() => void) | undefined;

/** The palette contract is synchronous; publish the async catalogue into its existing step. */
export function modelCatalogStep(sessionId: string): SecondaryStep | undefined {
  const session = useStore.getState().sessions.find(s => s.id === sessionId);
  if (!session) return;
  stopCurrent?.();
  const controller = createModelCatalogController(sessionModels);
  const accountId = session.accountId;
  let step: SecondaryStep;
  let active = true;
  const makeStep = (): SecondaryStep => {
    const state = controller.getState();
    return {
      placeholder: state.showLoading ? 'Loading models…' : state.error ? "Couldn't load models" : state.catalog?.freshness === 'stale' ? 'Using cached models' : state.catalog?.models.length === 0 ? 'No models available' : 'switch model',
      items: [
        ...(state.catalog?.models ?? []).map(m => ({ id: m.id, label: m.label })),
        { id: '\0refresh', label: state.error ? 'Retry' : 'Refresh models', hint: state.error?.message ?? state.catalog?.warning?.message ?? undefined },
      ],
      onPick: id => {
        if (id === '\0refresh') {
          if (!state.loading) void controller.load(accountId, true);
          else { step = makeStep(); usePaletteState.setState({ secondaryStep: step }); }
          return;
        }
        if (controller.getState().catalog?.models.some(m => m.id === id) && useStore.getState().activeSessionId === sessionId) {
          void sessionSwitchModel(sessionId, id).then(result => { if (!result.ok) showToast(result.error.message, 'error'); }).catch(() => showToast('Could not change model', 'error'));
        }
      },
    };
  };
  void controller.load(accountId);
  step = makeStep();
  const unsubscribe = controller.subscribe(() => {
    if (!active) return;
    step = makeStep();
    usePaletteState.setState({ secondaryStep: step });
  });
  const stop = () => { active = false; controller.cancel(); unsubscribe(); unwatchPalette(); unwatchSession(); };
  const unwatchPalette = usePaletteState.subscribe(state => {
    if (state.secondaryStep !== step) stop();
  });
  const unwatchSession = useStore.subscribe(state => {
    if (state.activeSessionId !== sessionId || state.sessions.find(s => s.id === sessionId)?.accountId !== accountId) {
      stop();
      usePaletteState.getState().popToRoot();
    }
  });
  stopCurrent = stop;
  return step;
}
