// Redesign 8b ("Credential vault") — unit tests for the provider axis.
// Everything the two-pane modal decides lives in providers.ts; the rail, the
// detail pane and the credential cards are thin renderers over these, so this
// file is where the design's rules are actually enforced.

import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import {
  PROVIDERS,
  accountSessionNames,
  accountWantsAttention,
  baseUrlHost,
  credentialLoginLabel,
  cliSectionState,
  credentialSessionLine,
  findGroup,
  isKeyCredential,
  keySectionState,
  providerGroups,
  providerIdForAccount,
  providerIsolationNote,
  providerSpec,
  resolveSelectedProvider,
  splitRail,
} from './providers';

function claude(over: Partial<Account> = {}): Account {
  return {
    id: 'c1',
    label: 'Work',
    configDir: '/cfg/c1',
    builtIn: false,
    isDefault: false,
    createdAt: 1,
    kind: 'claude-code-oauth',
    ...over,
  };
}

function codex(over: Partial<Account> = {}): Account {
  return {
    id: 'x1',
    label: 'ChatGPT',
    configDir: '/cfg/x1',
    builtIn: false,
    isDefault: false,
    createdAt: 2,
    kind: 'codex-cli',
    signedIn: true,
    ...over,
  };
}

function grok(over: Partial<Account> = {}): Account {
  return {
    id: 'g1',
    label: 'SuperGrok',
    configDir: '/cfg/g1',
    builtIn: false,
    isDefault: false,
    createdAt: 4,
    kind: 'grok-cli',
    signedIn: true,
    ...over,
  };
}

function endpoint(baseUrl: string, over: Partial<Account> = {}): Account {
  return {
    id: `e-${baseUrl}`,
    label: 'Gateway',
    configDir: null,
    builtIn: false,
    isDefault: false,
    createdAt: 3,
    kind: 'openai-compatible',
    endpoint: { baseUrl, hasKey: true },
    ...over,
  };
}

describe('baseUrlHost', () => {
  it('reads the host of a normalized URL', () => {
    expect(baseUrlHost('https://openrouter.ai/api/v1')).toBe('openrouter.ai');
  });

  it('lowercases and drops the port', () => {
    expect(baseUrlHost('http://LocalHost:1234/v1')).toBe('localhost');
  });

  it('survives a value the core has not normalized yet (no scheme)', () => {
    expect(baseUrlHost('api.deepseek.com/v1')).toBe('api.deepseek.com');
  });

  it('is empty for an empty value', () => {
    expect(baseUrlHost('   ')).toBe('');
  });
});

describe('providerIdForAccount', () => {
  it('maps the three CLI kinds to their vendor', () => {
    expect(providerIdForAccount(claude())).toBe('anthropic');
    expect(providerIdForAccount(codex())).toBe('openai');
    expect(providerIdForAccount(grok())).toBe('xai');
  });

  it('routes an endpoint account by the host of its base URL', () => {
    expect(providerIdForAccount(endpoint('https://api.openai.com/v1'))).toBe('openai');
    expect(providerIdForAccount(endpoint('https://openrouter.ai/api/v1'))).toBe('openrouter');
    expect(providerIdForAccount(endpoint('https://api.moonshot.cn/v1'))).toBe('moonshot');
  });

  it('falls back to `custom` for a host the catalog never heard of', () => {
    expect(providerIdForAccount(endpoint('http://127.0.0.1:11434/v1'))).toBe('custom');
    expect(providerIdForAccount(endpoint(''))).toBe('custom');
  });
});

describe('isKeyCredential', () => {
  it('splits keys from CLI logins', () => {
    expect(isKeyCredential(endpoint('https://api.openai.com/v1'))).toBe(true);
    expect(isKeyCredential(claude())).toBe(false);
    expect(isKeyCredential(codex())).toBe(false);
    expect(isKeyCredential(grok())).toBe(false);
  });
});

describe('accountWantsAttention', () => {
  it('covers all three ways a credential can be asking for something', () => {
    expect(accountWantsAttention(claude({ authFailedAt: 5 }))).toBe(true);
    expect(accountWantsAttention(codex({ signedIn: false }))).toBe(true);
    expect(accountWantsAttention(grok({ signedIn: false }))).toBe(true);
    expect(accountWantsAttention(claude())).toBe(false);
    expect(accountWantsAttention(codex())).toBe(false);
    expect(accountWantsAttention(grok())).toBe(false);
  });
});

describe('providerGroups', () => {
  it('keeps every catalog provider, connected or not', () => {
    const groups = providerGroups([]);
    expect(groups).toHaveLength(PROVIDERS.length);
    expect(groups.every((g) => !g.connected)).toBe(true);
  });

  it('buckets accounts and splits CLI logins from keys', () => {
    const groups = providerGroups([
      claude({ id: 'a', isDefault: true }),
      codex({ id: 'b' }),
      endpoint('https://api.openai.com/v1', { id: 'c' }),
    ]);
    const openai = findGroup(groups, 'openai');
    expect(openai.accounts.map((a) => a.id)).toEqual(['b', 'c']);
    expect(openai.cliAccounts.map((a) => a.id)).toEqual(['b']);
    expect(openai.keyAccounts.map((a) => a.id)).toEqual(['c']);
    expect(findGroup(groups, 'anthropic').accounts.map((a) => a.id)).toEqual(['a']);
  });

  it('buckets a grok-cli account into xAI as a CLI login', () => {
    const groups = providerGroups([grok({ id: 'g' })]);
    const xai = findGroup(groups, 'xai');
    expect(xai.cliAccounts.map((a) => a.id)).toEqual(['g']);
    expect(xai.keyAccounts).toEqual([]);
    expect(xai.connected).toBe(true);
  });

  it('reads `2 logins · 1 key` on a connected provider', () => {
    const groups = providerGroups([
      claude({ id: 'a' }),
      claude({ id: 'b' }),
      endpoint('https://api.anthropic.com/v1', { id: 'c' }),
    ]);
    expect(findGroup(groups, 'anthropic').meta).toBe('2 logins · 1 key');
  });

  it('lets `needs login` replace the count when a credential is asking', () => {
    const groups = providerGroups([claude({ id: 'a', authFailedAt: 9 }), claude({ id: 'b' })]);
    const anthropic = findGroup(groups, 'anthropic');
    expect(anthropic.meta).toBe('needs login');
    expect(anthropic.status).toBe('attention');
  });

  it('describes the route on an AVAILABLE provider instead of a count', () => {
    const groups = providerGroups([]);
    expect(findGroup(groups, 'openai').meta).toBe('codex CLI · api key');
    expect(findGroup(groups, 'deepseek').meta).toBe('api key');
    expect(findGroup(groups, 'anthropic').meta).toBe('claude CLI');
  });

  it('grades the dot: attention over active over idle, none when unconnected', () => {
    const withSessions = providerGroups([claude({ id: 'a' })], { a: 2 });
    expect(findGroup(withSessions, 'anthropic').status).toBe('active');
    expect(findGroup(withSessions, 'anthropic').sessionCount).toBe(2);

    const idle = providerGroups([claude({ id: 'a' })], { a: 0 });
    expect(findGroup(idle, 'anthropic').status).toBe('idle');

    expect(findGroup(providerGroups([]), 'anthropic').status).toBe('none');
  });
});

describe('splitRail', () => {
  it('puts connected providers above available ones, catalog order within each', () => {
    const { connected, available } = splitRail(providerGroups([codex({ id: 'b' })]));
    expect(connected.map((g) => g.spec.id)).toEqual(['openai']);
    expect(available[0].spec.id).toBe('anthropic');
    expect(available[available.length - 1].spec.id).toBe('custom');
  });
});

describe('resolveSelectedProvider', () => {
  it('honours a still-valid preference', () => {
    expect(resolveSelectedProvider(providerGroups([]), 'qwen')).toBe('qwen');
  });

  it('otherwise opens on the provider owning the default account', () => {
    const groups = providerGroups([claude({ id: 'a' }), codex({ id: 'b', isDefault: true })]);
    expect(resolveSelectedProvider(groups, null)).toBe('openai');
  });

  it('falls back to the first connected provider, then to Anthropic', () => {
    expect(resolveSelectedProvider(providerGroups([codex({ id: 'b' })]), null)).toBe('openai');
    expect(resolveSelectedProvider(providerGroups([]), null)).toBe('anthropic');
  });
});

describe('section states', () => {
  it('opens both sections on OpenAI — it has a CLI and an OpenAI-shaped API', () => {
    const spec = providerSpec('openai');
    expect(cliSectionState(spec).available).toBe(true);
    expect(keySectionState(spec).available).toBe(true);
  });

  it('closes the KEYS section on Anthropic and says why', () => {
    const state = keySectionState(providerSpec('anthropic'));
    expect(state.available).toBe(false);
    expect(state.comingSoon).toContain('coming soon');
  });

  it('closes the CLI section on a provider whose CLI we do not drive, naming it', () => {
    const state = cliSectionState(providerSpec('moonshot'));
    expect(state.available).toBe(false);
    expect(state.comingSoon).toContain('kimi');
  });

  it('says a key is the way in when a provider has no CLI at all', () => {
    const state = cliSectionState(providerSpec('openrouter'));
    expect(state.available).toBe(false);
    expect(state.comingSoon).toContain('API key');
  });

  it('leaves the custom endpoint row key-only with a blank prefill', () => {
    const spec = providerSpec('custom');
    expect(spec.apiBaseUrl).toBe('');
    expect(keySectionState(spec).available).toBe(true);
    expect(cliSectionState(spec).available).toBe(false);
  });

  it('never lets a provider be a dead end — every catalog entry offers a route', () => {
    for (const spec of PROVIDERS) {
      expect(cliSectionState(spec).available || keySectionState(spec).available).toBe(true);
    }
  });
});

describe('providerIsolationNote', () => {
  it('states the config-dir cost only where logins exist', () => {
    const groups = providerGroups([]);
    expect(providerIsolationNote(findGroup(groups, 'anthropic'))).toContain('own configuration');
    expect(providerIsolationNote(findGroup(groups, 'openrouter'))).not.toContain('own configuration');
  });
});

describe('credentialSessionLine', () => {
  it('is null when the credential carries nothing', () => {
    expect(credentialSessionLine([])).toBeNull();
  });

  it('names up to three sessions, then counts the rest', () => {
    expect(credentialSessionLine(['a'])).toBe('1 session: a');
    expect(credentialSessionLine(['a', 'b', 'c'])).toBe('3 sessions: a, b, c');
    expect(credentialSessionLine(['a', 'b', 'c', 'd', 'e'])).toBe('5 sessions: a, b, c, +2 more');
  });
});

describe('accountSessionNames', () => {
  const session = (id: string, name: string, accountId?: string) =>
    ({ id, name, accountId }) as unknown as SessionMeta;

  it('names the sessions each credential carries', () => {
    const accounts = [claude({ id: 'a', isDefault: true }), codex({ id: 'b' })];
    const names = accountSessionNames(accounts, [
      session('s1', 'api-refactor', 'a'),
      session('s2', 'panel-rail', 'b'),
      session('s3', 'docs-pass', 'a'),
    ]);
    expect(names.a).toEqual(['api-refactor', 'docs-pass']);
    expect(names.b).toEqual(['panel-rail']);
  });

  it('attributes a session on a removed account to the one that will run it', () => {
    const accounts = [claude({ id: 'a', isDefault: true })];
    const names = accountSessionNames(accounts, [session('s1', 'orphan', 'gone')]);
    expect(names.a).toEqual(['orphan']);
  });

  it('gives every account a bucket, even an empty one', () => {
    expect(accountSessionNames([claude({ id: 'a' })], [])).toEqual({ a: [] });
  });
});

describe('credentialLoginLabel', () => {
  it('is null where there is nothing to sign into', () => {
    expect(credentialLoginLabel(claude({ builtIn: true }))).toBeNull();
    expect(credentialLoginLabel(endpoint('https://api.openai.com/v1'))).toBeNull();
  });

  it('says Re-login for a Claude account and Sign in for a never-authed Codex one', () => {
    expect(credentialLoginLabel(claude())).toBe('Re-login');
    expect(credentialLoginLabel(codex({ signedIn: false }))).toBe('Sign in');
    expect(credentialLoginLabel(codex({ signedIn: true }))).toBe('Re-login');
  });

  it('says Sign in for a never-authed Grok account, Re-login once there was a credential', () => {
    expect(credentialLoginLabel(grok({ signedIn: false }))).toBe('Sign in');
    expect(credentialLoginLabel(grok({ signedIn: true }))).toBe('Re-login');
  });
});

describe('the catalog itself', () => {
  it('has unique ids and no host claimed twice', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hosts = PROVIDERS.flatMap((p) => p.hosts);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('tints every tile from the neutral hue ramp — a provider is identity, not status', () => {
    for (const spec of PROVIDERS) {
      expect(spec.hue.startsWith('var(--hue-')).toBe(true);
    }
  });

  // The install axis. `cliTool` says which vendor CLI Francois can detect and
  // install; `cliLogin` says which one it can drive a sign-in through. They are
  // NOT the same question, and xAI is the case that proves it.
  it('can install every CLI it can sign in with — a login route with no install route would strand the user', () => {
    for (const spec of PROVIDERS) {
      if (spec.cliLogin) expect(spec.cliTool).toBe(spec.cliLogin);
    }
  });

  // multi-provider-grok FR-28: cliLogin flipped from null once addGrok/grokLogin
  // gave xAI a real sign-in route — cliTool and cliLogin now agree, like every
  // other provider that can sign in through its own CLI.
  it('signs in to xAI through the grok CLI now that FR-28 wired it up', () => {
    const xai = providerSpec('xai');
    expect(xai.cliTool).toBe('grok');
    expect(xai.cliLogin).toBe('grok');
  });

  // The converse guard: a provider we can neither drive nor install must not
  // grow a card offering to install something that has no package behind it.
  it('claims no CLI for the providers whose tools it does not ship', () => {
    for (const id of ['google', 'moonshot', 'qwen', 'openrouter', 'deepseek', 'custom'] as const) {
      expect(providerSpec(id).cliTool).toBeNull();
    }
  });

  it('names a CLI in prose exactly when there is one to name', () => {
    for (const spec of PROVIDERS) {
      if (spec.cliTool) expect(spec.cliName).toBe(spec.cliTool);
    }
  });
});
