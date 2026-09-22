// Figma "State" (125:7904) — the session state glyph. Pass a `kind` directly, or
// a contract `status` and let state-kind.ts map it. The colour is the state's
// own token (icons.css), not a prop.

import type { CSSProperties } from 'react';
import type { SessionStatus } from '../../contract/common';
import { iconAssetUrl } from './icons';
import { stateKindForStatus, type StateKind } from './state-kind';
import './icons.css';

export type StateIconProps = {
  /** Square size in px; the design uses 10–16. Defaults to 14 (a roster row). */
  size?: number;
  className?: string;
  title?: string;
} & ({ kind: StateKind; status?: never } | { status: SessionStatus; kind?: never });

export function StateIcon(props: StateIconProps): JSX.Element {
  const kind = props.kind ?? stateKindForStatus(props.status as SessionStatus);
  const size = props.size ?? 14;
  const base = `state-icon state-icon--${kind}`;
  return (
    <span
      className={props.className ? `${base} ${props.className}` : base}
      style={{ '--icon-size': `${size}px`, '--icon-src': `url("${iconAssetUrl(`state-${kind}`)}")` } as CSSProperties}
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
      title={props.title}
    />
  );
}
