import { describe, expect, it } from 'vitest';
import type { McpServerInfo, SkillInfo } from '../../../contract/common';
import {
  accountProfileLine,
  downMessage,
  downServers,
  instructionNote,
  mcpGlyph,
  mcpHeading,
  mcpNote,
  pathLeaf,
  skillsHeading,
  splitSkills,
} from './context-section';

const server = (name: string, status: McpServerInfo['status'], extra: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name,
  status,
  ...extra,
});

describe('MCP rows', () => {
  it('maps each status onto a state glyph', () => {
    expect(mcpGlyph('connected')).toBe('done');
    expect(mcpGlyph('error')).toBe('failed');
    expect(mcpGlyph('connecting')).toBe('running');
    expect(mcpGlyph('pending')).toBe('approval');
  });

  it('reads the tool count when connected and "unavailable" when down', () => {
    expect(mcpNote(server('a', 'connected', { toolCount: 12 }))).toEqual({ text: '12 tools', tone: 'faint' });
    expect(mcpNote(server('a', 'connected', { toolCount: 1 }))).toEqual({ text: '1 tool', tone: 'faint' });
    expect(mcpNote(server('a', 'error'))).toEqual({ text: 'unavailable', tone: 'danger' });
    expect(mcpNote(server('a', 'pending')).tone).toBe('attention');
  });

  it('heads the list with the count and how many are down', () => {
    const list = [server('a', 'connected'), server('b', 'error'), server('c', 'connected'), server('d', 'connected')];
    expect(mcpHeading(list)).toBe('4 · 1 down');
    expect(mcpHeading(list.slice(0, 1))).toBe('1');
    expect(downServers(list).map((s) => s.name)).toEqual(['b']);
  });

  it('says why a server is down and what it costs', () => {
    expect(downMessage({ errorMessage: 'Handshake timed out after 10 s', toolCount: 7 })).toBe(
      'Handshake timed out after 10 s. Its 7 tools are unavailable to this session.',
    );
    expect(downMessage({ errorMessage: 'timeout.' })).toBe('timeout. Its tools are unavailable to this session.');
    expect(downMessage({})).toBe('It stopped answering. Its tools are unavailable to this session.');
  });
});

describe('skills', () => {
  const skill = (name: string, installed: boolean) => ({ name, installed, description: '' }) as SkillInfo;

  it('splits installed from available and heads them', () => {
    const { installed, available } = splitSkills([skill('review', true), skill('pdf', false), skill('build', true)]);
    expect(installed.map((s) => s.name)).toEqual(['review', 'build']);
    expect(available.map((s) => s.name)).toEqual(['pdf']);
    expect(skillsHeading(2, 6)).toBe('2 installed · 6 available');
    expect(skillsHeading(0, 3)).toBe('3 available');
    expect(skillsHeading(0, 0)).toBe('');
  });
});

describe('instructions + footer', () => {
  it('reads the repo leaf and the line count', () => {
    expect(instructionNote('orbit', 142)).toBe('orbit · 142 lines');
    expect(instructionNote(null, 1)).toBe('1 line');
    expect(pathLeaf('C:\\code\\orbit\\')).toBe('orbit');
    expect(pathLeaf('/home/me/orbit')).toBe('orbit');
  });

  it('pairs the account with its profile only when there is one', () => {
    expect(accountProfileLine('Work', 'api-default')).toBe('Work · api-default');
    expect(accountProfileLine('Work', undefined)).toBe('Work');
  });
});
