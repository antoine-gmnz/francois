// The vendor-CLI state of one provider, in the CLI LOGINS section head and — when
// the CLI is missing — as a dashed card above the credentials:
//
//   CLI LOGINS ──────────────────────────────────  ● codex 0.5.1
//
//   ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
//     ⭳  grok is not installed
//        Francois cannot drive grok for sessions yet — installing it
//        now is the first half of that route.
//        npm i -g @xai-official/grok          [Install grok] [Docs ↗]
//   └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
//
// Dashed, because it borrows the vocabulary the API KEYS section already uses
// for "a slot with nothing in it yet" (`.acc-key-row--empty`) rather than
// inventing a fourth card shape. It is NOT an error treatment: a CLI you have
// not installed is a normal state, not a fault, so nothing here is red until
// npm actually fails.
//
// All copy comes from cliTools.ts, so the three tools cannot drift into three
// different phrasings — the same discipline providers.ts applies to the
// "coming soon" sentences.

import { Check, Download, ExternalLink, Loader } from 'lucide-react';
import type { CliToolStatus } from '../../../contract/multi-account';
import {
  cliToolHeadline,
  cliToolRationale,
  installButtonLabel,
  installCommand,
  installErrorText,
  outputTail,
  type CliInstallState,
} from './cliTools';
import type { ProviderSpec } from './providers';
import './accounts.css';

/**
 * The one-line form for the section head, shown only once the CLI IS installed —
 * the missing case is the card below, and saying it twice would give a normal
 * state more weight than the credentials it sits above.
 */
export function CliToolChip({ tool }: { tool: CliToolStatus | null }): JSX.Element | null {
  if (!tool || !tool.installed) return null;
  return (
    <span className="acc-cli-chip" title={tool.program ?? undefined}>
      <Check size={11} aria-hidden="true" />
      {cliToolHeadline(tool)}
    </span>
  );
}

export interface CliToolCardProps {
  spec: ProviderSpec;
  tool: CliToolStatus;
  state: CliInstallState;
  /** A login or a form is up — the install is inert until it closes, like every other add affordance. */
  busy: boolean;
  onInstall: () => void;
}

export function CliToolCard({ spec, tool, state, busy, onInstall }: CliToolCardProps): JSX.Element {
  const installing = state.phase === 'installing';
  const tail = outputTail(state.output);

  return (
    <div className="acc-cli-card">
      <div className="acc-cli-card-icon" aria-hidden="true">
        {/* The endpoint form's spinner, reused rather than re-declared — one
            rotation idiom for the whole modal. */}
        {installing ? <Loader size={14} className="acc-endpoint-spin" /> : <Download size={14} />}
      </div>
      <div className="acc-cli-card-body">
        <div className="acc-cli-card-title">{cliToolHeadline(tool)}</div>
        <div className="acc-cli-card-note">{cliToolRationale(spec, tool)}</div>

        <div className="acc-cli-card-run">
          {/* Selectable, and deliberately the SAME string the button runs — a
              user without npm, or one who would rather see it happen in their
              own terminal, can copy exactly what Francois would have done. */}
          <code className="acc-cli-cmd">{installCommand(tool)}</code>
          <span className="acc-cli-card-actions">
            <button
              type="button"
              className="acc-cli-install"
              disabled={busy || installing}
              onClick={onInstall}
            >
              {installButtonLabel(state, tool)}
            </button>
            <a
              className="acc-cli-docs"
              href={tool.docsUrl}
              target="_blank"
              rel="noreferrer"
              title={`${spec.name} CLI documentation`}
            >
              Docs
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          </span>
        </div>

        {/* npm's own words, live while it runs and kept after a failure. The
            transcript is what turns "it didn't work" into an EACCES a user can
            act on, so it outlives the run that produced it. */}
        {tail !== '' && <pre className="acc-cli-log">{tail}</pre>}
        {state.phase === 'failed' && state.error && (
          <div className="acc-cli-error">{installErrorText(state.error)}</div>
        )}
      </div>
    </div>
  );
}
