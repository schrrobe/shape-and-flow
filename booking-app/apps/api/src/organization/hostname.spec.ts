import { describe, expect, it } from 'vitest';

import {
  centralHostnames,
  hostnameFromRequest,
  isCentralHost,
  normalizeHostname,
} from './hostname.js';

import type { CentralHostConfig } from './hostname.js';
import type { Request } from 'express';

const requestWith = (hostname: unknown): Request => ({ hostname }) as unknown as Request;

const configWith = (overrides: Partial<CentralHostConfig> = {}): CentralHostConfig => ({
  PUBLIC_WEB_ORIGIN: 'https://buchung.example.com',
  PUBLIC_API_ORIGIN: 'https://buchung.example.com',
  NODE_ENV: 'production',
  ...overrides,
});

describe('normalizeHostname', () => {
  it('lowercases', () => {
    expect(normalizeHostname('Studio-Muster.de')).toBe('studio-muster.de');
  });

  it('drops the root label a fully-qualified name carries', () => {
    expect(normalizeHostname('studio-muster.de.')).toBe('studio-muster.de');
  });

  it('accepts a pasted URL and keeps only the host', () => {
    expect(normalizeHostname('https://Studio-Muster.de/')).toBe('studio-muster.de');
    expect(normalizeHostname('http://www.studio-muster.de')).toBe('www.studio-muster.de');
  });

  it('drops a port, because a port never distinguishes tenants', () => {
    expect(normalizeHostname('studio-muster.de:8443')).toBe('studio-muster.de');
    expect(normalizeHostname('https://kunde-a.localhost:5173')).toBe('kunde-a.localhost');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHostname('  studio-muster.de  ')).toBe('studio-muster.de');
  });

  it('stores an internationalized name in the punycode form DNS and the Host header use', () => {
    expect(normalizeHostname('müller-studio.de')).toBe('xn--mller-studio-dlb.de');
  });

  it('accepts a single label, which is what local development uses', () => {
    expect(normalizeHostname('kunde-a.localhost')).toBe('kunde-a.localhost');
    expect(normalizeHostname('localhost')).toBe('localhost');
  });

  it.each([
    ['a path', 'studio-muster.de/booking'],
    ['a query string', 'studio-muster.de?organizer=x'],
    ['a fragment', 'studio-muster.de#top'],
    ['credentials', 'admin@studio-muster.de'],
    ['a non-HTTP scheme', 'ftp://studio-muster.de'],
    ['a scheme-relative URL', '//studio-muster.de'],
    ['inner whitespace', 'studio muster.de'],
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a leading hyphen in a label', '-studio.de'],
    ['a trailing hyphen in a label', 'studio-.de'],
    ['an underscore', 'studio_muster.de'],
    ['an empty label', 'studio..de'],
  ])('rejects %s', (_case, input) => {
    expect(normalizeHostname(input)).toBeNull();
  });

  it('rejects a label longer than 63 characters', () => {
    expect(normalizeHostname(`${'a'.repeat(64)}.de`)).toBeNull();
    expect(normalizeHostname(`${'a'.repeat(63)}.de`)).toBe(`${'a'.repeat(63)}.de`);
  });

  it('rejects a name longer than 253 characters', () => {
    const long = `${Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.')}.de`;
    expect(long.length).toBeGreaterThan(253);
    expect(normalizeHostname(long)).toBeNull();
  });

  it('rejects an IP literal, which can never be a real organizer domain', () => {
    expect(normalizeHostname('127.0.0.1')).toBeNull();
    expect(normalizeHostname('[::1]')).toBeNull();
    expect(normalizeHostname('203.0.113.10')).toBeNull();
  });

  it('rejects anything that is not a string', () => {
    expect(normalizeHostname(undefined)).toBeNull();
    expect(normalizeHostname(['a.de', 'b.de'])).toBeNull();
    expect(normalizeHostname(42)).toBeNull();
  });
});

describe('hostnameFromRequest', () => {
  it('normalizes what the proxy forwarded', () => {
    expect(hostnameFromRequest(requestWith('Studio-Muster.de.'))).toBe('studio-muster.de');
  });

  it('accepts the loopback addresses the dev server and the test suite connect to', () => {
    expect(hostnameFromRequest(requestWith('127.0.0.1'))).toBe('127.0.0.1');
    expect(hostnameFromRequest(requestWith('[::1]'))).toBe('::1');
  });

  it('returns null when there is no usable host', () => {
    expect(hostnameFromRequest(requestWith(undefined))).toBeNull();
    expect(hostnameFromRequest(requestWith(''))).toBeNull();
    expect(hostnameFromRequest(requestWith('not a host'))).toBeNull();
  });
});

describe('isCentralHost', () => {
  it('accepts the declared public origins', () => {
    const config = configWith({
      PUBLIC_WEB_ORIGIN: 'https://buchung.example.com',
      PUBLIC_API_ORIGIN: 'https://api.example.com',
    });

    expect(isCentralHost('buchung.example.com', config)).toBe(true);
    expect(isCentralHost('api.example.com', config)).toBe(true);
  });

  it('accepts configured aliases', () => {
    const config = configWith({ CENTRAL_HOSTNAMES: 'stage.example.com, Alias.Example.COM' });

    expect(isCentralHost('stage.example.com', config)).toBe(true);
    expect(isCentralHost('alias.example.com', config)).toBe(true);
  });

  it('rejects an unrelated host in production', () => {
    const config = configWith();

    expect(isCentralHost('studio-muster.de', config)).toBe(false);
    expect(isCentralHost('localhost', config)).toBe(false);
    expect(isCentralHost('127.0.0.1', config)).toBe(false);
    expect(isCentralHost('anything.localhost', config)).toBe(false);
  });

  it('accepts loopback and *.localhost outside production', () => {
    const config = configWith({ NODE_ENV: 'test' });

    expect(isCentralHost('localhost', config)).toBe(true);
    expect(isCentralHost('127.0.0.1', config)).toBe(true);
    expect(isCentralHost('::1', config)).toBe(true);
    expect(isCentralHost('kunde-a.localhost', config)).toBe(true);
  });

  it('treats a missing hostname as not central', () => {
    expect(isCentralHost(null, configWith({ NODE_ENV: 'test' }))).toBe(false);
  });

  it('computes the set once per configuration object', () => {
    const config = configWith();

    expect(centralHostnames(config)).toBe(centralHostnames(config));
  });
});
