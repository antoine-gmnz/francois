// multi-account FR-34..FR-36 — the Accounts modal, rebuilt as redesign turn 8b
// ("Credential vault"):
//
//   ┌ PROVIDERS & ACCOUNTS                                          n ┐
//   │ ┌ rail ────────┐ ┌ detail ─────────────────────────────────────┐│
//   │ │ CONNECTED    │ │ ▣ Anthropic  · 2 logins    [+ Add login]    ││
//   │ │  ▣ Anthropic │ │ CLI LOGINS ─────────────────────────────    ││
//   │ │  ▣ OpenAI    │ │  ┌ card · pills · gauges · sessions ┐        ││
//   │ │ AVAILABLE    │ │ API KEYS ──────────────── [+ Add key]       ││
//   │ │  ▣ Google …  │ │  ┌ dashed key row ┐                         ││
//   │ └──────────────┘ └─────────────────────────────────────────────┘│
//   └ ↑↓ move · ←→ provider · ⏎ default · r rename · del remove · a add┘
//
// Why the shape changed: the shipped modal was a flat list of Claude logins.
// With `codex` and OpenAI-compatible endpoints in play, the list gained two
// axes it never had — which PROVIDER, and whether the credential is a CLI
// login (a config dir, a plan, a quota that resets) or an API key (a secret, a
// base URL, no ceiling). A quota bar and a key are not the same object and no
// longer share a column.
//
// Every provider in the catalog is a row, connected or not, and a provider we
// cannot authenticate yet says so in its own pane rather than being hidden —
// see providers.ts, which owns all of that as pure, vitest-covered functions.
//
// Unchanged from before: it does NOT re-read the registry. FR-7 makes every
// mutation emit account.list with the full list and App.tsx's feed writes that
// into the store, so the store IS this modal's source of truth. The mutations
// still resolve the fresh list; that is used only to keep the cursor honest
// across a removal.
//
// Four states, now scoped to the RIGHT PANE instead of the whole modal (the
// designer's note: "the login terminal takes over this pane rather than the
// whole modal"):
//
//   list           the selected provider's credentials
//   login          AccountLoginView takes over the pane while a login runs
//   rename         the label becomes an inline input on its card
//   remove-confirm the compact confirm banner above the two panes
//
// Keyboard (§3): ↑/↓ move within a provider · ←/→ change provider ·
// Enter set default · r rename · Del remove · a add · Esc close (or cancel the
// login / the form / the confirm).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountId, AppError } from '../../../contract/common';
import type { Account, CliToolId, CliToolStatus } from '../../../contract/multi-account';
import {
  accountCliTools,
  accountCodexLogin,
  accountGrokLogin,
  accountInstallCli,
  accountLoginCancel,
  accountRemove,
  accountRename,
  accountSetDefault,
  projectList,
} from '../../lib/api';
import { useMounted } from '../../lib/hooks/useMounted';
import { useStore } from '../../lib/store';
import { seedAccountUsage } from '../usage/usage';
import AccountLoginView from './AccountLoginView';
import { CodexForm } from './CodexForm';
import { EndpointForm } from './EndpointForm';
import { GrokForm } from './GrokForm';
import { ProviderDetail } from './ProviderDetail';
import { ProviderRail } from './ProviderRail';
import { RemoveAccountConfirm } from './RemoveAccountConfirm';
import {
  ACCOUNTS_KEY_HINTS,
  accountIsCodex,
  accountIsEndpoint,
  accountIsGrok,
  accountSessionCounts,
  accountUsageProbeable,
  moveCursor,
  newlyAddedAccountId,
  startCliToolsFeed,
} from './accounts';
import { IDLE_INSTALL, findCliTool, reduceInstall, type CliInstallState } from './cliTools';
import {
  accountSessionNames,
  cliSectionState,
  findGroup,
  keySectionState,
  providerGroups,
  providerIdForAccount,
  resolveSelectedProvider,
  splitRail,
  type ProviderId,
} from './providers';
import './accounts.css';

/** Which login this is: a brand-new account, or FR-17's re-login into a row. */
type LoginTarget = { accountId?: string } | null;

/**
 * The endpoint form's target. `account` present ⇒ editing it; otherwise the
 * provider prefill redesign 8b's "+ Add key" hands in (providers.ts owns the
 * URLs, so this carries values, never a ProviderId to look up again).
 */
type EndpointTarget = { account?: Account; baseUrl?: string; label?: string } | null;

export default function AccountsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const accounts = useStore((s) => s.accounts);
  const setAccounts = useStore((s) => s.setAccounts);
  const sessions = useStore((s) => s.sessions);
  const usageByAccount = useStore((s) => s.usageByAccount);
  const setAccountUsage = useStore((s) => s.setAccountUsage);
  const autoAdd = useStore((s) => s.accountsAutoAdd);
  const setAutoAdd = useStore((s) => s.setAccountsAutoAdd);

  // The provider the rail is pointed at. A PREFERENCE, not the answer:
  // resolveSelectedProvider re-derives the live value every render, so a
  // provider that empties out mid-session can never leave the pane orphaned.
  const [providerPref, setProviderPref] = useState<ProviderId | null>(null);
  // Keyed by account id rather than by index: the pane draws two lists (logins,
  // then keys) and an index into "whichever list this row was in" breaks the
  // moment a credential moves between them.
  const [cursorId, setCursorId] = useState<AccountId | null>(null);
  const [login, setLogin] = useState<LoginTarget>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  // multi-provider-endpoint FR-13: the inline add/edit endpoint form.
  const [endpointForm, setEndpointForm] = useState<EndpointTarget>(null);
  // multi-provider-codex FR-24: the third add form. Separate state rather than a
  // discriminated `addForm` union, so the two existing forms keep their exact
  // open/close conditions and nothing about the endpoint flow moves.
  const [codexForm, setCodexForm] = useState(false);
  // multi-provider-grok FR-20: the fourth add form, same shape as codexForm.
  const [grokForm, setGrokForm] = useState(false);
  // The vendor CLIs, probed once per modal open. Machine-scoped rather than
  // account-scoped, so it lives HERE and not in the account store: the registry
  // survives the modal closing, this fact does not — a user who installs `codex`
  // in a terminal must see the truth on the next open, not a cached "missing".
  const [cliTools, setCliTools] = useState<CliToolStatus[]>([]);
  // Keyed by tool, not one slot: two providers' cards can be on screen across a
  // rail switch, and a shared slot would show `grok`'s npm output under
  // Anthropic's install.
  const [installs, setInstalls] = useState<Record<string, CliInstallState>>({});
  const alive = useMounted();
  // The live login's id, so cancel can address it from anywhere — including the
  // unmount cleanup, which must fire even when the modal is torn down by a
  // parent re-render rather than by a user action (FR-16).
  const loginIdRef = useRef<string | null>(null);
  // Guards commitRename against the delayed native `blur` a cancel triggers:
  // unmounting the (still-focused) rename <input> fires `blur` synchronously,
  // which React dispatches to the onBlur={commitRename} closure captured on
  // the PREVIOUS render — i.e. the one from before renamingId was cleared —
  // so without this flag that stale closure would silently re-commit the very
  // edit Escape just cancelled. Flipped true the instant either commitRename
  // or cancelRename actually runs, and reset only when a fresh rename starts;
  // this also makes a legitimate Enter-commit's own trailing blur a no-op
  // instead of firing accountRename twice.
  const renameHandledRef = useRef(false);

  // Memoized, and it matters: `groups` is a dependency of the keydown effect
  // below, so a fresh object every render would re-attach the window listener
  // on every keystroke of a rename draft — exactly what that effect's dep list
  // exists to avoid.
  const sessionCounts = useMemo(() => accountSessionCounts(accounts, sessions), [accounts, sessions]);
  const sessionNames = useMemo(() => accountSessionNames(accounts, sessions), [accounts, sessions]);
  const groups = useMemo(() => providerGroups(accounts, sessionCounts), [accounts, sessionCounts]);
  const providerId = resolveSelectedProvider(groups, providerPref);
  const group = findGroup(groups, providerId);
  // Visual order within a pane: logins, then keys — what ↑/↓ walks.
  const paneAccounts = useMemo(
    () => [...group.cliAccounts, ...group.keyAccounts],
    [group.cliAccounts, group.keyAccounts],
  );
  // Same defensive shape the provider selection uses: an id left over from a
  // removed row (or from another provider's pane) resolves to the first card.
  const selected =
    paneAccounts.find((a) => a.id === cursorId) ?? paneAccounts[0] ?? null;
  // `null` covers both "this provider has no CLI" and "the probe has not
  // answered" — the pane treats them the same, which is what keeps a slow probe
  // from flashing a "not installed" card at a machine that has it.
  const selectedCliTool = findCliTool(cliTools, group.spec.cliTool);
  const confirming = confirmId ? (accounts.find((a) => a.id === confirmId) ?? null) : null;
  const busy = login !== null || endpointForm !== null || codexForm || grokForm;

  // Redesign hangs a reset countdown off every quota gauge. Same granularity
  // rule the usage bar follows: one text tick a minute, not motion — the
  // countdown's finest unit IS the minute, so a faster clock buys nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // FR-34: each card shows its OWN meters, so every listed account needs a seed.
  // Cheap and idempotent — app_get_usage never probes (usage-bar FR-22), and a
  // seed for an account the live channel already covered is dropped.
  // The filter is the CAPABILITY, not a list of kinds: the seed spawns `claude`
  // with that account's dir as CLAUDE_CONFIG_DIR, which `claude` then
  // initializes — so seeding a Codex CODEX_HOME would plant a Claude profile in
  // it. Asking the table means a fourth runtime is covered the day its row is
  // added, instead of the day someone remembers to extend a negation.
  useEffect(() => {
    const stops = accounts
      .filter((a) => usageByAccount[a.id] === undefined && accountUsageProbeable(a))
      .map((a) => seedAccountUsage(a.id, setAccountUsage));
    return () => stops.forEach((stop) => stop());
    // Keyed on the ids alone: re-running on every snapshot write would restart
    // the seeds the writes are the result of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.map((a) => a.id).join(','), setAccountUsage]);

  // Probe the vendor CLIs once per open. Failures are SILENT: an unanswered
  // probe leaves `cliTools` empty, which reads as "no CLI facts" — every card
  // and the "+ Add login" block are then absent rather than wrong, and the
  // modal's actual job (managing credentials) is unaffected.
  useEffect(() => {
    void accountCliTools()
      .then((res) => {
        if (alive.current && res.ok) setCliTools(res.data);
      })
      .catch(() => {});
  }, [alive]);

  // The install sub-stream, mounted for as long as the modal is — NOT for as
  // long as a card is on screen. An install started from Anthropic's pane keeps
  // streaming while the user reads OpenAI's, and its `done` must still land.
  useEffect(
    () =>
      startCliToolsFeed({
        onOutput: (tool, data) => {
          if (!alive.current) return;
          setInstalls((prev) => ({
            ...prev,
            [tool]: reduceInstall(prev[tool] ?? IDLE_INSTALL, { kind: 'output', data }),
          }));
        },
        onDone: (tool, tools, error) => {
          if (!alive.current) return;
          // The re-probed list is what removes the card on success — the state
          // below only carries the failure transcript.
          setCliTools(tools);
          setInstalls((prev) => ({
            ...prev,
            [tool]: reduceInstall(prev[tool] ?? IDLE_INSTALL, { kind: 'done', error }),
          }));
        },
      }),
    [alive],
  );

  /**
   * Start `npm i -g` for one provider's CLI. Flipped to `installing`
   * optimistically so the button cannot be pressed twice while the invoke is in
   * flight; a refused start (npm missing, one already running) lands as the
   * failure it is, in the card rather than the modal's error bar — it is that
   * card's business and the credentials below are unaffected.
   */
  const doInstallCli = (tool: CliToolId) => {
    setInstalls((prev) => ({
      ...prev,
      [tool]: { phase: 'installing', output: '', error: null },
    }));
    void accountInstallCli({ tool })
      .then((res) => {
        if (alive.current && !res.ok) {
          setInstalls((prev) => ({
            ...prev,
            [tool]: { phase: 'failed', output: prev[tool]?.output ?? '', error: res.error },
          }));
        }
      })
      .catch(() => {
        if (!alive.current) return;
        setInstalls((prev) => ({
          ...prev,
          [tool]: {
            phase: 'failed',
            output: prev[tool]?.output ?? '',
            error: { code: 'INTERNAL', message: 'Could not reach the core' },
          },
        }));
      });
  };

  // multi-provider-codex FR-25: `codex login` for one card. Nothing to render
  // and nothing to cancel — the browser is the UI, and the card's `signedIn`
  // flips when the refreshed account.list arrives (FR-21a). Only a failure to
  // START it is worth surfacing here.
  const doCodexLogin = async (account: Account) => {
    setError(null);
    try {
      const res = await accountCodexLogin({ accountId: account.id });
      if (alive.current && !res.ok) setError(res.error);
    } catch {
      if (alive.current) setError({ code: 'INTERNAL', message: 'Could not reach the core' });
    }
  };

  // multi-provider-grok FR-21: `grok login` for one card, same shape as
  // doCodexLogin above — no PTY, no loginId, only a spawn failure to surface.
  const doGrokLogin = async (account: Account) => {
    setError(null);
    try {
      const res = await accountGrokLogin({ accountId: account.id });
      if (alive.current && !res.ok) setError(res.error);
    } catch {
      if (alive.current) setError({ code: 'INTERNAL', message: 'Could not reach the core' });
    }
  };

  // FR-16: whatever ends the login — Esc, CLOSE, the modal unmounting — kills
  // the PTY and deletes the half-written dir through this ONE path.
  const cancelLogin = () => {
    const id = loginIdRef.current;
    loginIdRef.current = null;
    if (id) void accountLoginCancel({ loginId: id }).catch(() => {});
  };

  useEffect(() => cancelLogin, []);  

  // The palette's "Add account" opens the modal straight into the login view.
  // One-shot: cleared here so re-opening the modal normally lands on the list.
  // It means the CLAUDE login specifically, so it also points the rail at
  // Anthropic — otherwise the terminal would take over some other provider's
  // pane and read as that provider's sign-in.
  useEffect(() => {
    if (!autoAdd) return;
    setAutoAdd(false);
    setProviderPref('anthropic');
    setLogin({});
  }, [autoAdd, setAutoAdd]);

  const closeLogin = () => {
    cancelLogin();
    setLogin(null);
  };

  const startRename = (account: Account) => {
    renameHandledRef.current = false;
    setRenameDraft(account.label);
    setRenamingId(account.id);
  };

  // FR-5 / design brief: Esc cancels without persisting. Marks the attempt as
  // handled BEFORE clearing renamingId, so the stale onBlur={commitRename}
  // closure the ensuing unmount fires sees renameHandledRef.current already
  // true and no-ops instead of committing the discarded draft (see the ref's
  // own comment above).
  const cancelRename = () => {
    renameHandledRef.current = true;
    setRenamingId(null);
  };

  // A rejected promise here means the Tauri bridge itself failed (not a domain
  // Result — those always resolve ok:false and are handled inline above). Same
  // guard AccountLoginView's accountAdd(...).catch(...) uses, so no mutation can
  // become an unhandled rejection.
  const onIpcRejected = () => {
    if (alive.current) setError({ code: 'INTERNAL', message: 'Could not reach the core' });
  };

  const commitRename = () => {
    if (renameHandledRef.current) return; // already cancelled, or already committed once
    renameHandledRef.current = true;
    const id = renamingId;
    setRenamingId(null);
    const target = accounts.find((a) => a.id === id);
    const label = renameDraft.trim();
    // FR-5: non-empty after trimming, and a no-op edit is not worth a round-trip.
    if (!id || !target || label === '' || label === target.label) return;
    void accountRename(id, label)
      .then((res) => {
        if (!alive.current) return;
        if (res.ok) {
          setError(null);
          setAccounts(res.data);
        } else setError(res.error);
      })
      .catch(onIpcRejected);
  };

  const setDefault = (account: Account) => {
    if (account.isDefault) return;
    void accountSetDefault(account.id)
      .then((res) => {
        if (!alive.current) return;
        if (res.ok) {
          setError(null);
          setAccounts(res.data);
        } else setError(res.error);
      })
      .catch(onIpcRejected);
  };

  const doRemove = (account: Account) => {
    setConfirmId(null);
    void accountRemove(account.id)
      .then((res) => {
        if (!alive.current) return;
        if (!res.ok) {
          setError(res.error); // e.g. ACCOUNT_NOT_REMOVABLE on the built-in (FR-8)
          return;
        }
        setError(null);
        setAccounts(res.data.accounts);
        // The cursor is by id, so a removal just stops resolving and `selected`
        // falls back to the pane's first card. Clearing it keeps that explicit.
        setCursorId(null);
        // FR-9's repointed sessions arrive as session.meta events on the session
        // stream, which pane [1] already owns — nothing to apply here.
        // The core also cleared this account from every project that named it as
        // its default, so the projects registry we hold is stale — re-read it.
        void projectList().then((res) => {
          if (!alive.current || !res.ok) return;
          useStore.getState().setProjects(res.data.projects);
          useStore.getState().setGroups(res.data.groups);
        });
      })
      .catch(onIpcRejected);
  };

  /** Flash the row a save just minted, the way a fresh login already does. */
  const flash = (id: AccountId | null) => {
    if (!id) return;
    setFreshId(id);
    window.setTimeout(() => alive.current && setFreshId(null), 1200);
  };

  // Redesign 8b: the provider's own add affordances. Which one "+ Add login"
  // means is the provider's business, not the modal's — the catalog says
  // whether this vendor is driven by `claude`, `codex` or `grok`.
  const addLogin = () => {
    if (group.spec.cliLogin === 'codex') setCodexForm(true);
    else if (group.spec.cliLogin === 'grok') setGrokForm(true);
    else if (group.spec.cliLogin === 'claude') setLogin({});
  };

  const addKey = () => {
    // `custom` is the catch-all row: it has a route but no URL of its own, and
    // borrowing its display name as a label would be worse than an empty field.
    const isCustom = group.spec.id === 'custom';
    setEndpointForm({ baseUrl: group.spec.apiBaseUrl ?? '', label: isCustom ? '' : group.spec.name });
  };

  /** `a`, and the fallback for a provider that can only be reached by key. */
  const addPrimary = () => {
    if (cliSectionState(group.spec).available) addLogin();
    else if (keySectionState(group.spec).available) addKey();
  };

  // FR-25 / multi-provider-grok FR-21: a Codex or Grok card MUST NOT reach the
  // Claude PTY login — that would run `claude` against their own config dir.
  // Routing lives here rather than in the card so the card stays a renderer
  // with one `onLogin`.
  const doLogin = (account: Account) => {
    if (accountIsCodex(account)) void doCodexLogin(account);
    else if (accountIsGrok(account)) void doGrokLogin(account);
    else setLogin({ accountId: account.id });
  };

  // §3 Keyboard. Capture phase, like every other modal in the shell, so the
  // app-wide single-letter globals never see these keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (login) closeLogin();
        else if (renamingId) cancelRename();
        else if (confirmId) setConfirmId(null);
        else if (endpointForm) setEndpointForm(null);
        else if (codexForm) setCodexForm(false);
        else if (grokForm) setGrokForm(false);
        else onClose();
        return;
      }
      // Everything below is list-state only: while the login TUI is up every
      // other key belongs to it, while renaming they belong to the input, and
      // while a form is open every key belongs to its own fields.
      if (login || renamingId || endpointForm || codexForm || grokForm) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const at = paneAccounts.findIndex((a) => a.id === selected?.id);
        const next = moveCursor(at < 0 ? 0 : at, e.key === 'ArrowDown' ? 1 : -1, paneAccounts.length);
        setCursorId(paneAccounts[next]?.id ?? null);
        return;
      }
      // Redesign 8b's second axis. The rail reads CONNECTED then AVAILABLE, so
      // ←/→ walks that same order — never the raw catalog order, which would
      // jump between the two groups on screen.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const rail = splitRail(groups);
        const order = [...rail.connected, ...rail.available];
        const at = order.findIndex((g) => g.spec.id === providerId);
        const next = moveCursor(at < 0 ? 0 : at, e.key === 'ArrowRight' ? 1 : -1, order.length);
        const target = order[next];
        if (target) {
          setProviderPref(target.spec.id);
          setCursorId(null);
        }
        return;
      }
      if (confirmId) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const account = accounts.find((a) => a.id === confirmId);
          if (account) doRemove(account);
        }
        return;
      }
      if (e.key === 'Enter' && selected) {
        e.preventDefault();
        e.stopPropagation();
        setDefault(selected);
      } else if ((e.key === 'r' || e.key === 'R') && selected) {
        e.preventDefault();
        e.stopPropagation();
        // An endpoint account's label is one field of a form, not a standalone
        // rename — the same split its pencil affordance already makes.
        if (accountIsEndpoint(selected)) setEndpointForm({ account: selected });
        else startRename(selected);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !selected.builtIn) {
        e.preventDefault();
        e.stopPropagation();
        setConfirmId(selected.id);
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        e.stopPropagation();
        addPrimary();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // Re-attaches only when the state the handler branches on actually
    // changes — not on every render (e.g. each keystroke of a rename draft),
    // like the effects above. The closures it calls (closeLogin, doRemove,
    // setDefault, startRename, addPrimary, onClose) read only refs/setters/
    // these same deps, so a version captured at that point stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login, renamingId, confirmId, endpointForm, codexForm, grokForm, selected, paneAccounts, groups, providerId, accounts, onClose]);

  return (
    <div
      className="acc-backdrop"
      onClick={() => {
        if (login) closeLogin();
        else onClose();
      }}
    >
      <div className="acc-panel acc-panel--vault" onClick={(e) => e.stopPropagation()}>
        <div className="acc-header">
          <span className="acc-title">Providers &amp; accounts</span>
          {/* The count pill beside every panel title — it also answers "did the
              new one land?" without counting cards across two panes. */}
          <span className="acc-count">{accounts.length}</span>
          <span className="acc-header-spacer" />
        </div>

        {error && <div className="acc-error">{error.message}</div>}
        {confirming && (
          <RemoveAccountConfirm
            account={confirming}
            sessions={sessions}
            onCancel={() => setConfirmId(null)}
            onConfirm={() => doRemove(confirming)}
          />
        )}

        <div className="acc-vault">
          <ProviderRail
            groups={groups}
            selected={providerId}
            onSelect={(id) => {
              setProviderPref(id);
              setCursorId(null);
            }}
          />
          <ProviderDetail
            group={group}
            usageByAccount={usageByAccount}
            sessionNames={sessionNames}
            now={now}
            cursorId={selected?.id ?? null}
            freshId={freshId}
            renamingId={renamingId}
            renameDraft={renameDraft}
            busy={busy}
            cliTool={selectedCliTool}
            cliInstall={group.spec.cliTool ? installs[group.spec.cliTool] : undefined}
            onInstallCli={() => group.spec.cliTool && doInstallCli(group.spec.cliTool)}
            takeover={
              login ? (
                <AccountLoginView
                  accountId={login.accountId}
                  onLoginId={(id) => {
                    loginIdRef.current = id;
                  }}
                  onClose={closeLogin}
                  onDone={(account) => {
                    loginIdRef.current = null;
                    if (!alive.current) return;
                    setLogin(null);
                    setError(null);
                    // The registry itself arrives as the account.list that FR-13
                    // emits right after; all this does is point the rail and the
                    // cursor at the new credential and flash it.
                    setProviderPref(providerIdForAccount(account));
                    setCursorId(account.id);
                    flash(account.id);
                  }}
                />
              ) : undefined
            }
            form={
              endpointForm ? (
                <EndpointForm
                  key={endpointForm.account?.id ?? `add:${endpointForm.baseUrl ?? ''}`}
                  account={endpointForm.account}
                  presetBaseUrl={endpointForm.baseUrl}
                  presetLabel={endpointForm.label}
                  onCancel={() => setEndpointForm(null)}
                  onSaved={(fresh) => {
                    const addedId = newlyAddedAccountId(accounts, fresh);
                    setAccounts(fresh);
                    setEndpointForm(null);
                    setError(null);
                    if (addedId) setCursorId(addedId);
                    flash(addedId);
                  }}
                />
              ) : codexForm ? (
                <CodexForm
                  onCancel={() => setCodexForm(false)}
                  onSaved={() => {
                    // Unlike EndpointForm this does not thread the fresh list
                    // through: `account_add_codex` emits account.list, which this
                    // modal already subscribes to.
                    setCodexForm(false);
                    setError(null);
                  }}
                />
              ) : grokForm ? (
                <GrokForm
                  onCancel={() => setGrokForm(false)}
                  onSaved={() => {
                    // Same as CodexForm: `account_add_grok` emits account.list,
                    // which this modal already subscribes to.
                    setGrokForm(false);
                    setError(null);
                  }}
                />
              ) : undefined
            }
            onRenameDraft={setRenameDraft}
            onRenameCommit={commitRename}
            onRenameCancel={cancelRename}
            onFocusAccount={setCursorId}
            onSetDefault={setDefault}
            onStartRename={startRename}
            onLogin={doLogin}
            onRemove={(account) => setConfirmId(account.id)}
            onEditEndpoint={(account) => setEndpointForm({ account })}
            onAddLogin={addLogin}
            onAddKey={addKey}
          />
        </div>

        {/* The keyboard model this modal has always had and never named —
            redesign's footer idiom, dim hints on one line. The isolation cost
            moved INTO the pane, where it can be said per provider (FR-36's
            single sentence was only ever true of Claude Code logins). */}
        <div className="acc-footer">
          <div className="acc-hints">
            {ACCOUNTS_KEY_HINTS.map((h) => (
              <span key={h.key} className="acc-hint">
                <span className="acc-hint-key">{h.key}</span>
                {h.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
