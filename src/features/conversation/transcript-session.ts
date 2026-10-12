// code-editor-agents FR-14: the session whose transcript is rendering — an inline
// code span is checked against that session root's file list (CodeLinks.tsx).

import { createContext } from 'react';

export const TranscriptSession = createContext<string | null>(null);
