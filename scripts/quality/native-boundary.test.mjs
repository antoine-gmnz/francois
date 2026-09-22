import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { nativeBoundaryFindings } from './native-boundary.mjs';

const root = fileURLToPath(new URL('../../src-tauri/src/', import.meta.url));
function rustFiles(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return rustFiles(`${dir}/${entry.name}`, path);
    return entry.name.endsWith('.rs') ? [{ path, source: readFileSync(`${dir}/${entry.name}`, 'utf8') }] : [];
  });
}
test('every production Rust file satisfies the native boundary, tool-executor and seam policy', () => {
  const files = rustFiles(root.slice(0, -1), 'src-tauri/src');
  assert.ok(files.some(f => f.path === 'src-tauri/src/session/adapter/claude_code.rs'));
  assert.deepEqual(nativeBoundaryFindings(files), []);
});
test('migrated Codex execution publishes through a session port', () => {
  for (const file of ['session/adapter/codex/runner.rs', 'session/adapter/codex/translate.rs']) {
    const source = readFileSync(root + file, 'utf8');
    assert.doesNotMatch(source, /use tauri|app\.state|append_transcript\(|emit\(/);
  }
});
test('session application imports values and explicit ports only', () => {
  for (const file of readdirSync(root + 'session/application').filter(f => f.endsWith('.rs') && !f.includes('test'))) {
    const source = readFileSync(root + 'session/application/' + file, 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(source, /use tauri|std::process|\bEngine\b|adapter::|legacy_bridge|runtime_bridge/);
  }
});
