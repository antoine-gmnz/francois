// The confirm-in-place Remove control: a quiet right-aligned "Remove" that
// expands into its own confirmation (message + cancel + remove) rather than
// opening a dialog. Destructive, so it never commits on the first click.
//
// Promoted here from src/features/projects/ once ProfilesModal needed the same
// control. The only thing that varies between callers is the confirmation
// sentence, which each feature owns as copy (`removeConfirmText` /
// `removeProfileConfirmText`) and passes in.

import { Action } from './Action';

export function RemoveControl({
  confirmText,
  confirming,
  onConfirm,
  onCancel,
  onRemove,
}: {
  confirmText: string;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="remove-row">
      {confirming ? (
        <>
          <span className="remove-confirm">{confirmText}</span>
          <Action color="var(--text-dim)" hoverColor="var(--text)" onClick={onCancel}>
            cancel
          </Action>
          <Action color="var(--error)" hoverColor="var(--error-bright)" onClick={onRemove}>
            remove
          </Action>
        </>
      ) : (
        <Action color="var(--text-muted)" hoverColor="var(--error)" onClick={onConfirm}>
          Remove
        </Action>
      )}
    </div>
  );
}
