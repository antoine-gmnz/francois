import { describe, expect, it } from 'vitest';
import type { CliToolStatus } from '../../../contract/multi-account';
import type { RuntimeInstallStatus } from '../../../contract/pi-runtime-distribution';
import type { RuntimeProbeState } from './cliTools';
import {
  IDLE_INSTALL,
  IDLE_RUNTIME_PROBE,
  appendInstallOutput,
  cliToolHeadline,
  cliToolRationale,
  findCliTool,
  installButtonLabel,
  installCommand,
  installErrorText,
  loginBlockedReason,
  outputTail,
  piSetupErrorText,
  piSetupHeadline,
  piSetupNote,
  reduceInstall,
  reduceRuntimeProbe,
  runtimeCheckedAtLabel,
  runtimeDetailLines,
  runtimeErrorText,
  runtimeInstallHeadline,
  runtimeInstallNote,
  runtimeInstallProbeInput,
  runtimeRetryLabel,
  runtimeShowsInstallCommand,
} from './cliTools';
import { providerSpec } from './providers';

function runtimeStatus(over: Partial<RuntimeInstallStatus> = {}): RuntimeInstallStatus {
  return {
    state: 'missing',
    supportedVersions: ['0.85.1'],
    provenance: 'unknown',
    checkedAt: 0,
    installCommand: 'npm i -g @earendil-works/pi-coding-agent@0.85.1',
    ...over,
  };
}

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

// ---------------------------------------------------------- Pi runtime probe

describe('reduceRuntimeProbe', () => {
  it('moves to probing on start and clears a previous error', () => {
    const failed = { phase: 'failed' as const, status: null, error: { code: 'INTERNAL' as const, message: 'x' } };
    const next = reduceRuntimeProbe(failed, { kind: 'start' });
    expect(next).toEqual({ phase: 'probing', status: null, error: null });
  });

  it('keeps the previous status visible while a refresh is in flight', () => {
    const loaded = { phase: 'loaded' as const, status: runtimeStatus({ state: 'ready' }), error: null };
    const next = reduceRuntimeProbe(loaded, { kind: 'start' });
    expect(next.status).toBe(loaded.status);
    expect(next.phase).toBe('probing');
  });

  it('lands on loaded with the fresh status', () => {
    const status = runtimeStatus({ state: 'ready', detectedVersion: '0.85.1' });
    const next = reduceRuntimeProbe(IDLE_RUNTIME_PROBE, { kind: 'loaded', status });
    expect(next).toEqual({ phase: 'loaded', status, error: null });
  });

  it('lands on failed when the IPC call itself fails, keeping the last status', () => {
    const loaded = { phase: 'loaded' as const, status: runtimeStatus({ state: 'ready' }), error: null };
    const error = { code: 'INTERNAL' as const, message: 'Could not reach the core' };
    const next = reduceRuntimeProbe(loaded, { kind: 'failed', error });
    expect(next).toEqual({ phase: 'failed', status: loaded.status, error });
  });
});

describe('runtimeInstallHeadline', () => {
  it('says Pi is not installed', () => {
    expect(runtimeInstallHeadline(runtimeStatus({ state: 'missing' }))).toBe('Pi is not installed');
  });

  it('names the detected version when incompatible', () => {
    expect(runtimeInstallHeadline(runtimeStatus({ state: 'incompatible', detectedVersion: '0.60.0' }))).toBe(
      'Pi 0.60.0 is not compatible',
    );
  });

  it('falls back when no version could be read on an incompatible probe', () => {
    expect(runtimeInstallHeadline(runtimeStatus({ state: 'incompatible' }))).toBe(
      'Pi version is not compatible',
    );
  });

  it('reports a probe failure', () => {
    expect(runtimeInstallHeadline(runtimeStatus({ state: 'probe-failed' }))).toBe('Pi could not be checked');
  });

  it('carries the version once ready', () => {
    expect(runtimeInstallHeadline(runtimeStatus({ state: 'ready', detectedVersion: '0.85.1' }))).toBe(
      'Pi 0.85.1',
    );
  });

  it('reads as checking before the first probe answers', () => {
    expect(runtimeInstallHeadline(null)).toBe('Checking for Pi…');
  });
});

describe('runtimeInstallNote', () => {
  it('explains the missing state', () => {
    expect(runtimeInstallNote(runtimeStatus({ state: 'missing' }))).toContain('PATH');
  });

  it('names the certified versions on an incompatible probe', () => {
    expect(runtimeInstallNote(runtimeStatus({ state: 'incompatible', supportedVersions: ['0.85.1'] }))).toContain(
      '0.85.1',
    );
  });

  it('flags unverified provenance on an otherwise ready probe', () => {
    expect(runtimeInstallNote(runtimeStatus({ state: 'ready', provenance: 'unverified' }))).toContain(
      'could not be verified',
    );
  });

  it('reads as certified when provenance matches the pinned artifact', () => {
    expect(runtimeInstallNote(runtimeStatus({ state: 'ready', provenance: 'certified' }))).toContain('Certified');
  });
});

describe('runtimeDetailLines', () => {
  it('lists the resolved path and Node version when both are known', () => {
    const lines = runtimeDetailLines(
      runtimeStatus({ state: 'ready', executablePath: '/usr/local/bin/pi', nodeVersion: '22.19.0' }),
    );
    expect(lines).toEqual(['/usr/local/bin/pi', 'Node 22.19.0']);
  });

  it('is empty when neither is known', () => {
    expect(runtimeDetailLines(runtimeStatus({ state: 'missing' }))).toEqual([]);
  });
});

describe('runtimeCheckedAtLabel', () => {
  it('reads "checked just now" for a reading taken moments ago', () => {
    const status = runtimeStatus({ checkedAt: 1_000 });
    expect(runtimeCheckedAtLabel(status, 1_000 + 2_000)).toBe('checked just now');
  });

  it('reads seconds for a reading under a minute old', () => {
    const status = runtimeStatus({ checkedAt: 1_000 });
    expect(runtimeCheckedAtLabel(status, 1_000 + 42_000)).toBe('checked 42s ago');
  });

  it('reads minutes for a reading under an hour old', () => {
    const status = runtimeStatus({ checkedAt: 0 });
    expect(runtimeCheckedAtLabel(status, 5 * 60_000)).toBe('checked 5m ago');
  });

  it('reads hours for a reading an hour or more old', () => {
    const status = runtimeStatus({ checkedAt: 0 });
    expect(runtimeCheckedAtLabel(status, 3 * 3_600_000)).toBe('checked 3h ago');
  });
});

describe('runtimeErrorText', () => {
  it('surfaces the AppError message when the status carries one', () => {
    expect(
      runtimeErrorText(runtimeStatus({ state: 'probe-failed', error: { code: 'RUNTIME_TIMEOUT', message: 'Pi did not answer in time' } })),
    ).toBe('Pi did not answer in time');
  });

  it('is null on a healthy status', () => {
    expect(runtimeErrorText(runtimeStatus({ state: 'ready' }))).toBeNull();
  });
});

describe('runtimeShowsInstallCommand', () => {
  it('shows the install command when missing or incompatible', () => {
    expect(runtimeShowsInstallCommand(runtimeStatus({ state: 'missing' }))).toBe(true);
    expect(runtimeShowsInstallCommand(runtimeStatus({ state: 'incompatible' }))).toBe(true);
  });

  it('hides it once ready, or while the probe itself failed', () => {
    expect(runtimeShowsInstallCommand(runtimeStatus({ state: 'ready' }))).toBe(false);
    expect(runtimeShowsInstallCommand(runtimeStatus({ state: 'probe-failed' }))).toBe(false);
  });
});

describe('runtimeRetryLabel', () => {
  it('reads as in-progress while probing', () => {
    expect(runtimeRetryLabel('probing')).toBe('Checking…');
  });

  it('reads as Retry otherwise', () => {
    expect(runtimeRetryLabel('idle')).toBe('Retry');
    expect(runtimeRetryLabel('loaded')).toBe('Retry');
    expect(runtimeRetryLabel('failed')).toBe('Retry');
  });
});

describe('piSetupErrorText', () => {
  it('is null when the probe has no error and no status', () => {
    expect(piSetupErrorText(IDLE_RUNTIME_PROBE)).toBeNull();
  });

  it('reads the health-state error off a loaded status', () => {
    const probe: RuntimeProbeState = {
      phase: 'loaded',
      status: runtimeStatus({ state: 'probe-failed', error: { code: 'RUNTIME_TIMEOUT', message: 'Pi did not answer in time' } }),
      error: null,
    };
    expect(piSetupErrorText(probe)).toBe('Pi did not answer in time');
  });

  it('reads the IPC-level error when there is no cached status at all — the first-load failure', () => {
    const probe: RuntimeProbeState = {
      phase: 'failed',
      status: null,
      error: { code: 'INTERNAL', message: 'Could not reach the core' },
    };
    expect(piSetupErrorText(probe)).toBe('Could not reach the core');
  });

  it('prefers the IPC-level error over a stale status error, being the newer failure', () => {
    const probe: RuntimeProbeState = {
      phase: 'failed',
      status: runtimeStatus({ state: 'probe-failed', error: { code: 'RUNTIME_TIMEOUT', message: 'stale reason' } }),
      error: { code: 'INTERNAL', message: 'Could not reach the core' },
    };
    expect(piSetupErrorText(probe)).toBe('Could not reach the core');
  });
});

describe('piSetupHeadline', () => {
  it('reads as a probe failure on a first-load IPC failure, not stuck on "Checking for Pi…"', () => {
    const probe: RuntimeProbeState = {
      phase: 'failed',
      status: null,
      error: { code: 'INTERNAL', message: 'Could not reach the core' },
    };
    expect(piSetupHeadline(probe)).toBe('Pi could not be checked');
  });

  it('falls through to the status headline once a status has loaded', () => {
    const probe: RuntimeProbeState = {
      phase: 'loaded',
      status: runtimeStatus({ state: 'ready', detectedVersion: '0.85.1' }),
      error: null,
    };
    expect(piSetupHeadline(probe)).toBe('Pi 0.85.1');
  });
});

describe('piSetupNote', () => {
  it('explains a first-load IPC failure the same way as a health-state probe failure', () => {
    const probe: RuntimeProbeState = {
      phase: 'failed',
      status: null,
      error: { code: 'INTERNAL', message: 'Could not reach the core' },
    };
    expect(piSetupNote(probe)).toBe('Checking the Pi installation failed.');
  });

  it('falls through to the status note once a status has loaded', () => {
    const probe: RuntimeProbeState = {
      phase: 'loaded',
      status: runtimeStatus({ state: 'missing' }),
      error: null,
    };
    expect(piSetupNote(probe)).toContain('PATH');
  });
});

describe('runtimeInstallProbeInput', () => {
  // FR-1/FR-8 give the core the native/WSL axis; this frontend slice has no
  // environment picker yet (design brief shows none), so it always probes the
  // native environment and leaves `distro` unset. Deferred, not forgotten:
  // see `deferred:pi-runtime-distribution` in specs/refactor-backlog.md.
  it('probes the native environment by default, refresh off', () => {
    expect(runtimeInstallProbeInput()).toEqual({ runtime: 'native', refresh: false });
  });

  it('sets refresh when asked to bypass the cache', () => {
    expect(runtimeInstallProbeInput(true)).toEqual({ runtime: 'native', refresh: true });
  });
});
