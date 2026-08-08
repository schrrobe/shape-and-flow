import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationWebhookHandler } from './organization-webhook.handler.js';

/** A handler over a stubbed Prisma, with the two calls it makes exposed. */
async function build(organization: { id: string } | null = { id: 'org_1' }, updated = 1) {
  const findUnique = vi.fn().mockResolvedValue(organization);
  const updateMany = vi.fn().mockResolvedValue({ count: updated });
  const prisma = { organization: { findUnique, updateMany } };

  const moduleRef = await Test.createTestingModule({
    providers: [OrganizationWebhookHandler, { provide: PrismaService, useValue: prisma }],
  }).compile();

  return { handler: moduleRef.get(OrganizationWebhookHandler), findUnique, updateMany };
}

describe('OrganizationWebhookHandler', () => {
  it('handles only account.updated', async () => {
    const { handler } = await build();

    expect(handler.handles('account.updated')).toBe(true);
    expect(handler.handles('checkout.session.completed')).toBe(false);
  });

  it('updates stripeDetailsSubmitted and stripeChargesEnabled from the account object', async () => {
    const { handler, findUnique, updateMany } = await build();
    const eventCreatedAt = new Date('2026-08-08T10:00:00.000Z');

    await handler.handle(
      'account.updated',
      { id: 'acct_123', details_submitted: true, charges_enabled: false },
      eventCreatedAt,
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_123' },
      select: { id: true },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        stripeAccountId: 'acct_123',
        OR: [{ stripeAccountUpdatedAt: null }, { stripeAccountUpdatedAt: { lt: eventCreatedAt } }],
      },
      data: {
        stripeDetailsSubmitted: true,
        stripeChargesEnabled: false,
        stripeAccountUpdatedAt: eventCreatedAt,
      },
    });
  });

  it('treats a missing details_submitted/charges_enabled as false, not undefined', async () => {
    const { handler, updateMany } = await build();

    await handler.handle('account.updated', { id: 'acct_123' });

    expect(updateMany).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_123' },
      data: { stripeDetailsSubmitted: false, stripeChargesEnabled: false },
    });
  });

  // Stripe does not order deliveries and the webhook queue runs jobs concurrently, so an
  // older snapshot can execute last. Applied unconditionally it would switch a ready
  // organizer back off, or a disabled one back on.
  it('will not overwrite state written by a newer event', async () => {
    const { handler, updateMany } = await build({ id: 'org_1' }, 0);
    const older = new Date('2026-08-08T09:59:00.000Z');

    await handler.handle(
      'account.updated',
      { id: 'acct_123', details_submitted: true, charges_enabled: false },
      older,
    );

    // The predicate is what does the rejecting; the point of the assertion is that the
    // write is conditional and that a no-op is tolerated rather than thrown.
    const [call] = updateMany.mock.calls as [
      [{ where: { OR?: unknown } }],
    ];
    expect(call[0].where.OR).toEqual([
      { stripeAccountUpdatedAt: null },
      { stripeAccountUpdatedAt: { lt: older } },
    ]);
  });

  it('applies an event with no timestamp rather than dropping it', async () => {
    const { handler, updateMany } = await build();

    await handler.handle('account.updated', {
      id: 'acct_123',
      details_submitted: true,
      charges_enabled: true,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { stripeAccountId: 'acct_123' },
      data: { stripeDetailsSubmitted: true, stripeChargesEnabled: true },
    });
  });

  it('does nothing when the account id matches no organization', async () => {
    const { handler, updateMany } = await build(null);

    await handler.handle('account.updated', {
      id: 'acct_missing',
      details_submitted: true,
      charges_enabled: true,
    });

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when the account object carries no id', async () => {
    const { handler, findUnique, updateMany } = await build();

    await handler.handle('account.updated', {});

    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
