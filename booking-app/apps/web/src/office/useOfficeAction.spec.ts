import { describe, expect, it } from 'vitest';

import { useOfficeAction } from './useOfficeAction.js';

/**
 * An `ApiError`-shaped rejection, which is what `officeMessage` reads.
 *
 * Thrown as an `Error` carrying the fields rather than as a bare object: the client rejects
 * with an `ApiError`, and a plain object would let a `caught instanceof Error` check pass
 * here that fails in the browser.
 */
function refusal(code: string): Error {
  return Object.assign(new Error(code), { code, correlationId: 'c1', status: 409 });
}

describe('useOfficeAction', () => {
  it('reports a write that went through even when the refetch afterwards fails', async () => {
    const action = useOfficeAction(() => Promise.reject(new Error('the list call failed')));

    const applied = await action.run(() => Promise.resolve());

    // The refund has already been sent at this point. Reporting it as failed is how an
    // operator ends up sending it twice.
    expect(applied).toBe(true);
    expect(action.error.value).toBeNull();
  });

  it('reports a refused write, and still refetches', async () => {
    let refetched = 0;
    const action = useOfficeAction(() => {
      refetched += 1;
      return Promise.resolve();
    });

    const applied = await action.run(() => Promise.reject(refusal('SLOT_UNAVAILABLE')));

    expect(applied).toBe(false);
    expect(action.error.value).not.toBeNull();
    // A 409 means the server's state moved, which is exactly when the screen must stop
    // showing what it thought was true.
    expect(refetched).toBe(1);
  });

  it('refetches once per run, whichever way the write went', async () => {
    let refetched = 0;
    const action = useOfficeAction(() => {
      refetched += 1;
      return Promise.resolve();
    });

    await action.run(() => Promise.resolve());

    expect(refetched).toBe(1);
  });

  it('releases the busy flag only once the refetch has settled', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const action = useOfficeAction(() => held);
    const running = action.run(() => Promise.resolve());

    await Promise.resolve();
    // Still busy: the screen has not been told what the write did to it yet, and a second
    // click from here would act on numbers that are already stale.
    expect(action.busy.value).toBe(true);

    release();
    await running;

    expect(action.busy.value).toBe(false);
  });

  it('ignores a second run while the first is in flight', async () => {
    let calls = 0;
    const action = useOfficeAction(() => Promise.resolve());

    const first = action.run(async () => {
      calls += 1;
      await Promise.resolve();
    });
    const second = await action.run(async () => {
      calls += 1;
      await Promise.resolve();
    });

    await first;

    expect(second).toBe(false);
    expect(calls).toBe(1);
  });
});
