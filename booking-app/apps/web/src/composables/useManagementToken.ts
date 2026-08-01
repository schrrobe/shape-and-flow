import { computed, ref } from 'vue';

import type { ComputedRef, Ref } from 'vue';

/**
 * The management token, taken out of the URL fragment and kept in memory.
 *
 * The fragment is where the token arrives because a fragment is never sent to a server: it stays
 * out of access logs, out of proxy logs and out of any `Referer` header the page later emits. That
 * only holds while it *stays* out of the address bar, which is what `history.replaceState` is for
 * — otherwise the first screenshot, shared link or shoulder-glance leaks a live credential.
 *
 * It is never written to `localStorage`, `sessionStorage` or a cookie. Any script on the origin can
 * read those, and a token in storage outlives the tab that needed it. Losing it on reload is the
 * correct trade: the customer has the link in their email.
 */

/**
 * The token in the fragment, or null.
 *
 * Decoded before being trimmed: a mail client that wrapped or encoded the link can leave the
 * fragment technically present and useless — `#%20` is not a token, and sending it to the API
 * would produce a 401 the customer cannot act on rather than "your link is incomplete".
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

/**
 * Read the token once, then keep it out of the URL.
 *
 * See the note above for why the fragment is the delivery mechanism and why it does not stay there.
 */
export function useManagementToken(): {
  token: Ref<string | null>;
  missing: ComputedRef<boolean>;
} {
  const token = ref<string | null>(readFragment());

  if (token.value !== null) {
    // `replaceState`, not `pushState`: a new history entry would make the back button reintroduce
    // the token into the address bar.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }

  const missing = computed(() => token.value === null);

  return { token, missing };
}
