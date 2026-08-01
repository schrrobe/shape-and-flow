import { Injectable } from '@nestjs/common';

import type { Prisma } from '../prisma/client.js';
import type { Locale } from '@shape-and-flow/booking-contracts';

export interface CustomerInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | undefined;
  locale: Locale;
}

/**
 * The form of an address two people would agree is "the same".
 *
 * Only case and surrounding whitespace. Not dot-stripping or plus-tag removal, which
 * some providers treat as significant — collapsing those would merge two people who
 * believe they have separate accounts, and unmerging them afterwards is not possible.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Finds the customer behind a booking, or creates them.
 *
 * The interesting decision is what a returning customer's booking is allowed to
 * change. Their locale, yes — they just told us which language they are reading in.
 * Their name and phone, no: a typo in a booking form would silently rewrite the record
 * the office recognises them by, and the office has no way to know it happened. So
 * those are set once, when the row is created, and afterwards only the office can
 * change them.
 */
@Injectable()
export class CustomerUpsertService {
  async upsert(
    tx: Prisma.TransactionClient,
    organizationId: string,
    input: CustomerInput,
  ): Promise<{ id: string }> {
    const emailNormalized = normaliseEmail(input.email);

    return await tx.customer.upsert({
      // The composite unique key, so two organizations can each have a customer with
      // the same address.
      where: { organizationId_emailNormalized: { organizationId, emailNormalized } },
      create: {
        organizationId,
        email: input.email.trim(),
        emailNormalized,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        ...(input.phone === undefined ? {} : { phone: input.phone.trim() }),
        locale: input.locale,
      },
      // Deliberately only the locale. See the note above.
      update: { locale: input.locale },
      select: { id: true },
    });
  }
}
