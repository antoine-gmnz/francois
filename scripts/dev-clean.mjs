// Reap leftovers from a previous `npm run dev:app`, scoped to THIS checkout.
//
// Why this exists: tauri's `beforeDevCommand` spawns `npm run dev` -> shell -> vite as a
// detached tree. When the tauri window dies abnormally, that tree is orphaned and keeps
// holding the dev port, so the next run fails on vite's `strictPort`. And the dev binary
// built by `tauri dev` has the SAME image name as an installed Francois (both `francois`,
// from the Cargo package name), so killing dev by process name also kills the app the user
// is running. Everything below is matched by PATH against the repo root -- an installed
// Francois, and any unrelated dev server on the port, are never touched.
//
// Port must match vite.config.ts `server.port` and tauri.conf.json `build.devUrl`.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_PORT = 8080;
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** Repo paths appear with either slash style and any casing in a command line. */
const belongsToRepo = (text) => {
  if (!text) return false;
  const haystack = text.replace(/\\/g, '/').toLowerCase();
  return haystack.includes(REPO.replace(/\\/g, '/').toLowerCase());
};

const run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // no match / tool absent -- both mean "nothing to clean"
  }
};

const ps = (script) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).trim();

/** @returns {{pid: number, cmd: string}[]} processes listening on the dev port. */
function portListeners() {
  if (isWindows) {
    const out = ps(
      `Get-NetTCPConnection -LocalPort ${DEV_PORT} -State Listen -ErrorAction SilentlyContinue |` +
        ` ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue;` +
        ` if ($p) { "$($p.ProcessId)|$($p.ExecutablePath) $($p.CommandLine)" } }`,
    );
    return parse(out);
  }
  const pids = run('lsof', ['-nP', `-iTCP:${DEV_PORT}`, '-sTCP:LISTEN', '-t']).split('\n');
  return pids
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pid) => ({ pid: Number(pid), cmd: run('ps', ['-p', pid, '-o', 'command=']).trim() }));
}

/** @returns {{pid: number, cmd: string}[]} dev binaries built into this repo's target dir. */
function repoBinaries() {
  const target = resolve(REPO, 'src-tauri', 'target');
  if (isWindows) {
    return parse(
      ps(
        `Get-CimInstance Win32_Process -Filter "Name='francois.exe'" -ErrorAction SilentlyContinue |` +
          ` ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
      ),
    ).filter((p) => belongsToRepo(p.cmd) && p.cmd.toLowerCase().includes('target'));
  }
  return run('pgrep', ['-af', `${target}/`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split(' ');
      return { pid: Number(pid), cmd: rest.join(' ') };
    });
}

function parse(out) {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split('|');
      return { pid: Number(pid), cmd: rest.join('|') };
    })
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

function killTree(pid) {
  if (isWindows) run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

let reaped = 0;
for (const proc of portListeners()) {
  if (!belongsToRepo(proc.cmd)) {
    // Someone else's server. Bailing is the whole point -- never free a port we don't own.
    console.warn(
      `dev-clean: port ${DEV_PORT} is held by PID ${proc.pid}, which is not from this repo. Leaving it alone.`,
    );
    console.warn(`dev-clean:   ${proc.cmd.trim()}`);
    continue;
  }
  killTree(proc.pid);
  reaped++;
  console.log(`dev-clean: reaped stale dev server on port ${DEV_PORT} (PID ${proc.pid})`);
}

for (const proc of repoBinaries()) {
  killTree(proc.pid);
  reaped++;
  console.log(`dev-clean: reaped stale dev build (PID ${proc.pid})`);
}

if (reaped === 0) console.log('dev-clean: nothing to clean');
