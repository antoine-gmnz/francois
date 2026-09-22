import { describe, expect, it } from 'vitest';
import { PANE_TABS, paneStatusText } from './split-pane';

describe('paneStatusText', () => {
  it('shows the live clock while a turn is in flight', () => {
    expect(paneStatusText('running')).toEqual({ kind: 'clock', text: '', tone: 'running' });
    expect(paneStatusText('starting').kind).toBe('clock');
  });

  it('names a blocked pane in the attention tone', () => {
    expect(paneStatusText('awaiting_approval')).toEqual({ kind: 'word', text: 'needs approval', tone: 'attention' });
    expect(paneStatusText('awaiting_input')).toEqual({ kind: 'word', text: 'has a question', tone: 'attention' });
  });

  it('names the settled states', () => {
    expect(paneStatusText('done')).toEqual({ kind: 'word', text: 'finished', tone: 'success' });
    expect(paneStatusText('error')).toEqual({ kind: 'word', text: 'failed', tone: 'danger' });
    expect(paneStatusText('idle')).toEqual({ kind: 'word', text: 'idle', tone: 'faint' });
  });
});

describe('PANE_TABS', () => {
  it('lists the three built-in views in design order', () => {
    expect(PANE_TABS.map((t) => t.label)).toEqual(['Conversation', 'Changes', 'Terminal']);
    expect(PANE_TABS.map((t) => t.id)).toEqual(['session', 'diff', 'shell']);
  });
});
