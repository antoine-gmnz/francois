import { describe, expect, it, vi } from 'vitest';
import { onCohorteSettingsRequest, requestCohorteSettings, takeCohorteSettingsRequest } from './settings-request';

describe('Cohorte: Settings (FR-88, R-16)', () => {
  it('parks the request and opens Settings when it is closed', () => {
    const open = vi.fn();
    requestCohorteSettings(open);
    expect(open).toHaveBeenCalledOnce();
    expect(takeCohorteSettingsRequest()).toBe(true);
    expect(takeCohorteSettingsRequest()).toBe(false);
  });

  it('navigates the open Settings view directly', () => {
    const open = vi.fn();
    const go = vi.fn();
    const off = onCohorteSettingsRequest(go);
    requestCohorteSettings(open);
    expect(go).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(takeCohorteSettingsRequest()).toBe(false);
    off();
    requestCohorteSettings(open);
    expect(open).toHaveBeenCalledOnce();
    takeCohorteSettingsRequest();
  });
});
