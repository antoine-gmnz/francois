// mcp-panel — pure logic tests (scope/status vocabulary + attach-request building).

import { describe, expect, it } from 'vitest';
import type { McpServerInfo } from '../../../contract/common';
import type { McpRegistryEntry } from '../../../contract/mcp-panel';
import {
  buildAttachRequest,
  buildCustomAttachRequest,
  buildRegistryAttachRequest,
  canSubmitAttach,
  detailText,
  dotColor,
  isNameTaken,
  scopeColor,
  scopeText,
  type CustomServerForm,
} from './mcp';

const baseCustom: CustomServerForm = { name: '', transport: 'stdio', command: '', url: '' };

const registryEntry: McpRegistryEntry = {
  name: 'github',
  description: 'GitHub MCP server',
  transport: 'stdio',
  commandTemplate: 'gh-mcp --token {token} --org {org}',
  params: [
    { key: 'token', label: 'TOKEN', required: true, secret: true },
    { key: 'org', label: 'ORG', required: false },
  ],
};

describe('scopeText / scopeColor', () => {
  it('maps known scopes to their descriptive label and color', () => {
    expect(scopeText('project')).toBe('project · .mcp.json');
    expect(scopeText('local')).toBe('local · ~/.claude.json');
    expect(scopeText('user')).toBe('user · global');
    expect(scopeColor('project')).toBe('var(--text-dim)');
    expect(scopeColor('local')).toBe('var(--hue-slate)');
    expect(scopeColor('user')).toBe('var(--text-muted)');
  });

  it('falls back to the raw scope / faint color for an unknown scope', () => {
    expect(scopeText('mystery')).toBe('mystery');
    expect(scopeColor('mystery')).toBe('var(--text-faint)');
  });
});

describe('dotColor', () => {
  it('maps every McpStatus to its dot color', () => {
    expect(dotColor('connected')).toBe('var(--success)');
    expect(dotColor('connecting')).toBe('var(--warn)');
    expect(dotColor('error')).toBe('var(--error)');
  });
});

describe('detailText', () => {
  it('connected: tool count, dim color', () => {
    const server: McpServerInfo = { name: 's', status: 'connected', toolCount: 4 };
    expect(detailText(server)).toEqual({ text: '4 tools', color: 'var(--text-dim)' });
  });

  it('connected with no toolCount defaults to 0', () => {
    const server: McpServerInfo = { name: 's', status: 'connected' };
    expect(detailText(server)).toEqual({ text: '0 tools', color: 'var(--text-dim)' });
  });

  it('connecting: handshake notice, dim color', () => {
    const server: McpServerInfo = { name: 's', status: 'connecting' };
    expect(detailText(server)).toEqual({ text: 'handshake…', color: 'var(--text-dim)' });
  });

  it('error: error message, error color', () => {
    const server: McpServerInfo = { name: 's', status: 'error', errorMessage: 'timeout' };
    expect(detailText(server)).toEqual({ text: 'timeout', color: 'var(--error)' });
  });

  it('error with no message falls back to "error"', () => {
    const server: McpServerInfo = { name: 's', status: 'error' };
    expect(detailText(server)).toEqual({ text: 'error', color: 'var(--error)' });
  });
});

describe('isNameTaken', () => {
  it('true only for an exact existing name', () => {
    expect(isNameTaken('github', ['github', 'slack'])).toBe(true);
    expect(isNameTaken('gitlab', ['github', 'slack'])).toBe(false);
  });
});

describe('buildCustomAttachRequest', () => {
  it('requires a name', () => {
    const result = buildCustomAttachRequest({ ...baseCustom, command: 'foo' }, []);
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'name required' } });
  });

  it('rejects a name already in use', () => {
    const result = buildCustomAttachRequest({ ...baseCustom, name: 'github', command: 'foo' }, ['github']);
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'name already exists' } });
  });

  it('builds a stdio request with the command, trimmed', () => {
    const result = buildCustomAttachRequest({ ...baseCustom, name: ' my-server ', command: ' run.sh ' }, []);
    expect(result).toEqual({
      ok: true,
      request: { name: 'my-server', transport: 'stdio', command: 'run.sh', url: undefined },
    });
  });

  it('builds an http request with the url, trimmed', () => {
    const result = buildCustomAttachRequest(
      { name: 'my-server', transport: 'http', command: '', url: ' https://example.com ' },
      [],
    );
    expect(result).toEqual({
      ok: true,
      request: { name: 'my-server', transport: 'http', command: undefined, url: 'https://example.com' },
    });
  });
});

describe('buildRegistryAttachRequest', () => {
  it('rejects a name already in use', () => {
    const result = buildRegistryAttachRequest(registryEntry, {}, ['github']);
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT', message: 'name already exists' } });
  });

  it('substitutes non-secret params into the command and routes secrets to secretParams', () => {
    const result = buildRegistryAttachRequest(registryEntry, { token: 'shh', org: 'acme' }, []);
    expect(result).toEqual({
      ok: true,
      request: {
        name: 'github',
        transport: 'stdio',
        command: 'gh-mcp --token {token} --org acme',
        url: undefined,
        secretParams: { token: 'shh' },
        registrySource: 'github',
      },
    });
  });

  it('omits secretParams entirely when the entry has no secret params', () => {
    const entry: McpRegistryEntry = { ...registryEntry, params: [{ key: 'org', label: 'ORG', required: false }] };
    const result = buildRegistryAttachRequest(entry, { org: 'acme' }, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.secretParams).toBeUndefined();
  });

  it('substitutes into the url for an http entry', () => {
    const entry: McpRegistryEntry = {
      name: 'http-srv',
      description: '',
      transport: 'http',
      urlTemplate: 'https://{host}/mcp',
      params: [{ key: 'host', label: 'HOST', required: true }],
    };
    const result = buildRegistryAttachRequest(entry, { host: 'api.example.com' }, []);
    expect(result).toEqual({
      ok: true,
      request: {
        name: 'http-srv',
        transport: 'http',
        command: undefined,
        url: 'https://api.example.com/mcp',
        secretParams: undefined,
        registrySource: 'http-srv',
      },
    });
  });
});

describe('buildAttachRequest', () => {
  it('dispatches to the custom branch', () => {
    const result = buildAttachRequest('custom', { ...baseCustom, name: 'x', command: 'y' }, {}, []);
    expect(result.ok).toBe(true);
  });

  it('dispatches to the registry branch', () => {
    const result = buildAttachRequest(registryEntry, baseCustom, { token: 't', org: 'o' }, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.registrySource).toBe('github');
  });
});

describe('canSubmitAttach', () => {
  it('false with nothing selected', () => {
    expect(canSubmitAttach(null, baseCustom, {}, [])).toBe(false);
  });

  it('custom stdio: requires a name and a command', () => {
    expect(canSubmitAttach('custom', baseCustom, {}, [])).toBe(false);
    expect(canSubmitAttach('custom', { ...baseCustom, name: 'x' }, {}, [])).toBe(false);
    expect(canSubmitAttach('custom', { ...baseCustom, name: 'x', command: 'y' }, {}, [])).toBe(true);
  });

  it('custom http: requires a name and a url', () => {
    expect(canSubmitAttach('custom', { ...baseCustom, name: 'x', transport: 'http' }, {}, [])).toBe(false);
    expect(canSubmitAttach('custom', { ...baseCustom, name: 'x', transport: 'http', url: 'u' }, {}, [])).toBe(true);
  });

  it('custom: name already taken blocks submit', () => {
    expect(canSubmitAttach('custom', { ...baseCustom, name: 'github', command: 'y' }, {}, ['github'])).toBe(false);
  });

  it('registry: every required param must be filled', () => {
    expect(canSubmitAttach(registryEntry, baseCustom, {}, [])).toBe(false);
    expect(canSubmitAttach(registryEntry, baseCustom, { token: 't' }, [])).toBe(true); // org is optional
  });

  it('registry: name already taken blocks submit', () => {
    expect(canSubmitAttach(registryEntry, baseCustom, { token: 't' }, ['github'])).toBe(false);
  });
});
