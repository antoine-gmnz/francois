// durable-sessions FR-14 — shown once when a --resume attempt was rejected and
// the core continued on a fresh thread. Dismissible; also cleared automatically
// by the next user turn (see conversation-blocks.ts's session event handlers).

export default function ResumeFailBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="resume-banner">
      <span className="resume-banner__text">previous thread unavailable — continuing fresh</span>
      <span onClick={onDismiss} className="resume-banner__dismiss" title="dismiss">
        ✕
      </span>
    </div>
  );
}
