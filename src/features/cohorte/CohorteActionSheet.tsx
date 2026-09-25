// cohorte-actions FR-40..FR-43 — one modal for every sheet-backed action
// (frame 36, Figma 219:21379): intake's own form, and the feature-select
// sheets for brainstorm/spec/start. The head, stage strip, Command block and
// footer are shared chrome (SheetShell); each action supplies its own fields.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { COHORTE_FROZEN_STATUSES, COHORTE_SAFE_FEATURE_ID, type CohorteFeatureChoice } from '../../../contract/cohorte-actions';
import { cohorteActionIntake, cohorteFeatures, cohorteStart } from '../../lib/api';
import { useCohorteActionsStore, type CohorteResultEntry } from '../../lib/cohorteActionsStore';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useStore } from '../../lib/store';
import { setDraft, getDraft } from '../../lib/composer-draft';
import { abbreviate, basename } from '../../lib/path';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Switch } from '../../ui/Switch';
import { showToast } from '../../lib/toast';
import { cohorteBrainstormDisplay, cohorteCommandLines, cohorteIntakeDisplay, cohorteSpecDisplay, cohorteStartDisplay } from './command-display';
import { intakeClientError, intakeSeedFromDraft, type IntakeFields } from './intake-validate';
import { openCohorteRun } from './actions';
import { openCohorteTerminal } from './terminal';
import { detectionFor } from './linkage';
import { CASE_INSENSITIVE_FS } from './useCohorte';
import { CohorteMark } from './CohorteParts';
import './cohorte.css';

const STAGES = ['Intake', 'Brainstorm', 'Spec', 'Freeze', 'Run', 'Ship'];
const STAGE_INDEX: Record<string, number> = { intake: 0, brainstorm: 1, spec: 2, start: 4 };

export default function CohorteActionSheet({ home = '' }: { home?: string }): JSX.Element | null {
  const sheet = useCohorteActionsStore((s) => s.sheet);
  const session = useStore((s) => (sheet ? s.sessions.find((x) => x.id === sheet.sessionId) : undefined));
  const root = useCohorteStore((s) => (session ? (detectionFor(s.detections, session.cwd, CASE_INSENSITIVE_FS)?.root ?? null) : null));

  if (!sheet || !session || !root) return null;
  return <SheetBody key={sheet.action + sheet.sessionId} action={sheet.action} sessionId={sheet.sessionId} root={root} home={home} featureId={sheet.featureId} />;
}

function close(): void {
  useCohorteActionsStore.getState().closeSheet();
}

interface SheetBodyProps {
  action: 'intake' | 'brainstorm' | 'spec' | 'start' | 'patch' | 'fleet' | 'audit' | 'retro';
  sessionId: string;
  root: string;
  home: string;
  featureId?: string;
}

function SheetBody({ action, sessionId, root, home, featureId }: SheetBodyProps): JSX.Element | null {
  if (action === 'intake') return <IntakeSheet sessionId={sessionId} root={root} home={home} />;
  if (action === 'brainstorm' || action === 'spec' || action === 'start') {
    return <FeatureSheet action={action} sessionId={sessionId} root={root} home={home} initialFeatureId={featureId} />;
  }
  return null; // patch/fleet/audit/retro never open a sheet (FR-21).
}

// ── shared chrome ────────────────────────────────────────────────────────────

interface SheetShellProps {
  title: string;
  subtitle: string;
  stage: number;
  /** right end of the stage strip: `new feature` or the feature id */
  stageNote: string;
  command: string;
  cwd: string;
  footNote: string;
  primary: { label: string; busy: boolean; disabled: boolean };
  onRun: () => void;
  width: number;
  children: ReactNode;
}

function SheetShell({ title, subtitle, stage, stageNote, command, cwd, footNote, primary, onRun, width, children }: SheetShellProps): JSX.Element {
  const copy = () => {
    void navigator.clipboard.writeText(command).then(
      () => showToast('Command copied', 'success'),
      () => showToast('Could not copy the command', 'error'),
    );
  };
  return (
    <Modal onClose={close} width={width} align="center" closeOnEscape closeOnBackdropClick className="cohorte-sheet-backdrop">
      <div
        className="cohorte-sheet"
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onRun();
          }
        }}
      >
        <header className="cohorte-sheet__head">
          <CohorteMark size={16} />
          <div className="cohorte-sheet__heading">
            <h2 className="cohorte-sheet__title">{title}</h2>
            <p className="cohorte-sheet__subtitle">{subtitle}</p>
          </div>
          <span className="cohorte-spacer" />
          <IconButton title="Close · Esc" size={24} onClick={close}>
            <Icon name="x" />
          </IconButton>
        </header>
        <div className="cohorte-sheet__stages" aria-label="Pipeline stage">
          {STAGES.map((label, i) => (
            <span key={label} className="cohorte-sheet__stage-wrap">
              {i > 0 && <span className="cohorte-sheet__stage-sep" aria-hidden="true">›</span>}
              <span className={i === stage ? 'cohorte-sheet__stage cohorte-sheet__stage--current' : 'cohorte-sheet__stage'} aria-current={i === stage ? 'step' : undefined}>
                {label}
              </span>
            </span>
          ))}
          <span className="cohorte-spacer" />
          <span className="cohorte-sheet__stage-note truncate">{stageNote}</span>
        </div>
        <div className="cohorte-sheet__fields">{children}</div>
        <div className="cohorte-sheet__command">
          <div className="cohorte-sheet__command-head">
            <span className="cohorte-sheet__command-label">Command</span>
            <span className="cohorte-spacer" />
            <span className="cohorte-sheet__command-meta truncate">cwd {cwd}</span>
            <button type="button" className="cohorte-sheet__copy" onClick={copy}>
              copy
            </button>
          </div>
          <pre className="cohorte-sheet__command-line">
            {cohorteCommandLines(command)
              .map((line, i) => (i === 0 ? `$ ${line}` : line))
              .join('\n')}
          </pre>
        </div>
        <footer className="cohorte-sheet__foot">
          <span className="cohorte-sheet__foot-note truncate">{footNote}</span>
          <span className="cohorte-spacer" />
          <Button variant="ghost" onClick={close} shortcut="Esc">
            Cancel
          </Button>
          <Button variant="primary" busy={primary.busy} disabled={primary.disabled} onClick={onRun} shortcut="⌘⏎">
            {primary.label}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

function Field({ label, flag, htmlFor, children }: { label: string; flag?: string; htmlFor?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="cohorte-sheet__field">
      <div className="cohorte-sheet__field-head">
        <label className="cohorte-sheet__label" htmlFor={htmlFor}>
          {label}
        </label>
        <span className="cohorte-spacer" />
        {flag && <span className="cohorte-sheet__flag">{flag}</span>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div className="cohorte-sheet__segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? 'cohorte-sheet__seg cohorte-sheet__seg--sel' : 'cohorte-sheet__seg'}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function ErrorLine({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return (
    <p role="alert" className="cohorte-sheet__error">
      {message}
    </p>
  );
}

// ── intake ───────────────────────────────────────────────────────────────────

function IntakeSheet({ sessionId, root, home }: { sessionId: string; root: string; home: string }): JSX.Element {
  const [sourceKind, setSourceKind] = useState<'text' | 'file' | 'url'>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState(() => intakeSeedFromDraft(getDraft(sessionId)));
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [thenContinue, setThenContinue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // FR-32 flow 2: the draft is cleared only if it was the seed — captured once
  // at mount, not recomputed against a draft the composer could have moved on from.
  const seededFromDraft = useRef(text !== '');

  const fields: IntakeFields = { title, sourceKind, text, path, url };
  const clientError = intakeClientError(fields);
  const req = useMemo(
    () => ({
      root,
      title,
      source: sourceKind === 'text' ? ({ kind: 'text', text } as const) : sourceKind === 'file' ? ({ kind: 'file', path } as const) : ({ kind: 'url', url } as const),
    }),
    [root, title, sourceKind, text, path, url],
  );
  const command = cohorteIntakeDisplay(req);

  const run = async () => {
    setAttempted(true);
    if (busy || clientError) return;
    setBusy(true);
    setError(null);
    const res = await cohorteActionIntake(req);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    if (seededFromDraft.current && sourceKind === 'text') setDraft(sessionId, '');
    const entry: CohorteResultEntry = { id: crypto.randomUUID(), verb: 'intake', at: Date.now(), result: res.data };
    const store = useCohorteActionsStore.getState();
    store.addResult(sessionId, entry);
    store.markNewFeature(res.data.featureId);
    close();
    // A patch triage skips brainstorm and goes straight to its spec.
    if (thenContinue) store.openSheet({ action: res.data.triage === 'patch' ? 'spec' : 'brainstorm', sessionId, featureId: res.data.featureId });
  };

  // Don't greet an empty form with "Title is required": validation shows once
  // the user has typed a title or tried to run.
  const shownError = error ?? (attempted || title !== '' ? clientError : null);

  return (
    <SheetShell
      title="Intake"
      subtitle="Triage anything that arrives into a stored brief"
      stage={STAGE_INDEX.intake}
      stageNote="new feature"
      command={command}
      cwd={abbreviate(root, home)}
      footNote="Output lands in this session as a Cohorte card"
      primary={{ label: 'Run intake', busy, disabled: busy || !!clientError }}
      onRun={() => void run()}
      width={620}
    >
      <Field label="Source">
        <Segmented
          label="Source"
          value={sourceKind}
          options={[['text', 'Text'], ['file', 'File'], ['url', 'URL']] as const}
          onChange={setSourceKind}
        />
      </Field>
      <Field label="Title" flag="--title" htmlFor="cohorte-intake-title">
        <input
          id="cohorte-intake-title"
          className="cohorte-sheet__input"
          value={title}
          maxLength={200}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What arrived, in one line"
        />
      </Field>
      {sourceKind === 'text' && (
        <Field label="Text" flag={seededFromDraft.current ? '--text · from the composer draft' : '--text'} htmlFor="cohorte-intake-text">
          <textarea
            id="cohorte-intake-text"
            className="cohorte-sheet__input cohorte-sheet__input--area"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the ticket, email, thread or stack trace"
          />
        </Field>
      )}
      {sourceKind === 'file' && (
        <Field label="File" flag="--file" htmlFor="cohorte-intake-file">
          <input
            id="cohorte-intake-file"
            className="cohorte-sheet__input cohorte-sheet__input--mono"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/absolute/path/to/brief.md"
          />
        </Field>
      )}
      {sourceKind === 'url' && (
        <Field label="URL" flag="--url" htmlFor="cohorte-intake-url">
          <input
            id="cohorte-intake-url"
            className="cohorte-sheet__input cohorte-sheet__input--mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
          />
        </Field>
      )}
      <Field label="Project" flag="cwd">
        <div className="cohorte-sheet__input cohorte-sheet__input--static" title={root}>
          <span className="cohorte-sheet__project">{basename(root)}</span>
          <span className="cohorte-sheet__project-path truncate">{abbreviate(root, home)}</span>
        </div>
      </Field>
      <div className="cohorte-sheet__then">
        <Switch on={thenContinue} onChange={setThenContinue} label="Continue when the brief is stored" />
        <div className="cohorte-sheet__then-text">
          <span className="cohorte-sheet__then-title">Continue to Brainstorm when the brief is stored</span>
          <span className="cohorte-sheet__then-sub">Opens the next form with the new feature id — Write spec if it triages as a patch</span>
        </div>
      </div>
      <ErrorLine message={shownError} />
    </SheetShell>
  );
}

// ── brainstorm · spec · start ────────────────────────────────────────────────

const FEATURE_COPY = {
  brainstorm: { title: 'Brainstorm', subtitle: 'A persona panel challenges the idea — guided, in a terminal', primary: 'Open in terminal', foot: 'Opens a terminal tab in this session' },
  spec: { title: 'Write spec', subtitle: 'Guide a brief through to an approved, frozen spec — in a terminal', primary: 'Open in terminal', foot: 'Opens a terminal tab in this session' },
  start: { title: 'Start run', subtitle: 'Build → review → fix for a frozen feature', primary: 'Start run', foot: 'Opens the run view once it starts' },
} as const;

function FeatureSheet({
  action,
  sessionId,
  root,
  home,
  initialFeatureId,
}: {
  action: 'brainstorm' | 'spec' | 'start';
  sessionId: string;
  root: string;
  home: string;
  initialFeatureId?: string;
}): JSX.Element {
  const [features, setFeatures] = useState<CohorteFeatureChoice[]>([]);
  const [selected, setSelected] = useState<string>(initialFeatureId ?? '');
  const [newIdea, setNewIdea] = useState(action === 'brainstorm' && !initialFeatureId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void cohorteFeatures(root).then((res) => {
      if (!current || !res.ok) return;
      const list =
        action === 'brainstorm'
          ? res.data.filter((f) => f.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt)
          : action === 'spec'
            ? res.data.filter((f) => !COHORTE_FROZEN_STATUSES.includes(f.status)).sort((a, b) => b.updatedAt - a.updatedAt)
            : res.data.filter((f) => COHORTE_FROZEN_STATUSES.includes(f.status)).sort((a, b) => b.updatedAt - a.updatedAt);
      setFeatures(list);
      if (!initialFeatureId && list[0]) setSelected(list[0].id);
    });
    return () => {
      current = false;
    };
  }, [root, action, initialFeatureId]);

  const featureIdSafe = selected === '' || COHORTE_SAFE_FEATURE_ID.test(selected);
  const usesFeature = !(action === 'brainstorm' && newIdea);
  const command = !usesFeature ? cohorteBrainstormDisplay(null) : action === 'brainstorm' ? cohorteBrainstormDisplay(selected || null) : action === 'spec' ? cohorteSpecDisplay(selected) : cohorteStartDisplay(selected);
  const disabled = busy || (usesFeature && (!selected || !featureIdSafe));

  const run = async () => {
    if (disabled) return;
    if (action === 'start') {
      setBusy(true);
      setError(null);
      const res = await cohorteStart({ root, featureId: selected });
      setBusy(false);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      useCohorteStore.getState().upsertRun(res.data);
      close();
      openCohorteRun(res.data.runId);
      return;
    }
    // brainstorm / spec — FR-20, run in a session shell tab.
    setBusy(true);
    const ok = await openCohorteTerminal(sessionId, command, { execute: true });
    setBusy(false);
    if (ok) close();
  };

  const copy = FEATURE_COPY[action];
  return (
    <SheetShell
      title={copy.title}
      subtitle={copy.subtitle}
      stage={STAGE_INDEX[action]}
      stageNote={usesFeature ? selected || 'no feature' : 'new idea'}
      command={command}
      cwd={abbreviate(root, home)}
      footNote={copy.foot}
      primary={{ label: copy.primary, busy, disabled }}
      onRun={() => void run()}
      width={560}
    >
      {action === 'brainstorm' && (
        <Field label="Start from">
          <Segmented
            label="Start from"
            value={newIdea ? 'new' : 'feature'}
            options={[['feature', 'Existing feature'], ['new', 'New idea']] as const}
            onChange={(v) => setNewIdea(v === 'new')}
          />
        </Field>
      )}
      {usesFeature && (
        <Field label="Feature" flag={action === 'brainstorm' ? '--feature-id' : 'positional'} htmlFor="cohorte-feature-sheet-select">
          <div className="cohorte-sheet__select">
            <select
              id="cohorte-feature-sheet-select"
              className="cohorte-sheet__input"
              value={selected}
              disabled={features.length === 0}
              onChange={(e) => setSelected(e.target.value)}
            >
              {features.length === 0 && <option value="">No eligible features</option>}
              {features.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title} — {f.id}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" className="cohorte-sheet__select-caret" />
          </div>
        </Field>
      )}
      {!usesFeature && <p className="cohorte-sheet__hint">The guided brainstorm asks for the idea itself, in the terminal.</p>}
      <ErrorLine message={!featureIdSafe ? "This feature id can't be passed to a shell safely" : error} />
    </SheetShell>
  );
}
