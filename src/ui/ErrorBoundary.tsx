// Contains a render throw to one region of the shell instead of blanking the
// whole webview. `resetKey` (e.g. the selected session id) clears a held error
// when it changes, so switching session recovers without a manual retry.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';
import { EmptyPane } from './EmptyPane';
import './error-boundary.css';

export interface ErrorBoundaryProps {
  /** What failed, e.g. "Transcript". */
  label: string;
  resetKey?: string | null;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Whether a boundary holding an error should clear it after an update. */
export function shouldReset(
  prevKey: string | null | undefined,
  nextKey: string | null | undefined,
  hasError: boolean,
): boolean {
  return hasError && prevKey !== nextKey;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (shouldReset(prev.resetKey, this.props.resetKey, this.state.error !== null)) this.reset();
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <EmptyPane className="error-boundary">
        <span className="error-boundary__title">{this.props.label} failed to render.</span>
        <span className="error-boundary__detail">{error.message}</span>
        <Button variant="secondary" size="sm" onClick={this.reset}>
          Retry
        </Button>
      </EmptyPane>
    );
  }
}
