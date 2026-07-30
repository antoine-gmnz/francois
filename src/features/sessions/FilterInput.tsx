import type { RefObject } from 'react';
import './sidebar.css';

export interface FilterInputProps {
  value: string;
  onChange: (v: string) => void;
  inputRef: RefObject<HTMLInputElement>;
}

/** Sidebar's '/' name/path filter row (FR-20). */
export function FilterInput({ value, onChange, inputRef }: FilterInputProps): JSX.Element {
  return (
    <div className="filter-input">
      <input
        ref={inputRef}
        className="filter-input__field"
        value={value}
        placeholder="filter…"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
