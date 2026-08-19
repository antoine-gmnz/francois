import { describe, expect, it } from 'vitest';
import type { CliToolStatus } from '../../../contract/multi-account';
import {
  IDLE_INSTALL,
  appendInstallOutput,
  cliToolHeadline,
  cliToolRationale,
  findCliTool,
  installButtonLabel,
  installCommand,
  installErrorText,
  loginBlockedReason,
  outputTail,
  reduceInstall,
} from './cliTools';
import { providerSpec } from './providers';

function tool(over: Partial<CliToolStatus> = {}): CliToolStatus {
  return {
    id: 'grok',
    bin: 'grok',
    installed: false,
    npmPackage: '@xai-official/grok',
    docsUrl: 'https://docs.x.ai/build/overview',
    ...over,
  };
}

describe('findCliTool', () => {
  it('answers null for a provider with no CLI at all, without reaching the list', () => {
    expect(findCliTool([tool()], null)).toBeNull();
  });

  it('answers null when the probe has not reported that tool', () => {
    expect(findCliTool([tool({ id: 'grok' })], 'codex')).toBeNull();
  });

  it('finds the tool by id', () => {
    const codex = tool({ id: 'codex', bin: 'codex', installed: true });
    expect(findCliTool([tool(), codex], 'codex')).toBe(codex);
  });
});

describe('installCommand', () => {
  it('is the npm command the button runs and the card shows — one string, one source', () => {
    expect(installCommand(tool())).toBe('npm i -g @xai-official/grok');
    expect(installCommand(tool({ npmPackage: '@anthropic-ai/claude-code' }))).toBe(
      'npm i -g @anthropic-ai/claude-code',
    );
  });
});

describe('cliToolHeadline', () => {
  it('names the BINARY when missing, so the user can check the same word in a terminal', () => {
    expect(cliToolHeadline(tool())).toBe('grok is not installed');
  });

  it('carries the version when the probe got one', () => {
    expect(cliToolHeadline(tool({ installed: true, version: '1.0.4' }))).toBe('grok 1.0.4');
  });

  it('still reads as installed when the version probe timed out', () => {
    expect(cliToolHeadline(tool({ installed: true }))).toBe('grok is installed');
  });
});

describe('cliToolRationale', () => {
  it('says the CLI runs the sessions for a provider Francois can sign into', () => {
    const text = cliToolRationale(providerSpec('openai'), tool({ id: 'codex', bin: 'codex' }));
    expect(text).toContain('codex');
    expect(text).toContain('OpenAI');
  });

  // multi-provider-grok FR-28: xAI now has a real sign-in route, so its card
  // reads the same as every other provider Francois can drive a login through
  // — the "cannot drive it yet" honesty rule now applies to a provider with no
  // cliLogin at all (covered on 'google' below).
  it('says the CLI runs the sessions for xAI, now that FR-28 gave it a login route', () => {
    const text = cliToolRationale(providerSpec('xai'), tool());
    expect(text).toContain('grok');
    expect(text).toContain('xAI');
  });

  it('still says outright that Francois cannot drive a CLI it has no login route for', () => {
    const text = cliToolRationale(providerSpec('google'), tool({ id: 'claude', bin: 'gemini' }));
    expect(text).toContain('cannot drive gemini');
  });
});

describe('loginBlockedReason', () => {
  it('blocks "+ Add login" when the CLI that would run it is missing', () => {
    const reason = loginBlockedReason(providerSpec('openai'), tool({ id: 'codex', bin: 'codex' }));
    expect(reason).toContain('Install the codex CLI first');
  });

  it('does not block once the CLI is there', () => {
    expect(
      loginBlockedReason(providerSpec('openai'), tool({ id: 'codex', installed: true })),
    ).toBeNull();
  });

  // A probe in flight must not disable the button — a rare SPAWN_FAILED that
  // explains itself beats an affordance that is dead while the modal loads.
  it('does not block while the probe has not answered', () => {
    expect(loginBlockedReason(providerSpec('anthropic'), null)).toBeNull();
  });

  it('has nothing to say about a provider with no CLI login route', () => {
    expect(loginBlockedReason(providerSpec('google'), null)).toBeNull();
  });

  // multi-provider-grok FR-28: xAI now HAS a login route, so a missing `grok`
  // blocks "+ Add login" exactly like a missing `codex` blocks OpenAI's.
  it('blocks "+ Add login" on xAI when grok is missing, now that FR-28 gave it a route', () => {
    const reason = loginBlockedReason(providerSpec('xai'), tool());
    expect(reason).toContain('Install the grok CLI first');
  });
});

describe('appendInstallOutput', () => {
  it('accumulates chunks in order', () => {
    expect(appendInstallOutput('added ', '1 package\n')).toBe('added 1 package\n');
  });

  it('drops from the FRONT past the cap — a failure explains itself at the end', () => {
    const long = 'x'.repeat(25_000);
    const out = appendInstallOutput(long, 'the real reason');
    expect(out.length).toBe(20_000);
    expect(out.endsWith('the real reason')).toBe(true);
  });
});

describe('outputTail', () => {
  it('keeps the last non-empty lines', () => {
    expect(outputTail('a\n\nb\nc\n', 2)).toBe('b\nc');
  });

  it('resolves npm’s \\r progress redraws to what it settled on', () => {
    expect(outputTail('⠋ idealTree\r⠙ idealTree\r⠹ reify: grok\n', 1)).toBe('⠹ reify: grok');
  });

  it('is empty for empty output rather than a blank line', () => {
    expect(outputTail('\n\n  \n')).toBe('');
  });
});

describe('installButtonLabel', () => {
  it('names the binary at rest, so the button says what it will produce', () => {
    expect(installButtonLabel(IDLE_INSTALL, tool())).toBe('Install grok');
  });

  it('reads as a retry after a failure, not as a different action', () => {
    expect(
      installButtonLabel({ phase: 'failed', output: '', error: null }, tool()),
    ).toBe('Retry install');
  });

  it('reads as in-progress while npm runs', () => {
    expect(installButtonLabel({ phase: 'installing', output: '', error: null }, tool())).toBe(
      'Installing…',
    );
  });
});

describe('reduceInstall', () => {
  it('folds output chunks into the transcript without changing phase', () => {
    const started = { phase: 'installing' as const, output: '', error: null };
    const next = reduceInstall(started, { kind: 'output', data: 'added 1 package\n' });
    expect(next.phase).toBe('installing');
    expect(next.output).toBe('added 1 package\n');
  });

  // The refreshed tool list riding along with `done` is what removes the card;
  // a 'succeeded' phase would be a state nothing renders.
  it('returns to idle on a clean done', () => {
    const running = { phase: 'installing' as const, output: 'noise', error: null };
    expect(reduceInstall(running, { kind: 'done' })).toEqual(IDLE_INSTALL);
    expect(reduceInstall(running, { kind: 'done', error: null })).toEqual(IDLE_INSTALL);
  });

  it('keeps the transcript on a failure, so the reason stays on screen', () => {
    const running = { phase: 'installing' as const, output: 'npm warn …', error: null };
    const failed = reduceInstall(running, {
      kind: 'done',
      error: { code: 'CLI_INSTALL_FAILED', message: 'npm exited with code 1' },
    });
    expect(failed.phase).toBe('failed');
    expect(failed.output).toBe('npm warn …');
    expect(failed.error?.code).toBe('CLI_INSTALL_FAILED');
  });
});

describe('installErrorText', () => {
  it('prefers npm’s own tail — an exit code alone means nothing to search for', () => {
    const text = installErrorText({
      code: 'CLI_INSTALL_FAILED',
      message: 'npm exited with code 1',
      detail: { code: 1, tail: 'npm error code EACCES\nnpm error syscall mkdir' },
    });
    expect(text).toContain('npm exited with code 1');
    expect(text).toContain('EACCES');
  });

  it('falls back to the message when the core attached no tail', () => {
    expect(
      installErrorText({
        code: 'CLI_INSTALL_UNAVAILABLE',
        message: 'npm could not be found on PATH',
      }),
    ).toBe('npm could not be found on PATH');
  });
});
