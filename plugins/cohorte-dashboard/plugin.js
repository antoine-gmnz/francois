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
//
// Since 1.1.0 it also holds `readState` and `driveSessions`, which is how the
// fleet becomes actionable: a project the dashboard reports as failing or stale
// can be handed to a Claude session as a prompt. `driveSessions` cannot SEND
// anything — `francois.session.prompt` only mints a request that appears as an
// Approve/Deny card in the transcript, showing the exact text. The human sends
// it. That is why routing cohorte's work through a session is safe while
// POST /api/action still is not.

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

/**
 * Compare two absolute paths for "same directory".
 *
 * cohorte reports whatever the user typed when adding the project; a Francois
 * session reports its own cwd. On Windows those routinely differ by separator
 * and by drive-letter case for the very same folder, so a raw `===` would match
 * almost nothing and the fleet rows would silently never find their session.
 */
function samePath(a, b) {
  const norm = (p) =>
    String(p || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  const na = norm(a);
  return na !== '' && na === norm(b);
}

/**
 * Which session should receive a prompt about `projectPath`.
 *
 * Preference order: a session already open ON that project (the whole point —
 * the work belongs where the files are), then the session the user is looking
 * at. Never an arbitrary third session: sending a prompt about project A into
 * an unrelated project B's session is worse than doing nothing, even with the
 * approval card in front of it.
 */
function pickSession(sessions, projectPath, ctxSessionId) {
  const onProject = sessions.filter((s) => samePath(s.cwd, projectPath));
  if (onProject.length > 0) {
    // Prefer one that is not mid-turn, so the prompt is not queued behind work.
    const idle = onProject.find((s) => s.status === 'idle');
    return (idle || onProject[0]).id;
  }
  if (ctxSessionId && sessions.some((s) => s.id === ctxSessionId)) return ctxSessionId;
  return null;
}

/**
 * Request an injection, and leave a line in the panel saying what happened.
 *
 * FR-56: the outcome of a request is never reported back to the plugin — it
 * cannot learn whether the human approved. So the note deliberately says the
 * card was raised, not that anything was sent.
 */
async function requestPrompt(projectPath, ctxSessionId, prompt) {
  const sessions = await francois.sessions.list();
  const sessionId = pickSession(sessions, projectPath, ctxSessionId);
  if (!sessionId) {
    await francois.storage.set('note', {
      tone: 'warn',
      text: 'no session open on that project — open one first',
    });
    return;
  }
  await francois.session.prompt(sessionId, prompt);
  await francois.storage.set('note', {
    tone: 'accent',
    text: 'prompt sent for approval — see the session transcript',
  });
}

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

        const behind = p.versions && p.versions.freshness;
        const failing = p.summary && p.summary.bad > 0;

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

        // Actionable rows only. An action offered on a healthy, current project
        // would raise an approval card for a prompt that has nothing to say.
        if (failing) {
          row.push({
            type: 'action',
            label: '⚑ fix',
            commandId: 'fix-health',
            args: { path: String(p.path || ''), name: String(p.name || p.path || '') },
          });
        } else if (typeof behind === 'number' && behind > 0) {
          row.push({
            type: 'action',
            label: '↑ update',
            commandId: 'update-core',
            args: {
              path: String(p.path || ''),
              name: String(p.name || p.path || ''),
              behind: String(behind),
            },
          });
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

    // The outcome of the last command, if it left one.
    const note = await francois.storage.get('note');
    if (note && note.text) {
      nodes.push({ type: 'divider' });
      nodes.push(text(note.text, note.tone || 'dim', true));
    }

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

  /**
   * The COHORTE main tab: cohorte's own React cockpit, framed.
   *
   * This is the one place the React half DOES run — not here in the isolate, but
   * in a frame the app opens at the URL below. The plugin never sees that page
   * and cannot script it; it only names it, and Francois refuses any host
   * outside `capabilities.network.hosts`.
   *
   * The probe is not ceremony. Returning a URL for a server that is down would
   * frame a browser connection-error page, which tells the user nothing about
   * what to do; the message does.
   */
  async tab() {
    const probe = await getJson('/api/versions');
    if (!probe.ok) {
      return {
        version: 1,
        message:
          'cohorte dashboard is not running.\n\nStart it with `cohorte dashboard`, ' +
          'then retry. Francois cannot start it for you — no plugin can cause a ' +
          'process to run.',
        action: { label: 'retry', commandId: 'refresh' },
      };
    }
    return { version: 1, url: baseUrl() };
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
      await francois.storage.remove('note');
    },

    /**
     * Hand a project's failing /doctor checks to a Claude session.
     *
     * The prompt names the project explicitly rather than saying "this project":
     * the session that receives it may not be the one the user was looking at,
     * and the approval card shows this text with no other context.
     */
    async 'fix-health'(ctx) {
      const a = ctx.args || {};
      if (!a.path) return;
      await requestPrompt(
        a.path,
        ctx.sessionId,
        `The cohorte dashboard reports failing /doctor checks for ${a.name || a.path} ` +
          `(${a.path}).\n\nRun /doctor, then fix each failure it reports. Explain what ` +
          `you changed and why before making the edits.`,
      );
    },

    /** Hand a stale pipeline core to a Claude session. */
    async 'update-core'(ctx) {
      const a = ctx.args || {};
      if (!a.path) return;
      const behind = Number(a.behind) || 0;
      await requestPrompt(
        a.path,
        ctx.sessionId,
        `The cohorte pipeline core for ${a.name || a.path} (${a.path}) is ${behind} ` +
          `release${behind === 1 ? '' : 's'} behind the latest.\n\nRun /update-pipeline to ` +
          `bring it current, then summarise what changed in PIPELINE.md and the rendered ` +
          `agent files.`,
      );
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
