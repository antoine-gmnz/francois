// The session panel's Context section — redesign "Graphite & Signal", Figma
// "18 · Panel / Context — MCP down" (134:4077, light 142:15063): what the
// focused session is running WITH.
//
//   banner        one per MCP server that is down: its reason, then Retry
//                 (reconnect) and Detach — the two answers the MCP tab offers.
//   MCP SERVERS   every server with a state glyph and its tool count, then
//                 "Attach a server to this session" (the MCP tab's overlay).
//   SKILLS        the installed skills; "Browse N more · run one" opens SKILLS.
//   INSTRUCTIONS  the repo's CLAUDE.md, via the welcome header's repo brief.
//   footer        model · effort · permission mode, account · profile, context.
//
// The MCP settings themselves (approvals, attach form, detail popover) stay in
// the MCP main tab; this is the at-a-glance view.

import { useEffect, useState } from 'react';
import type { McpServerInfo, SessionMeta } from '../../../contract/common';
import type { RepoBrief } from '../../../contract/session-welcome';
import type { SessionPanelSectionProps } from '../../app/session-panel/sections';
import { mcpDetach, mcpReconnect, projectRepoBrief } from '../../lib/api';
import { sessionCapability } from '../../lib/runtimeCapability';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { MeterRow, SidePanelBody, SidePanelEmpty, SidePanelFooter, SidePanelLabel } from '../../ui/SidePanel';
import { StateIcon } from '../../ui/StateIcon';
import { accountDisplayLabel, findAccount } from '../accounts/accounts';
import { runChipParts } from '../sessions/run-chip';
import { skillInvocationLabel, skillRowKey } from '../skills/skills-loaded';
import { useSkillsFeed } from '../skills/useSkillsFeed';
import {
  accountProfileLine,
  downMessage,
  downServers,
  instructionNote,
  mcpGlyph,
  mcpHeading,
  mcpNote,
  pathLeaf,
  skillsHeading,
  splitSkills,
} from './context-section';
import './context-section.css';
import { useSessionMcp } from './useSessionMcp';

/** Installed skills listed before the rest fold into "Browse N more". */
const SKILL_ROWS = 5;

export default function ContextSection({ session, context }: SessionPanelSectionProps) {
  const setMainTab = useStore((s) => s.setMainTab);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const setMcpAttachOpen = useStore((s) => s.setMcpAttachOpen);

  const openTab = (tab: 'mcp' | 'skills') => {
    setFocusedPane('main');
    setMainTab(tab);
  };

  return (
    <>
      <SidePanelBody className="context-section">
        <McpBlock
          session={session}
          onAttach={() => {
            openTab('mcp'); // the attach overlay lives inside the MCP tab
            setMcpAttachOpen(true);
          }}
        />
        <SkillsBlock session={session} onBrowse={() => openTab('skills')} />
        <InstructionsBlock sessionId={session.id} />
      </SidePanelBody>
      <SidePanelFooter>
        <RunFacts session={session} />
        {context && <MeterRow label="Context" fraction={context.fraction} figure={context.figure} />}
      </SidePanelFooter>
    </>
  );
}

// ---------- MCP ----------

function McpBlock({ session, onAttach }: { session: SessionMeta; onAttach: () => void }) {
  const capability = sessionCapability(session, 'mcp');
  const { servers, error, loaded, reload } = useSessionMcp(session.id);
  const down = downServers(servers);

  if (!capability.available) {
    return (
      <>
        <SidePanelLabel>MCP servers</SidePanelLabel>
        <SidePanelEmpty>{capability.reason ?? 'MCP is not available for this session.'}</SidePanelEmpty>
      </>
    );
  }

  return (
    <>
      {down.map((server) => (
        <DownBanner key={server.name} sessionId={session.id} server={server} onSettled={reload} />
      ))}
      <SidePanelLabel count={servers.length > 0 ? mcpHeading(servers) : undefined}>MCP servers</SidePanelLabel>
      {error ? (
        <SidePanelEmpty>Could not list MCP servers: {error.message}</SidePanelEmpty>
      ) : loaded && servers.length === 0 ? (
        <SidePanelEmpty>No MCP servers configured.</SidePanelEmpty>
      ) : (
        servers.map((server) => {
          const note = mcpNote(server);
          return (
            <div key={server.name} className="context-row-wrap">
              <div className="context-row" title={server.errorMessage ?? server.name}>
                <StateIcon kind={mcpGlyph(server.status)} size={12} />
                <span className="context-row__name truncate">{server.name}</span>
                <span className={`context-row__note context-row__note--${note.tone}`}>{note.text}</span>
              </div>
            </div>
          );
        })
      )}
      <button type="button" className="context-link" onClick={onAttach}>
        <Icon name="plus" size={11} />
        Attach a server to this session
      </button>
    </>
  );
}

function DownBanner({ sessionId, server, onSettled }: { sessionId: string; server: McpServerInfo; onSettled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const act = (call: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    void call().then((res) => {
      setBusy(false);
      if (!res.ok) setFailed(res.error?.message ?? 'failed');
      onSettled();
    });
  };

  return (
    <div className="context-down-wrap">
      <div className="context-down" role="alert">
        <div className="context-down__head">
          <span className="context-down__icon">
            <Icon name="warn" size={13} />
          </span>
          <span className="context-down__title">
            <span className="context-down__name">{server.name}</span> is down
          </span>
        </div>
        <p className="context-down__body">{downMessage(server)}</p>
        {failed && <p className="context-down__failed">{failed}</p>}
        <div className="context-down__actions">
          <Button size="sm" variant="primary" disabled={busy} title="Reconnect this server" onClick={() => act(() => mcpReconnect(sessionId, server.name))}>
            Retry
          </Button>
          <Button size="sm" disabled={busy} title="Detach this server from the session" onClick={() => act(() => mcpDetach(sessionId, server.name))}>
            Detach
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------- skills ----------

function SkillsBlock({ session, onBrowse }: { session: SessionMeta; onBrowse: () => void }) {
  const capability = sessionCapability(session, 'skills');
  const { skills, status } = useSkillsFeed(capability.available ? session.id : null);
  const { installed, available } = splitSkills(skills);
  const shown = installed.slice(0, SKILL_ROWS);
  const more = skills.length - shown.length;
  const heading = skillsHeading(installed.length, available.length);

  return (
    <>
      <SidePanelLabel count={heading || undefined}>Skills</SidePanelLabel>
      {!capability.available ? (
        <SidePanelEmpty>{capability.reason ?? 'Skills are not available for this session.'}</SidePanelEmpty>
      ) : status === 'loaded' && skills.length === 0 ? (
        <SidePanelEmpty>No skills found for this session.</SidePanelEmpty>
      ) : (
        shown.map((skill) => (
          <div key={skillRowKey(skill)} className="context-row-wrap">
            <div className="context-row context-row--button" role="button" title={skill.description || skill.name} onClick={onBrowse}>
              <Icon name="spark" size={12} />
              <span className="context-row__name truncate">{skillInvocationLabel(skill)}</span>
              {skill.scope && <span className="context-row__note context-row__note--faint">{skill.scope}</span>}
            </div>
          </div>
        ))
      )}
      {capability.available && skills.length > 0 && (
        <button type="button" className="context-link" onClick={onBrowse}>
          {more > 0 ? `Browse ${more} more · run one` : 'Run one'}
        </button>
      )}
    </>
  );
}

// ---------- instructions ----------

function InstructionsBlock({ sessionId }: { sessionId: string }) {
  const [brief, setBrief] = useState<RepoBrief | null>(null);

  useEffect(() => {
    let live = true;
    setBrief(null);
    void projectRepoBrief(sessionId).then((res) => {
      if (live && res.ok) setBrief(res.data);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (!brief?.claudeMd) return null;
  const root = brief.root ?? null;

  return (
    <>
      <SidePanelLabel>Instructions</SidePanelLabel>
      <div className="context-row-wrap">
        <div className="context-row" title={root ? `${root}/CLAUDE.md` : 'CLAUDE.md'}>
          <Icon name="doc" size={12} />
          <span className="context-row__name truncate">CLAUDE.md</span>
          <span className="context-row__note context-row__note--faint">
            {instructionNote(root ? pathLeaf(root) : null, brief.claudeMd.lines)}
          </span>
        </div>
      </div>
    </>
  );
}

// ---------- footer ----------

function RunFacts({ session }: { session: SessionMeta }) {
  const accounts = useStore((s) => s.accounts);
  const parts = runChipParts(session);
  const account = findAccount(accounts, session.accountId);
  const accountLabel = account ? accountDisplayLabel(account) : session.accountId;

  return (
    <div className="context-facts">
      <div className="context-fact">
        <span className="context-fact__label">Model</span>
        <span className="context-fact__value truncate">
          {parts.model}
          {parts.effort && ` · ${parts.effort}`}
          {' · '}
          <span className={parts.danger ? 'context-fact__danger' : undefined}>{parts.mode}</span>
        </span>
      </div>
      <div className="context-fact">
        <span className="context-fact__label">{session.profile ? 'Account · profile' : 'Account'}</span>
        <span className="context-fact__value truncate">{accountProfileLine(accountLabel, session.profile?.name)}</span>
      </div>
    </div>
  );
}
