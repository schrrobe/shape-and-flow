/**
 * What route meta may carry.
 *
 * Declared rather than left as `unknown`, so `to.meta.requiresSession !== true` is a
 * type-checked comparison instead of a guess. A typo in the key would otherwise read as
 * "this route is public" — the safe-looking answer, and the wrong one.
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** `'office'` for the staff area; absent for the customer-facing pages. */
    area?: 'office';
    /** The route needs a live office session. Absent means it does not. */
    requiresSession?: boolean;
  }
}

export {};
