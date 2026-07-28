// Cohorte Dashboard — a Francois plugin.
//
// The cohorte dashboard (`npx cohorte dashboard`) is a dependency-free node
// server on 127.0.0.1:4317 that serves a React cockpit plus a small JSON API.
// The React half cannot run here and is not meant to: a Francois plugin returns
// a declarative PanelSpec that Francois draws with its own components, so there
// is no place for third-party markup. What this plugin does is read the JSON
// half and render the fleet the way the rest of the app looks.
//
// One self-contained file, no imports — that is the v1 plugin contract. The only
// capability it asks for is `network` limited to 127.0.0.1, because the server it
// talks to is on your own machine.
//
// It deliberately does NOT touch the dashboard's action endpoints
// (POST /api/action → install / update / reset / claude). Those spawn processes;
// a panel that refreshes every 30 seconds has no business holding a trigger for
// them, and the plugin sandbox's 15-second fetch timeout could not follow their
// streamed output anyway.

const DEFAULT_PORT = 4317;

/** Read the configured port, falling back to cohorte's own default. */
function baseUrl() {
  const settings = francois.settings.get();
  const port = Number(settings.port) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * GET a JSON endpoint. Returns `{ ok, data }` or `{ ok: false, reason }`.
 *
 * A connection failure is the EXPECTED state, not an error: the dashboard is a
 * separate process the user starts by hand, so "not running" has to render as a
 * calm instruction rather than a red error card.
 */
async function getJson(path) {
  try {
    const res = await francois.fetch(`${baseUrl()}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, reason: `dashboard returned ${res.status}` };
    return { ok: true, data: JSON.parse(res.text) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * The project array out of a `/api/fleet` response.
 *
 * The server answers `{ projects: [...] }`; older builds answered a bare array.
 * Accepting both costs one line and means a dashboard version bump cannot empty
 * the pane silently — which is exactly how this would fail if it were wrong.
 */
function projectsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.projects)) return data.projects;
  return [];
}

/** Freshness → a tone + a short label. `-1` is cohorte's "unknown". */
function freshness(v) {
  if (v === undefined || v === null || v === -1) return { tone: 'dim', label: '?' };
  if (v === 0) return { tone: 'success', label: 'current' };
  if (v === 1) return { tone: 'warn', label: '1 behind' };
  return { tone: 'error', label: `${v} behind` };
}

/** The health summary as a compact `ok/warn/bad` triple, worst-first in tone. */
function healthBadge(summary) {
  if (!summary) return null;
  const bad = summary.bad || 0;
  const warn = summary.warn || 0;
  const ok = summary.ok || 0;
  const tone = bad > 0 ? 'error' : warn > 0 ? 'warn' : 'success';
  return { type: 'badge', value: `${ok}/${warn}/${bad}`, tone };
}

const text = (value, tone, wrap) => {
  const node = { type: 'text', value: String(value) };
  if (tone) node.tone = tone;
  if (wrap) node.wrap = true;
  return node;
};

/** The "start it yourself" state — a plugin cannot spawn the server (by design). */
function notRunning(reason) {
  return {
    version: 1,
    nodes: [
      text('dashboard not running', 'warn'),
      text('run `cohorte dashboard` in a terminal', 'dim', true),
      { type: 'divider' },
      text(reason, 'dim', true),
      { type: 'action', label: 'retry', commandId: 'refresh', keyhint: '⏎' },
    ],
  };
}

export default {
  async panel() {
    const settings = francois.settings.get();
    const [fleet, versions] = await Promise.all([getJson('/api/fleet'), getJson('/api/versions')]);

    if (!fleet.ok) return notRunning(fleet.reason);

    const projects = projectsOf(fleet.data);
    const nodes = [];

    // The global core banner, when /api/versions answered.
    if (versions.ok && versions.data) {
      const core = freshness(versions.data.freshness);
      nodes.push({
        type: 'row',
        align: 'between',
        children: [
          text('core', 'dim'),
          {
            type: 'row',
            gap: 'sm',
            children: [
              text(versions.data.installedVersion || '—'),
              { type: 'badge', value: core.label, tone: core.tone },
            ],
          },
        ],
      });
      nodes.push({ type: 'divider' });
    }

    // The fleet itself. `selectable` makes this the pane's keyboard target, so
    // ↑/↓ move and ⏎ fires the first action inside the selected row.
    nodes.push({
      type: 'list',
      selectable: true,
      emptyText: 'no projects tracked — add one in the dashboard',
      items: projects.map((p) => {
        const f = freshness(p.versions && p.versions.freshness);
        const row = [text(p.name || p.path, p.exists === false ? 'error' : undefined)];

        if (p.error) {
          row.push({ type: 'badge', value: 'error', tone: 'error' });
        } else {
          if (settings.showHealth) {
            const health = healthBadge(p.summary);
            if (health) row.push(health);
          }
          row.push({ type: 'badge', value: `${p.specs || 0} specs`, tone: 'dim' });
          row.push({ type: 'badge', value: f.label, tone: f.tone });
        }
        // The action carries the path so `open-project` can fetch its detail.
        row.push({
          type: 'action',
          label: '›',
          commandId: 'open-project',
          args: { path: String(p.path || '') },
        });
        return { type: 'row', align: 'between', children: row };
      }),
    });

    // Whatever the last `open-project` looked up, rendered underneath.
    const detail = await francois.storage.get('detail');
    if (detail && detail.name) {
      nodes.push({ type: 'divider' });
      nodes.push(text(detail.name, 'accent'));
      nodes.push({
        type: 'stack',
        gap: 'sm',
        children: (detail.lines || []).map((l) => text(l, 'dim', true)),
      });
    }

    return { version: 1, nodes };
  },

  async statusBar() {
    const fleet = await getJson('/api/fleet');
    if (!fleet.ok) return null; // silent when the dashboard is not running

    const projects = projectsOf(fleet.data);
    const stale = projects.filter((p) => {
      const v = p.versions && p.versions.freshness;
      return typeof v === 'number' && v > 0;
    }).length;
    const unhealthy = projects.filter((p) => p.summary && p.summary.bad > 0).length;

    if (unhealthy > 0) {
      return { version: 1, text: `${unhealthy} failing`, tone: 'error', badge: 'coh' };
    }
    if (stale > 0) {
      return { version: 1, text: `${stale} stale`, tone: 'warn', badge: 'coh' };
    }
    return { version: 1, text: `${projects.length} projects`, tone: 'dim', badge: 'coh' };
  },

  commands: {
    /** Re-render. The core invalidates every surface after a command settles. */
    async refresh() {
      await francois.storage.remove('detail');
    },

    /** Fetch one project's /api/state and stash a few lines for the panel. */
    async 'open-project'(ctx) {
      const path = ctx.args && ctx.args.path;
      if (!path) return;
      const res = await getJson(`/api/state?project=${encodeURIComponent(path)}`);
      if (!res.ok) {
        francois.log('open-project failed', res.reason);
        return;
      }
      const s = res.data || {};
      const profile = s.profile || {};
      const lines = [];
      if (profile.one_liner) lines.push(profile.one_liner);
      if (Array.isArray(profile.surfaces)) {
        lines.push(`surfaces: ${profile.surfaces.map((x) => x.key).join(', ')}`);
      }
      if (s.summary) {
        lines.push(`checks: ${s.summary.ok} ok · ${s.summary.warn} warn · ${s.summary.bad} bad`);
      }
      if (Array.isArray(s.specs)) lines.push(`specs: ${s.specs.length}`);
      await francois.storage.set('detail', { name: profile.name || path, lines });
    },
  },
};
