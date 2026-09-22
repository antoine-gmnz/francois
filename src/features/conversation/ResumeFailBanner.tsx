// durable-sessions FR-14 — shown when a saved native thread could not be
// resumed. process-session-continuity FR-5: the core fails that turn and keeps
// the anchor — it never continues on a fresh thread. Dismissible; also cleared
// automatically by the next user turn (see conversation-blocks.ts).

export default function ResumeFailBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="resume-banner">
      <span className="resume-banner__text">previous thread unavailable — start a new session to continue</span>
      <button type="button" onClick={onDismiss} className="resume-banner__dismiss" title="dismiss">
        ✕
      </button>
    </div>
  );
}
