// mcp-panel — pure logic for pane [4] (McpPanel.tsx), extracted so the scope/
// status vocabulary and the attach-request building (registry vs. custom,
// param-template substitution, the name-taken guard) are unit-testable
// without the DOM. Mirrors the `projects.ts` pattern: the component stays a
// thin shell over these functions.

import type { AppError, McpServerInfo, McpStatus } from '../../../contract/common';
import type { McpAttachRequest, McpRegistryEntry } from '../../../contract/mcp-panel';

// ---------- scope vocabulary ----------

export interface ScopeMeta {
  /** Descriptive text shown in the detail popover's SCOPE field. */
  label: string;
  color: string;
}

/** Unifies the old `scopeColor` Record and `scopeText` ternary over the same scopes. */
export const SCOPE_META: Record<string, ScopeMeta> = {
  project: { label: 'project · .mcp.json', color: 'var(--text-dim)' },
  local: { label: 'local · ~/.claude.json', color: 'var(--hue-slate)' },
  user: { label: 'user · global', color: 'var(--text-muted)' },
};

export function scopeText(scope: string): string {
  return SCOPE_META[scope]?.label ?? scope;
}

export function scopeColor(scope: string): string {
  return SCOPE_META[scope]?.color ?? 'var(--text-faint)';
}

// ---------- status vocabulary ----------

export const DOT_COLOR: Record<McpStatus, string> = {
  connected: 'var(--success)',
  connecting: 'var(--warn)',
  error: 'var(--error)',
};

export function dotColor(status: McpStatus): string {
  return DOT_COLOR[status];
}

/** The row/detail-popover secondary text: tool count, handshake notice, or the error message. */
export function detailText(server: McpServerInfo): { text: string; color: string } {
  if (server.status === 'connected') return { text: `${server.toolCount ?? 0} tools`, color: 'var(--text-dim)' };
  if (server.status === 'connecting') return { text: 'handshake…', color: 'var(--text-dim)' };
  return { text: server.errorMessage ?? 'error', color: 'var(--error)' };
}

// ---------- attach request building ----------

export function isNameTaken(name: string, existing: string[]): boolean {
  return existing.includes(name);
}

export interface CustomServerForm {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  url: string;
}

export type AttachRequestResult = { ok: true; request: McpAttachRequest } | { ok: false; error: AppError };

/** AttachOverlay's `custom` branch: a name, plus a command or url depending on transport. */
export function buildCustomAttachRequest(custom: CustomServerForm, existing: string[]): AttachRequestResult {
  const name = custom.name.trim();
  if (!name || isNameTaken(name, existing)) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: isNameTaken(name, existing) ? 'name already exists' : 'name required' },
    };
  }
  return {
    ok: true,
    request: {
      name,
      transport: custom.transport,
      command: custom.transport === 'stdio' ? custom.command.trim() : undefined,
      url: custom.transport === 'http' ? custom.url.trim() : undefined,
    },
  };
}

/** AttachOverlay's registry-entry branch: substitutes non-secret `{param}` tokens; secrets go to `secretParams`. */
export function buildRegistryAttachRequest(
  entry: McpRegistryEntry,
  form: Record<string, string>,
  existing: string[],
): AttachRequestResult {
  if (isNameTaken(entry.name, existing)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: 'name already exists' } };
  }
  const secretParams: Record<string, string> = {};
  let command = entry.commandTemplate ?? '';
  let url = entry.urlTemplate ?? '';
  for (const p of entry.params) {
    const val = form[p.key] ?? '';
    if (p.secret) secretParams[p.key] = val;
    else {
      const token = `{${p.key}}`;
      command = command.split(token).join(val);
      url = url.split(token).join(val);
    }
  }
  return {
    ok: true,
    request: {
      name: entry.name,
      transport: entry.transport,
      command: entry.transport === 'stdio' ? command : undefined,
      url: entry.transport === 'http' ? url : undefined,
      secretParams: Object.keys(secretParams).length ? secretParams : undefined,
      registrySource: entry.name,
    },
  };
}

/** Dispatches to the custom or registry branch — mirrors AttachOverlay's old `submit()`. */
export function buildAttachRequest(
  selected: McpRegistryEntry | 'custom',
  custom: CustomServerForm,
  form: Record<string, string>,
  existing: string[],
): AttachRequestResult {
  return selected === 'custom'
    ? buildCustomAttachRequest(custom, existing)
    : buildRegistryAttachRequest(selected, form, existing);
}

/** The submit button's enabled gate — every required field filled, name not taken. */
export function canSubmitAttach(
  selected: McpRegistryEntry | 'custom' | null,
  custom: CustomServerForm,
  form: Record<string, string>,
  existing: string[],
): boolean {
  if (!selected) return false;
  if (selected === 'custom') {
    const name = custom.name.trim();
    const nameOk = name !== '' && !isNameTaken(name, existing);
    return nameOk && (custom.transport === 'stdio' ? custom.command.trim() !== '' : custom.url.trim() !== '');
  }
  return selected.params.every((p) => !p.required || (form[p.key] ?? '').trim() !== '') && !isNameTaken(selected.name, existing);
}
