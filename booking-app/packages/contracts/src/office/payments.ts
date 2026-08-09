import { z } from 'zod';

/**
 * What the office needs to mount Stripe's Connect embedded components.
 *
 * The publishable key travels in the response rather than being compiled into the
 * bundle. The web image carries no runtime configuration by design, so a build-time
 * `VITE_` variable would tie the artifact to one Stripe mode — test and live would need
 * separate images of otherwise identical code. Handing the key back from the API keeps
 * the key and the client secret it pairs with coming from the same place.
 *
 * The client secret is single-use and short-lived: Stripe re-invokes `fetchClientSecret`
 * on refresh, so this endpoint is called repeatedly rather than once per page load.
 */
export const accountSessionResponseSchema = z.object({
  clientSecret: z.string(),
  publishableKey: z.string(),
});

export type AccountSessionResponse = z.infer<typeof accountSessionResponseSchema>;
