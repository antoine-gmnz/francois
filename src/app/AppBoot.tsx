// Figma "32 · App boot" (172:17271, light twin L32 172:17282) — the whole
// window while the fleet's first hydration is in flight: the mark re-drawing
// itself beside the wordmark, a status line, a Stitch hairline, and a footer
// of what is being restored. App.tsx unmounts it once `sessionsHydrated`
// flips (success or failure — useSessionFleetSync settles it either way).
//
// No 300 ms gate: unlike LoaderPane it covers the shell, so a delayed mount
// would flash the half-hydrated UI first and then cover it.

import { Slabs, Stitch } from '../ui/Loaders';
import { useStore } from '../lib/store';
import './app-boot.css';

export interface AppBootProps {
  appVersion: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export default function AppBoot({ appVersion }: AppBootProps) {
  const projectCount = useStore((s) => s.projects.length);
  const sessionCount = useStore((s) => s.sessions.length);
  const facts = [
    appVersion ? `v${appVersion}` : null,
    projectCount > 0 ? plural(projectCount, 'project') : null,
    sessionCount > 0 ? `${plural(sessionCount, 'session')} restored` : null,
  ].filter((f): f is string => f !== null);

  return (
    // Frameless window: the boot screen hides the app bar, so it is the drag
    // region (native `app-region` on Windows, the attribute on Linux).
    <div className="app-boot" role="status" aria-live="polite" data-tauri-drag-region>
      <div className="app-boot__brand" data-tauri-drag-region>
        <Slabs size={34} label={null} className="app-boot__mark" />
        <span className="app-boot__name">François</span>
      </div>
      <div className="app-boot__status">Warming up the worktrees…</div>
      <Stitch className="app-boot__stitch" />
      {facts.length > 0 && <div className="app-boot__facts">{facts.join('  ·  ')}</div>}
    </div>
  );
}
