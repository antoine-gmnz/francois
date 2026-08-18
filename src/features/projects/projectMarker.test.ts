// unbound-panes FR-14: the neutral project marker's derivation.

import { describe, expect, it } from 'vitest';
import { projectMarker } from './projectMarker';

describe('projectMarker (FR-14)', () => {
  it('takes initials across word boundaries', () => {
    expect(projectMarker('acme api')).toBe('AA');
    expect(projectMarker('acme-api')).toBe('AA');
    expect(projectMarker('acme_api')).toBe('AA');
  });

  it('falls back to the first three characters of a single word', () => {
    expect(projectMarker('francois')).toBe('FRA');
  });

  it('degrades an empty/whitespace name to a placeholder rather than throwing', () => {
    expect(projectMarker('')).toBe('?');
    expect(projectMarker('   ')).toBe('?');
  });
});
