> Project profile & pipeline facts: **@PIPELINE.md**
>
> Pipeline: global core — run `npx cohorte@latest update --global` (or the installer) to refresh if
> `/cohorte-brainstorm`, `/cohorte-build` etc. are missing.

# Francois

Native desktop terminal app (Tauri 2: Rust core in `src-tauri/`, React 18 + TypeScript webview in
`src/`) that orchestrates Claude Code sessions. Product description: `PROJECT.md`. Stack, surfaces,
conventions, commands, and the feature map: `PIPELINE.md`. Feature specs live in `specs/<id>.md`.

Ships primarily as an npm package (`npm i -g francois`) rather than through the native
installers — see `packaging/npm/`. It is **not a surface**: zero dependencies, plain CommonJS,
no contract types.
