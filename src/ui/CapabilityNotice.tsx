// The disabled-pane treatment (multi-provider-openai FR-20, design brief §1):
// a pane whose capability table entry is `available: false` keeps its normal
// frame and header, and shows this ONE dim line in place of its content —
// left-aligned, vertically centered, wrapping to at most two lines and then
// clipping (the full sentence rides on `title`, per §Resize behaviour). No
// icon, no illustration, no button, no link — a statement, not a call to
// action. Shared across panes [3]-[6] and the slash menu (six call sites);
// the usage bar's off-state (design brief §2) has its own, narrower, treatment.

export interface CapabilityNoticeProps {
  /** Verbatim `CapabilityState.reason` — never reworded here (contract owns the copy). */
  reason: string;
}

export function CapabilityNotice({ reason }: CapabilityNoticeProps): JSX.Element {
  return (
    <div className="capability-notice">
      <span className="capability-notice__text" title={reason}>
        {reason}
      </span>
    </div>
  );
}
