// The Settings surface's shared parts (Figma "21–23 · Settings / …", 140:7586,
// 140:7787, 140:7929): the left nav (groups of 32px items with a trailing mono
// count), the page header (breadcrumb · heading · lede · one action), and the
// three block shapes every page composes — a labelled field, a filled row card
// (title + description + trailing control, with a danger tone) and the info
// note. Each settings page lives in its own feature; these are the pieces they
// share so the pages cannot drift apart. Styles: settings.css.

import type { ReactNode, SelectHTMLAttributes } from 'react';
import { Icon } from './Icon';
import './settings.css';

// ------------------------------------------------------------------ nav

export function SettingsNavGroup({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="settings-nav__group" role="group" aria-label={label}>
      <div className={action ? 'settings-nav__head settings-nav__head--action' : 'settings-nav__head'}>
        <span className="settings-nav__label">{label}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

export interface SettingsNavItemProps {
  label: string;
  selected?: boolean;
  /** Trailing mono figure; hidden when undefined or 0. */
  count?: number;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

export function SettingsNavItem({ label, selected = false, count, disabled, title, onSelect }: SettingsNavItemProps): JSX.Element {
  return (
    <button
      type="button"
      className={selected ? 'settings-nav__item settings-nav__item--selected' : 'settings-nav__item'}
      aria-current={selected ? 'page' : undefined}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      <span className="settings-nav__text">{label}</span>
      {count !== undefined && count > 0 && <span className="settings-nav__count">{count}</span>}
    </button>
  );
}

// --------------------------------------------------------------- header

export interface SettingsHeaderProps {
  /** Breadcrumb segments, e.g. ['App', 'Accounts']. */
  crumbs: string[];
  title: string;
  /** The lede under the heading (ui text), or a mono line such as a path. */
  lede?: ReactNode;
  ledeMono?: boolean;
  /** The page's one strong action, bottom-aligned on the right. */
  action?: ReactNode;
}

export function SettingsHeader({ crumbs, title, lede, ledeMono, action }: SettingsHeaderProps): JSX.Element {
  return (
    <header className="settings-header">
      <div className="settings-header__title">
        <span className="settings-header__crumbs">{crumbs.join('  /  ')}</span>
        <h1 className="settings-header__heading">{title}</h1>
        {lede && <p className={ledeMono ? 'settings-header__lede settings-header__lede--mono' : 'settings-header__lede'}>{lede}</p>}
      </div>
      {action}
    </header>
  );
}

// --------------------------------------------------------------- blocks

/** A label over a control, with an optional hint line under it. */
export function SettingsField({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return (
    <label className={className ? `settings-field ${className}` : 'settings-field'}>
      <span className="settings-field__label">{label}</span>
      {children}
      {hint && <span className="settings-field__hint">{hint}</span>}
    </label>
  );
}

/** Figma "Select": a native <select> in the input chrome, with the set's chevron. */
export function SettingsSelect({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }): JSX.Element {
  return (
    <span className="settings-select">
      <select className={className ? `settings-input ${className}` : 'settings-input'} {...rest}>
        {children}
      </select>
      <Icon name="chevron-down" size={12} className="settings-select__chevron" />
    </span>
  );
}

/** Figma "Pinned" / "Danger zone": a filled row — title + description, one trailing control. */
export function SettingsCard({
  title,
  description,
  tone = 'default',
  children,
}: {
  title: string;
  description?: ReactNode;
  tone?: 'default' | 'danger';
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={tone === 'danger' ? 'settings-card settings-card--danger' : 'settings-card'}>
      <div className="settings-card__text">
        <span className="settings-card__title">{title}</span>
        {description && <span className="settings-card__description">{description}</span>}
      </div>
      {children}
    </div>
  );
}

/** Figma "Note": the info line under a table. `<code>` inside renders mono. */
export function SettingsNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="settings-note">
      <Icon name="info" size={15} className="settings-note__icon" />
      <p className="settings-note__text">{children}</p>
    </div>
  );
}
