// The pure half of the session panel's Context section (redesign "Graphite &
// Signal", Figma "18 · Panel / Context — MCP down" 134:4077): what a session is
// running WITH — its MCP servers (and a banner for any that are down), its
// skills, its instruction files, and the model/account it runs as. Unit-tested
// in context-section.test.ts.

import type { McpServerInfo, McpStatus, SkillInfo } from '../../../contract/common';
import type { StateKind } from '../../ui/state-kind';

/** The State glyph an MCP row leads with. */
const MCP_GLYPH: Record<McpStatus, StateKind> = {
  connected: 'done',
  connecting: 'running',
  error: 'failed',
  pending: 'approval',
  rejected: 'idle',
  approved: 'pending',
};

export function mcpGlyph(status: McpStatus): StateKind {
  return MCP_GLYPH[status] ?? 'idle';
}

export type NoteTone = 'faint' | 'danger' | 'attention';

/**
 * An MCP row's trailing note. A connected server reads its tool count — the
 * figure the stream reports (it reports no per-server call count); a down one
 * reads `unavailable`, since its reason is in the banner above.
 */
export function mcpNote(server: Pick<McpServerInfo, 'status' | 'toolCount'>): { text: string; tone: NoteTone } {
  switch (server.status) {
    case 'connected': {
      const n = server.toolCount ?? 0;
      return { text: `${n} ${n === 1 ? 'tool' : 'tools'}`, tone: 'faint' };
    }
    case 'connecting':
      return { text: 'connecting', tone: 'faint' };
    case 'pending':
      return { text: 'needs approval', tone: 'attention' };
    case 'rejected':
      return { text: 'not approved', tone: 'faint' };
    case 'approved':
      return { text: 'starts next turn', tone: 'faint' };
    default:
      return { text: 'unavailable', tone: 'danger' };
  }
}

export function downServers(servers: readonly McpServerInfo[]): McpServerInfo[] {
  return servers.filter((s) => s.status === 'error');
}

/** "4 · 1 down", or just "4". */
export function mcpHeading(servers: readonly McpServerInfo[]): string {
  const down = downServers(servers).length;
  return down > 0 ? `${servers.length} · ${down} down` : String(servers.length);
}

/**
 * The banner's sentence: the server's own reason, then what it costs you. The
 * tool count is only said when the core reported one — a server that never
 * connected has none to lose that we know of.
 */
export function downMessage(server: Pick<McpServerInfo, 'errorMessage' | 'toolCount'>): string {
  const raw = server.errorMessage?.trim() || 'It stopped answering';
  const reason = /[.!?]$/.test(raw) ? raw : `${raw}.`;
  const cost =
    server.toolCount && server.toolCount > 0
      ? `Its ${server.toolCount} ${server.toolCount === 1 ? 'tool is' : 'tools are'} unavailable to this session.`
      : 'Its tools are unavailable to this session.';
  return `${reason} ${cost}`;
}

/** Skills split into what the session has installed and what it could enable. */
export function splitSkills(skills: readonly SkillInfo[]): { installed: SkillInfo[]; available: SkillInfo[] } {
  return {
    installed: skills.filter((s) => s.installed),
    available: skills.filter((s) => !s.installed),
  };
}

/** "2 installed · 6 available", zero halves dropped; '' for none at all. */
export function skillsHeading(installed: number, available: number): string {
  const parts: string[] = [];
  if (installed > 0) parts.push(`${installed} installed`);
  if (available > 0) parts.push(`${available} available`);
  return parts.join(' · ');
}

/** "orbit · 142 lines". */
export function instructionNote(rootLeaf: string | null, lines: number): string {
  const count = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  return rootLeaf ? `${rootLeaf} · ${count}` : count;
}

/** "Work · api-default", or just the account when no profile was picked. */
export function accountProfileLine(account: string, profile: string | null | undefined): string {
  return profile ? `${account} · ${profile}` : account;
}

/** The last segment of a path, either separator. */
export function pathLeaf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
