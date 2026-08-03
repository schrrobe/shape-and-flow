import { Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';

import type { OfficeSession } from './session.store.js';

/** Every employee, for a role that is not scoped to one. */
export const ALL_EMPLOYEES = 'ALL';

export type VisibleEmployees = string[] | typeof ALL_EMPLOYEES;

/**
 * The "own only" rows of §10.5.
 *
 * A decorator can say "employees may complete a booking". It cannot say "employees may
 * complete *their own* bookings", because that depends on the row being touched — so
 * this is enforced in the service layer, and every office service that takes an employee
 * id or lists across employees is expected to ask.
 *
 * The refusal is `NOT_FOUND`, not `FORBIDDEN_ROLE`, and the difference is the point: a
 * 403 would confirm that the id exists and belongs to a colleague, which is exactly the
 * fact an employee is not supposed to be able to enumerate. It also makes "another
 * employee's booking" and "another organization's booking" indistinguishable from
 * outside, which is what §6.1 already promises for foreign ids.
 */
@Injectable()
export class EmployeeScopeService {
  /** Refuse an EMPLOYEE-role user reaching an employee that is not theirs. */
  assertMayAccessEmployee(session: OfficeSession, employeeId: string): void {
    if (session.role !== 'EMPLOYEE') return;
    if (session.employeeId === employeeId) return;

    throw notFound();
  }

  /**
   * Which employees this session may see.
   *
   * Synchronous, unlike the plan's signature. No query is needed: the session already
   * carries `employeeId`, copied in at login, so making this a promise would advertise
   * I/O that does not happen and force every caller to await nothing.
   */
  visibleEmployeeIds(session: OfficeSession): VisibleEmployees {
    if (session.role !== 'EMPLOYEE') return ALL_EMPLOYEES;

    if (session.employeeId === null) {
      // An EMPLOYEE-role user with no linked employee has no calendar to be scoped to.
      // That is a misconfiguration rather than an attack, but it must not fall through
      // to "sees everything", and FORBIDDEN_ROLE is what tells an operator to fix the
      // link — a 500 would just say something broke.
      throw new AppError('FORBIDDEN_ROLE', {
        message: 'This account has the employee role but is not linked to an employee.',
      });
    }

    return [session.employeeId];
  }

  /**
   * A Prisma `where` fragment for the employee column.
   *
   * Returns `{}` for an unscoped role, so a caller can spread it into a filter without
   * branching — and, more usefully, cannot forget the branch.
   */
  employeeFilter(session: OfficeSession): { employeeId?: { in: string[] } } {
    const visible = this.visibleEmployeeIds(session);

    return visible === ALL_EMPLOYEES ? {} : { employeeId: { in: visible } };
  }
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Not found.' });
}
