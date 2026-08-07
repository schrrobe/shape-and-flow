import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationWebhookHandler } from './organization-webhook.handler.js';

describe('OrganizationWebhookHandler', () => {
  it('handles only account.updated', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: {} }],
    }).compile();

    const handler = moduleRef.get(OrganizationWebhookHandler);

    expect(handler.handles('account.updated')).toBe(true);
    expect(handler.handles('checkout.session.completed')).toBe(false);
  });

  it('updates stripeDetailsSubmitted and stripeChargesEnabled from the account object', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'org_1' });
    const update = vi.fn().mockResolvedValue({});
    const prisma = { organization: { findUnique, update } };

    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: prisma }],
    }).compile();

    const handler = moduleRef.get(OrganizationWebhookHandler);

    await handler.handle('account.updated', {
      id: 'acct_123',
      details_submitted: true,
      charges_enabled: false,
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_123' },
      select: { id: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_123' },
      data: { stripeDetailsSubmitted: true, stripeChargesEnabled: false },
    });
  });

  it('treats a missing details_submitted/charges_enabled as false, not undefined', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'org_1' });
    const update = vi.fn().mockResolvedValue({});
    const prisma = { organization: { findUnique, update } };

    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: prisma }],
    }).compile();

    const handler = moduleRef.get(OrganizationWebhookHandler);

    await handler.handle('account.updated', { id: 'acct_123' });

    expect(update).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_123' },
      data: { stripeDetailsSubmitted: false, stripeChargesEnabled: false },
    });
  });

  it('does nothing when the account id matches no organization', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const update = vi.fn();
    const prisma = { organization: { findUnique, update } };

    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: prisma }],
    }).compile();

    const handler = moduleRef.get(OrganizationWebhookHandler);

    await handler.handle('account.updated', {
      id: 'acct_missing',
      details_submitted: true,
      charges_enabled: true,
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('does nothing when the account object carries no id', async () => {
    const findUnique = vi.fn();
    const update = vi.fn();
    const prisma = { organization: { findUnique, update } };

    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: prisma }],
    }).compile();

    const handler = moduleRef.get(OrganizationWebhookHandler);

    await handler.handle('account.updated', {});

    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
