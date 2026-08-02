import { AppError } from '../../common/errors/app-error.js';

/**
 * Which employee takes an "any available employee" booking.
 *
 * Resolved server-side *before* the row is inserted, so no booking ever exists
 * without a concrete employee — which is what lets `bookings.employee_id` be NOT
 * NULL and the exclusion constraint work at all.
 *
 * The rule is deterministic on purpose. A random or arbitrary pick would make the
 * reservation path untestable and would mean two identical requests could produce
 * different bookings, which is impossible to reason about when a customer phones
 * to ask who they are seeing.
 */

export interface EmployeeCandidate {
  employeeId: string;
  /**
   * Bookings that employee already has on the appointment's local day, counted
   * over blocking statuses only. Expired or cancelled bookings must not count, or
   * an employee would be penalised for a customer who abandoned a checkout.
   */
  bookingsThatDay: number;
  displayOrder: number;
}

/**
 * Fewest bookings that day, then display order, then employee id.
 *
 * Load first, so the day spreads across the team rather than filling one person's
 * calendar. Display order second, so the business's own preferred ordering breaks
 * ties. Employee id last, purely so the result is total — without it two employees
 * with equal load and equal display order would be ordered by however the rows
 * happened to arrive.
 */
export function selectEmployee(candidates: readonly EmployeeCandidate[]): string {
  const best = [...candidates].sort(compareCandidates)[0];

  if (!best) {
    throw new AppError('NO_EMPLOYEE_AVAILABLE', {
      status: 409,
      message: 'No employee is available for that service and time.',
    });
  }

  return best.employeeId;
}

function compareCandidates(a: EmployeeCandidate, b: EmployeeCandidate): number {
  if (a.bookingsThatDay !== b.bookingsThatDay) return a.bookingsThatDay - b.bookingsThatDay;
  if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
  if (a.employeeId < b.employeeId) return -1;
  return a.employeeId > b.employeeId ? 1 : 0;
}
