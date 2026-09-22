import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('the real CLI accepts allowed source and exits 1 for a forbidden production import', () => {
  const tempParent = resolve(tmpdir());
  const fixture = mkdtempSync(join(tempParent, 'francois-boundary-check-'));
  const quality = join(fixture, 'scripts', 'quality');
  const application = join(fixture, 'src-tauri', 'src', 'session', 'application');
  try {
    mkdirSync(quality, { recursive: true });
    mkdirSync(application, { recursive: true });
    const origin = dirname(fileURLToPath(import.meta.url));
    for (const file of ['check.mjs', 'conventions.mjs', 'native-boundary.mjs', 'sarif.mjs']) {
      copyFileSync(join(origin, file), join(quality, file));
    }
    const source = join(application, 'mod.rs');
    const run = () => spawnSync(process.execPath, [join(quality, 'check.mjs')], {
      cwd: fixture, encoding: 'utf8', windowsHide: true,
    });
    writeFileSync(source, 'use crate::ipc::AppError;\n');
    expect(run().status).toBe(0);
    writeFileSync(source, 'use tauri::AppHandle as Context;\n');
    const forbidden = run();
    expect(forbidden.status).toBe(1);
    expect(forbidden.stdout).toContain('native-application-boundary');
    expect(forbidden.stdout).toContain('src-tauri/src/session/application/mod.rs');
    // Claude08 is migrated: its adapter path is enforced by the same CLI.
    writeFileSync(source, 'use crate::ipc::AppError;\n');
    const claude = join(fixture, 'src-tauri', 'src', 'session', 'adapter', 'claude_code.rs');
    mkdirSync(dirname(claude), { recursive: true });
    writeFileSync(claude, 'use super::{TurnContext, TurnControl};\n');
    expect(run().status).toBe(0);
    writeFileSync(claude, 'use crate::session::*;\n');
    const glob = run();
    expect(glob.status).toBe(1);
    expect(glob.stdout).toContain('src-tauri/src/session/adapter/claude_code.rs');
    // Task 11 AC-3: a local tool executor outside the Francois bridge fails too.
    writeFileSync(claude, 'fn execute_tool_call() {}\n');
    expect(run().status).toBe(1);
  } finally {
    // Only remove the unique directory this test created inside the OS temp
    // directory, never a computed workspace/repository path.
    if (dirname(resolve(fixture)) === tempParent) rmSync(fixture, { recursive: true, force: true });
  }
});
