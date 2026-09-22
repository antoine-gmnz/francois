// cohorte-integration FR-80..FR-82 — Settings · PROJECT · Cohorte (frames 27
// `158:15589` and 28 `159:15655`). Detected: the detection card with the doctor
// rows, the four Francois-side switches and the read-only gate policy. Not
// detected: the empty state with `Run cohorte init` — the one write Francois
// ever triggers, through the CLI. Francois never writes to .cohorte/ itself.

import { Check, Lock, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { showToast } from '../palette/palette';
import { ensurePolicy } from './actions';
import './cohorte.css';
import { CohorteMark, CohorteStateChip } from './CohorteParts';
import { checkGlyph, COHORTE_DOCS_URL, detectionHead, detectionSegments, doctorChip, pageMode } from './settings';
import { detectProject, useProjectDetection } from './useCohorte';

const SWITCHES: { key: keyof CohortePrefs; title: string; description: string }[] = [
  { key: 'showPanelTab', title: 'Show Cohorte in the session panel', description: 'A fifth panel tab, only in projects where .cohorte/ exists.' },
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
  const mode = pageMode(detection);
  const detected = detection?.state === 'detected';
  const cohorteRoot = detection?.root ?? null;

  useEffect(() => {
    if (root) void detectProject(root);
  }, [root]);

  const runDoctor = () => {
    if (!cohorteRoot) return;
    setDoctorRunning(true);
    void cohorteDoctor({ root: cohorteRoot }).then((res) => {
      setDoctorRunning(false);
      if (res.ok) setDoctor(res.data);
      else showToast(res.error.message, 'error');
    });
  };

  // FR-80: doctor once per page open, policy once per root.
  useEffect(() => {
    setDoctor(null);
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
          {mode === 'not-detected' ? `No .cohorte/ in ${abbreviate(root, home)}` : detection?.dir ? abbreviate(detection.dir, home) : ' '}
        </p>
      </header>
      {mode === 'detected' && detection && (
        <Detected detection={detection} doctor={doctor} doctorRunning={doctorRunning} onDoctor={runDoctor} />
      )}
      {mode === 'not-detected' && detection && <NotDetected detection={detection} root={root} />}
      {mode === 'checking' && <p className="cohorte-settings__foot">Checking for .cohorte/…</p>}
    </div>
  );
}

function Detected({
  detection,
  doctor,
  doctorRunning,
  onDoctor,
}: {
  detection: CohorteDetection;
  doctor: CohorteDoctorReport | null;
  doctorRunning: boolean;
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
                    {i > 0 && <span className="cohorte-detect__sep">  ·  </span>}
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
              Run doctor
            </Button>
          )}
        </div>
        {((doctor?.rows.length ?? 0) > 0 || !detection.hasProjectFile) && (
          <div className="cohorte-detect__checks">
            {!detection.hasProjectFile && (
              <CheckRow status="warning" command=".cohorte/project.yaml missing" summary="run cohorte init" />
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
          <code className="cohorte-policy__hint">cohorte config get</code>
        </div>
        <div className="cohorte-policy__tags">
          {policy ? policy.gatedSteps.map((step) => <Tag key={step}>{step}</Tag>) : <span className="cohorte-policy__none">—</span>}
        </div>
        <p className="cohorte-toggle__description">
          Everything else runs unattended. Policy lives in {policy?.file ?? '.cohorte/config.yaml'} — François reads it, never edits it.
        </p>
      </div>

      <p className="cohorte-settings__foot">François never writes to .cohorte/ — every action here maps to a CLI command.</p>
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
          François looks for a .cohorte/ directory in the project root. Until it exists, the Cohorte tab, the run grouping and the gate inbox stay hidden for this project.
        </p>
        <div className="cohorte-empty__code">
          <div className="cohorte-empty__line">
            <span className="cohorte-empty__prompt">$ </span>
            <span className="cohorte-empty__cmd">cohorte init</span>
            <span className="cohorte-spacer" />
            <span className="cohorte-empty__comment">creates .cohorte/</span>
          </div>
          <div className="cohorte-empty__line">
            <span className="cohorte-empty__prompt">$ </span>
            <span className="cohorte-empty__cmd">cohorte doctor</span>
            <span className="cohorte-spacer" />
            <span className="cohorte-empty__comment">checks runtime + providers</span>
          </div>
        </div>
        <div className="cohorte-empty__actions">
          <Button
            variant="primary"
            disabled={!installed || busy !== null}
            title={installed ? 'Runs cohorte init in the project root' : 'Install Cohorte first: npm i -g cohorte'}
            onClick={init}
          >
            {busy === 'init' && <StateIcon kind="running" size={12} />}
            Run cohorte init
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
