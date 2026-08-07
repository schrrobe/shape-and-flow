import { describe, expect, it, vi } from 'vitest';

import { OfficeTenantMiddleware } from './office-tenant.middleware.js';
import { hasTenant } from './tenant-context.store.js';

import type { SessionStore } from '../auth/session.store.js';
import type { AppConfig } from '../config/env.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NextFunction, Request, Response } from 'express';

const config = { SESSION_COOKIE_NAME: 'sid' } as AppConfig;

function fakeRequest(cookieHeader: string | undefined): Request {
  return { headers: { cookie: cookieHeader } } as unknown as Request;
}

describe('OfficeTenantMiddleware', () => {
  it('falls through to the default organization when there is no session cookie', async () => {
    const read = vi.fn();
    const findUnique = vi.fn();
    const middleware = new OfficeTenantMiddleware(
      { read } as unknown as SessionStore,
      { organization: { findUnique } } as unknown as PrismaService,
      config,
    );
    const next = vi.fn();

    await middleware.middleware(fakeRequest(undefined), {} as Response, next as NextFunction);

    expect(read).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(hasTenant()).toBe(false);
  });

  it('resolves the tenant scope for a valid session', async () => {
    const organization = { id: 'org-1', slug: 'acme', settings: { id: 'settings-1' } };
    const read = vi.fn().mockResolvedValue({ organizationId: 'org-1' });
    const findUnique = vi.fn().mockResolvedValue(organization);
    const middleware = new OfficeTenantMiddleware(
      { read } as unknown as SessionStore,
      { organization: { findUnique } } as unknown as PrismaService,
      config,
    );
    const next = vi.fn(() => {
      expect(hasTenant()).toBe(true);
    });

    await middleware.middleware(fakeRequest('sid=abc'), {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects instead of falling through when the session exists but the organization lookup fails', async () => {
    const read = vi.fn().mockResolvedValue({ organizationId: 'org-missing' });
    const findUnique = vi.fn().mockResolvedValue(null);
    const middleware = new OfficeTenantMiddleware(
      { read } as unknown as SessionStore,
      { organization: { findUnique } } as unknown as PrismaService,
      config,
    );
    const next = vi.fn();

    await expect(
      middleware.middleware(fakeRequest('sid=abc'), {} as Response, next as NextFunction),
    ).rejects.toThrow();

    expect(next).not.toHaveBeenCalled();
  });
});
