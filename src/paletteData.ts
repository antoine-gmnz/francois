// Shared, synchronously-readable caches that back the palette's secondary steps
// and dynamic hints (FR-19/FR-21). Each is populated by the owning feature's pane
// as it loads its own data, and read (never mutated) by the palette commands.
// This adapts the spec's "data the registering feature already holds" to this
// single-App architecture without duplicating fetches.

import { create } from 'zustand';
import type { ModelInfo, SkillInfo, AgentInfo } from '../contract/common';

// A revision counter the palette subscribes to, so a change to any of these caches
// re-renders the open palette and its per-render PaletteContext/hints stay live (FR-9).
export const usePaletteDataRev = create<{ rev: number; bump: () => void }>((set) => ({
  rev: 0,
  bump: () => set((s) => ({ rev: s.rev + 1 })),
}));
const bump = () => usePaletteDataRev.getState().bump();

// switch-model: the static model catalog, fetched once at bootstrap (FR-19).
let models: ModelInfo[] = [];
export const setPaletteModels = (m: ModelInfo[]) => {
  models = m;
  bump();
};
export const getPaletteModels = (): ModelInfo[] => models;

// run-skill: installed skills for a session (skills-panel's skills:list cache, FR-23).
const skillsBySession: Record<string, SkillInfo[]> = {};
export const setPaletteSkills = (sessionId: string, list: SkillInfo[]) => {
  skillsBySession[sessionId] = list.filter((s) => s.installed);
  bump();
};
export const getPaletteSkills = (sessionId: string | null): SkillInfo[] =>
  (sessionId && skillsBySession[sessionId]) || [];

// kill-agent + runningAgentCount: the active session's agent map (agents-panel, FR-23).
const agentsBySession: Record<string, AgentInfo[]> = {};
export const setPaletteAgents = (sessionId: string, list: AgentInfo[]) => {
  agentsBySession[sessionId] = list;
  bump();
};
export const getPaletteRunningAgents = (sessionId: string | null): AgentInfo[] =>
  ((sessionId && agentsBySession[sessionId]) || []).filter((a) => a.status === 'running');

// view-diff hint: fileCount for the active session (app-shell's derived badge count, FR-21).
let diffCount = 0;
export const setPaletteDiffCount = (n: number) => {
  diffCount = n;
  bump();
};
export const getPaletteDiffCount = (): number => diffCount;

// Drop a session's cached data when it is removed (avoids unbounded growth).
export const prunePaletteSession = (sessionId: string) => {
  delete skillsBySession[sessionId];
  delete agentsBySession[sessionId];
};
