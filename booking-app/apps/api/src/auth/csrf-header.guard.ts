import { Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The methods that change something, and therefore need proof of intent. */
const STATE_CHANGING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const REQUIRED_HEADER = 'x-requested-with';
const REQUIRED_VALUE = 'xmlhttprequest';

/**
 * The second half of the CSRF defence.
 *
 * `SameSite=Lax` on the session cookie is the first, and on its own it already stops a
 * cross-site form POST from carrying the session. This guard covers what Lax does not:
 * browsers that predate it, and the top-level GET navigations Lax deliberately still
 * allows — which is why only state-changing methods are checked here, and why a GET
 * that needs protection must not be a GET.
 *
 * The header itself is the mechanism, not its value. A cross-origin request cannot set
 * `X-Requested-With` without a CORS preflight, and the API answers no preflight that
 * would permit it — so a request carrying the header provably came from a script this
 * origin served. That makes a token unnecessary, and a token that is not needed is a
 * thing that can be got wrong.
 */
@Injectable()
export class CsrfHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (!STATE_CHANGING.has(request.method.toUpperCase())) return true;

    const header = request.headers[REQUIRED_HEADER];
    const value = Array.isArray(header) ? header[0] : header;

    if (value?.toLowerCase() !== REQUIRED_VALUE) {
      throw new AppError('CSRF_FAILED', {
        message: `This request must carry the header X-Requested-With: XMLHttpRequest.`,
      });
    }

    return true;
  }
}
