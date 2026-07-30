// A set of mutually-exclusive Chip options, generic over the option's value
// type. Replaces the FOUR near-identical chip blocks in NewSessionModal:
// effort (:388-407, value: string, '' = model default), permissions
// (:415-435, value: PermissionMode, with a `danger` option), and runtime
// (:469-491, value: ClaudeRuntime). The GIT chip (:445-458) is a lone toggle,
// not a group — see Chip.tsx.
//
// ChipGroup deliberately renders no wrapping element: every call site already
// wraps its chips in its own labeled field `<div>` with its own flex/gap, and
// a generic container class for "a row of chips" isn't part of the frozen
// CSS contract — the caller keeps owning that layout.

import type { ReactNode } from 'react';
import { Chip } from './Chip';

export interface ChipOption<T> {
  value: T;
  label: ReactNode;
  /** Marks this option as the destructive/risky choice (see Chip's `danger`). */
  danger?: boolean;
}

export interface ChipGroupProps<T> {
  options: ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** The index of `value` within `options`, or -1 if none matches. Equality is
 * `===`, which is exactly right for every current call site (string/enum
 * option values) — an object-valued ChipGroup would need option identity to
 * be stable across renders, same as a React `key`. */
export function selectedChipIndex<T>(options: ChipOption<T>[], value: T): number {
  return options.findIndex((o) => o.value === value);
}

export function ChipGroup<T>({ options, value, onChange }: ChipGroupProps<T>): JSX.Element {
  const selectedIndex = selectedChipIndex(options, value);
  return (
    <>
      {options.map((o, i) => (
        <Chip key={`${i}-${String(o.value)}`} selected={i === selectedIndex} danger={o.danger} onClick={() => onChange(o.value)}>
          {o.label}
        </Chip>
      ))}
    </>
  );
}
