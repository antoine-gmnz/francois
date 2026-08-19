// Shared `window.innerWidth` state (resizable-sidebar FR-14): originally
// AccountChip's own inline copy (kept there to size its status-chip label,
// `statusChipMaxChars`), promoted here now that the roster-width render
// clamp is a second consumer — the shared-hook convention promotes a helper
// on its second call site.

import { useEffect, useState } from 'react';

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}
