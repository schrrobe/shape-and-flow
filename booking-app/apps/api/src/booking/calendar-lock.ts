import { Prisma } from '../prisma/client.js';

import { CALENDAR_LOCK_CLASS_ID } from './booking-status.machine.js';

/**
 * Serialise everything that touches one employee's calendar.
 *
 * PostgreSQL's exclusion constraint stops two bookings overlapping, and that is a
 * real guarantee — but it can only see one table. A booking that collides with a
 * `BlockedTime`, or with approved time off, is invisible to it: those live in other
 * tables, and no constraint can span them. So the reservation reads availability and
 * then inserts, and between those two statements another transaction could insert the
 * blocked time that would have made the slot unavailable.
 *
 * The advisory lock closes that window. Held for the transaction's lifetime and keyed
 * on the employee, it makes "check then act" atomic *per employee* — which is exactly
 * the granularity the problem has. Two customers booking different employees at the
 * same instant never wait for each other.
 *
 * Locks are taken in sorted order. With one employee that is irrelevant; with several
 * it is the difference between a deadlock and a queue, and the reschedule path in
 * Stage 6 does hold two.
 */
export async function withCalendarLock<T>(
  tx: Prisma.TransactionClient,
  employeeIds: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  // Sorted and de-duplicated: a stable global order is what prevents two
  // transactions holding each other's next lock.
  const ordered = [...new Set(employeeIds)].sort();

  for (const employeeId of ordered) {
    // `hashtext` rather than the id itself because advisory locks are keyed on
    // integers. A collision would mean two employees sharing a lock — slower, never
    // wrong, which is the right way for a hash to fail here.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(${CALENDAR_LOCK_CLASS_ID}, hashtext(${employeeId}))`,
    );
  }

  return await fn();
}
