// code-editor FR-7 / §7: the one door to Monaco. A dynamic import, so Monaco stays
// out of the main bundle until the Code tab first shows a file; a failed load is
// forgotten so the "Editor failed to load" Retry can try again.

export type MonacoModule = typeof import('./monaco-setup');

let loading: Promise<MonacoModule> | null = null;

export function loadMonaco(): Promise<MonacoModule> {
  if (!loading) {
    loading = import('./monaco-setup').catch((e: unknown) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
