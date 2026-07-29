// plugin-system §8·A — the numbered pane `[6]+` and the PanelSpec renderer.
//
// This file is where the isolation becomes visible. It renders a JSON tree the
// CORE validated (FR-36) using Francois's own tokens; there is no HTML, no CSS
// string, no SVG, no `dangerouslySetInnerHTML` and no `style` value that comes
// from a plugin. `PanelTone` is the only thing a plugin can influence, and it
// resolves through `toneColor` to an existing CSS variable (FR-37).
//
// Every plugin string reaches the DOM as a text child, never as an attribute,
// a URL, or a key that selects behaviour.

import { useCallback, useEffect, useRef } from 'react';
import type { InstalledPlugin, PanelNode, PanelSpec } from '../../../contract/plugin-system';
import { pluginPaneId } from '../../../contract/plugin-system';
import { pluginsRender } from '../../lib/api';
import { useStore } from '../../lib/store';
import { invokePluginCommand } from './pluginInvoke';
import { usePluginsStore } from './pluginsStore';
import {
  CONSENT_PENDING_LINE,
  PANEL_UNSUPPORTED_VERSION,
  PANE_EMPTY_LINE,
  PANE_ERROR_TITLE,
  PANE_LOADING_LINE,
  clampSelection,
  declaredCommandIds,
  findSelectableList,
  isActionInert,
  moveListSelection,
  paneCount,
  paneCountLabel,
  paneTitle,
  refreshIntervalFor,
  selectionAction,
  shouldRefresh,
  toneColor,
  validPanelNode,
} from './plugins';

const C = {
  accent: 'var(--accent)',
  dim: 'var(--text-dim)',
  faint: 'var(--text-faint)',
  hint: 'var(--text-hint)',
  muted: 'var(--text-muted)',
  error: 'var(--error)',
  warn: 'var(--warn)',
};

const GAP = { sm: 6, md: 10 } as const;
const JUSTIFY = { start: 'flex-start', center: 'center', between: 'space-between' } as const;

/** §8·A3 — the whole vocabulary. This table IS the public look of a plugin. */
function Node({
  node,
  declared,
  onAction,
  selectedList,
  selectedIndex,
}: {
  node: PanelNode;
  declared: ReadonlySet<string>;
  onAction: (commandId: string, args?: Record<string, string | number | boolean>) => void;
  selectedList: PanelNode | null;
  selectedIndex: number;
}) {
  // FR-35: an unknown type or a wrong field type renders the placeholder. The
  // core already substitutes these, so reaching here means a spec that skipped
  // validation — the guard stays because "the renderer only draws what it
  // recognizes" must be true on its own, not by trusting an upstream.
  if (!validPanelNode(node)) {
    return <span style={{ fontSize: 11.5, color: C.faint }}>⟨invalid node⟩</span>;
  }
  const kids = (children: PanelNode[]) =>
    children.map((child, i) => (
      <Node
        key={i}
        node={child}
        declared={declared}
        onAction={onAction}
        selectedList={selectedList}
        selectedIndex={selectedIndex}
      />
    ));

  switch (node.type) {
    case 'text':
      return (
        <span
          style={{
            fontSize: 11.5,
            color: toneColor(node.tone),
            ...(node.wrap
              ? { overflowWrap: 'anywhere' as const }
              : {
                  whiteSpace: 'nowrap' as const,
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                }),
          }}
        >
          {node.value}
        </span>
      );

    case 'row':
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: GAP[node.gap ?? 'sm'],
            justifyContent: JUSTIFY[node.align ?? 'start'],
            minWidth: 0,
          }}
        >
          {kids(node.children)}
        </div>
      );

    case 'stack':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP[node.gap ?? 'sm'], minWidth: 0 }}>
          {kids(node.children)}
        </div>
      );

    case 'list': {
      // FR-41: an empty list is a single dim centred line.
      if (node.items.length === 0) {
        return (
          <div style={{ fontSize: 10.5, color: C.faint, textAlign: 'center', padding: '6px 0' }}>
            {node.emptyText ?? 'empty'}
          </div>
        );
      }
      // FR-40: only the FIRST selectable list is the keyboard target; any others
      // render as plain lists.
      const isTarget = node === selectedList;
      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {node.items.map((item, i) => {
            const selected = isTarget && i === selectedIndex;
            return (
              <div
                key={i}
                style={{
                  padding: '4px 6px',
                  borderRadius: 3,
                  minWidth: 0,
                  background: selected ? 'var(--bg-raised)' : 'transparent',
                  borderLeft: selected ? `2px solid ${C.accent}` : '2px solid transparent',
                }}
              >
                <Node
                  node={item}
                  declared={declared}
                  onAction={onAction}
                  selectedList={selectedList}
                  selectedIndex={selectedIndex}
                />
              </div>
            );
          })}
        </div>
      );
    }

    case 'badge':
      return (
        <span
          style={{
            fontSize: 9.5,
            padding: '0 6px',
            border: '1px solid var(--border-2)',
            borderRadius: 3,
            color: node.tone ? toneColor(node.tone) : C.dim,
            flexShrink: 0,
            lineHeight: 1.6,
          }}
        >
          {node.value}
        </span>
      );

    case 'keyhint':
      return (
        <span
          style={{
            fontSize: 9.5,
            padding: '0 4px',
            background: 'var(--bg-raised)',
            borderRadius: 2,
            color: C.hint,
            flexShrink: 0,
          }}
        >
          {node.value}
        </span>
      );

    case 'divider':
      return <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />;

    case 'action': {
      // FR-38: an action naming an undeclared command is dimmed and inert. The
      // renderer decides this — `action` has no `disabled` field of its own, so
      // a plugin cannot present an inert control as a live one.
      const inert = isActionInert(node.commandId, declared);
      return (
        <span
          role="button"
          tabIndex={inert ? -1 : 0}
          onClick={() => !inert && onAction(node.commandId, node.args)}
          style={{
            fontSize: 11,
            color: C.hint,
            cursor: inert ? 'default' : 'pointer',
            opacity: inert ? 0.45 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {node.label}
          {node.keyhint && (
            <span
              style={{
                fontSize: 9.5,
                padding: '0 4px',
                background: 'var(--bg-raised)',
                borderRadius: 2,
                color: C.hint,
              }}
            >
              {node.keyhint}
            </span>
          )}
        </span>
      );
    }

    case 'progress':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div style={{ flex: 1, height: 3, background: 'var(--border)', borderRadius: 2, minWidth: 0 }}>
            <div
              style={{
                width: `${Math.max(0, Math.min(100, node.percent))}%`,
                height: '100%',
                background: C.accent,
                borderRadius: 2,
              }}
            />
          </div>
          {node.label && <span style={{ fontSize: 10, color: C.faint, flexShrink: 0 }}>{node.label}</span>}
        </div>
      );

    case 'spinner':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="blink" style={{ color: C.accent, fontSize: 11 }}>
            ▪
          </span>
          {node.label && <span style={{ fontSize: 10.5, color: C.faint }}>{node.label}</span>}
        </div>
      );

    default:
      return <span style={{ fontSize: 11.5, color: C.faint }}>⟨invalid node⟩</span>;
  }
}

export default function PluginPane({
  plugin,
  hotkey,
  projectId,
  sessionId,
}: {
  plugin: InstalledPlugin;
  hotkey: string | null;
  projectId: string | null;
  sessionId: string | null;
}) {
  const id = plugin.manifest.id;
  const paneId = pluginPaneId(id);
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const focused = focusedPane === paneId;

  const spec = usePluginsStore((s) => s.renderCache[id]);
  const error = usePluginsStore((s) => s.panelError[id]);
  const selection = usePluginsStore((s) => s.selection[id] ?? 0);
  const invalidation = usePluginsStore((s) => s.invalidation[`${id}:panel`] ?? 0);
  const failures = usePluginsStore((s) => s.failures[`${id}:panel`] ?? 0);
  const setPanelSpec = usePluginsStore((s) => s.setPanelSpec);
  const setPanelError = usePluginsStore((s) => s.setPanelError);
  const setSelection = usePluginsStore((s) => s.setSelection);
  const resetFailures = usePluginsStore((s) => s.resetFailures);
  const openModal = usePluginsStore((s) => s.openModal);
  const modalOpen = usePluginsStore((s) => s.modalOpen);

  const declared = declaredCommandIds(plugin.manifest);
  const cached = spec ?? null;
  const loaded = spec !== undefined;

  const render = useCallback(async () => {
    // FR-72: on-demand only. This runs when the pane mounts, on a refresh tick,
    // and on plugin.invalidated — never for a pane that is not mounted.
    //
    // The contract says plugins_render never rejects (every domain failure is a
    // Result). A rejection therefore means the BRIDGE failed — an unbound
    // argument, an unregistered command, a panic in the handler. Left uncaught
    // that resolves nothing, so `spec` stays undefined and the pane sits on
    // "rendering…" forever with no way out. Surface it as the FR-73 error state
    // instead: it is visible, it has a retry, and it tells the truth.
    let res;
    try {
      res = await pluginsRender({ pluginId: id, surface: 'panel', projectId, sessionId });
    } catch (e) {
      setPanelError(id, e instanceof Error ? e.message : String(e));
      return;
    }
    if (res.ok) {
      if (res.data.surface === 'panel') {
        setPanelSpec(id, res.data.spec);
        setPanelError(id, null);
      }
    } else {
      setPanelError(id, res.error.message);
    }
  }, [id, projectId, sessionId, setPanelSpec, setPanelError]);

  // FR-72: mount + invalidation.
  useEffect(() => {
    if (plugin.consentPending) return;
    void render();
  }, [render, invalidation, plugin.consentPending]);

  // FR-70/FR-72/FR-73: the tick runs only while this pane is mounted AND the
  // window is visible — the frontend drives it, so a hidden window costs
  // nothing — and it stops after PLUGIN_FAILURE_LIMIT consecutive failures.
  // The conditions live in `shouldRefresh`, which is tested; re-deriving them
  // here (with a magic 5) is how they drifted last time.
  //
  // The deps name `refreshIntervalMs`, NOT `plugin.manifest`: the manifest
  // object's identity changes on every plugin.registry snapshot, which tore the
  // interval down and recreated it on every registry event.
  const intervalMs = refreshIntervalFor(plugin.manifest);
  const renderRef = useRef(render);
  renderRef.current = render;
  useEffect(() => {
    if (
      !shouldRefresh({
        intervalMs,
        documentVisible: true, // re-checked per tick below
        failures,
        consentPending: plugin.consentPending,
        enabled: true, // a mounted pane is, by construction, in scope (FR-76)
      })
    ) {
      return;
    }
    const tick = () => {
      if (document.visibilityState === 'visible') void renderRef.current();
    };
    const handle = window.setInterval(tick, intervalMs as number);
    return () => window.clearInterval(handle);
  }, [intervalMs, plugin.consentPending, failures]);

  // FR-40: while focused, this pane owns the arrow keys and ⏎.
  //
  // The modal guard mirrors app-shell's own: with FRANCOIS PLUGINS (or any
  // other modal) open, a pane behind it must not eat ↑/↓/⏎ — the same
  // convention permission-guardrails FR-29 and projects FR-37 set.
  useEffect(() => {
    if (!focused || !cached || modalOpen) return;
    const list = findSelectableList(cached.nodes);
    if (!list) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelection(id, moveListSelection(list.items.length, selection, e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        const action = selectionAction(cached, clampSelection(list.items.length, selection), declared);
        if (action) {
          e.preventDefault();
          void invokePluginCommand({ pluginId: id, commandId: action.commandId, args: action.args, projectId, sessionId });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, cached, modalOpen, selection, id, declared, projectId, sessionId, setSelection]);

  const onAction = useCallback(
    (commandId: string, args?: Record<string, string | number | boolean>) => {
      void invokePluginCommand({ pluginId: id, commandId, args, projectId, sessionId });
    },
    [id, projectId, sessionId],
  );

  const selectedList = cached ? findSelectableList(cached.nodes) : null;
  const title = paneTitle(cached?.title ?? plugin.manifest.contributes.panel?.title ?? id);

  return (
    <section
      onClick={() => setFocusedPane(paneId)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-deep)',
        border: `1px solid ${focused ? C.accent : 'var(--border-2)'}`,
        borderRadius: 5,
        overflow: 'hidden',
        minHeight: 0,
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: '0.14em', color: focused ? C.accent : C.dim, fontWeight: 700 }}>
          {title}
        </span>
        <span style={{ fontSize: 10, color: C.faint }}>{paneCountLabel(paneCount(cached), hotkey)}</span>
      </div>

      <div className="scz" style={{ flex: 1, overflow: 'auto', padding: '8px 10px' }}>
        <Body
          plugin={plugin}
          spec={cached}
          loaded={loaded}
          error={error ?? null}
          declared={declared}
          selectedList={selectedList}
          selectedIndex={cached && selectedList ? clampSelection(selectedList.items.length, selection) : 0}
          onAction={onAction}
          onRetry={() => {
            // FR-73: retry resets the counter, which restarts the timer too.
            resetFailures(id, 'panel');
            setPanelError(id, null);
            void render();
          }}
          onReview={() => openModal(id)}
        />
      </div>
    </section>
  );
}

/** §8·A4 — the four states a pane body can be in, plus the rendered spec. */
function Body({
  plugin,
  spec,
  loaded,
  error,
  declared,
  selectedList,
  selectedIndex,
  onAction,
  onRetry,
  onReview,
}: {
  plugin: InstalledPlugin;
  spec: PanelSpec | null;
  loaded: boolean;
  error: string | null;
  declared: ReadonlySet<string>;
  selectedList: PanelNode | null;
  selectedIndex: number;
  onAction: (commandId: string, args?: Record<string, string | number | boolean>) => void;
  onRetry: () => void;
  onReview: () => void;
}) {
  const line = (text: string, color: string) => (
    <div style={{ fontSize: 10.5, color, textAlign: 'center', padding: '10px 0' }}>{text}</div>
  );

  // FR-16: consent-pending outranks everything — the plugin is inert, and the
  // only thing to offer is the review that un-freezes it.
  if (plugin.consentPending) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', padding: '10px 0' }}>
        <span style={{ fontSize: 11, color: C.warn, textAlign: 'center' }}>{CONSENT_PENDING_LINE}</span>
        <span role="button" onClick={onReview} style={{ fontSize: 10.5, color: C.hint, cursor: 'pointer' }}>
          review…
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: C.error }}>{PANE_ERROR_TITLE}</span>
        <span
          style={{
            fontSize: 10.5,
            color: C.muted,
            overflowWrap: 'anywhere',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {error}
        </span>
        <span role="button" onClick={onRetry} style={{ fontSize: 10.5, color: C.hint, cursor: 'pointer' }}>
          retry
        </span>
      </div>
    );
  }

  if (!loaded) return line(PANE_LOADING_LINE, C.faint);
  // FR-34: the version IS the compatibility gate.
  if (spec && spec.version !== 1) return line(PANEL_UNSUPPORTED_VERSION, C.warn);
  if (!spec || spec.nodes.length === 0) return line(PANE_EMPTY_LINE, C.faint);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {spec.nodes.map((node, i) => (
        <Node
          key={i}
          node={node}
          declared={declared}
          onAction={onAction}
          selectedList={selectedList}
          selectedIndex={selectedIndex}
        />
      ))}
    </div>
  );
}
