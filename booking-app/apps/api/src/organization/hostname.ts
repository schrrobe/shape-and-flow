import { isIP } from 'node:net';

import type { Request } from 'express';

/**
 * Hostname handling for domain-based tenant resolution.
 *
 * Two entry points, deliberately different in strictness:
 *
 *  - `normalizeHostname` decides what may be *stored*. It is the narrow one: a stored
 *    hostname has to be the single spelling every future lookup will produce, so
 *    anything ambiguous is rejected rather than guessed at.
 *  - `hostnameFromRequest` decides what an *arriving* request is asking for. It has to
 *    accept whatever a browser or proxy actually sends, including the loopback
 *    addresses the dev server and the integration suite use.
 *
 * Ports are dropped on both sides. In production a port never distinguishes tenants —
 * everything arrives on 443 — and locally the way to reach a second organizer is a
 * `*.localhost` name, not a second port. Storing `example.com:8443` would only create a
 * spelling that the request path could never match.
 */

/** RFC 1035 wire-format limit, minus the root label. */
const MAX_HOSTNAME_LENGTH = 253;

/** One DNS label: 1–63 chars, alphanumeric with inner hyphens. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Strip the decorations a host can arrive with, without judging what is left.
 *
 * IPv6 arrives bracketed (`[::1]`) because that is how it is written in a URL, and a
 * fully-qualified name may carry the root label's trailing dot (`example.com.`) —
 * `example.com.` and `example.com` are the same name and must not be two rows.
 */
function stripDecorations(value: string): string {
  let host = value.trim().toLowerCase();

  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);

  return host;
}

/** A syntactically valid DNS name, or null. IP literals are not names and fail here. */
function validDnsName(host: string): string | null {
  if (host === '' || host.length > MAX_HOSTNAME_LENGTH) return null;
  if (isIP(host) !== 0) return null;

  const labels = host.split('.');
  if (labels.some((label) => !LABEL_PATTERN.test(label))) return null;

  return host;
}

/**
 * The canonical stored form of a hostname, or null if it cannot be one.
 *
 * Accepts what an owner is likely to paste — `https://Studio-Muster.de/`, a trailing
 * dot, a port, an internationalized name — and reduces all of it to the one spelling
 * `hostnameFromRequest` will produce for a request that arrives there. `URL` does the
 * IDN work: `müller.de` is stored as `xn--mller-kva.de`, which is what DNS resolves and
 * what the `Host` header carries.
 *
 * IP literals are rejected. A booking flow reached at a bare address has no certificate
 * and no DNS record pointing at it, so it is never a real organizer domain — and
 * allowing one would offer `127.0.0.1` as a claimable hostname.
 */
export function normalizeHostname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (value === '' || /\s/.test(value)) return null;

  const scheme = /^https?:\/\//i.exec(value);
  if (scheme === null) {
    // Some other scheme, or a bare `//host`. Either way this is not a hostname the
    // caller merely spelled verbosely.
    if (value.includes('//')) return null;
  } else {
    value = value.slice(scheme[0].length);
  }

  // A single trailing slash is what a browser's address bar copies; anything past it is
  // a path, and a path means the caller supplied a URL rather than a hostname.
  if (value.endsWith('/')) value = value.slice(0, -1);
  if (/[/?#@]/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    return null;
  }

  return validDnsName(stripDecorations(parsed.hostname));
}

/**
 * The hostname this request arrived on, or null if it is unusable.
 *
 * `request.hostname` is the trusted read: with `app.set('trust proxy', 1)` (see
 * `main.ts`) Express returns the `X-Forwarded-Host` value, and nginx sets that header
 * itself on every proxied request, overwriting anything a client sent. The API is
 * published on loopback only, so there is no path to it that skips that rewrite.
 *
 * Unlike the stored form this accepts IP literals, because `127.0.0.1` and `::1` are
 * what the dev server and the integration suite actually connect to — they never match
 * a stored domain, but they do have to reach the central-host check.
 */
export function hostnameFromRequest(request: Request): string | null {
  const raw = request.hostname;
  if (typeof raw !== 'string') return null;

  const host = stripDecorations(raw);
  if (host === '') return null;
  if (isIP(host) !== 0) return host;

  return validDnsName(host);
}

/**
 * The configuration `isCentralHost` reads.
 *
 * Structurally a subset of `AppConfig`, declared separately so the host rules can be
 * unit-tested without constructing a whole environment.
 */
export interface CentralHostConfig {
  PUBLIC_WEB_ORIGIN: string;
  PUBLIC_API_ORIGIN: string;
  CENTRAL_HOSTNAMES?: string | undefined;
  NODE_ENV: 'development' | 'test' | 'production';
}

const cache = new WeakMap<CentralHostConfig, ReadonlySet<string>>();

/**
 * The hostnames on which `?organizer=<slug>` is allowed to choose the tenant.
 *
 * Derived from the origins the deployment already declares, so the common case needs no
 * new configuration. `CENTRAL_HOSTNAMES` only adds aliases — a stage host that answers
 * under two names, say.
 *
 * Outside production the loopback names join the set. That is not a convenience: the
 * integration suite reaches the app as `127.0.0.1:<port>` and the dev server as
 * `localhost:5173`, and without this every existing `?organizer=` request would be a
 * foreign host asking to pick a tenant, which is exactly what the gate refuses.
 */
export function centralHostnames(config: CentralHostConfig): ReadonlySet<string> {
  const cached = cache.get(config);
  if (cached !== undefined) return cached;

  const hosts = new Set<string>();

  for (const origin of [config.PUBLIC_WEB_ORIGIN, config.PUBLIC_API_ORIGIN]) {
    const host = stripDecorations(new URL(origin).hostname);
    if (host !== '') hosts.add(host);
  }

  for (const entry of (config.CENTRAL_HOSTNAMES ?? '').split(',')) {
    const host = stripDecorations(entry);
    if (host !== '') hosts.add(host);
  }

  if (config.NODE_ENV !== 'production') {
    hosts.add('localhost');
    hosts.add('127.0.0.1');
    hosts.add('::1');
  }

  cache.set(config, hosts);
  return hosts;
}

/**
 * Whether this host may resolve a tenant from the query string.
 *
 * A null hostname is not central. An unparseable `Host` header offering a slug is not a
 * request from our own front door, and treating it as one would hand tenant selection to
 * whoever sent the header.
 */
export function isCentralHost(hostname: string | null, config: CentralHostConfig): boolean {
  if (hostname === null) return false;

  const hosts = centralHostnames(config);
  if (hosts.has(hostname)) return true;

  // `*.localhost` resolves to loopback in every current browser and is how a second
  // organizer is reached in local development. Never in production.
  return config.NODE_ENV !== 'production' && hostname.endsWith('.localhost');
}
