// pi-provider-auth remediation — the PTY-login state machine AccountLoginView
// (Claude sign-in) and PiSetupView (Pi's own /login inside a takeover
// terminal) both drove by hand, ~90% identical: subscribe to startLoginFeed
// BEFORE firing the start call (so no byte of the TUI's first frame is
// lost), buffer bytes until the terminal registers its write sink, and guard
// the start call against React 18 StrictMode's mount-effect double-invoke —
// the core allows one login at a time, so a double-fired start would refuse
// its own second call.
//
// `createPtyByteSink`/`shouldStartAttempt` are the pure, framework-free halves
// (testable without a renderer, same split `useElapsedClock`/`useDismiss`/
// `useMounted` already make); `useLoginPty` is the React wrapper that wires
// them to `startLoginFeed` + a caller-supplied `start()`.

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AppError, Result } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import { accountLoginCancel } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { startLoginFeed } from './accounts';

export interface PtyByteSink {
  /** Forwards to the registered writer, or buffers until one registers. */
  write: (data: string) => void;
  /** Registers the terminal's write sink and flushes anything buffered so far. */
  registerWriter: (writer: (data: string) => void) => void;
}

/** The write-buffering half: bytes can arrive before the terminal mounts. */
export function createPtyByteSink(): PtyByteSink {
  let writer: ((data: string) => void) | null = null;
  const pending: string[] = [];
  return {
    write: (data) => {
      if (writer) writer(data);
      else pending.push(data);
    },
    registerWriter: (w) => {
      writer = w;
      for (const chunk of pending.splice(0, pending.length)) w(chunk);
    },
  };
}

/**
 * True (and records `attempt`) the first time this `attempt` is seen; false
 * on a repeat. `startedRef` survives React 18 StrictMode's simulated
 * unmount/remount of the same component instance, which is what makes a
 * doubled mount-effect idempotent — a genuine remount gets a fresh ref and
 * correctly starts again.
 */
export function shouldStartAttempt(startedRef: MutableRefObject<number | null>, attempt: number): boolean {
  if (startedRef.current === attempt) return false;
  startedRef.current = attempt;
  return true;
}

export interface UseLoginPtyOptions {
  /** Starts (or restarts, on retry) the PTY. Called once per `attempt`. */
  start: () => Promise<Result<{ loginId: string }>>;
  /** Hands the live loginId up so the caller's own cancel path can address it. */
  onLoginId: (loginId: string | null) => void;
  /** `account.login.done` for this attempt's loginId. */
  onDone: (account: Account) => void;
  /** `account.login.failed` for this attempt's loginId, or a refused `start()`. */
  onFailed: (error: AppError) => void;
  /** `start()` itself rejecting (e.g. the IPC call throwing). */
  startFailedMessage: string;
}

export interface LoginPtyState {
  /** null until `start()` resolves — the frame shows a "starting…" message. */
  loginId: string | null;
  /** Set once and terminal — the caller renders its own failure view over it. */
  error: AppError | null;
  /** Bump to retry: remounts the terminal (`key={attempt}`) and re-runs `start()`. */
  attempt: number;
  retry: () => void;
  /** Pass straight through as the terminal's `onReady`. */
  registerWriter: (writer: (data: string) => void) => void;
}

export function useLoginPty(options: UseLoginPtyOptions): LoginPtyState {
  const { start, onLoginId, onDone, onFailed, startFailedMessage } = options;
  const [loginId, setLoginId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const alive = useMounted();
  const loginIdRef = useRef<string | null>(null);
  const sinkRef = useRef<PtyByteSink>(createPtyByteSink());
  const startedAttemptRef = useRef<number | null>(null);

  // ONE subscription per attempt, mounted BEFORE `start()` is fired below so
  // no byte of the TUI's first frame is lost. It does not filter on the
  // loginId until one exists — at most one login runs at a time, so anything
  // arriving before the ack belongs to this attempt.
  useEffect(() => {
    const stop = startLoginFeed({
      onData: (id, data) => {
        if (loginIdRef.current !== null && id !== loginIdRef.current) return;
        sinkRef.current.write(data);
      },
      onDone: (id, account) => {
        if (loginIdRef.current !== null && id !== loginIdRef.current) return;
        loginIdRef.current = null;
        onLoginId(null); // the core already killed the PTY — nothing to cancel
        onDone(account);
      },
      onFailed: (id, err) => {
        if (loginIdRef.current !== null && id !== loginIdRef.current) return;
        loginIdRef.current = null;
        onLoginId(null); // the core already killed the PTY (and deleted the dir, if any)
        if (alive.current) {
          setLoginId(null);
          setError(err);
        }
        onFailed(err);
      },
    });
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // At most ONE `start()` per attempt — see `shouldStartAttempt`'s doc above.
  useEffect(() => {
    if (!shouldStartAttempt(startedAttemptRef, attempt)) return;
    setError(null);
    setLoginId(null);
    void start()
      .then((res) => {
        if (!res.ok) {
          if (alive.current) setError(res.error);
          onFailed(res.error);
          return;
        }
        // The view went away while `start()` was in flight. The core still
        // registered a live login, and this is the last reference to its id —
        // dropping it would strand the PTY, so cancel it here instead.
        if (!alive.current) {
          void accountLoginCancel({ loginId: res.data.loginId }).catch(() => {});
          return;
        }
        loginIdRef.current = res.data.loginId;
        onLoginId(res.data.loginId);
        setLoginId(res.data.loginId);
      })
      .catch(() => {
        const err: AppError = { code: 'INTERNAL', message: startFailedMessage };
        if (alive.current) setError(err);
        onFailed(err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  return {
    loginId,
    error,
    attempt,
    retry: () => setAttempt((n) => n + 1),
    registerWriter: (w) => sinkRef.current.registerWriter(w),
  };
}
