// projects — the small inline error line shared by the project settings'
// General, Session defaults and Standards tabs.

export function InlineError({ children }: { children: React.ReactNode }) {
  return <div className="pj-inline-error">{children}</div>;
}
