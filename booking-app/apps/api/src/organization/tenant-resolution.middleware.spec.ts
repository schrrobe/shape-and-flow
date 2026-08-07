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
});
