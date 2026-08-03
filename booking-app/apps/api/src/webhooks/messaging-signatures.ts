import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature verification for the two messaging providers.
 *
 * One function each, because there is no shared scheme to factor out. Resend signs through
 * Svix and Twilio does its own thing, and they differ in every dimension that matters: the
 * digest algorithm, the encoding, the key material, and what the signed string even is. A
 * single generic HMAC helper can only be right for one of them, and silently rejecting
 * every authentic delivery from the other is exactly the failure it produces.
 *
 * Both return a boolean rather than throwing, so the controller owns the response and this
 * module stays testable without an HTTP layer.
 */

/**
 * How far a Svix timestamp may be from now.
 *
 * Svix's own tolerance. Checked rather than merely read: without it a captured request stays
 * replayable forever, because the signature over it never stops being valid.
 */
export const SVIX_TOLERANCE_MS = 5 * 60_000;

/**
 * Verify a Svix signature, which is what Resend sends.
 *
 * The secret arrives base64-encoded behind a `whsec_` prefix and is the *decoded* bytes that
 * key the HMAC — using the prefixed string verbatim produces a digest that never matches.
 * The digest is base64, and `svix-signature` may carry several space-separated versions, so
 * every `v1,` entry is a candidate: Svix sends more than one while a secret is being rotated.
 */
export function verifySvix(input: {
  secret: string;
  svixId: string;
  timestamp: string;
  body: string;
  signatureHeader: string;
  now: Date;
}): boolean {
  if (!withinTolerance(input.timestamp, input.now)) return false;

  const key = svixKey(input.secret);
  if (key === null) return false;

  const expected = createHmac('sha256', key)
    .update(`${input.svixId}.${input.timestamp}.${input.body}`, 'utf8')
    .digest('base64');

  return input.signatureHeader
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => entry.slice('v1,'.length))
    .some((candidate) => constantTimeEquals(expected, candidate));
}

/**
 * Verify a Twilio signature.
 *
 * HMAC-SHA1 — not SHA-256 — base64-encoded, over the full request URL with every POST
 * parameter appended as `name` immediately followed by `value`, sorted by name. Not over the
 * raw body: two bodies that parse to the same parameters must produce the same signature,
 * which is why Twilio specifies the reconstruction rather than the bytes.
 */
export function verifyTwilio(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  const signedPayload = Object.keys(input.params)
    .sort()
    .reduce((accumulator, name) => `${accumulator}${name}${input.params[name] ?? ''}`, input.url);

  const expected = createHmac('sha1', input.authToken)
    .update(signedPayload, 'utf8')
    .digest('base64');

  return constantTimeEquals(expected, input.signature);
}

/** The decoded signing key, or null when the secret is not shaped like one. */
function svixKey(secret: string): Buffer | null {
  const encoded = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;

  // A secret that is not valid base64 would decode to something arbitrary and silently
  // fail every comparison, so it is rejected as the configuration error it is.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;

  const key = Buffer.from(encoded, 'base64');
  return key.length === 0 ? null : key;
}

function withinTolerance(timestamp: string, now: Date): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;

  return Math.abs(now.getTime() - seconds * 1000) <= SVIX_TOLERANCE_MS;
}

/**
 * Compare two digests without leaking their difference through timing.
 *
 * Length-checked first because `timingSafeEqual` throws on differing lengths — and a length
 * mismatch is not a secret: it means the caller sent something the wrong shape entirely.
 */
function constantTimeEquals(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');

  return left.length === right.length && timingSafeEqual(left, right);
}
