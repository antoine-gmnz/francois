import { describe, expect, it } from 'vitest';
import type { CohorteDoctorReport } from '../../../contract/cohorte-integration';
import { detection } from '../../lib/cohorte.testutil';
import { checkGlyph, detectionHead, detectionSegments, doctorChip, doctorErrorNote, doctorResultApplies, navDotOn, pageMode } from './settings';

const report = (statuses: string[], ok = true): CohorteDoctorReport => ({
  root: '/r',
  ok,
  cohorteVersion: '3.4.1',
  generatedAt: 0,
  ranAt: 0,
  rows: [],
  checks: statuses.map((status, i) => ({ id: `c${i}`, status, summary: '' })),
});

describe('Settings · Cohorte (FR-80..FR-82)', () => {
  it('builds the detection sub-line, omitting unknown segments', () => {
    expect(detectionSegments(detection({ runtime: 'Pi', cli: { ...detection().cli, version: '3.4.1' } }))).toEqual([
      '.cohorte/',
      'cohorte 3.4.1',
      'runtime Pi',
      'state SQLite',
    ]);
    expect(detectionSegments(detection({ stateBackend: null, cli: { ...detection().cli, version: undefined } }))).toEqual(['.cohorte/']);
  });

  it('draws frame 27 for any found .cohorte/, frame 28 otherwise', () => {
    expect(pageMode(null)).toBe('checking');
    expect(pageMode(detection())).toBe('detected');
    expect(pageMode(detection({ state: 'cli-missing' }))).toBe('detected');
    expect(pageMode(detection({ state: 'not-initialised' }))).toBe('not-detected');
    expect(pageMode(detection({ state: 'no-project' }))).toBe('not-detected');
  });

  it('heads the card by state', () => {
    expect(detectionHead(detection()).title).toBe('Cohorte detected in this project');
    expect(detectionHead(detection({ state: 'cli-missing' }))).toEqual({ title: 'Cohorte CLI not found', tone: 'danger', hint: 'npm i -g cohorte' });
    expect(detectionHead(detection({ state: 'cli-incompatible', cli: { installed: true, version: '2.4.0', supportedRange: '>=3.0.0-dev.1 <4.0.0', compatible: false } })).title).toBe(
      'Cohorte 2.4.0 is not supported — Francois needs >=3.0.0-dev.1 <4.0.0',
    );
  });

  it('words the doctor chip', () => {
    expect(doctorChip(null)).toBeNull();
    expect(doctorChip(report(['ok', 'ok']))?.label).toBe('doctor passed');
    expect(doctorChip(report(['ok', 'warning', 'warning']))).toMatchObject({ label: 'doctor: 2 warnings', tone: 'attention' });
    expect(doctorChip(report(['warning', 'error'], false))).toMatchObject({ label: 'doctor failed', tone: 'danger' });
  });

  it('maps check glyphs and the nav dot', () => {
    expect(['ok', 'warning', 'error', 'skipped', 'weird'].map(checkGlyph)).toEqual(['ok', 'warning', 'error', 'skipped', 'skipped']);
    expect(navDotOn(detection())).toBe(true);
    expect(navDotOn(detection({ state: 'cli-missing' }))).toBe(false);
    expect(navDotOn(null)).toBe(false);
  });
});

describe('doctor race guard (R-16)', () => {
  it('drops a result for a root the page no longer shows', () => {
    expect(doctorResultApplies('/a', '/a')).toBe(true);
    expect(doctorResultApplies('/a', '/b')).toBe(false);
    expect(doctorResultApplies('/a', null)).toBe(false);
  });
});

describe('doctorErrorNote (R2-9)', () => {
  it('explains a doctor timeout, and only a timeout', () => {
    expect(doctorErrorNote('COHORTE_TIMEOUT')).toBe(
      'cohorte doctor did not finish — known issue in Cohorte 3.0.0-dev.1 on Windows when run without a terminal; run it in a shell',
    );
    expect(doctorErrorNote('COHORTE_OUTPUT_INVALID')).toBeNull();
  });
});
