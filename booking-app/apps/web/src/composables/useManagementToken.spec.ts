import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useManagementToken } from './useManagementToken.js';

const MANAGE_PATH = '/manage';

function withFragment(fragment: string): void {
  history.replaceState(null, '', `${MANAGE_PATH}${fragment}`);
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

    const { token } = useManagementToken();

    expect(token.value).toBe('abc123');
    // A token left in the address bar leaks through the first screenshot or shared link.
    expect(window.location.hash).toBe('');
    expect(replaceState).toHaveBeenCalled();
  });

  it('keeps the path and query when it strips the fragment', () => {
    history.replaceState(null, '', `${MANAGE_PATH}?lang=en#abc123`);

    useManagementToken();

    expect(window.location.pathname).toBe(MANAGE_PATH);
    expect(window.location.search).toBe('?lang=en');
  });

  it('keeps the token in memory only', () => {
    withFragment('#abc123');

    useManagementToken();

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

    const { token, missing } = useManagementToken();

    expect(token.value).toBeNull();
    expect(missing.value).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('treats a fragment of only whitespace as missing', () => {
    withFragment('#%20');

    // A mail client that wrapped the link can leave the fragment technically present and useless.
    expect(useManagementToken().missing.value).toBe(true);
  });

  it('does not touch history when there is nothing to strip', () => {
    withFragment('');
    const replaceState = vi.spyOn(history, 'replaceState');

    useManagementToken();

    expect(replaceState).not.toHaveBeenCalled();
  });
});
