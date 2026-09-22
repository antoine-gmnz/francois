import { describe, expect, it } from 'vitest';
import { finding, gate, request, run } from '../../lib/cohorte.testutil';
import {
  actionLabel,
  compactActionLabel,
  findingLocation,
  gateKindLabel,
  gateNotificationBody,
  gateQuestion,
  gateSummary,
} from './gate-view';

const withKind = (kind: string) => gate({ request: request({ kind, reason: 'Needs a look.' }) });
const approve = { id: 'approve' as const, stopsRun: false, cli: [] };

describe('FR-62 kind copy (AC-22)', () => {
  const table: [string, string, string, string][] = [
    ['ship', 'SHIP APPROVAL', 'Ship auth-retry?', 'Approve · ship'],
    ['review-leftovers', 'REVIEW VERDICT', 'Ship auth-retry, or send it back to fix?', 'Approve · ship'],
    ['contract-change', 'CONTRACT CHANGE', 'A fix touches the contract. Allow it?', 'Approve'],
    ['loop-stalled', 'LOOP STALLED', 'The fix loop stopped making progress. Continue?', 'Approve · continue'],
    ['budget', 'BUDGET', 'The run hit a budget limit. Raise it and continue?', 'Approve · continue'],
    ['spec-not-ready', 'SPEC NOT READY', 'The spec is not ready to build. Proceed anyway?', 'Approve'],
    ['tool', 'TOOL APPROVAL', 'Needs a look.', 'Allow once'],
    ['shared-path', 'SHARED PATH', 'Needs a look.', 'Allow once'],
    ['unowned-path', 'UNOWNED PATH', 'Needs a look.', 'Allow once'],
    ['provision-network', 'NETWORK', 'Needs a look.', 'Allow once'],
    ['api-billing', 'API BILLING', 'Needs a look.', 'Allow once'],
    ['blocked-ack', 'BLOCKED', 'Needs a look.', 'Acknowledge'],
    ['brand-new-kind', 'BRAND NEW KIND', 'Needs a look.', 'Approve'],
  ];
  it.each(table)('%s → %s', (kind, label, question, approveLabel) => {
    expect(gateKindLabel(kind)).toBe(label);
    expect(gateQuestion(withKind(kind), 'auth-retry')).toBe(question);
    expect(actionLabel(approve, kind)).toBe(approveLabel);
  });

  it('labels fix and deny by stopsRun', () => {
    expect(actionLabel({ id: 'fix', stopsRun: false, cli: [] }, 'ship')).toBe('Send to fix');
    expect(actionLabel({ id: 'deny', stopsRun: true, cli: [] }, 'ship')).toBe('Deny · stop run');
    expect(actionLabel({ id: 'deny', stopsRun: false, cli: [] }, 'tool')).toBe('Deny');
    expect(compactActionLabel({ id: 'deny', stopsRun: true, cli: [] })).toBe('Deny');
  });
});

describe('gate summary, notification and location', () => {
  it('counts issues and blocking ones, else falls back to the reason', () => {
    const g = gate({ findings: [finding(), finding({ id: 'f2', blocking: false, label: 'minor' })] });
    expect(gateSummary(g)).toBe('Review found 2 issues, 1 blocking. Cohorte waits for your verdict before it ships.');
    expect(gateSummary(gate({ findings: [] }))).toBe('Review found 4 issues, 1 blocking.');
  });
  it('words the notification without agent text', () => {
    expect(gateNotificationBody(run(), gate())).toBe('auth-retry · Cohorte gate: review verdict');
  });
  it('formats file:line', () => {
    expect(findingLocation({ file: 'a.ts', line: 3 })).toBe('a.ts:3');
    expect(findingLocation({ file: 'a.ts' })).toBe('a.ts');
    expect(findingLocation({})).toBeNull();
  });
});
