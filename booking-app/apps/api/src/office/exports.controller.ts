import { pipeline } from 'node:stream';

import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { exportQuerySchema } from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';

import { ExportsService } from './exports.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { Response } from 'express';
import type { Readable } from 'node:stream';

/**
 * `/office/exports/*.csv`.
 *
 * The only routes in the office API that write to the response themselves rather than
 * returning a value, because they stream: a year of bookings must not be assembled in
 * memory to be serialised by Nest.
 *
 * That has one consequence worth stating. Nest's exception filter cannot rewrite a
 * response whose headers have already gone out, so a failure *mid-stream* destroys the
 * connection rather than producing an error envelope. The client sees a truncated
 * download, which is the honest signal — a half-file that looked complete would be worse.
 * Everything that can fail cheaply — parsing the range, the role check — happens before
 * the first byte.
 */
@Controller('office/exports')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get('bookings.csv')
  @Roles('OWNER', 'ADMIN')
  bookings(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
    @Res() response: Response,
  ): void {
    const query = exportQuerySchema.parse(rawQuery);

    sendCsv(response, `bookings-${query.from}-${query.to}.csv`, () =>
      this.exports.bookings(session.organizationId, query),
    );
  }

  @Get('payments.csv')
  @Roles('OWNER', 'ADMIN')
  payments(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
    @Res() response: Response,
  ): void {
    const query = exportQuerySchema.parse(rawQuery);
    const stream = this.exports.payments(session.organizationId, query);

    sendCsv(response, `payments-${query.from}-${query.to}.csv`, () => stream);
  }
}

/**
 * Headers, then the stream.
 *
 * `charset=utf-8` **and** the BOM the stream starts with: the header is for anything
 * that reads over HTTP, the BOM is for Excel, which reads the file from disk after the
 * header is long gone.
 */
export function sendCsv(response: Response, filename: string, open: () => Readable): void {
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // The length is unknown until the last row, which is the point of streaming.
  response.setHeader('Cache-Control', 'no-store');

  pipeline(open(), response, (error) => {
    if (error !== null && !response.destroyed) response.destroy(error);
  });
}
