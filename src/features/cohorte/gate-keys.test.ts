import { describe, expect, it } from 'vitest';
import { gateKeyAction, isControlTarget, isEditableTarget, type GateKeyState } from './gate-keys';

const base: GateKeyState = {
  editable: false,
  blocked: false,
  busy: false,
  offered: ['approve', 'fix', 'deny'],
  denyStopsRun: true,
  confirmArmed: false,
  repeat: false,
  onControl: false,
};

describe('gateKeyAction (FR-63, AC-33)', () => {
  it('1 approves and 2 sends to fix', () => {
    expect(gateKeyAction('1', base)).toEqual({ kind: 'run', action: 'approve' });
    expect(gateKeyAction('2', base)).toEqual({ kind: 'run', action: 'fix' });
  });
  it('3 on a stop-run deny arms the confirm; 3 or Enter confirms; Esc backs out', () => {
    expect(gateKeyAction('3', base)).toEqual({ kind: 'arm' });
    const armed = { ...base, confirmArmed: true };
    expect(gateKeyAction('3', armed)).toEqual({ kind: 'run', action: 'deny' });
    expect(gateKeyAction('Enter', armed)).toEqual({ kind: 'run', action: 'deny' });
    expect(gateKeyAction('Escape', armed)).toEqual({ kind: 'disarm' });
    expect(gateKeyAction('1', armed)).toEqual({ kind: 'swallow' });
    expect(gateKeyAction('x', armed)).toEqual({ kind: 'pass' });
  });
  it('3 denies directly when it does not stop the run', () => {
    expect(gateKeyAction('3', { ...base, denyStopsRun: false })).toEqual({ kind: 'run', action: 'deny' });
  });
  it('lets keys through while typing, or under a modal', () => {
    expect(gateKeyAction('1', { ...base, editable: true })).toEqual({ kind: 'pass' });
    expect(gateKeyAction('1', { ...base, blocked: true })).toEqual({ kind: 'pass' });
  });
  it('ignores digits while busy and for actions not offered', () => {
    expect(gateKeyAction('1', { ...base, busy: true })).toEqual({ kind: 'swallow' });
    expect(gateKeyAction('2', { ...base, offered: ['approve', 'deny'] })).toEqual({ kind: 'swallow' });
    expect(gateKeyAction('Enter', base)).toEqual({ kind: 'pass' });
    expect(gateKeyAction('4', base)).toEqual({ kind: 'pass' });
  });
});

describe('isEditableTarget', () => {
  it('recognises inputs, contenteditable and the terminal', () => {
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', closest: (s) => (s === '.xterm' ? {} : null) })).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON', closest: () => null })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('Remediation R-12', () => {
  it('ignores auto-repeat: a held digit never runs or arms twice', () => {
    expect(gateKeyAction('1', { ...base, repeat: true })).toEqual({ kind: 'swallow' });
    expect(gateKeyAction('3', { ...base, repeat: true })).toEqual({ kind: 'swallow' });
    expect(gateKeyAction('3', { ...base, repeat: true, confirmArmed: true })).toEqual({ kind: 'swallow' });
    expect(gateKeyAction('Enter', { ...base, repeat: true, confirmArmed: true })).toEqual({ kind: 'swallow' });
    expect(gateKeyAction('x', { ...base, repeat: true })).toEqual({ kind: 'pass' });
  });
  it('while armed, Enter on a focused button/link/[role=button] goes to that control', () => {
    expect(gateKeyAction('Enter', { ...base, confirmArmed: true, onControl: true })).toEqual({ kind: 'pass' });
    expect(gateKeyAction('3', { ...base, confirmArmed: true, onControl: true })).toEqual({ kind: 'run', action: 'deny' });
  });
  it('recognises controls', () => {
    expect(isControlTarget({ tagName: 'BUTTON' })).toBe(true);
    expect(isControlTarget({ tagName: 'a' })).toBe(true);
    expect(isControlTarget({ tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'button' : null) })).toBe(true);
    expect(isControlTarget({ tagName: 'DIV', getAttribute: () => null })).toBe(false);
    expect(isControlTarget(null)).toBe(false);
  });
});
