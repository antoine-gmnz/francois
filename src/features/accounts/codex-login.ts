import type { AccountId, AppError } from '../../../contract/common';
import { accountCodexLogin, onAccountEvent } from '../../lib/api';

/** Codex browser login reports its terminal result using the account's id. */
export function startCodexLogin(
  accountId: AccountId,
  handlers: { onError: (error: AppError) => void; onSettled: () => void },
): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  const stop = () => {
    live = false;
    unlisten?.();
    unlisten = undefined;
  };
  const settle = (error?: AppError) => {
    if (!live) return;
    stop();
    if (error) handlers.onError(error);
    handlers.onSettled();
  };
  void (async () => {
    try {
      const unsubscribe = await onAccountEvent((event) => {
        if (event.type === 'account.login.failed' && event.loginId === accountId) settle(event.error);
        else if (event.type === 'account.login.done' && event.loginId === accountId) settle();
      });
      if (!live) { unsubscribe(); return; }
      unlisten = unsubscribe;
      const result = await accountCodexLogin({ accountId });
      if (!result.ok) settle(result.error);
    } catch {
      settle({ code: 'INTERNAL', message: 'Could not reach the core' });
    }
  })();
  return stop;
}
