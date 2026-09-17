---
id: updating-bug
title: Recognize npm installs after a Node version switch
status: shipped
kind: patch
created: 2026-09-17
depends_on: [self-update]
---

# Updating after switching Node versions

The running Windows executable belongs to NVM's Node 18 installation (app
0.37.1), while the active npm root belongs to Node 21 (app 0.38.0). Both have
valid install records. Checking only the active root incorrectly classifies the
running copy as manual, and a shortcut targeting the old version keeps launching
it after a successful npm update.

## Requirements

- Amend self-update FR-5: keep the active global root check, including macOS
  bundle matching. If that record does not match, also check the running
  executable's own `francois/vendor/install.json`. Require the expected package
  layout and a record naming the running executable; unrelated, missing and
  corrupt records must still fail. An available npm global root remains required.
- Use the same detection for checking and applying updates. Preserve the running
  session guard. The existing helper installs into the active npm root and
  rereads that root's record to launch the updated copy; the old executable is
  only its fallback if the update fails or the new record cannot be read.
- Windows desktop registration resolves the executable to its physical path.
  Shortcuts remain pinned to the selected installation when NVM switches Node
  versions; terminal launches still follow the active Node version. On this
  machine, the user explicitly selected the Node 21.7.3 copy for OS launches.
  Keep the install record tied to the actual payload.
- An unverifiable record must not claim that the app was never installed by npm.
- Document reopening the active installation and replacing stale desktop pins.

## Validation

Regression fixtures cover two distinct npm roots, a mismatched local record,
the apply decision after a Node switch, resolving a real directory junction, and
missing executable paths. Only temporary files are used. Do not update, launch,
or stop the installed app while diagnosing this issue from its own terminal.

The regression run first failed on provenance detection and the apply decision
for the older Node installation. After the fix, all 70 Rust update tests and
89 packaging/update UI tests passed. TypeScript, ESLint, rustfmt, Clippy across
all targets and repository conventions passed (conventions retain existing warnings).

The user's subsequent clarification requires fixed desktop targets, not following
NVM's active junction. The revised desktop regression failed before the change
and all 46 packaging tests passed afterward, with ESLint clean. Windows launcher
inspection confirmed the Start Menu already selected Node 21.7.3, while the
hidden taskbar pin still selected Node 18.20.8. Both links were backed up and
their saved targets verified against the Node 21.7.3 executable without starting
or stopping the app. No additional App Paths or application open-command
registrations were found.
