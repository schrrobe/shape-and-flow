import { describe, expect, it, vi } from 'vitest';

import { hasTenant } from './tenant-context.store.js';
import { TenantResolutionMiddleware } from './tenant-resolution.middleware.js';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { NextFunction, Request, Response } from 'express';

function fakeRequest(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe('TenantResolutionMiddleware', () => {
  it('falls through to the default organization when no ?organizer= param is present', async () => {
    const findUnique = vi.fn();
    const middleware = new TenantResolutionMiddleware({ organization: { findUnique } } as unknown as PrismaService);
    const next = vi.fn();

    await middleware.middleware(fakeRequest({}), {} as Response, next as NextFunction);

    expect(findUnique).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(hasTenant()).toBe(false);
  });

  it('resolves the tenant scope when ?organizer= names a real organization', async () => {
    const organization = { id: 'org-1', slug: 'acme', settings: { id: 'settings-1' } };
    const findUnique = vi.fn().mockResolvedValue(organization);
    const middleware = new TenantResolutionMiddleware({ organization: { findUnique } } as unknown as PrismaService);
    const next = vi.fn(() => {
      expect(hasTenant()).toBe(true);
    });

    await middleware.middleware(fakeRequest({ organizer: 'acme' }), {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects instead of falling through when ?organizer= names no organization', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const middleware = new TenantResolutionMiddleware({ organization: { findUnique } } as unknown as PrismaService);
    const next = vi.fn();

    await expect(
      middleware.middleware(fakeRequest({ organizer: 'ghost' }), {} as Response, next as NextFunction),
    ).rejects.toThrow();

    expect(next).not.toHaveBeenCalled();
  });

  // A present-but-malformed parameter is an explicit identity that cannot be resolved,
  // not an absent one. Reading it as absent is what lets a tampered link operate on the
  // bootstrap tenant's data.
  it.each([
    ['an empty value', { organizer: '' }],
    ['repeated values', { organizer: ['a', 'b'] }],
  ])('rejects %s rather than serving the default organization', async (_label, query) => {
    const findUnique = vi.fn();
    const middleware = new TenantResolutionMiddleware({ organization: { findUnique } } as unknown as PrismaService);
    const next = vi.fn();

    await expect(
      middleware.middleware(fakeRequest(query), {} as Response, next as NextFunction),
    ).rejects.toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
