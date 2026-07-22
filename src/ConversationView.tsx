import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SessionEvent, SlashCommandInfo } from '../contract/common';
import { toolBody, type ConversationBlock } from '../contract/conversation-view';
import { displayWslCwd } from '../contract/wsl-filesystem';
import { getTranscript, onSessionEvent, sessionListCommands, sessionSend } from './api';
import CommandBlock from './CommandCard';
import { transcriptReducer } from './conversation-blocks';
import { composerPlaceholder, hasPendingQuestionBlock } from './question-card';
import QuestionCard from './QuestionCard';
import {
  completionText,
  filterCommands,
  getSessionCommands,
  moveSelection,
  nextDismissed,
  popupKeyAction,
  popupVisible,
  refreshSelection,
  setSessionCommands,
  slashToken,
} from './slash-menu';
import SlashMenu from './SlashMenu';
import { useStore } from './store';

const C = {
  accent: '#c8a15a',
  faint: '#565a63',
  dim: '#868a93',
  primary: '#c4c7ce',
  bright: '#dfe2e8',
  userBody: '#d3d6dc',
  error: '#c46b62',
  queued: '#c2b06a',
};

// Block apply rules (reducer) live in ./conversation-blocks — pure + unit-tested.

function eventSessionId(e: SessionEvent): string | null {
  if (e.type === 'session.meta') return e.meta.id;
  if ('sessionId' in e) return e.sessionId;
  return null;
}

export default function ConversationView({ sessionId }: { sessionId: string }) {
  const meta = useStore((s) => s.sessions.find((x) => x.id === sessionId) ?? null);
  const [state, dispatch] = useReducer(transcriptReducer, { blocks: [] });
  const [hydrated, setHydrated] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(meta?.status ?? 'idle');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(meta?.errorMessage);
  const [isPinned, setPinned] = useState(true);
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [resumeFailed, setResumeFailed] = useState(false); // durable-sessions FR-14 banner

  // slash-menu popup state (spec §6): registry mirror for THIS session (cache-
  // seeded, FR-10), dismissal token (FR-9) and selection (FR-7). All component-
  // local — a session switch remounts (keyed by sessionId) and clears them.
  const [commands, setCommands] = useState<SlashCommandInfo[]>(() => getSessionCommands(sessionId));
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [selIdx, setSelIdx] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);
  pinnedRef.current = isPinned;

  // Hydration + live events (FR-8/9/10). Component is keyed by sessionId in the
  // parent, so this runs fresh per session; a stale getTranscript after unmount
  // is discarded via mountedRef (FR-9).
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    let hydratedLocal = false;
    const pending: SessionEvent[] = [];

    const route = (e: SessionEvent) => {
      switch (e.type) {
        case 'session.status':
          setStatus(e.status);
          break;
        case 'session.meta':
          setStatus(e.meta.status);
          setErrorMessage(e.meta.errorMessage);
          break;
        case 'session.error':
          setErrorMessage(e.error.message);
          setStatus('error');
          break;
        case 'context.usage':
          useStore.getState().patchUsage(sessionId, e.usedTokens, e.limitTokens);
          break;
        case 'message.user':
          dispatch({ t: 'msgUser', blockId: e.blockId, text: e.text });
          setResumeFailed(false); // a new user turn clears the resume-fail notice (FR-14)
          break;
        case 'session.resumeFailed':
          setResumeFailed(true); // the --resume was rejected; core continued fresh (FR-9/14)
          break;
        case 'assistant.delta':
          dispatch({ t: 'delta', blockId: e.blockId, text: e.text });
          break;
        case 'assistant.done':
          dispatch({ t: 'assistantDone', blockId: e.blockId });
          break;
        case 'tool.start':
          dispatch({ t: 'toolStart', blockId: e.blockId, tool: e.tool, summary: e.summary });
          break;
        case 'tool.done':
          dispatch({ t: 'toolDone', blockId: e.blockId, meta: e.meta });
          break;
        case 'command.started':
          // interactive-commands FR-20: pending command block (loading card)
          dispatch({ t: 'commandStarted', blockId: e.blockId, command: e.command });
          break;
        case 'command.output':
          // interactive-commands FR-20: upsert card; insert-if-unseen (instant notices)
          dispatch({ t: 'commandOutput', blockId: e.blockId, card: e.card });
          break;
        case 'question.asked':
          // session-questions FR-6/16: insert the pending question card
          dispatch({ t: 'questionAsked', blockId: e.blockId, questions: e.questions });
          break;
        case 'question.resolved':
          // session-questions FR-11/13/16: flip to answered/cancelled in place
          dispatch({ t: 'questionResolved', blockId: e.blockId, state: e.state, answers: e.answers });
          break;
        case 'session.commands':
          // slash-menu FR-10: idempotent replace — an open popup refilters in place
          setCommands(e.commands);
          break;
        default:
          break;
      }
    };

    void onSessionEvent((e) => {
      // slash-menu edge 7: cache the registry for EVERY session (no UI effect
      // for non-visible ones — they re-seed from this cache when shown).
      if (e.type === 'session.commands') setSessionCommands(e.sessionId, e.commands);
      if (eventSessionId(e) !== sessionId) return;
      if (!hydratedLocal) pending.push(e);
      else route(e);
    }).then((u) => {
      if (!mounted) u();
      else unlisten = u;
    });

    void getTranscript(sessionId).then((res) => {
      if (!mounted) return; // FR-9: discard stale response
      if (res.ok) {
        dispatch({ t: 'seed', blocks: res.data });
        for (const e of pending) route(e);
        pending.length = 0;
        hydratedLocal = true;
        setHydrated(true);
        setPinned(true);
      } else {
        setHydrationError(res.error.message);
      }
    });

    return () => {
      mounted = false;
      if (unlisten) unlisten();
    };
  }, [sessionId]);

  // slash-menu FR-10: seed the registry on mount / session switch (the keyed
  // remount makes both the same path). The cache gave an instant value above;
  // listCommands refreshes it. Errors keep whatever the cache had.
  useEffect(() => {
    let mounted = true;
    void sessionListCommands(sessionId).then((res) => {
      if (!mounted || !res.ok) return;
      setSessionCommands(sessionId, res.data);
      setCommands(res.data);
    });
    return () => {
      mounted = false;
    };
  }, [sessionId]);

  // Scroll-to-bottom while pinned (FR-17/18).
  useLayoutEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.blocks, hydrated]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > 32 && pinnedRef.current) setPinned(false); // FR-19
  };

  const jumpToLatest = () => {
    setPinned(true);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  const disabled = status === 'done' || status === 'error';

  // ---------- slash-menu popup (FR-5..FR-9/12) ----------

  const token = slashToken(input);
  const filtered = useMemo(() => filterCommands(commands, token ?? ''), [commands, token]);
  const popupOpen = popupVisible({ token, matchCount: filtered.length, dismissedToken, disabled });

  // FR-9: dismissal holds only while the token stays the dismissed one.
  useEffect(() => {
    setDismissedToken((d) => nextDismissed(d, token));
  }, [token]);

  // FR-7: first row on open/refilter (token changed). FR-10: on a registry
  // refresh with an unchanged token, keep the selected name if it survived.
  const selIdxRef = useRef(0);
  selIdxRef.current = selIdx;
  const prevTokenRef = useRef<string | null>(null);
  const prevFilteredRef = useRef<SlashCommandInfo[]>([]);
  useEffect(() => {
    if (prevTokenRef.current !== token) {
      setSelIdx(0);
    } else if (prevFilteredRef.current !== filtered) {
      const name = prevFilteredRef.current[selIdxRef.current]?.name ?? null;
      setSelIdx(refreshSelection(filtered, name));
    }
    prevTokenRef.current = token;
    prevFilteredRef.current = filtered;
  }, [token, filtered]);

  const dismissPopup = () => setDismissedToken(token);

  // FR-8/11: a menu run goes through the NORMAL send path with the bare
  // '/name' — byte-identical to having typed it. No metadata rides along.
  const runCommand = (name: string) => {
    void send(completionText(name, 'run'));
  };

  const send = async (textArg?: string) => {
    const text = textArg ?? input;
    if (!text.trim() || disabled) return;
    const blockId = crypto.randomUUID();
    dispatch({ t: 'optimisticUser', blockId, text });
    setPinned(true); // FR-20
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    const res = await sessionSend(sessionId, blockId, text);
    if (!res.ok) {
      dispatch({ t: 'remove', blockId });
      setInput(text);
      setSendError(res.error.message);
      setTimeout(() => setSendError(null), 4000);
    }
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // slash-menu FR-8/9: while the popup is rendered its keys preempt the
    // composer defaults (Enter-to-send included); everything else falls through.
    if (popupOpen) {
      const action = popupKeyAction(e.key, e.shiftKey);
      if (action) {
        e.preventDefault();
        if (action === 'down' || action === 'up') {
          setSelIdx((i) => moveSelection(filtered.length, i, action === 'down' ? 1 : -1));
        } else if (action === 'run') {
          const sel = filtered[selIdx] ?? filtered[0];
          if (sel) runCommand(sel.name);
        } else if (action === 'complete') {
          const sel = filtered[selIdx] ?? filtered[0];
          if (sel) setInput(completionText(sel.name, 'complete')); // trailing space ends the token → popup closes
        } else {
          dismissPopup();
        }
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
  };

  // session-questions FR-20: the placeholder swaps while a pending question
  // card exists in this session's transcript and reverts when none is.
  const placeholder = composerPlaceholder(status, errorMessage, hasPendingQuestionBlock(state.blocks));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* resume-fail banner (durable-sessions FR-14) */}
      {resumeFailed && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            background: '#20222a',
            borderLeft: '2px solid #c2b06a',
            borderRadius: 4,
            padding: '8px 11px',
            margin: '6px 8px',
            flexShrink: 0,
            animation: 'fadeIn 120ms ease-out',
          }}
        >
          <span style={{ fontSize: 11.5, color: '#a9adb6', flex: 1 }}>previous thread unavailable — continuing fresh</span>
          <span onClick={() => setResumeFailed(false)} style={{ fontSize: 10, color: C.faint, cursor: 'pointer' }} title="dismiss">
            ✕
          </span>
        </div>
      )}

      {/* transcript */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scz"
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'auto',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {hydrationError ? (
            <Centered>
              <span style={{ color: C.error }}>{hydrationError}</span>
            </Centered>
          ) : hydrated && state.blocks.length === 0 ? (
            <Centered>
              <div style={{ fontSize: 12, color: C.dim }}>{meta && (displayWslCwd(meta.cwd) ?? meta.cwd)}</div>
              <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{meta?.model.label}</div>
              <div style={{ fontSize: 12.5, color: C.faint, marginTop: 10 }}>waiting for your first prompt</div>
            </Centered>
          ) : (
            state.blocks.map((b) => <Block key={b.blockId} b={b} sessionId={sessionId} />)
          )}
        </div>

        {!isPinned && (
          <div
            onClick={jumpToLatest}
            style={{
              position: 'absolute',
              bottom: 10,
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '5px 12px',
              borderRadius: 12,
              background: '#20222a',
              border: '1px solid #2a2c33',
              fontSize: 10.5,
              color: C.accent,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#26282f')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#20222a')}
          >
            ↓ jump to latest
          </div>
        )}
      </div>

      {/* input bar */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {/* slash-menu popup — anchored above the input bar, never covering it (FR-5) */}
        {popupOpen && (
          <SlashMenu items={filtered} selIdx={selIdx} onHover={setSelIdx} onRun={runCommand} onDismiss={dismissPopup} />
        )}
        {sendError && (
          <div
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 14,
              right: 14,
              marginBottom: 4,
              background: 'rgba(196,107,98,0.09)',
              color: C.error,
              fontSize: 11,
              borderRadius: 4,
              padding: '6px 10px',
            }}
          >
            {sendError}
          </div>
        )}
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid #24262d',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <span style={{ color: disabled ? '#3a3d45' : C.accent, fontSize: 13, marginTop: 2 }}>›</span>
          <textarea
            ref={inputRef}
            value={input}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={onInputKey}
            rows={1}
            style={{
              flex: 1,
              resize: 'none',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: C.userBody,
              fontSize: 12.5,
              fontFamily: 'inherit',
              lineHeight: 1.5,
              maxHeight: 130,
              padding: 0,
            }}
          />
          <span style={{ fontSize: 10, color: '#3a3d45', marginTop: 3 }}>⌘K palette</span>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        minHeight: 200,
      }}
    >
      {children}
    </div>
  );
}

function Block({ b, sessionId }: { b: ConversationBlock; sessionId: string }) {
  // interactive-commands: command cards (and notice one-liners) have their own renderer (§8)
  if (b.kind === 'command') {
    return <CommandBlock b={b} sessionId={sessionId} />;
  }
  // session-questions: interactive question cards (spec §8)
  if (b.kind === 'question') {
    return <QuestionCard b={b} sessionId={sessionId} />;
  }
  if (b.kind === 'user') {
    return (
      <div style={{ background: '#1b1d23', borderLeft: '2px solid #c8a15a', borderRadius: '0 4px 4px 0', padding: '10px 13px' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 5 }}>
          <span style={{ fontSize: 10, letterSpacing: '0.12em', color: C.accent }}>YOU</span>
          <span style={{ flex: 1 }} />
          {b.queued && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{ width: 5, height: 5, borderRadius: '50%', background: C.queued, animation: 'pulse 1.4s ease-in-out infinite' }}
              />
              <span style={{ fontSize: 9.5, letterSpacing: '0.04em', color: C.queued }}>queued</span>
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: C.userBody, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{b.text}</div>
      </div>
    );
  }

  let glyph = '';
  let glyphColor = C.dim;
  let bodyColor = C.primary;
  let body: React.ReactNode = '';
  if (b.kind === 'assistant') {
    glyph = b.glyph;
    glyphColor = b.glyphColor;
    bodyColor = b.bodyColor;
    body = (
      <>
        {b.text}
        {b.isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 15,
              background: C.accent,
              verticalAlign: 'text-bottom',
              marginLeft: 2,
              animation: 'blink 1s step-end infinite',
            }}
          />
        )}
      </>
    );
  } else if (b.kind === 'tool') {
    glyph = b.glyph;
    glyphColor = b.glyphColor;
    bodyColor = b.bodyColor;
    body = (
      <>
        {toolBody(b.tool, b.summary)}
        {b.meta && <span style={{ color: C.faint }}> · {b.meta}</span>}
      </>
    );
  } else {
    glyph = b.glyph;
    glyphColor = b.glyphColor;
    bodyColor = b.bodyColor;
    body = (
      <>
        Dispatched subagent  {b.agentName}
        {b.meta && <span style={{ color: C.faint }}> · {b.meta}</span>}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ width: 16, flexShrink: 0, textAlign: 'center', fontSize: 12, color: glyphColor, marginTop: 1 }}>{glyph}</span>
      <div style={{ minWidth: 0, flex: 1, fontSize: 12.5, lineHeight: 1.55, color: bodyColor, whiteSpace: 'pre-wrap' }}>{body}</div>
    </div>
  );
}
