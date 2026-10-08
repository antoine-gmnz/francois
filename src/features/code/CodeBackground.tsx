// The Code tab's app-wide half, mounted by App whether or not Code is on screen:
// the editor event feed (FR-12), the window close guard and its prompt (FR-13), and
// §7's "root removed while open" — tabs of a vanished project/session close, and
// dirty ones are listed in a "Save all · Discard" prompt first.

import { useEffect, useState } from 'react';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { initCloseGuard, proceedWithClose } from './close-guard';
import { allDirtyTabs, useCodeStore, type DirtyTab } from './codeStore';
import { initCodeEvents } from './codeEvents';
import { rootExists } from './editor-root';
import './code.css';

function DirtyList({ items }: { items: DirtyTab[] }): JSX.Element {
  return (
    <ul className="code-prompt__list">
      {items.map((d) => (
        <li key={`${d.rootKey}::${d.path}`} className="code-prompt__file">
          {d.path}
        </li>
      ))}
    </ul>
  );
}

/** FR-13: closing the window with dirty buffers. */
function ClosePrompt(): JSX.Element | null {
  const open = useCodeStore((s) => s.closePrompt);
  const setOpen = useCodeStore((s) => s.setClosePrompt);
  const tabsByRootKey = useCodeStore((s) => s.tabsByRootKey);
  const rootsByKey = useCodeStore((s) => s.rootsByKey);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!open) return null;
  const dirty = allDirtyTabs({ tabsByRootKey, rootsByKey });
  const cancel = () => {
    setFailed(false);
    setOpen(false);
  };
  const saveAll = async () => {
    setBusy(true);
    const ok = await useCodeStore.getState().saveAll();
    setBusy(false);
    if (!ok) return setFailed(true);
    setOpen(false);
    proceedWithClose();
  };
  const discard = () => {
    setOpen(false);
    proceedWithClose();
  };
  return (
    <Modal onClose={cancel} width={440} align="center" closeOnEscape>
      <ModalHeader>
        <span className="code-prompt__title">Unsaved changes</span>
      </ModalHeader>
      <ModalBody>
        <p className="code-prompt__text">
          {dirty.length === 1 ? 'This file has' : `These ${dirty.length} files have`} unsaved changes. Save before closing?
        </p>
        <DirtyList items={dirty} />
        {failed && <p className="code-prompt__error">Some files could not be saved.</p>}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={discard}>
          Discard
        </Button>
        <Button variant="primary" size="sm" busy={busy} onClick={() => void saveAll()}>
          Save all
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** §7: roots whose project/session went away while tabs were open. */
function useRemovedRoots(): [string[], (rk: string) => void] {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const sessionsHydrated = useStore((s) => s.sessionsHydrated);
  const rootsByKey = useCodeStore((s) => s.rootsByKey);
  const tabsByRootKey = useCodeStore((s) => s.tabsByRootKey);
  const [pending, setPending] = useState<string[]>([]);

  useEffect(() => {
    for (const [rk, root] of Object.entries(rootsByKey)) {
      if (root.kind === 'session' && !sessionsHydrated) continue;
      if (rootExists(root, projects, sessions)) continue;
      const dirty = (tabsByRootKey[rk]?.tabs ?? []).some((t) => t.dirty);
      if (!dirty) useCodeStore.getState().dropRoot(rk);
      else setPending((p) => (p.includes(rk) ? p : [...p, rk]));
    }
  }, [projects, sessions, sessionsHydrated, rootsByKey, tabsByRootKey]);

  return [pending, (rk) => setPending((p) => p.filter((k) => k !== rk))];
}

function RemovedRootPrompt({ rootKey, onDone }: { rootKey: string; onDone: () => void }): JSX.Element {
  const tabsByRootKey = useCodeStore((s) => s.tabsByRootKey);
  const rootsByKey = useCodeStore((s) => s.rootsByKey);
  const [busy, setBusy] = useState(false);
  const dirty = allDirtyTabs({ tabsByRootKey, rootsByKey }).filter((d) => d.rootKey === rootKey);
  const finish = () => {
    useCodeStore.getState().dropRoot(rootKey);
    onDone();
  };
  const saveAll = async () => {
    setBusy(true);
    for (const d of dirty) await useCodeStore.getState().save(d.rootKey, d.path);
    setBusy(false);
    finish();
  };
  return (
    <Modal onClose={finish} width={440} align="center">
      <ModalHeader>
        <span className="code-prompt__title">{rootKey.startsWith('session:') ? 'Session closed' : 'Project removed'}</span>
      </ModalHeader>
      <ModalBody>
        <p className="code-prompt__text">Its open files close. These have unsaved changes:</p>
        <DirtyList items={dirty} />
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={finish}>
          Discard
        </Button>
        <Button variant="primary" size="sm" busy={busy} onClick={() => void saveAll()}>
          Save all
        </Button>
      </ModalFooter>
    </Modal>
  );
}

export default function CodeBackground(): JSX.Element {
  useEffect(() => {
    initCodeEvents();
    initCloseGuard();
  }, []);
  const [removed, resolve] = useRemovedRoots();
  return (
    <>
      <ClosePrompt />
      {removed.length > 0 && <RemovedRootPrompt key={removed[0]} rootKey={removed[0]} onDone={() => resolve(removed[0])} />}
    </>
  );
}
