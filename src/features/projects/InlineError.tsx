// projects — the small inline error line shared by ProjectsModal's Identity,
// Session defaults and Standards groups. Split out of ProjectsModal per
// REFACTOR.md §6c.

export function InlineError({ children, indent }: { children: React.ReactNode; indent?: boolean }) {
  return <div className={indent ? 'pj-inline-error pj-inline-error--indented' : 'pj-inline-error'}>{children}</div>;
}
