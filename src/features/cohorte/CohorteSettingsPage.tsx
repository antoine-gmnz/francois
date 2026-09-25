// cohorte-integration FR-80..FR-82 — Settings · PROJECT · Cohorte (frames 27
// `158:15589` and 28 `159:15655`). Detected: the detection card with the doctor
// rows, the four Francois-side switches and the read-only gate policy. Not
// detected: the empty state offers project registration through the local
// Python service. François does not write Cohorte's state directly.

import { Check, Lock, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CohorteDetection, CohorteDoctorReport, CohortePrefs } from '../../../contract/cohorte-integration';
import { formatRelativeTime } from '../../../contract/fleet-board';
import type { ProjectMeta } from '../../../contract/projects';
import { cohorteDoctor, cohorteInit } from '../../lib/api';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { abbreviate } from '../../lib/path';
import { buttonClassName, Button } from '../../ui/Button';
import { StateIcon } from '../../ui/StateIcon';
import { Switch } from '../../ui/Switch';
import { Tag } from '../../ui/Tag';
import { showToast } from '../../lib/toast';
import { ensurePolicy } from './actions';
import './cohorte.css';
import './cohorte-settings.css';
import { CohorteMark, CohorteStateChip } from './CohorteParts';
import { checkGlyph, COHORTE_DOCS_URL, detectionHead, detectionSegments, doctorChip, doctorErrorNote, doctorResultApplies, pageMode } from './settings';
import { detectProject, useProjectDetection } from './useCohorte';

const SWITCHES: { key: keyof CohortePrefs; title: string; description: string }[] = [
  { key: 'showPanelTab', title: 'Show Cohorte in the session panel', description: 'A fifth panel tab for projects registered with Cohorte.' },
  {
    key: 'gatesInNeedsYou',
    title: 'Surface gates in Needs you',
    description: 'A run waiting on approve or deny arrives in the inbox, like a permission request.',
  },
  {
    key: 'groupSessionsUnderRun',
    title: 'Group sessions under their run',
    description: 'Sessions started by a Cohorte step are nested under the run in the sidebar.',
  },
  { key: 'notifyOnGate', title: 'Notify when a run reaches a gate', description: 'Desktop notification, even when François is in the background.' },
];

/** The nav item's leading mark and trailing dot (FR-80). */
export function CohorteNavDot({ on }: { on: boolean }): JSX.Element {
  return <span className={on ? 'cohorte-nav-dot cohorte-nav-dot--on' : 'cohorte-nav-dot'} aria-label={on ? 'detected' : 'not detected'} />;
}

function ago(then: number, now: number): string {
  const rel = formatRelativeTime(then, now);
  return rel === 'now' ? 'just now' : `${rel} ago`;
}

export default function CohorteSettingsPage({ project, home }: { project: ProjectMeta | null; home: string }): JSX.Element {
  const root = project?.root ?? null;
  const detection = useProjectDetection(root);
  const [doctor, setDoctor] = useState<CohorteDoctorReport | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  // R2-9: a doctor timeout leaves an explanation on the page instead of a toast.
  const [doctorNote, setDoctorNote] = useState<string | null>(null);
  const detectError = useCohorteStore((s) => (root ? (s.detectErrors[root] ?? null) : null));
  const mode = pageMode(detection, detectError);
  const detected = detection?.state === 'detected';
  const cohorteRoot = detection?.root ?? null;

  useEffect(() => {
    if (root) void detectProject(root);
  }, [root]);

  // R-16: a doctor result only lands on the page of the root it ran for.
  const currentRoot = useRef(cohorteRoot);
  currentRoot.current = cohorteRoot;
  const runDoctor = () => {
    if (!cohorteRoot) return;
    const ranFor = cohorteRoot;
    setDoctorRunning(true);
    void cohorteDoctor({ root: ranFor }).then((res) => {
      if (!doctorResultApplies(ranFor, currentRoot.current)) return;
      setDoctorRunning(false);
      if (res.ok) {
        setDoctor(res.data);
        setDoctorNote(null);
        return;
      }
      const note = doctorErrorNote(res.error.code);
      setDoctorNote(note);
      if (!note) showToast(res.error.message, 'error');
    });
  };

  // FR-80: doctor once per page open, policy once per root.
  useEffect(() => {
    setDoctor(null);
    setDoctorNote(null);
    setDoctorRunning(false);
    if (!detected || !cohorteRoot) return;
    runDoctor();
    ensurePolicy(cohorteRoot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, cohorteRoot]);

  if (!project || !root) {
    return <div className="cohorte-settings">Pick a project to see its Cohorte setup.</div>;
  }

  return (
    <div className="cohorte-settings">
      <header className="cohorte-settings__header">
        <span className="cohorte-settings__crumbs">{project.name}  /  Cohorte</span>
        <h1 className="cohorte-settings__heading">
          <CohorteMark size={20} />
          Cohorte
        </h1>
        <p className="cohorte-settings__lede">
          {mode === 'not-detected' ? `Project not registered: ${abbreviate(root, home)}` : abbreviate(root, home)}
        </p>
      </header>
      {mode === 'detected' && detection && (
        <Detected detection={detection} doctor={doctor} doctorRunning={doctorRunning} doctorNote={doctorNote} onDoctor={runDoctor} />
      )}
      {mode === 'not-detected' && detection && <NotDetected detection={detection} root={root} />}
      {mode === 'checking' && <p className="cohorte-settings__foot">Checking the Cohorte service…</p>}
      {mode === 'error' && (
        <div className="cohorte-settings__error">
          <p role="alert" className="cohorte-settings__foot cohorte-settings__foot--danger">
            Couldn't reach the Cohorte service: {detectError}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void detectProject(root, true)}>
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}

function Detected({
  detection,
  doctor,
  doctorRunning,
  doctorNote,
  onDoctor,
}: {
  detection: CohorteDetection;
  doctor: CohorteDoctorReport | null;
  doctorRunning: boolean;
  doctorNote: string | null;
  onDoctor: () => void;
}) {
  const prefs = useCohorteStore((s) => s.prefs);
  const setPref = useCohorteStore((s) => s.setPref);
  const policy = useCohorteStore((s) => (detection.root ? s.policies[detection.root] : undefined));
  const head = detectionHead(detection);
  const chip = doctorRunning ? null : doctorChip(doctor);
  const segments = detectionSegments(detection);
  return (
    <div className="cohorte-settings__form">
      <div className="cohorte-detect">
        <div className="cohorte-detect__head">
          <span className={`cohorte-detect__badge cohorte-detect__badge--${head.tone}`}>
            {head.tone === 'success' ? <Check size={14} /> : head.tone === 'danger' ? <X size={14} /> : <TriangleAlert size={14} />}
          </span>
          <div className="cohorte-detect__text">
            <span className="cohorte-detect__title">{head.title}</span>
            <span className="cohorte-detect__sub">
              {head.hint ? (
                <code>{head.hint}</code>
              ) : (
                segments.map((seg, i) => (
                  <span key={seg}>
                    {i > 0 && <span className="cohorte-detect__sep"> · </span>}
                    <span className={i === 0 ? 'cohorte-detect__seg cohorte-detect__seg--first' : 'cohorte-detect__seg'}>{seg}</span>
                  </span>
                ))
              )}
            </span>
          </div>
          <span className="cohorte-spacer" />
          {chip && <CohorteStateChip label={chip.label} tone={chip.tone} glyph={chip.glyph} />}
          {detection.state === 'detected' && (
            <Button size="sm" variant="secondary" disabled={doctorRunning} onClick={onDoctor}>
              {doctorRunning && <StateIcon kind="running" size={12} />}
              Check service
            </Button>
          )}
        </div>
        {doctorNote && <p className="cohorte-detect__note">{doctorNote}</p>}
        {((doctor?.rows.length ?? 0) > 0 || !detection.hasProjectFile) && (
          <div className="cohorte-detect__checks">
            {!detection.hasProjectFile && (
              <CheckRow status="warning" command="project not registered" summary="Register project" />
            )}
            {doctor?.rows.map((row) => (
              <CheckRow key={row.command} status={row.status} command={row.command} summary={row.summary} title={row.remediation} />
            ))}
          </div>
        )}
      </div>

      {SWITCHES.map((sw) => (
        <div key={sw.key} className="cohorte-toggle">
          <div className="cohorte-toggle__text">
            <span className="cohorte-toggle__title">{sw.title}</span>
            <span className="cohorte-toggle__description">{sw.description}</span>
          </div>
          <Switch on={prefs[sw.key]} label={sw.title} onChange={(on) => setPref(sw.key, on)} />
        </div>
      ))}

      <div className="cohorte-toggle cohorte-toggle--policy">
        <div className="cohorte-policy__head">
          <span className="cohorte-toggle__title">Steps that always ask you first</span>
          <span className="cohorte-spacer" />
          <code className="cohorte-policy__hint">cohorte/1 projects.get</code>
        </div>
        <div className="cohorte-policy__tags">
          {policy ? policy.gatedSteps.map((step) => <Tag key={step}>{step}</Tag>) : <span className="cohorte-policy__none">—</span>}
        </div>
        <p className="cohorte-toggle__description">
          François reads the project policy from {policy?.file ?? 'the Cohorte service'}.
        </p>
      </div>

      <p className="cohorte-settings__foot">François sends project and run actions to the local Cohorte service.</p>
    </div>
  );
}

function CheckRow({ status, command, summary, title }: { status: string; command: string; summary: string; title?: string }) {
  const glyph = checkGlyph(status);
  return (
    <div className="cohorte-check" title={title}>
      <span className={`cohorte-check__glyph cohorte-check__glyph--${glyph}`}>
        {glyph === 'ok' ? <Check size={13} /> : glyph === 'warning' ? <TriangleAlert size={13} /> : glyph === 'error' ? <X size={13} /> : <StateIcon kind="pending" size={13} />}
      </span>
      <span className="cohorte-check__command">{command}</span>
      <span className="cohorte-spacer" />
      <span className="cohorte-check__summary">{summary}</span>
    </div>
  );
}

function NotDetected({ detection, root }: { detection: CohorteDetection; root: string }) {
  const [busy, setBusy] = useState<'init' | 'check' | null>(null);
  const now = useElapsedClock(true, 30_000);
  const installed = detection.cli.installed;

  const init = () => {
    setBusy('init');
    void cohorteInit({ projectRoot: root }).then((res) => {
      setBusy(null);
      if (res.ok) useCohorteStore.getState().setDetection(root, res.data);
      else showToast(res.error.message, 'error');
    });
  };
  const check = () => {
    setBusy('check');
    void detectProject(root, true).then(() => setBusy(null));
  };

  return (
    <div className="cohorte-settings__form cohorte-settings__form--tight">
      <div className="cohorte-empty">
        <span className="cohorte-empty__glyph">
          <CohorteMark size={20} />
        </span>
        <h2 className="cohorte-empty__title">Cohorte is not set up here</h2>
        <p className="cohorte-empty__body">
          François looks for this project in the local Cohorte service. Register it to show runs and requests here.
        </p>
        <div className="cohorte-empty__code">
          <div className="cohorte-empty__line">
            <span className="cohorte-empty__prompt">$ </span>
            <span className="cohorte-empty__cmd">cohorte init</span>
            <span className="cohorte-spacer" />
            <span className="cohorte-empty__comment">registers the project</span>
          </div>
          <div className="cohorte-empty__line">
            <span className="cohorte-empty__prompt">$ </span>
            <span className="cohorte-empty__cmd">cohorte doctor</span>
            <span className="cohorte-spacer" />
            <span className="cohorte-empty__comment">checks service health</span>
          </div>
        </div>
        <div className="cohorte-empty__actions">
          <Button
            variant="primary"
            disabled={!installed || busy !== null}
            title={installed ? 'Registers this project with the Cohorte service' : 'Install the Python Cohorte service first'}
            onClick={init}
          >
            {busy === 'init' && <StateIcon kind="running" size={12} />}
            Register project
          </Button>
          <Button variant="secondary" disabled={busy !== null} onClick={check}>
            Check again
          </Button>
          <a className={buttonClassName('ghost', 'md', false)} href={COHORTE_DOCS_URL} target="_blank" rel="noreferrer">
            Cohorte docs
          </a>
        </div>
        <p className="cohorte-empty__meta">
          Last checked {ago(detection.checkedAt, now)}
          <span className="cohorte-empty__sep">  ·  </span>
          François re-checks on every project switch
        </p>
      </div>

      <div className="cohorte-enables">
        <div className="cohorte-label">WHAT TURNS ON ONCE COHORTE IS THERE</div>
        {[
          ['Cohorte panel tab', 'Phases, steps and the current gate, next to Changes and Activity.'],
          ['Gates in Needs you', 'Approve, send to fix or deny without leaving the inbox.'],
          ['Runs in the sidebar', 'Sessions a run started are grouped under it.'],
        ].map(([title, body]) => (
          <div key={title} className="cohorte-enables__item">
            <Lock size={13} className="cohorte-enables__icon" />
            <div className="cohorte-enables__text">
              <span className="cohorte-enables__title">{title}</span>
              <span className="cohorte-enables__body">{body}</span>
            </div>
          </div>
        ))}
      </div>

      <p className="cohorte-settings__foot">Nothing here changes your project — init is run in your terminal, or from this button.</p>
    </div>
  );
}
