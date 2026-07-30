# Troubleshooting

This page covers the problems most likely to come up around installing, launching, and running
Francois day to day — and what's actually happening under the hood in each case, so the fix
makes sense rather than being a blind incantation.

## `npm i -g francois` fails, or nothing installs

Francois ships as an npm package with no bundled binaries: the postinstall script downloads the
matching platform build from the project's GitHub releases, verifies it against a sha256 digest
baked in at publish time, and registers it with your desktop (Start Menu shortcut on Windows,
app bundle in `~/Applications` on macOS, `.desktop` launcher on Linux). If the install itself
fails, check:

- **Node version.** Francois requires **Node 18+**. An older Node is the most common cause of a
  postinstall failure — check with `node --version` and upgrade if needed.
- **Network access to GitHub releases.** The postinstall downloads from
  `https://github.com/antoine-gmnz/francois/releases`. On a locked-down network or CI box, set
  `FRANCOIS_DOWNLOAD_BASE` to point at a mirror, or `FRANCOIS_SKIP_DOWNLOAD=1` to skip the
  download step entirely (for example in an air-gapped setup where the binary is provisioned
  another way).
- **Unsupported platform.** Prebuilt archives only exist for macOS (universal), Windows x64, and
  Linux x64. On anything else, the postinstall has nothing to fetch — build from source instead.

## The app won't launch after a successful install

If `npm i -g francois` completed but the app itself won't start (or starts and immediately
errors), check the requirements from the package's own README, in order:

- **Claude Code on `PATH`, and authenticated.** Francois spawns `claude` per session — if the
  `claude` binary isn't resolvable on `PATH`, or isn't logged in, session creation will fail even
  though the Francois app itself opened fine.
- **`git` on `PATH`.** Required for the DIFF tab (and for worktree-isolated sessions, below).
  Without it, git-backed features fail even if everything else is fine.
- **Windows: the WebView2 runtime.** Francois's UI is a webview rendered by WebView2. It's
  preinstalled on Windows 11 and current Windows 10, but a stripped-down or older Windows install
  may be missing it — install it from Microsoft's WebView2 runtime page if the app fails to
  render at all.
- **Re-register the desktop entry.** If the Start Menu shortcut / Dock icon / `.desktop` launcher
  is missing or broken (for example after a headless install, or if the entry was deleted by
  hand), run `francois shortcut` to re-register it without touching the underlying npm package.
- **Run attached for diagnostics.** `francois --attach` launches the app in the foreground with
  its output attached to your terminal, which is the quickest way to see why it's failing rather
  than silently not appearing.

## No SmartScreen / Gatekeeper warning — is that expected?

Yes. Windows SmartScreen and macOS Gatekeeper key off the Mark-of-the-Web / `com.apple.quarantine`
attribute that a **browser** attaches at download time. Because Francois's postinstall fetches
the binary via a CLI (npm) rather than a browser, the download never carries that attribute — so
the same unsigned build that would get blocked as a `.dmg` or `.exe` download launches clean
here, with no certificate prompt and no *More info → Run anyway* / right-click → Open step. This
is the documented reason the package installs this way at all, not a sign that verification was
skipped — the sha256 digest check still runs during postinstall regardless.

## A session's previous thread is unavailable after reopening the app

Francois persists each session's full transcript and its underlying Claude thread id so that
quitting and reopening the app resumes the same conversation, not a blank one. On the very next
message you send in a reopened session, the core passes that persisted id to `claude --resume`.

Occasionally Claude has since pruned or expired that thread server-side, so the resume is
rejected. This is expected and handled automatically, not an error to work around:

- Francois detects the rejected resume, clears the stale thread id, and **transparently re-runs
  your same message on a fresh thread** — no need to resend anything yourself.
- The new thread id is captured and persisted, so future turns resume normally again.
- A small dismissible banner appears in the conversation view: *"previous thread unavailable —
  continuing fresh."* It doesn't clear your transcript or block input — the full prior
  conversation stays exactly as it was, only the underlying thread identity changed. The banner
  clears when you dismiss it or send your next message.

There is nothing to configure here and no data is lost — the only visible effect is that one
banner and, going forward, a new Claude-side thread underneath the same Francois session.

## Orphaned worktree directories

Sessions can optionally be isolated in a dedicated `git worktree`, created at
`<repo-parent>/.francois-worktrees/<repo-name>/<branch-slug>` so parallel sessions on the same
repo get independent checkouts, independent diffs, and independent commits. Francois manages the
git side of this (`git worktree add`, later `git worktree remove` + `git worktree prune`) as long
as it's the one asking.

Two situations leave a worktree directory behind that Francois no longer tracks:

- **A crash mid-create.** If the app is killed between creating the worktree and finishing session
  setup, the directory can be left on disk without a corresponding session.
- **Deleting a dirty or unpushed worktree session.** Francois hard-blocks worktree *directory*
  removal whenever the tree has uncommitted changes or commits not present on the branch's
  upstream — there is no override, and Francois will never run `git worktree remove --force` on
  your behalf. Confirming the delete in this state removes the session from Francois but
  deliberately **keeps the directory** (and the branch) on disk.

This is accepted, not a bug: the spec for this feature explicitly rejects building a worktree
inventory or an orphan sweeper. The only mitigations Francois applies are running
`git worktree prune` before every new `git worktree add` (so a stale admin entry doesn't block a
future create) and, when you try to open a session on a branch that's already checked out
elsewhere, offering to open a session in that existing worktree instead of erroring.

**Manual cleanup:** run `git worktree prune` (and, if you're sure the leftover directory's changes
are no longer needed, remove the directory yourself and then prune) from inside the **source
repository** — not the worktree directory itself. `git worktree list --porcelain` in the source
repo is the authoritative way to see what git currently considers a live worktree versus admin
cruft; Francois never re-derives paths from the directory naming scheme, so trust that output over
guessing from the folder name.

## Uninstalling cleanly

Use the app's own uninstall command rather than a bare npm uninstall:

```sh
francois uninstall
```

This unregisters the desktop entry (Start Menu shortcut, `~/Applications` bundle, or `.desktop`
launcher) and then removes the npm package — the supported, complete way to remove Francois.

A **bare `npm uninstall -g francois`** is not equivalent: current npm (v7+) doesn't run the
package's `preuninstall` hook that a plain uninstall would need to clean up the desktop
integration. The npm package itself is removed, but the app bundle, Start Menu shortcut, or
`.desktop` entry is left behind on disk.

If you only want to remove the desktop shortcut without touching the npm package (for example to
re-register it fresh), use:

```sh
francois shortcut --remove
```

followed by `francois shortcut` to re-create it, if needed — this pair never installs or removes
the underlying package, only the desktop registration.
