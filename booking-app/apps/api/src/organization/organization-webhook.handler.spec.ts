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

interface FakeOrgRow {
  id: string;
  stripeAccountId: string;
  stripeDetailsSubmitted: boolean;
  stripeChargesEnabled: boolean;
  stripeAccountUpdatedAt: Date | null;
}

interface WhereClause {
  stripeAccountId: string;
  OR?: Array<{ stripeAccountUpdatedAt: null | { lte: Date } }>;
}

/**
 * A minimal fake of the one table this handler touches, faithful enough to the real
 * `updateMany` semantics (the `stripeAccountId` match, the null-or-`lte` staleness
 * predicate) that driving the handler against it proves the resulting row state, not
 * just the shape of the query the handler issued. A test against a mock that always
 * returns `{ count: 0 }` cannot tell a correct guard from a broken one; this can.
 */
function buildFakeOrganizationTable(row: FakeOrgRow) {
  let state = row;

  const findUnique = vi.fn(async ({ where }: { where: { stripeAccountId: string } }) =>
    state.stripeAccountId === where.stripeAccountId ? { id: state.id } : null,
  );

  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: WhereClause;
      data: Partial<FakeOrgRow>;
    }): Promise<{ count: number }> => {
      if (state.stripeAccountId !== where.stripeAccountId) return { count: 0 };

      if (where.OR !== undefined) {
        const matches = where.OR.some((clause) =>
          clause.stripeAccountUpdatedAt === null
            ? state.stripeAccountUpdatedAt === null
            : state.stripeAccountUpdatedAt !== null &&
              state.stripeAccountUpdatedAt.getTime() <=
                clause.stripeAccountUpdatedAt.lte.getTime(),
        );
        if (!matches) return { count: 0 };
      }

      state = { ...state, ...data };
      return { count: 1 };
    },
  );

  return {
    findUnique,
    updateMany,
    get row(): FakeOrgRow {
      return state;
    },
  };
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
        OR: [{ stripeAccountUpdatedAt: null }, { stripeAccountUpdatedAt: { lte: eventCreatedAt } }],
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
  // organizer back off, or a disabled one back on. Driven against buildFakeOrganizationTable
  // rather than a mock stubbed to a fixed return value, so the assertion is on the row that
  // results, not on the shape of the query the handler happened to issue.
  it('will not overwrite state written by a newer event', async () => {
    const table = buildFakeOrganizationTable({
      id: 'org_1',
      stripeAccountId: 'acct_123',
      stripeDetailsSubmitted: false,
      stripeChargesEnabled: false,
      stripeAccountUpdatedAt: null,
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationWebhookHandler,
        { provide: PrismaService, useValue: { organization: table } },
      ],
    }).compile();
    const handler = moduleRef.get(OrganizationWebhookHandler);

    const newer = new Date('2026-08-08T10:00:00.000Z');
    const older = new Date('2026-08-08T09:59:00.000Z');

    await handler.handle(
      'account.updated',
      { id: 'acct_123', details_submitted: true, charges_enabled: true },
      newer,
    );
    expect(table.row.stripeChargesEnabled).toBe(true);

    // The older event arrives second (Stripe does not guarantee order); it must not
    // revert the state the newer event already committed.
    await handler.handle(
      'account.updated',
      { id: 'acct_123', details_submitted: true, charges_enabled: false },
      older,
    );
    expect(table.row.stripeChargesEnabled).toBe(true);
    expect(table.row.stripeAccountUpdatedAt).toEqual(newer);
  });

  // Regression for the bug this guard used to have: Stripe's `created` has one-second
  // resolution, and two account.updated events for the same account in the same second
  // are routine (card_payments and transfers activating together at the end of Express
  // onboarding). With a strict `lt` predicate, the second such event matched neither
  // branch of the staleness OR — it was silently dropped, permanently: even a Stripe
  // dashboard resend replays the same `created` and is dropped again.
  it('applies a second event sharing the same created second as the first, not drops it', async () => {
    const table = buildFakeOrganizationTable({
      id: 'org_1',
      stripeAccountId: 'acct_123',
      stripeDetailsSubmitted: false,
      stripeChargesEnabled: false,
      stripeAccountUpdatedAt: null,
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationWebhookHandler,
        { provide: PrismaService, useValue: { organization: table } },
      ],
    }).compile();
    const handler = moduleRef.get(OrganizationWebhookHandler);

    const sameSecond = new Date('2026-08-08T10:00:00.000Z');

    // Event A: details submitted, capabilities not yet all active.
    await handler.handle(
      'account.updated',
      { id: 'acct_123', details_submitted: true, charges_enabled: false },
      sameSecond,
    );
    expect(table.row.stripeChargesEnabled).toBe(false);

    // Event B: same `created` second, charges now enabled. Must be applied, not dropped.
    await handler.handle(
      'account.updated',
      { id: 'acct_123', details_submitted: true, charges_enabled: true },
      sameSecond,
    );
    expect(table.row.stripeChargesEnabled).toBe(true);
    expect(table.row.stripeAccountUpdatedAt).toEqual(sameSecond);
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
