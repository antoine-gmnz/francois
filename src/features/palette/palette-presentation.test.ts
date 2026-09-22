import { describe, expect, it } from 'vitest';
import { ICON_NAMES } from '../../ui/icons';
import { BEST_MATCH_COUNT, commandLook, flattenSections, paletteSections } from './palette-presentation';

const id = (x: { id: string }) => x.id;
const cmds = (...ids: string[]) => ids.map((i) => ({ id: i }));

describe('commandLook', () => {
  it('names a real icon for every known command, and falls back for an unknown one', () => {
    expect(commandLook('new-session')).toEqual({ icon: 'plus', section: 'session', keycap: 'N' });
    expect(commandLook('view-overview').keycap).toBe('O');
    expect(commandLook('some-plugin-command')).toEqual({ icon: 'command', section: 'other' });
    for (const cmd of ['switch-model', 'toggle-theme', 'manage-projects', 'shell-close']) {
      expect(ICON_NAMES).toContain(commandLook(cmd).icon);
    }
  });
});

describe('paletteSections', () => {
  it('groups by section in a fixed order when nothing is typed', () => {
    const ranked = cmds('toggle-theme', 'view-diff', 'new-session', 'mystery', 'switch-model');
    const sections = paletteSections(ranked, '', id);
    expect(sections.map((s) => s.label)).toEqual(['Session', 'Go to', 'App', 'Commands']);
    expect(sections[0]!.items.map(id)).toEqual(['new-session', 'switch-model']);
  });

  it('lifts the top results into Best match once a query is typed, keeping rank order elsewhere', () => {
    const ranked = cmds('attach-mcp-server', 'clear-project-attachments', 'view-diff', 'adopt-cloud-session', 'toggle-theme');
    const sections = paletteSections(ranked, 'att', id);
    expect(sections[0]).toMatchObject({ id: 'best', label: 'Best match' });
    expect(sections[0]!.items.map(id)).toEqual(['attach-mcp-server', 'clear-project-attachments'].slice(0, BEST_MATCH_COUNT));
    expect(sections.slice(1).map((s) => s.id)).toEqual(['session', 'goto', 'app']);
  });

  it('treats a whitespace-only query as no query', () => {
    expect(paletteSections(cmds('new-session'), '  ', id)[0]!.id).toBe('session');
  });

  it('drops empty sections and returns nothing for no results', () => {
    expect(paletteSections([], 'zz', id)).toEqual([]);
    expect(paletteSections(cmds('view-diff'), 'vd', id).map((s) => s.id)).toEqual(['best']);
  });
});

describe('flattenSections', () => {
  it('walks the sections top to bottom — the order the keyboard cursor follows', () => {
    const sections = paletteSections(cmds('toggle-theme', 'view-diff', 'new-session'), '', id);
    expect(flattenSections(sections).map(id)).toEqual(['new-session', 'view-diff', 'toggle-theme']);
  });
});
