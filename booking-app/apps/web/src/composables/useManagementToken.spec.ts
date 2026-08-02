import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { useManagementToken } from './useManagementToken.js';

const MANAGE_PATH = '/manage';

function withFragment(fragment: string): void {
  history.replaceState(null, '', `${MANAGE_PATH}${fragment}`);
}

enableAutoUnmount(afterEach);

/**
 * Run the composable inside a component, because that is where it runs.
 *
 * It registers an unmount hook — it listens for a fragment that arrives after mount — so
 * calling it bare would both warn and leave the listener behind between tests.
 */
function run(): ReturnType<typeof useManagementToken> {
  // A holder rather than a bare `let`: TypeScript cannot see the assignment inside `setup`, so a
  // local would be narrowed to `null` and the guard below would read as always true.
  const captured: { result: ReturnType<typeof useManagementToken> | null } = { result: null };

  mount(
    defineComponent({
      setup() {
        captured.result = useManagementToken();
        return () => h('div');
      },
    }),
  );

  if (captured.result === null) throw new Error('setup did not run');

  return captured.result;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  withFragment('');
});

describe('useManagementToken', () => {
  it('reads the token from the fragment and strips it from the address bar', () => {
    withFragment('#abc123');
    const replaceState = vi.spyOn(history, 'replaceState');

    const { token } = run();

    expect(token.value).toBe('abc123');
    // A token left in the address bar leaks through the first screenshot or shared link.
    expect(window.location.hash).toBe('');
    expect(replaceState).toHaveBeenCalled();
  });

  it('keeps the path and query when it strips the fragment', () => {
    history.replaceState(null, '', `${MANAGE_PATH}?lang=en#abc123`);

    run();

    expect(window.location.pathname).toBe(MANAGE_PATH);
    expect(window.location.search).toBe('?lang=en');
  });

  it('keeps the token in memory only', () => {
    withFragment('#abc123');

    run();

    // Any script on the origin can read storage, and a token there outlives the tab that needed
    // it. The customer still has the link in their email.
    expect(localStorage.getItem('sf.manage.token')).toBeNull();
    expect(sessionStorage.getItem('sf.manage.token')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain('abc123');
  });

  it('reports a missing token instead of calling the api', () => {
    withFragment('');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { token, missing } = run();

    expect(token.value).toBeNull();
    expect(missing.value).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('treats a fragment of only whitespace as missing', () => {
    withFragment('#%20');

    // A mail client that wrapped the link can leave the fragment technically present and useless.
    expect(run().missing.value).toBe(true);
  });

  it('does not touch history when there is nothing to strip', () => {
    withFragment('');
    const replaceState = vi.spyOn(history, 'replaceState');

    run();

    expect(replaceState).not.toHaveBeenCalled();
  });

  it('picks up a fragment that arrives after mount', () => {
    withFragment('');
    const { token, missing } = run();
    expect(missing.value).toBe(true);

    // Opening the emailed link while already on this path is a hash-only navigation: nothing
    // remounts, so a token read only at setup would sit in the address bar while the page said
    // the link was incomplete. Found by doing exactly that in a browser.
    withFragment('#late456');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(token.value).toBe('late456');
    expect(window.location.hash).toBe('');
  });

  it('does not lose the token to its own tidying up', () => {
    withFragment('#abc123');
    const { token } = run();

    // `replaceState` empties the fragment. If that were read back as "no token", a page would
    // discard the credential it is in the middle of using.
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(token.value).toBe('abc123');
  });
});
