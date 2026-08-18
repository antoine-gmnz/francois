import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, AppError } from '../../../contract/common';
import { agentsActivity, agentsDispatch, agentsKill } from '../../lib/api';
import { agentIdToDropForTrailError, collapseTrail, receiveTrailActivity, toggleTrail } from './agent-trail';
import { setPaletteAgents } from '../palette/paletteData';
import { useSessionMeta } from '../../lib/hooks/useSessionMeta';
import { sessionCapability } from '../../lib/runtimeCapability';
import { useStore } from '../../lib/store';
import { HintBar } from '../../ui/HintBar';
import { Modal, ModalHeader } from '../../ui/Modal';
import { PanelHeader } from '../../ui/PanelHeader';
import { AgentsListBody } from './AgentsListBody';
import { useAgentsFeed } from './useAgentsFeed';
import { useAgentsKeyboard } from './useAgentsKeyboard';
import './agents.css';

const rank = (status: string) => (status === 'running' ? 0 : status === 'idle' ? 1 : 2);

function ordered(map: Map<string, AgentInfo>): AgentInfo[] {
  return Array.from(map.values())
    .map((agent, i) => ({ agent, i }))
    .sort((left, right) => rank(left.agent.status) - rank(right.agent.status) || left.i - right.i)
    .map(({ agent }) => agent);
}

// design 7a: no longer a right-column card — this is a MAIN TAB, so it is
// never collapsed and its header is a plain title row again.
export default function AgentsPanel({ sessionId }: { sessionId: string | null }) {
  const focusedPane = useStore((s) => s.focusedPane);
  const setFocusedPane = useStore((s) => s.setFocusedPane);
  const newAgentOpen = useStore((s) => s.newAgentOpen);
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen);
  const openAgentTab = useStore((s) => s.openAgentTab);
  const syncAgentTab = useStore((s) => s.syncAgentTab);

  const { agents, setAgents, loading, listError, trail, setTrail, pendingKill, setPendingKill, selectedId, setSelectedId } =
    useAgentsFeed({ sessionId, syncAgentTab });

  // multi-provider-openai FR-20: subagents' capability for this session's runtime.
  const meta = useSessionMeta(sessionId);
  const capability = sessionCapability(meta, 'subagents');

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());

  const focused = focusedPane === 'agents';
  const list = ordered(agents);
  const hasRunning = list.some((agent) => agent.status === 'running');

  // Publish this session's agents to the palette cache (backs kill-agent + runningAgentCount, FR-23).
  useEffect(() => {
    if (sessionId) setPaletteAgents(sessionId, ordered(agents));
  }, [sessionId, agents]);

  // split-session §Right column: this panel is the only mount that holds its
  // count, and while split the column folds to the icon rail — which badges it.
  useEffect(() => {
    if (sessionId) useStore.getState().setPanelCount(sessionId, 'agents', agents.size);
  }, [sessionId, agents]);

  // Tick the elapsed timer once a second while any agent is running.
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const doKill = async (agentId: string) => {
    if (pendingKill.has(agentId)) return;
    setPendingKill((prev) => new Set(prev).add(agentId));
    const res = await agentsKill(agentId);
    if (!res.ok) {
      setPendingKill((prev) => {
        const n = new Set(prev);
        n.delete(agentId);
        return n;
      });
      if (res.error.code === 'AGENT_NOT_FOUND') {
        setAgents((prev) => {
          const n = new Map(prev);
          n.delete(agentId);
          return n;
        });
      }
    }
    // success: pendingKill cleared on the next agent.update for this id (FR-20)
  };
  const kill = (agentId: string) => void doKill(agentId);

  // async-agents FR-19: hydrate the expanded card's trail. A stale response (the
  // card was collapsed or re-expanded meanwhile) is dropped by its reqId. `ipc()`
  // rejects (rather than resolving a Result) on transport-level failures — funnel
  // that through the same Result path so `trail.loading` never sticks forever.
  const loadTrail = async (agentId: string, reqId: number) => {
    try {
      const res = await agentsActivity(agentId);
      setTrail((prev) => receiveTrailActivity(prev, reqId, res));
    } catch (err) {
      setTrail((prev) =>
        receiveTrailActivity(prev, reqId, { ok: false, error: { code: 'INTERNAL', message: String(err) } }),
      );
    }
  };

  // async-agents §7: AGENT_NOT_FOUND drops the card, but one render pass AFTER
  // the trail's error row has painted — setTrail (above) and this setAgents must
  // NOT land in the same React batch, or the card unmounts before the "expanded,
  // trail errored" row (§8) is ever visible.
  useEffect(() => {
    const dropId = agentIdToDropForTrailError(trail);
    if (!dropId) return;
    setAgents((prev) => {
      if (!prev.has(dropId)) return prev;
      const n = new Map(prev);
      n.delete(dropId);
      return n;
    });
  }, [trail]);

  // FR-19/FR-22: ⏎ (or the same card again) toggles; expanding re-issues the fetch.
  const toggleExpand = (agentId: string) => {
    const next = toggleTrail(trail, agentId);
    setTrail(next);
    if (next.agentId !== null) void loadTrail(next.agentId, next.reqId);
  };

  useAgentsKeyboard({
    focused,
    newAgentOpen,
    list,
    selectedId,
    agents,
    pendingKill,
    trail,
    setSelectedId,
    setTrail,
    onToggleExpand: toggleExpand,
    onKill: kill,
  });

  return (
    <section
      onClick={() => setFocusedPane('agents')}
      className={focused ? 'agents-panel agents-panel--focused' : 'agents-panel'}
    >
      <PanelHeader title="AGENTS" count={agents.size} paneKey={3} focused={focused} />

      <AgentsListBody
          capability={capability}
          listError={listError}
          loading={loading}
          list={list}
          now={clockNow}
          selectedId={selectedId}
          trail={trail}
          hoverId={hoverId}
          pendingKill={pendingKill}
          onSelect={(agent, e) => {
            if (agent.id !== trail.agentId) setTrail(collapseTrail); // FR-13: selection collapses
            setSelectedId(agent.id);
            // agent-tab FR-10: a CLICK also opens (or re-activates) this
            // agent's main-pane tab and hands it focus — you clicked to read
            // it. stopPropagation keeps the section's own handler from
            // immediately pulling focus back to pane [3]. The keyboard path
            // (↑/↓ + ⏎, the in-place trail) is deliberately unchanged.
            e.stopPropagation();
            // fix-agent-view FR-15: the tab is opened for THIS panel's session,
            // so it lands in the pane that holds it — the focused one, split or
            // not. openAgentTab moves focus to the main pane itself (FR-4), so
            // a session that holds no pane cannot pull focus out of pane [3].
            if (sessionId) openAgentTab(sessionId, { id: agent.id, name: agent.name, status: agent.status });
          }}
          onHover={setHoverId}
          onKill={kill}
          onAtBottom={(v) => setTrail((t) => (t.atBottom === v ? t : { ...t, atBottom: v }))}
      />

      {newAgentOpen && sessionId && (
        <NewAgentModal sessionId={sessionId} onClose={() => setNewAgentOpen(false)} />
      )}
    </section>
  );
}

function NewAgentModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [task, setTask] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (submitting) return;
    if (task.trim() === '') {
      setError({ code: 'INVALID_INPUT', message: 'describe the task first' });
      return;
    }
    setSubmitting(true);
    setError(null);
    const res = await agentsDispatch(sessionId, task.trim());
    setSubmitting(false);
    if (res.ok) onClose();
    else setError(res.error);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    // NewAgentModal keeps its own Escape/Enter keydown handler above (Enter
    // dispatches), so closeOnEscape stays off here to avoid double-handling —
    // see REFACTOR-CONVENTIONS.md's Modal note. closeOnBackdropClick mirrors
    // the previous unconditional `onClick={onClose}` on the backdrop.
    <Modal onClose={onClose} width={420} align="top" closeOnBackdropClick closeOnEscape={false}>
      <ModalHeader>
        <div className="agent-modal-title-row">
          <span className="agent-modal-arrow">›</span>
          <input
            ref={inputRef}
            value={task}
            disabled={submitting}
            placeholder="describe the subagent's task…"
            onChange={(e) => setTask(e.target.value)}
            className="agent-modal-input"
            style={{ opacity: submitting ? 0.7 : 1 }}
          />
          <span className="agent-modal-hint">esc</span>
        </div>
      </ModalHeader>
      {error && <div className="agent-modal-error">{error.message}</div>}
      <HintBar
        items={[
          { key: '⏎', label: 'dispatch' },
          { key: 'esc', label: 'cancel' },
        ]}
      />
    </Modal>
  );
}
