import { describe, expect, it } from 'vitest';

import { Prisma } from '../../prisma/client.js';

import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isSerializationFailure,
  isUniqueViolation,
  sqlState,
} from './prisma-errors.js';

/**
 * Unit coverage over the exact error shapes Prisma 7's pg driver adapter
 * produces, captured from real violations against PostgreSQL.
 *
 * The integration suite proves these predicates against genuine database
 * errors; these tests pin the shape itself, so a change after a Prisma upgrade
 * fails here with an obvious diff rather than somewhere downstream.
 */

function driverError(
  code: string,
  cause: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Database error.', {
    code,
    clientVersion: '7.9.1',
    meta: {
      modelName: 'Booking',
      driverAdapterError: { name: 'DriverAdapterError', cause },
    },
  });
}

const exclusionViolation = driverError('P2039', {
  originalCode: '23P01',
  originalMessage: 'conflicting key value violates exclusion constraint "bookings_no_overlap"',
  kind: 'postgres',
  code: '23P01',
});

const checkViolation = driverError('P2039', {
  originalCode: '23514',
  originalMessage:
    'new row for relation "bookings" violates check constraint "bookings_block_range_check"',
  kind: 'postgres',
  code: '23514',
});

const uniqueViolation = driverError('P2002', {
  originalCode: '23505',
  originalMessage:
    'duplicate key value violates unique constraint "service_categories_organization_id_name_key"',
  kind: 'UniqueConstraintViolation',
  constraint: { fields: ['organization_id', 'name'] },
});

describe('sqlState', () => {
  it('reads the SQLSTATE from the driver adapter cause', () => {
    expect(sqlState(exclusionViolation)).toBe('23P01');
    expect(sqlState(checkViolation)).toBe('23514');
    expect(sqlState(uniqueViolation)).toBe('23505');
  });

  it('falls back to the rendered message when no structured code is present', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Invalid invocation. Database error. Code: `40001`. Message: `could not serialize`',
      { code: 'P2039', clientVersion: '7.9.1' },
    );
    expect(sqlState(error)).toBe('40001');
  });

  it('is undefined for an error that did not come from the database', () => {
    expect(sqlState(new Error('boom'))).toBeUndefined();
    expect(sqlState(undefined)).toBeUndefined();
    expect(sqlState('not an error')).toBeUndefined();
  });
});

describe('isExclusionViolation', () => {
  it('matches a 23P01 and its constraint name', () => {
    expect(isExclusionViolation(exclusionViolation)).toBe(true);
    expect(isExclusionViolation(exclusionViolation, 'bookings_no_overlap')).toBe(true);
  });

  it('does not match a different exclusion constraint', () => {
    expect(isExclusionViolation(exclusionViolation, 'blocked_times_no_overlap')).toBe(false);
  });

  it('does not match other integrity failures or plain errors', () => {
    expect(isExclusionViolation(checkViolation)).toBe(false);
    expect(isExclusionViolation(uniqueViolation)).toBe(false);
    expect(isExclusionViolation(new Error('conflicting key value'))).toBe(false);
  });
});

describe('isCheckViolation', () => {
  it('matches a 23514 and its constraint name', () => {
    expect(isCheckViolation(checkViolation)).toBe(true);
    expect(isCheckViolation(checkViolation, 'bookings_block_range_check')).toBe(true);
    expect(isCheckViolation(checkViolation, 'bookings_expires_at_matches_status')).toBe(false);
  });

  it('does not match an exclusion violation', () => {
    expect(isCheckViolation(exclusionViolation)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('matches by Prisma code, by field name and by index name', () => {
    expect(isUniqueViolation(uniqueViolation)).toBe(true);
    expect(isUniqueViolation(uniqueViolation, 'name')).toBe(true);
    expect(isUniqueViolation(uniqueViolation, 'service_categories_organization_id_name_key')).toBe(
      true,
    );
  });

  it('does not match an unrelated target', () => {
    expect(isUniqueViolation(uniqueViolation, 'token_hash')).toBe(false);
  });

  it('does not match an exclusion or check violation', () => {
    expect(isUniqueViolation(exclusionViolation)).toBe(false);
    expect(isUniqueViolation(checkViolation)).toBe(false);
  });
});

describe('isSerializationFailure', () => {
  it('matches a serialization failure and a deadlock, which are safe to retry', () => {
    expect(isSerializationFailure(driverError('P2039', { originalCode: '40001' }))).toBe(true);
    expect(isSerializationFailure(driverError('P2039', { originalCode: '40P01' }))).toBe(true);
  });

  it('does not match an integrity violation, which retrying cannot fix', () => {
    expect(isSerializationFailure(exclusionViolation)).toBe(false);
    expect(isSerializationFailure(uniqueViolation)).toBe(false);
  });
});

describe('isForeignKeyViolation', () => {
  it('matches a 23503', () => {
    expect(isForeignKeyViolation(driverError('P2039', { originalCode: '23503' }))).toBe(true);
  });

  it('does not match an exclusion violation', () => {
    expect(isForeignKeyViolation(exclusionViolation)).toBe(false);
  });
});
