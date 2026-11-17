// The right-hand session panel — redesign "Graphite & Signal", Figma "Session
// panel" (130:378). A 300px rail beside the main column: a 44px tab strip, then
// the selected section's own body + footer (sections.ts is the registry and says
// how to add one). Shown / hidden with `]`, the session header's panel toggle, or
// the strip's `×`; both the open flag and the tab persist (sessionPanelStore).
//
// The selected tab reads icon + label + count; the others fold to icon + their
// compact figure, exactly as drawn.

import type { SessionMeta } from '../../../contract/common';
import { useStore } from '../../lib/store';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { SidePanelEmpty } from '../../ui/SidePanel';
import { panelContext } from './panel-context';
import { resolveSection, SESSION_PANEL_SECTIONS, type SessionPanelSection } from './sections';
import './session-panel.css';

export default function SessionPanel({ session }: { session: SessionMeta | null }) {
  const tab = useStore((s) => s.sessionPanelTab);
  const setTab = useStore((s) => s.setSessionPanelTab);
  const setShow = useStore((s) => s.setShowSessionPanel);
  const current = resolveSection(SESSION_PANEL_SECTIONS, tab);

  return (
    <aside className="session-panel" aria-label="session panel">
      <div className="session-panel__tabs" role="tablist">
        {SESSION_PANEL_SECTIONS.map((section) => (
          <PanelTab
            key={section.id}
            section={section}
            session={session}
            selected={current?.id === section.id}
            onSelect={() => setTab(section.id)}
          />
        ))}
        <span className="session-panel__spacer" />
        <IconButton size={28} title="Hide the session panel · ]" onClick={() => setShow(false)}>
          <Icon name="x" size={12} />
        </IconButton>
      </div>
      {session && current ? (
        <current.Body key={`${current.id}:${session.id}`} session={session} context={panelContext(session)} />
      ) : (
        <SidePanelEmpty>Select a session to see its changes and activity.</SidePanelEmpty>
      )}
    </aside>
  );
}

function PanelTab({
  section,
  session,
  selected,
  onSelect,
}: {
  section: SessionPanelSection;
  session: SessionMeta | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const Badge = section.Badge;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      title={section.label}
      className={selected ? 'session-panel__tab session-panel__tab--on' : 'session-panel__tab'}
      onClick={onSelect}
    >
      <Icon name={section.icon} size={14} />
      {selected && <span className="session-panel__tab-label">{section.label}</span>}
      {Badge && session && (
        <span className="session-panel__tab-count">
          <Badge session={session} />
        </span>
      )}
    </button>
  );
}
