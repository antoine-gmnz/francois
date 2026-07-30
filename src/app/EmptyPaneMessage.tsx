import type { ReactNode } from 'react';
import { EmptyPane } from '../ui/EmptyPane';

export interface EmptyPaneMessageProps {
  children: ReactNode;
}

/**
 * Thin wrapper around the shared `EmptyPane` primitive for the app-shell's
 * "select a session…" placeholders — used throughout `MainPaneBody`'s
 * renderer table so every branch reads the same way.
 */
export default function EmptyPaneMessage({ children }: EmptyPaneMessageProps) {
  return <EmptyPane>{children}</EmptyPane>;
}
