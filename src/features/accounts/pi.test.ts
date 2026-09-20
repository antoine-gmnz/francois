// pi-provider-auth — frontend unit tests for the Pi section's pure logic.

import { describe, expect, it } from 'vitest';
import type { AppError, SessionMeta } from '../../../contract/common';
import type { Account, PiProviderAuthObservation } from '../../../contract/multi-account';
import {
  accountIsPi,
  piAddPayload,
  piBlockedSessionsMessage,
  piConfigDirError,
  piDeriveEnvironment,
  piDistroError,
  piEnvironmentLabel,
  piErrorMessage,
  piInheritLabel,
  piLabelError,
  piObservationCheckedAtLabel,
  piObservationLabel,
  piObservationTone,
  piActionBlockedReason,
  piObservationsSummary,
  piRemoveConfirmView,
  piSaveDisabled,
  piTrustActionLabel,
  piTrustLabel,
} from './pi';

function observation(over: Partial<PiProviderAuthObservation> = {}): PiProviderAuthObservation {
  return { providerId: 'anthropic', state: 'unknown', checkedAt: 0, ...over };
}

describe('accountIsPi', () => {
  it('is true only for kind pi', () => {
    expect(accountIsPi({ kind: 'pi' } as never)).toBe(true);
    expect(accountIsPi({ kind: 'claude-code-oauth' } as never)).toBe(false);
  });
});

describe('piLabelError', () => {
  it('rejects blank labels', () => {
    expect(piLabelError('')).not.toBeNull();
    expect(piLabelError('   ')).not.toBeNull();
  });

  it('rejects labels over 60 chars after trim', () => {
    expect(piLabelError('a'.repeat(61))).not.toBeNull();
    expect(piLabelError(`  ${'a'.repeat(60)}  `)).toBeNull();
  });

  it('accepts a normal label', () => {
    expect(piLabelError('Work Pi')).toBeNull();
  });
});

describe('piConfigDirError', () => {
  it('requires a non-blank directory', () => {
    expect(piConfigDirError('')).not.toBeNull();
    expect(piConfigDirError('   ')).not.toBeNull();
    expect(piConfigDirError('/home/u/.pi/agent')).toBeNull();
  });
});

describe('piDistroError', () => {
  it('requires a distro only under wsl', () => {
    expect(piDistroError('native', '')).toBeNull();
    expect(piDistroError('wsl', '')).not.toBeNull();
    expect(piDistroError('wsl', '   ')).not.toBeNull();
    expect(piDistroError('wsl', 'Ubuntu')).toBeNull();
  });
});

describe('piSaveDisabled', () => {
  it('is disabled while busy or any field is invalid', () => {
    expect(piSaveDisabled('Work', '/dir', 'native', '', true)).toBe(true);
    expect(piSaveDisabled('', '/dir', 'native', '', false)).toBe(true);
    expect(piSaveDisabled('Work', '', 'native', '', false)).toBe(true);
    expect(piSaveDisabled('Work', '/dir', 'wsl', '', false)).toBe(true);
  });

  it('is enabled once every field is valid', () => {
    expect(piSaveDisabled('Work', '/dir', 'native', '', false)).toBe(false);
    expect(piSaveDisabled('Work', '\\\\wsl$\\Ubuntu\\home\\u', 'wsl', 'Ubuntu', false)).toBe(false);
  });
});

describe('piDeriveEnvironment', () => {
  it('reads native for a plain path', () => {
    expect(piDeriveEnvironment('/home/u/.pi/agent')).toEqual({ runtime: 'native', distro: '' });
    expect(piDeriveEnvironment('C:\\Users\\u\\.pi\\agent')).toEqual({ runtime: 'native', distro: '' });
  });

  it('derives the distro from a WSL UNC path', () => {
    expect(piDeriveEnvironment('\\\\wsl$\\Ubuntu\\home\\u\\.pi\\agent')).toEqual({
      runtime: 'wsl',
      distro: 'Ubuntu',
    });
    expect(piDeriveEnvironment('\\\\wsl.localhost\\Debian\\home\\u')).toEqual({
      runtime: 'wsl',
      distro: 'Debian',
    });
  });
});

describe('piAddPayload', () => {
  it('trims label and configDir and omits distro for native', () => {
    expect(
      piAddPayload({
        label: '  Work Pi  ',
        configDir: '  /home/u/.pi/agent  ',
        runtime: 'native',
        distro: '',
        inheritEnvironmentCredentials: false,
        trustConfiguration: false,
      }),
    ).toEqual({
      kind: 'pi',
      label: 'Work Pi',
      configDir: '/home/u/.pi/agent',
      runtime: 'native',
      inheritEnvironmentCredentials: false,
      trustConfiguration: false,
    });
  });

  it('carries a trimmed distro for wsl', () => {
    const payload = piAddPayload({
      label: 'Work Pi',
      configDir: '\\\\wsl$\\Ubuntu\\home\\u',
      runtime: 'wsl',
      distro: '  Ubuntu  ',
      inheritEnvironmentCredentials: true,
      trustConfiguration: true,
    });
    expect(payload.distro).toBe('Ubuntu');
    expect(payload.inheritEnvironmentCredentials).toBe(true);
    expect(payload.trustConfiguration).toBe(true);
  });
});

describe('display copy', () => {
  it('renders the environment label', () => {
    expect(piEnvironmentLabel({ runtime: 'native', distro: undefined })).toBe('native');
    expect(piEnvironmentLabel({ runtime: 'wsl', distro: 'Ubuntu' })).toBe('wsl · Ubuntu');
  });

  it('renders trust labels and the toggle action', () => {
    expect(piTrustLabel(true)).toBe('Trusted');
    expect(piTrustLabel(false)).toBe('Untrusted');
    expect(piTrustActionLabel(true)).toBe('Revoke trust');
    expect(piTrustActionLabel(false)).toBe('Trust');
  });

  it('renders the inherit-credentials line', () => {
    expect(piInheritLabel(true)).toMatch(/inherits/);
    expect(piInheritLabel(false)).toMatch(/no inherited/);
  });
});

describe('piActionBlockedReason', () => {
  it('blocks setup/refresh while untrusted and clears once trusted', () => {
    expect(piActionBlockedReason({ trusted: false })).not.toBeNull();
    expect(piActionBlockedReason({ trusted: true })).toBeNull();
  });

  it('blocks with a distinct reason when the account carries no Pi config at all', () => {
    expect(piActionBlockedReason(undefined)).toBe('No Pi configuration on this account.');
  });
});

describe('provider auth observations', () => {
  it('labels and tones the four states', () => {
    expect(piObservationLabel(observation({ state: 'unknown' }))).toBe('not checked');
    expect(piObservationLabel(observation({ state: 'configured' }))).toBe('configured');
    expect(piObservationLabel(observation({ state: 'verified' }))).toBe('verified');
    expect(piObservationLabel(observation({ state: 'failed' }))).toBe('failed');

    expect(piObservationTone(observation({ state: 'failed' }))).toBe('error');
    expect(piObservationTone(observation({ state: 'verified' }))).toBe('ok');
    expect(piObservationTone(observation({ state: 'configured' }))).toBe('ok');
    expect(piObservationTone(observation({ state: 'unknown' }))).toBe('dim');
  });

  it('formats a relative checked-at label', () => {
    const now = 1_000_000;
    expect(piObservationCheckedAtLabel(observation({ checkedAt: now - 8_000 }), now)).toBe('checked 8s ago');
    expect(piObservationCheckedAtLabel(observation({ checkedAt: now - 90_000 }), now)).toBe('checked 1m ago');
    expect(piObservationCheckedAtLabel(observation({ checkedAt: now - 3 * 3_600_000 }), now)).toBe('checked 3h ago');
  });

  it('summarizes an empty list as not checked yet', () => {
    expect(piObservationsSummary([])).toBe('not checked yet');
  });

  it('summarizes counts by state, verified first', () => {
    const summary = piObservationsSummary([
      observation({ providerId: 'a', state: 'configured' }),
      observation({ providerId: 'b', state: 'verified' }),
      observation({ providerId: 'c', state: 'failed' }),
      observation({ providerId: 'd', state: 'verified' }),
    ]);
    expect(summary).toBe('2 verified · 1 configured · 1 failed');
  });
});

describe('piErrorMessage', () => {
  const err = (code: AppError['code'], message = ''): AppError => ({ code, message });

  it('gives each Pi-specific code its own sentence', () => {
    expect(piErrorMessage(err('ACCOUNT_CONFIG_UNTRUSTED'))).toMatch(/not trusted/);
    expect(piErrorMessage(err('ACCOUNT_CONFIG_CHANGED'))).toMatch(/changed/);
    expect(piErrorMessage(err('ACCOUNT_IN_USE'))).toMatch(/session or setup/);
    expect(piErrorMessage(err('RUNTIME_UNAVAILABLE'))).toMatch(/not installed/);
    expect(piErrorMessage(err('RUNTIME_INCOMPATIBLE'))).toMatch(/certified/);
    expect(piErrorMessage(err('RUNTIME_TIMEOUT'))).toMatch(/did not answer/);
    expect(piErrorMessage(err('RUNTIME_PROTOCOL_ERROR'))).toMatch(/could not parse/);
    expect(piErrorMessage(err('PROVIDER_AUTH_FAILED'))).toMatch(/authentication failure/);
    expect(piErrorMessage(err('SPAWN_FAILED'))).toBe('Could not start Pi.');
    expect(piErrorMessage(err('PTY_ERROR'))).toBe('Could not start Pi.');
  });

  it('falls through to the core message otherwise', () => {
    expect(piErrorMessage(err('INTERNAL', 'disk is on fire'))).toBe('disk is on fire');
    expect(piErrorMessage(err('INTERNAL', ''))).toBe('Something went wrong.');
  });
});

describe('piBlockedSessionsMessage', () => {
  it('is null for anything other than ACCOUNT_IN_USE', () => {
    expect(piBlockedSessionsMessage({ code: 'INTERNAL', message: 'x' }, new Map())).toBeNull();
  });

  it('names the blocked sessions when the detail carries ids', () => {
    const names = new Map([
      ['s1', 'api-refactor'],
      ['s2', 'docs-pass'],
    ]);
    const msg = piBlockedSessionsMessage(
      { code: 'ACCOUNT_IN_USE', message: 'x', detail: { blockedSessions: ['s1', 's2'] } },
      names,
    );
    expect(msg).toBe('Stop first: api-refactor, docs-pass.');
  });

  it('falls back to the raw id when a name is unknown', () => {
    const msg = piBlockedSessionsMessage(
      { code: 'ACCOUNT_IN_USE', message: 'x', detail: { blockedSessions: ['unknown-id'] } },
      new Map(),
    );
    expect(msg).toBe('Stop first: unknown-id.');
  });

  it('gives a generic line when the detail carries no ids', () => {
    const msg = piBlockedSessionsMessage({ code: 'ACCOUNT_IN_USE', message: 'x' }, new Map());
    expect(msg).toBe('This account is in use — stop its session(s) first.');
  });
});

describe('piRemoveConfirmView', () => {
  const piAccount: Account = {
    id: 'pi1',
    label: 'Work Pi',
    configDir: '/home/u/.pi/agent',
    builtIn: false,
    isDefault: false,
    createdAt: 0,
    kind: 'pi',
    pi: { runtime: 'native', inheritEnvironmentCredentials: false, trusted: true },
  };

  function session(over: Partial<SessionMeta> & { id: string }): SessionMeta {
    return {
      name: over.id,
      cwd: '/repo',
      model: { id: 'm', label: 'M' },
      status: 'idle',
      contextUsedTokens: 0,
      contextLimitTokens: 0,
      startedAt: 0,
      lastActivityAt: 0,
      permissionMode: 'default',
      permissionModeSince: 0,
      runtime: 'native',
      accountId: 'pi1',
      agentRuntime: 'pi',
      protocol: null,
      responseMode: 'default',
      allowGit: false,
      ...over,
    };
  }

  it('never claims credentials are deleted or that sessions fall back (FR-8)', () => {
    const view = piRemoveConfirmView(piAccount, []);
    expect(view.credentialsLine).toMatch(/untouched/);
    expect(view.credentialsLine).not.toMatch(/deleted/);
    expect(view.sessionsLine).toBeNull();
  });

  it('names bound sessions as BLOCKING the removal, not as falling back', () => {
    const view = piRemoveConfirmView(piAccount, [session({ id: 's1' }), session({ id: 's2' })]);
    expect(view.sessionsLine).toMatch(/Blocked/);
    expect(view.names).toEqual(['s1', 's2']);
  });
});
