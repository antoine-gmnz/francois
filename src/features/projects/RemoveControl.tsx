// projects — ProjectsModal's REMOVE row (FR-36): a confirm-in-place control,
// no separate dialog. Split out of ProjectsModal's `{selected && (...)}`
// block per REFACTOR.md §6c.

import { Action } from './Action';
import { removeConfirmText } from './projects';

export function RemoveControl({
  name,
  confirming,
  onConfirm,
  onCancel,
  onRemove,
}: {
  name: string;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="pj-remove-row">
      {confirming ? (
        <>
          <span className="pj-remove-confirm">{removeConfirmText(name)}</span>
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
