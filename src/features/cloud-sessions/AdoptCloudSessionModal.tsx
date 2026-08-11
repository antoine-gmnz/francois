// cloud-sessions FR-14/FR-15 §8 — the "Adopt cloud session" modal: the whole
// feature's front door, opened from a pane [1] action beside "New session" and
// from ⌘K.
//
// Top to bottom: paste field → session list → landing toggle → project selector
// → Adopt. The PASTE FIELD is the authoritative path (spec §2) and is built to
// read as such: focused on open, full width, and never blocked by the list —
// which is a convenience that degrades to one calm line (FR-17).
//
// Two decisions worth knowing:
//  - The field and the list are ONE value. Clicking (or arrowing onto) a row
//    fills the field; there is no second, competing selection to reconcile.
//  - The core is the authority on what a ref is (FR-3). Adopt only asks for a
//    non-empty ref, so a link shape the CLI learns before Francois does is
//    refused there with an honest INVALID_INPUT rather than greyed out here.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectId } from '../../../contract/common';
import type { CloudDestination, CloudSession } from '../../../contract/cloud-sessions';
import type { ProjectMeta } from '../../../contract/projects';
import { cloudAdopt, cloudResolve, onCloudEvent, projectList, sessionList } from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { ChipGroup, type ChipOption } from '../../ui/ChipGroup';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { safeCall } from '../projects/projects';
import { AdoptPhaseList } from './AdoptPhaseList';
import { CloudSessionList } from './CloudSessionList';
import {
  ADOPT_ONE_WAY_HINT,
  PASTE_PLACEHOLDER,
  adoptRequest,
  canAdopt,
  checkoutWarning,
  isAdoptTerminal,
  parseCloudRef,
  projectAfterResolve,
  type AdoptForm,
  type AdoptProgress,
} from './cloud-sessions';
import { startAdoption } from './adopt-runner';
import { useCloudList } from './useCloudList';
import './cloud-sessions.css';

const LANDING_OPTIONS: ChipOption<CloudDestination>[] = [
  { value: 'worktree', label: 'New worktree' },
  // Destructive: teleport stashes whatever is uncommitted in the checkout.
  { value: 'checkout', label: "This project's checkout", danger: true },
];

/** Debounce before resolving a half-typed ref — one lookup per pause, not per key. */
const RESOLVE_DELAY_MS = 250;

export default function AdoptCloudSessionModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [ref, setRef] = useState('');
  const [projectId, setProjectId] = useState<ProjectId | ''>('');
  const [destination, setDestination] = useState<CloudDestination>('worktree');
  const [confirmed, setConfirmed] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  /** The resolved cloud metadata — only used to name the branch in the confirmation. */
  const [resolved, setResolved] = useState<CloudSession | null>(null);
  const [progress, setProgress] = useState<AdoptProgress | null>(null);
  const [cursor, setCursor] = useState(-1);

  const mounted = useMounted();
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  // A project the user chose by hand always wins over a late `cloud_resolve`
  // match (read through a ref so the resolve effect never closes over a stale
  // value). Held outside state: nothing renders from it.
  const userPickedProject = useRef(false);
  const resolveToken = useRef(0);
  // `onClose` is an inline arrow at the call site, so its identity changes on
  // every App render. Effects below react to what HAPPENED (a ready session, a
  // keypress), never to that identity — so the callback is read through a ref
  // and kept out of their dependency lists.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const list = useCloudList();

  // The registry, for the selector and for naming the project in the checkout
  // confirmation. Failing to read it is not an error state: the selector simply
  // has nothing to offer, and the hint below says what to do about it.
  useEffect(() => {
    void safeCall(projectList()).then((res) => {
      if (mounted.current && res.ok) setProjects(res.data);
    });
  }, [mounted]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // FR-3 (frontend half): resolve the ref as it settles, to pre-select a project
  // quietly. A failed lookup is deliberately silent — resolving is a convenience
  // here too; teleport does its own validation and adoption may well succeed.
  useEffect(() => {
    const id = parseCloudRef(ref);
    resolveToken.current += 1;
    if (id === null) {
      setResolved(null);
      return;
    }
    const token = resolveToken.current;
    const timer = setTimeout(() => {
      void cloudResolve({ ref: ref.trim() })
        .then((res) => {
          if (!mounted.current || token !== resolveToken.current) return; // a later ref won
          // A malformed ok (older core, demo backend) is treated like a failed
          // lookup: no metadata, no crash, and the paste path unaffected.
          if (!res.ok || !res.data?.session) {
            setResolved(null);
            return;
          }
          setResolved(res.data.session);
          setProjectId((current) => projectAfterResolve(current, res.data.matchedProjectId, userPickedProject.current));
        })
        .catch(() => {
          /* the paste path still works — adoption reports the real reason */
        });
    }, RESOLVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ref, mounted]);

  // Memoized so `submit` — and through it the keydown subscription — only changes
  // when a field the request is built from changes.
  const form: AdoptForm = useMemo(
    () => ({ ref, projectId, destination, confirmed }),
    [ref, projectId, destination, confirmed],
  );
  const inFlight = progress !== null && !isAdoptTerminal(progress);
  // §Flows 7: a failure restores the form ABOVE the phase list, ref intact, so a
  // retry costs one click.
  const showForm = progress === null || progress.error !== null;
  const enabled = canAdopt(form) && !inFlight;

  const project = projects.find((p) => p.id === projectId) ?? null;
  // FR-14: quiet when the repo matched, promoted to a visibly-empty required
  // field when it did not.
  const projectRequired = projectId === '' && projects.length > 0;

  const pick = useCallback((session: CloudSession) => {
    setRef(session.id);
    setResolved(session);
  }, []);

  const submit = useCallback(() => {
    if (!enabled) return;
    cancelRef.current?.();
    cancelRef.current = startAdoption({
      request: adoptRequest(form),
      subscribe: onCloudEvent,
      adopt: cloudAdopt,
      onProgress: (p) => {
        if (mounted.current) setProgress(p);
      },
    });
  }, [enabled, form, mounted]);

  // Leaving stops WATCHING the adoption; it does not stop the adoption itself —
  // §5 exposes no cancel channel — so nothing here pretends otherwise. A run
  // that finishes after this still lands in pane [1] through session.meta.
  const close = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    onCloseRef.current();
  }, []);

  useEffect(() => () => cancelRef.current?.(), []);

  // FR-10 landing: the adopted session is an ordinary local session, so it joins
  // the fleet the ordinary way. The meta is pulled once before selecting it —
  // selecting an id the store has never seen paints an empty main pane until the
  // session.meta event happens to arrive.
  const readySessionId = progress?.sessionId ?? null;
  useEffect(() => {
    if (readySessionId === null) return;
    let live = true;
    void sessionList()
      .then((res) => {
        if (!res.ok) return;
        const meta = res.data.find((m) => m.id === readySessionId);
        if (meta) useStore.getState().upsertSession(meta);
      })
      .catch(() => {
        /* the event stream fills it in */
      })
      .finally(() => {
        if (!live) return;
        const st = useStore.getState();
        // split-session FR-8: a new session lands in the FOCUSED pane, like every
        // other "assign a session" path.
        if (st.splitSessionId !== null && st.focusedSide === 'right') st.openInRightPane(readySessionId);
        else st.setActiveSessionId(readySessionId);
        st.setMainTab('session');
        onCloseRef.current();
      });
    return () => {
      live = false;
    };
    // `readySessionId` ALONE: landing is owed to the adoption having finished,
    // once. Listing `onClose` here re-ran the whole thing on any App re-render
    // during the `sessionList()` round-trip — a second fetch, and a second
    // setActiveSessionId/setMainTab/close after the modal had already left.
  }, [readySessionId]);

  // Esc closes (Modal's own closeOnEscape stays off to avoid double-handling),
  // ⏎ submits when Adopt is enabled, ↑/↓ walk the list — which is optional to
  // the flow: everything here is reachable without touching it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'Enter') {
        if (!enabled) return;
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl?.tagName === 'SELECT') return;
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (inFlight || list.sessions.length === 0) return;
        e.preventDefault();
        const next =
          e.key === 'ArrowDown'
            ? Math.min(cursor + 1, list.sessions.length - 1)
            : Math.max(cursor - 1, 0);
        setCursor(next);
        pick(list.sessions[next]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // Explicit deps: with no array this capture-phase window listener was torn
    // down and re-subscribed on EVERY render (every keystroke in the paste
    // field). The three callbacks are memoized above, so it now re-subscribes
    // only when what the handler actually reads changes.
  }, [enabled, inFlight, cursor, list.sessions, submit, close, pick]);

  return (
    <Modal onClose={close} width={480} closeOnEscape={false} closeOnBackdropClick={true}>
      <ModalHeader>
        <span className="cloud-modal__title">
          <span className="cloud-modal__title-mark">›</span> adopt cloud session
        </span>
      </ModalHeader>

      <ModalBody>
        {showForm && (
          <>
            <div>
              <label className="cloud-modal__label" htmlFor="cloud-ref">
                CLOUD SESSION
              </label>
              <input
                id="cloud-ref"
                ref={inputRef}
                className="cloud-modal__field"
                value={ref}
                spellCheck={false}
                autoComplete="off"
                placeholder={PASTE_PLACEHOLDER}
                onChange={(e) => {
                  setRef(e.target.value);
                  setCursor(-1);
                }}
              />
              {/* §7 #8: load-bearing, not a footnote — a user who believes the
                  phone still sees this session loses work believing it. */}
              <div className="cloud-modal__hint">{ADOPT_ONE_WAY_HINT}</div>
            </div>

            <CloudSessionList list={list} selectedId={parseCloudRef(ref)} cursor={cursor} onPick={pick} />

            <div>
              <label className="cloud-modal__label">LANDING</label>
              <div className="cloud-modal__chip-row">
                <ChipGroup
                  options={LANDING_OPTIONS}
                  value={destination}
                  onChange={(value) => {
                    setDestination(value);
                    // A tick belongs to the landing it was given for — switching
                    // away and back must ask again (FR-12).
                    setConfirmed(false);
                  }}
                />
              </div>
              {destination === 'worktree' ? (
                <div className="cloud-modal__hint cloud-modal__hint--below-chips">
                  a fresh worktree off this project, on the cloud session's own branch
                </div>
              ) : (
                <div className="cloud-modal__warning">
                  <div>{checkoutWarning(project?.name ?? 'this project', resolved?.branch ?? null)}</div>
                  <label className="cloud-modal__check">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    I understand — stash and check out
                  </label>
                </div>
              )}
            </div>

            <div>
              <label className="cloud-modal__label" htmlFor="cloud-project">
                PROJECT
              </label>
              <div className="cloud-modal__select">
                <select
                  id="cloud-project"
                  className={
                    projectRequired
                      ? 'cloud-modal__field cloud-modal__field--select cloud-modal__field--required'
                      : 'cloud-modal__field cloud-modal__field--select'
                  }
                  value={projectId}
                  onChange={(e) => {
                    userPickedProject.current = true;
                    setProjectId(e.target.value);
                  }}
                >
                  <option value="">— select a project —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.rootExists ? p.name : `${p.name} (missing)`}
                    </option>
                  ))}
                </select>
                <span className="cloud-modal__select-caret">▾</span>
              </div>
              {projects.length === 0 ? (
                <div className="cloud-modal__hint">
                  an adopted session lands in a project — register one in Projects first
                </div>
              ) : projectRequired ? (
                <div className="cloud-modal__hint">
                  this cloud session's repository matched no project — choose where it lands
                </div>
              ) : (
                project && <div className="cloud-modal__hint">lands in {project.root}</div>
              )}
            </div>
          </>
        )}

        {progress && <AdoptPhaseList progress={progress} />}

        {inFlight && (
          <div className="cloud-modal__hint">
            {/* Honest: §5 has no cancel channel, so leaving stops watching, not adopting. */}
            leaving keeps the adoption running — the session appears in pane [1] when it is ready
          </div>
        )}
      </ModalBody>

      <ModalFooter>
        <div className="cloud-modal__actions">
          <Button variant="ghost" onClick={close}>
            {inFlight ? 'Run in background' : 'Cancel'}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!enabled}>
            {inFlight ? 'Adopting…' : 'Adopt'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}
