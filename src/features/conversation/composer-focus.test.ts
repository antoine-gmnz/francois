import { describe, expect, it } from 'vitest';
import { shouldFocusComposer } from './composer-focus';

describe('shouldFocusComposer', () => {
  it('focuses the composer when the pane takes focus (inert → live)', () => {
    expect(shouldFocusComposer({ wasInert: true, inert: false, hasSelection: false })).toBe(true);
  });

  it('does nothing while the pane stays focused — a click inside it must not move the caret', () => {
    expect(shouldFocusComposer({ wasInert: false, inert: false, hasSelection: false })).toBe(false);
  });

  it('does nothing when the pane loses focus', () => {
    expect(shouldFocusComposer({ wasInert: false, inert: true, hasSelection: false })).toBe(false);
    expect(shouldFocusComposer({ wasInert: true, inert: true, hasSelection: false })).toBe(false);
  });

  it('leaves a live text selection alone — focusing the textarea would collapse it', () => {
    expect(shouldFocusComposer({ wasInert: true, inert: false, hasSelection: true })).toBe(false);
  });
});
