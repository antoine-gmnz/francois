// FR-19 — shown while the transcript is scrolled away from the bottom (not
// pinned); clicking re-pins and scrolls to the latest block.

export default function JumpToLatestChip({ onClick }: { onClick: () => void }) {
  return (
    <div onClick={onClick} className="jump-latest">
      ↓ jump to latest
    </div>
  );
}
