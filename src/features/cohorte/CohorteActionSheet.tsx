// cohorte-actions FR-40..FR-43 — one modal for every sheet-backed action
// (frame 36, Figma 219:21379): intake's own form, and the feature-select
// sheets for brainstorm/spec/start. The head, stage strip, Command block and
// footer are shared chrome (SheetShell); each action supplies its own fields.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { COHORTE_FROZEN_STATUSES, COHORTE_SAFE_FEATURE_ID, type CohorteBrainstormTurn, type CohorteFeatureChoice, type CohorteSpecData, type CohorteSpecRequest } from '../../../contract/cohorte-actions';
import { cohorteActionBrainstorm, cohorteActionBrief, cohorteActionIntake, cohorteActionSpec, cohorteFeatures, cohorteStart } from '../../lib/api';
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
import { brainstormSource, cohorteBrainstormDisplay, cohorteCommandLines, cohorteIntakeDisplay, cohorteSpecDisplay, cohorteStartDisplay } from './command-display';
import { intakeClientError, intakeNextAction, intakeSeedFromDraft, type IntakeFields } from './intake-validate';
import { openCohorteRun } from './actions';
import { openCohorteTerminal } from './terminal';
import { detectionFor } from './linkage';
import { CASE_INSENSITIVE_FS } from './useCohorte';
import { CohorteMark } from './CohorteParts';
import './cohorte.css';

const STAGES = ['Intake', 'Brainstorm', 'Spec', 'Freeze', 'Run', 'Ship'];
const STAGE_INDEX: Record<string, number> = { intake: 0, brainstorm: 1, spec: 2, start: 4 };
const PYTHON_FEATURE_ID = /^[a-z0-9-]{1,80}$/;
const PANEL_NAMES: Record<string, string> = { product: 'Produit', architecture: 'Architecture', ux: 'Expérience', qa: 'Qualité', security: 'Sécurité' };

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
  if (action === 'brainstorm') return <BrainstormSheet sessionId={sessionId} root={root} home={home} initialFeatureId={featureId} />;
  if (action === 'spec') return <SpecSheet sessionId={sessionId} root={root} home={home} initialFeatureId={featureId} />;
  if (action === 'start') {
    return <FeatureSheet action={action} sessionId={sessionId} root={root} home={home} initialFeatureId={featureId} />;
  }
  return null; // patch/fleet/audit/retro never open a sheet (FR-21).
}

function SpecSheet({ sessionId, root, home, initialFeatureId }: { sessionId: string; root: string; home: string; initialFeatureId?: string }): JSX.Element {
  const [features, setFeatures] = useState<CohorteFeatureChoice[]>([]);
  const [selected, setSelected] = useState(initialFeatureId ?? '');
  const [state, setState] = useState<CohorteSpecData | null>(null);
  const [feedback, setFeedback] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [contract, setContract] = useState('');
  const [prepared, setPrepared] = useState<CohorteSpecData['preparation']>(undefined);
  const [candidate, setCandidate] = useState<CohorteSpecData['candidate']>(undefined);
  const [profileSnapshot, setProfileSnapshot] = useState<CohorteSpecData['profile_snapshot']>(undefined);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void cohorteFeatures(root).then(result => {
      if (!active || !result.ok) return;
      const available = result.data.sort((a, b) => b.updatedAt - a.updatedAt);
      setFeatures(available);
      if (!initialFeatureId && available[0]) setSelected(available[0].id);
    });
    return () => { active = false; };
  }, [root, initialFeatureId]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setState(null);
    setError(null);
    setPrepared(undefined);
    setCandidate(undefined);
    setProfileSnapshot(undefined);
    setConfirmed(false);
    void cohorteActionSpec({ root, featureId: selected, action: 'show' }).then(result => {
      if (!active) return;
      if (result.ok) setState(result.data);
      else setError(result.error.message);
    });
    return () => { active = false; };
  }, [root, selected]);

  const proposal = state?.proposal;
  const draft = state?.draft;
  const proposalAccepted = !!draft && !!state?.proposal_ref && state.draft_proposal_ref?.revision === state.proposal_ref.revision;
  const surfaceIds = [...new Set(proposal?.acceptance.map(item => item.surface_id) ?? [])];
  const canPropose = !!selected && !busy && state?.feature_status !== 'frozen' && (proposal ? !!feedback.trim() : !!state);

  const action = async (kind: CohorteSpecRequest['action'], extra: Partial<CohorteSpecRequest> = {}) => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cohorteActionSpec({ root, featureId: selected, action: kind, ...extra });
      if (!result.ok) { setError(result.error.message); return; }
      if (kind === 'prepare') {
        setPrepared(result.data.preparation);
        setCandidate(result.data.candidate);
        setProfileSnapshot(result.data.profile_snapshot);
        setConfirmed(false);
        return;
      }
      const refreshed = await cohorteActionSpec({ root, featureId: selected, action: 'show' });
      if (!refreshed.ok) { setError(refreshed.error.message); return; }
      setState(refreshed.data);
      setPrepared(undefined);
      setCandidate(undefined);
      setProfileSnapshot(undefined);
      setConfirmed(false);
      if (kind === 'propose') setFeedback('');
      if (kind === 'accept') setAnswers({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const accept = () => {
    if (!state?.proposal_ref) return;
    const indexedAnswers = Object.entries(answers).filter(([, value]) => value.trim()).map(([index, value]) => `${index}=${value.trim()}`);
    void action('accept', {
      answers: indexedAnswers,
      ...(contract.trim() ? { contract: contract.trim() } : {}),
      expectProposalRevision: state.proposal_ref.revision,
      expectDraftRevision: draft?.revision ?? 0,
    });
  };

  return <SheetShell
    title="Préparer la spec"
    subtitle="L'équipe propose, vous discutez et validez le contenu exact avant le gel"
    stage={STAGE_INDEX.spec}
    stageNote={selected || 'choisir une fonctionnalité'}
    command={`cohorte spec-session ${selected || 'FEATURE_ID'} ${proposal ? 'propose' : 'show'}`}
    cwd={abbreviate(root, home)}
    footNote={draft ? `Brouillon · révision ${draft.revision}` : proposal ? `Proposition · révision ${state?.proposal_ref?.revision ?? 1}` : 'Aucune spec gelée sans approbation'}
    primary={{ label: busy ? 'L’équipe réfléchit…' : proposal ? 'Envoyer ce retour' : 'Créer une proposition', busy, disabled: !canPropose }}
    onRun={() => void action('propose', proposal ? { message: feedback.trim() } : {})}
    width={760}
  >
    {!initialFeatureId && <Field label="Fonctionnalité" htmlFor="cohorte-spec-feature"><select id="cohorte-spec-feature" className="cohorte-sheet__input" value={selected} onChange={event => { setSelected(event.target.value); setFeedback(''); setAnswers({}); }}>{features.map(feature => <option key={feature.id} value={feature.id}>{feature.title} · {feature.id}</option>)}</select></Field>}
    {state?.feature_status === 'frozen' && <section className="cohorte-preparation__card"><h3>Spec gelée</h3><p>Cette fonctionnalité peut démarrer son run.</p></section>}
    {state?.feature_status === 'frozen' && state.standing_candidates?.map((candidate, index) => <section key={candidate.decision} className="cohorte-preparation__card"><h3>Décision à garder pour le projet ?</h3><p>{candidate.decision}</p><p>Motif : {candidate.reason}</p><Button size="sm" disabled={busy} onClick={() => void action('ratify', { candidateIndex: index + 1 })}>Conserver cette décision</Button></section>)}
    {proposal && <div className="cohorte-spec-conversation">
      {state?.feedback && state.feedback.length > 0 && <section className="cohorte-preparation__card"><h3>Échanges sur la spec</h3>{state.feedback.map((message, index) => <p key={index}>Vous : {message}</p>)}</section>}
      {proposal.response_to_feedback && <section className="cohorte-preparation__card"><h3>Réponse de l’équipe</h3><p>{proposal.response_to_feedback}</p></section>}
      <section className="cohorte-preparation__card"><h3>{proposal.title}</h3><p><strong>Périmètre</strong></p><ul>{proposal.in_scope.map(item => <li key={item}>{item}</li>)}</ul><p><strong>Hors périmètre</strong></p><ul>{proposal.out_of_scope.map(item => <li key={item}>{item}</li>)}</ul></section>
      <section className="cohorte-preparation__card"><h3>Scénarios</h3>{proposal.scenarios.map(item => <p key={item.id}>{item.given} → {item.when} → {item.then}</p>)}</section>
      <section className="cohorte-preparation__card"><h3>Critères vérifiables</h3><ul>{proposal.acceptance.map((item, index) => <li key={index}>{item.statement} <small>· {item.surface_id} · {item.check_id ?? 'revue'}</small></li>)}</ul></section>
      <section className="cohorte-preparation__card"><h3>Tests et risques</h3><p>Tests : {proposal.test_strategy.join(' · ')}</p><p>Erreurs : {proposal.error_cases.join(' · ')}</p><p>Migration : {proposal.migrations}</p><p>Retour arrière : {proposal.rollback}</p></section>
      {proposal.question_suggestions.map((item, index) => <section key={index} className="cohorte-preparation__card"><h3>Décision {index + 1}</h3><p>{item.question}</p><p>Piste de l’équipe : {item.suggestion}</p><p>À vérifier : {item.caveat}</p><Field label="Votre décision" htmlFor={`cohorte-spec-answer-${index}`}><textarea id={`cohorte-spec-answer-${index}`} className="cohorte-sheet__input" value={answers[index + 1] ?? ''} onChange={event => setAnswers(current => ({ ...current, [index + 1]: event.target.value }))} rows={2} /><Button size="sm" onClick={() => setAnswers(current => ({ ...current, [index + 1]: item.suggestion }))}>Choisir cette piste</Button></Field></section>)}
      <Field label="Question, objection ou correction" htmlFor="cohorte-spec-feedback"><textarea id="cohorte-spec-feedback" className="cohorte-sheet__input" value={feedback} onChange={event => setFeedback(event.target.value)} rows={3} maxLength={4000} /></Field>
      {surfaceIds.length > 1 && <Field label="Contrat partagé (chemin dans le projet)" htmlFor="cohorte-spec-contract"><input id="cohorte-spec-contract" className="cohorte-sheet__input" value={contract} onChange={event => setContract(event.target.value)} /></Field>}
      {state?.feature_status !== 'frozen' && !proposalAccepted && <Button size="sm" disabled={busy || (surfaceIds.length > 1 && !contract.trim())} onClick={accept}>Accepter cette proposition comme brouillon</Button>}
    </div>}
    {draft && <section className="cohorte-preparation__card"><h3>Brouillon enregistré</h3><p>{draft.title} · {draft.surfaces.join(', ')}</p>{draft.open_questions.length > 0 ? <p>Questions encore ouvertes : {draft.open_questions.join(' · ')}</p> : <p>Questions tranchées. Le gel peut être préparé.</p>}{state?.feature_status !== 'frozen' && proposalAccepted && state?.draft_current && draft.open_questions.length === 0 && !prepared && <Button size="sm" disabled={busy} onClick={() => void action('prepare')}>Préparer l’approbation</Button>}</section>}
    {prepared && candidate && profileSnapshot && <section className="cohorte-preparation__card"><h3>Approbation exacte</h3><p>Spec : {candidate.title} · révision {candidate.revision}</p><p>{candidate.problem}</p><p>Profil : {state?.profile?.project_id} · révision {state?.profile?.revision}</p><details><summary>Lire la spec complète qui sera figée</summary><pre className="cohorte-spec-snapshot">{JSON.stringify(candidate, null, 2)}</pre></details><details><summary>Lire le profil complet approuvé avec la spec</summary><pre className="cohorte-spec-snapshot">{JSON.stringify(profileSnapshot, null, 2)}</pre></details><p className="cohorte-spec-hash">Spec {prepared.spec_hash}</p><p className="cohorte-spec-hash">Profil {prepared.profile_hash}</p><label className="cohorte-spec-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> J’ai relu cette spec et ce profil ; j’approuve leur gel.</label><Button size="sm" disabled={busy || !confirmed} onClick={() => void action('freeze', { requestId: prepared.request_id, specHash: prepared.spec_hash, profileHash: prepared.profile_hash })}>Approuver et figer</Button></section>}
    {error && <Button size="sm" onClick={() => void openCohorteTerminal(sessionId, `cohorte spec ${selected}`, { execute: false, root })}>Ouvrir le terminal Cohorte</Button>}
    <ErrorLine message={error} />
  </SheetShell>;
}

function BrainstormSheet({ sessionId, root, home, initialFeatureId }: { sessionId: string; root: string; home: string; initialFeatureId?: string }): JSX.Element {
  const [features, setFeatures] = useState<CohorteFeatureChoice[]>([]);
  const [newIdea, setNewIdea] = useState(!initialFeatureId);
  const [idea, setIdea] = useState('');
  const [featureId, setFeatureId] = useState(initialFeatureId ?? '');
  const [turn, setTurn] = useState<CohorteBrainstormTurn | null>(null);
  const [reply, setReply] = useState('');
  const [replyKind, setReplyKind] = useState<'message' | 'answer'>('message');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void cohorteFeatures(root).then(result => {
      if (!active || !result.ok) return;
      const candidates = result.data.filter(feature => feature.status === 'draft' && brainstormSource(feature) !== null);
      setFeatures(candidates);
      if (!initialFeatureId && candidates[0]) setFeatureId(candidates[0].id);
    });
    return () => { active = false; };
  }, [root, initialFeatureId]);

  useEffect(() => {
    if (newIdea || turn || !featureId || brainstormSource(features.find(feature => feature.id === featureId)) !== 'brainstorm') return;
    let active = true;
    void cohorteActionBrief(root, featureId).then(result => {
      if (active && result.ok) setTurn(result.data);
    });
    return () => { active = false; };
  }, [root, newIdea, featureId, features, turn]);

  const suggestedId = idea.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  const selectedId = newIdea && !turn ? (featureId && !features.some(feature => feature.id === featureId) ? featureId : suggestedId) : featureId;
  const source = turn ? 'continue' : newIdea ? undefined : brainstormSource(features.find(feature => feature.id === featureId)) === 'intake' ? 'intake' : 'continue';
  const canSend = !busy && PYTHON_FEATURE_ID.test(selectedId) && (turn ? !!reply.trim() : newIdea ? !!idea.trim() : !!featureId && source !== undefined && (source === 'intake' || !!reply.trim()));

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cohorteActionBrainstorm({
        root,
        featureId: selectedId,
        ...(source ? { source } : { idea: idea.trim() }),
        ...(reply.trim() ? replyKind === 'answer' ? { answer: turn?.brief.synthesis.blocking_questions.length === 1 && !reply.includes(turn.brief.synthesis.blocking_questions[0]) ? `${turn.brief.synthesis.blocking_questions[0]} ${reply.trim()}` : reply.trim() } : { message: reply.trim() } : {}),
      });
      if (!result.ok) { setError(result.error.message); return; }
      setTurn(result.data);
      setFeatureId(result.data.brief.feature_id);
      setReply('');
      setReplyKind('message');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  return <SheetShell
    title="Brainstorm"
    subtitle="Discutez avec les perspectives du projet ; seules vos réponses confirmées deviennent des décisions"
    stage={STAGE_INDEX.brainstorm}
    stageNote={turn?.brief.feature_id ?? (newIdea ? 'nouvelle idée' : featureId)}
    command={turn ? `cohorte brainstorm --continue ${turn.brief.feature_id}` : newIdea ? 'cohorte brainstorm' : cohorteBrainstormDisplay(featureId, brainstormSource(features.find(feature => feature.id === featureId))) ?? 'cohorte brainstorm'}
    cwd={abbreviate(root, home)}
    footNote={turn ? `Brief enregistré · révision ${turn.brief_ref.revision}` : 'Le panel lit le projet en lecture seule'}
    primary={{ label: busy ? 'Le panel réfléchit…' : turn ? 'Envoyer au panel' : 'Lancer le panel', busy, disabled: !canSend }}
    onRun={() => void send()}
    width={760}
  >
    {!turn && <>
      <Segmented label="Source" value={newIdea ? 'new' : 'existing'} options={[["new", "Nouvelle idée"], ["existing", "Reprendre"]] as const} onChange={value => { setNewIdea(value === 'new'); setTurn(null); }} />
      {newIdea ? <>
        <Field label="Idée" htmlFor="cohorte-brainstorm-idea"><textarea id="cohorte-brainstorm-idea" className="cohorte-sheet__input" value={idea} onChange={event => setIdea(event.target.value)} rows={3} maxLength={4000} /></Field>
        <Field label="Identifiant" htmlFor="cohorte-brainstorm-id"><input id="cohorte-brainstorm-id" className="cohorte-sheet__input" value={selectedId} onChange={event => setFeatureId(event.target.value)} /></Field>
      </> : <Field label="Brainstorm à reprendre" htmlFor="cohorte-brainstorm-feature"><select id="cohorte-brainstorm-feature" className="cohorte-sheet__input" value={featureId} onChange={event => { setFeatureId(event.target.value); setTurn(null); }}>{features.map(feature => <option key={feature.id} value={feature.id}>{feature.title} · {feature.id}</option>)}</select></Field>}
    </>}
    {turn && <div className="cohorte-brainstorm-conversation">
      {turn.brief.prior_decisions.length > 0 && <section className="cohorte-preparation__card"><h3>Décisions déjà prises</h3><ul>{turn.brief.prior_decisions.map(decision => <li key={decision}>{decision}</li>)}</ul></section>}
      {(turn.brief.user_messages.length > 0 || turn.brief.user_answers.length > 0) && <section className="cohorte-preparation__card"><h3>Vos échanges</h3>{turn.brief.user_messages.map((message, index) => <p key={`message-${index}`}>Question ou réaction : {message}</p>)}{turn.brief.user_answers.map((answer, index) => <p key={`answer-${index}`}>Décision confirmée : {answer}</p>)}</section>}
      {turn.brief.contributions.map(contribution => <section key={contribution.perspective} className="cohorte-preparation__card"><h3>{PANEL_NAMES[contribution.perspective] ?? contribution.perspective}</h3><p>{contribution.problem}</p>{contribution.alternatives[0] && <p><strong>Proposition :</strong> {contribution.alternatives[0]}</p>}{contribution.disagreements[0] && <p><strong>Objection :</strong> {contribution.disagreements[0]}</p>}{contribution.risks[0] && <p><strong>Risque :</strong> {contribution.risks[0]}</p>}</section>)}
      <section className="cohorte-preparation__card"><h3>Synthèse</h3><p>{turn.brief.synthesis.recommendation}</p>{turn.brief.synthesis.strong_objections.map(objection => <p key={objection}>À discuter : {objection}</p>)}</section>
      {turn.brief.synthesis.question_proposals.map(proposal => <section key={proposal.question} className="cohorte-preparation__card"><p>{proposal.question}</p><p>Produit : {proposal.business_option}</p><p>Code : {proposal.code_option}</p><p>À vérifier : {proposal.caveat}</p><Button size="sm" onClick={() => { setReply(`${proposal.question} ${proposal.business_option}`); setReplyKind('answer'); }}>Confirmer la piste produit</Button> <Button size="sm" onClick={() => { setReply(`${proposal.question} ${proposal.code_option}`); setReplyKind('answer'); }}>Confirmer la piste code</Button></section>)}
    </div>}
    {(turn || !newIdea) && <Field label={replyKind === 'answer' ? 'Décision à confirmer' : 'Question ou réaction'} htmlFor="cohorte-brainstorm-reply"><textarea id="cohorte-brainstorm-reply" className="cohorte-sheet__input" value={reply} onChange={event => { setReply(event.target.value); setReplyKind('message'); }} rows={3} maxLength={4000} /><div className="cohorte-result__actions"><Button size="sm" onClick={() => setReplyKind('message')}>Discuter</Button> <Button size="sm" onClick={() => setReplyKind('answer')}>Confirmer comme décision</Button></div></Field>}
    {turn && <Button size="sm" onClick={() => { close(); useCohorteActionsStore.getState().openSheet({ action: 'spec', sessionId, featureId: turn.brief.feature_id }); }}>Passer à la spec</Button>}
    {error && <Button size="sm" onClick={() => void openCohorteTerminal(sessionId, `cohorte brainstorm${turn ? ` --continue ${turn.brief.feature_id}` : ''}`, { execute: false, root })}>Ouvrir le terminal Cohorte</Button>}
    <ErrorLine message={error} />
  </SheetShell>;
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
    const nextAction = intakeNextAction(res.data);
    if (thenContinue && nextAction) store.openSheet({ action: nextAction, sessionId, featureId: res.data.featureId });
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
          <span className="cohorte-sheet__then-sub">Opens the next form when triage is resolved. Open questions stay in the result card.</span>
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
          ? res.data.filter((f) => f.status === 'draft' && f.kind !== 'questions' && brainstormSource(f) !== null).sort((a, b) => b.updatedAt - a.updatedAt)
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
  const source = brainstormSource(features.find(feature => feature.id === selected));
  const command = !usesFeature ? cohorteBrainstormDisplay(null)! : action === 'brainstorm' ? cohorteBrainstormDisplay(selected || null, source) : action === 'spec' ? cohorteSpecDisplay(selected) : cohorteStartDisplay(selected);
  const disabled = busy || command === null || (usesFeature && (!selected || !featureIdSafe || !features.some(feature => feature.id === selected)));

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
    const ok = await openCohorteTerminal(sessionId, command!, { execute: true, root });
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
      command={command ?? 'Choose a stored intake or brainstorm'}
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
        <Field label="Feature" flag={action === 'brainstorm' ? source === 'brainstorm' ? '--continue' : '--from-intake' : 'positional'} htmlFor="cohorte-feature-sheet-select">
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
