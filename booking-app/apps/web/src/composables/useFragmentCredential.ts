import { computed, onBeforeUnmount, ref } from 'vue';

import type { ComputedRef, Ref } from 'vue';

/**
 * A credential that arrived in the URL fragment, taken out of it and kept in memory.
 *
 * The fragment is where these tokens arrive because a fragment is never sent to a server: it stays
 * out of access logs, out of proxy logs and out of any `Referer` header the page later emits. That
 * only holds while it *stays* out of the address bar, which is what `history.replaceState` is for
 * — otherwise the first screenshot, shared link or shoulder-glance leaks a live credential.
 *
 * It is never written to `localStorage`, `sessionStorage` or a cookie. Any script on the origin can
 * read those, and a token in storage outlives the tab that needed it. Losing it on reload is the
 * correct trade: the recipient has the link in their email.
 *
 * Two things arrive this way — a customer's management token and an office password-reset token —
 * and they need identical handling, so the mechanics live here rather than in either page.
 */

/**
 * The token in the fragment, or null.
 *
 * Decoded before being trimmed: a mail client that wrapped or encoded the link can leave the
 * fragment technically present and useless — `#%20` is not a token, and sending it to the API
 * would produce a 401 the recipient cannot act on rather than "your link is incomplete".
 */
function readFragment(): string | null {
  const raw = window.location.hash.replace(/^#/, '');

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding: not a token either.
    return null;
  }

  const trimmed = decoded.trim();
  return trimmed === '' ? null : trimmed;
}

/** Read the token, then keep it out of the URL. */
export function useFragmentCredential(): {
  token: Ref<string | null>;
  missing: ComputedRef<boolean>;
} {
  const token = ref<string | null>(null);

  function take(): void {
    const found = readFragment();
    // Never clears a token already held: `replaceState` below empties the fragment, and a page
    // mid-way through using its credential must not lose it to its own tidying up.
    if (found === null) return;

    token.value = found;

    // `replaceState`, not `pushState`: a new history entry would make the back button reintroduce
    // the token into the address bar.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }

  take();

  /**
   * A fragment that arrives after mount still counts.
   *
   * Opening the emailed link while already sitting on the same path is a hash-only navigation:
   * the browser and the router both treat it as the same document, so nothing remounts and the
   * token would sit in the address bar while the page said the link was incomplete. Found by
   * doing exactly that in a browser.
   */
  window.addEventListener('hashchange', take);
  onBeforeUnmount(() => {
    window.removeEventListener('hashchange', take);
  });

  const missing = computed(() => token.value === null);

  return { token, missing };
}
