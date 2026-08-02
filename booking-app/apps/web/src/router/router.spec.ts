import { describe, expect, it } from 'vitest';

import { router } from './index.js';

describe('the router', () => {
  it('resolves the home route', () => {
    expect(router.resolve('/').name).toBe('home');
  });

  it('sends an unknown path to the not-found page rather than a blank screen', () => {
    expect(router.resolve('/does/not/exist').name).toBe('not-found');
  });

  it('declares no route pointing at a component that cannot be loaded', async () => {
    // A lazy route is only checked when somebody visits it, so a typo in an import path is a
    // 404 in production and nothing in CI. Loading every component here turns that into a
    // failing test.
    for (const route of router.getRoutes()) {
      const loader = route.components?.default;
      if (typeof loader !== 'function') continue;

      await expect((loader as () => Promise<unknown>)(), route.path).resolves.toBeTruthy();
    }
  });
});
