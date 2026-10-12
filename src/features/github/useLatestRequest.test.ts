import { describe, expect, it } from 'vitest';
import { createGenerationGuard, resolveLatestRequest } from './useLatestRequest';

describe('createGenerationGuard', () => {
  it('a single run stays current', () => {
    const guard = createGenerationGuard();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
  });

  it('a later run supersedes an earlier one', () => {
    const guard = createGenerationGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('invalidate() supersedes every in-flight run', () => {
    const guard = createGenerationGuard();
    const first = guard.begin();
    guard.invalidate();
    expect(first()).toBe(false);

    const second = guard.begin();
    expect(second()).toBe(true);
  });

  it('isCurrent can be checked repeatedly without side effects', () => {
    const guard = createGenerationGuard();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
    expect(isCurrent()).toBe(true);
    guard.begin();
    expect(isCurrent()).toBe(false);
    expect(isCurrent()).toBe(false);
  });
});

describe('repository load and Fetch coordination', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it('drops every late Fetch mutation when another repository loaded', async () => {
    const guard = createGenerationGuard();
    guard.setScope('A');
    const fetch = deferred<string>();
    let repo = 'A';
    let fetching = true;
    let refreshKey = 0;
    const fetchRun = resolveLatestRequest(guard.begin, () => fetch.promise, (data) => {
      repo = data;
      fetching = false;
      refreshKey += 1;
    });
    guard.setScope('B');
    fetching = false; // scope transition resets the indicator
    await resolveLatestRequest(guard.begin, () => Promise.resolve('B'), (data) => { repo = data; });
    fetching = true; // a new Fetch of B must keep its own indicator
    fetch.resolve('A');
    await fetchRun;
    expect({ repo, fetching, refreshKey }).toEqual({ repo: 'B', fetching: true, refreshKey: 0 });
  });

  it('rejects old A Fetch even after switching A → B → A', async () => {
    const guard = createGenerationGuard();
    guard.setScope('A');
    const oldA = deferred<string>();
    const results: string[] = [];
    const fetchRun = resolveLatestRequest(guard.begin, () => oldA.promise, data => results.push(data));
    guard.setScope('B');
    guard.setScope('A');
    await resolveLatestRequest(guard.begin, () => Promise.resolve('new A'), data => results.push(data));
    oldA.resolve('old A');
    await fetchRun;
    expect(results).toEqual(['new A']);
  });

  it('a Fetch supersedes an in-flight load using their shared generation', async () => {
    const guard = createGenerationGuard();
    const load = deferred<string>();
    const results: string[] = [];
    const loadRun = resolveLatestRequest(guard.begin, () => load.promise, data => results.push(data));
    await resolveLatestRequest(guard.begin, () => Promise.resolve('fetched'), data => results.push(data));
    load.resolve('before fetch');
    await loadRun;
    expect(results).toEqual(['fetched']);
  });
});
