import { Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mergeMap } from 'rxjs';

import { CURRENT_USER } from '../../auth/session.store.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { correlationId } from '../correlation/correlation.store.js';

import { redactForAudit } from './audit-redaction.js';

import type { OfficeSession } from '../../auth/session.store.js';
import type { AuditAction, Prisma } from '../../prisma/client.js';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

/** Metadata key the interceptor reads. */
export const AUDIT = 'audit:action';

export interface AuditSpec {
  action: AuditAction;
  /** The model the action is about, as it is named in the schema. */
  entityType: string;
}

/**
 * This route leaves a trace.
 *
 * Declared per route rather than inferred from the HTTP method, because not every office
 * mutation is worth a permanent record and the ones that are do not share a shape. The
 * router metadata test in the authorization suite is what stops a *new* mutating route
 * from quietly having no trace.
 */
export const Audited = (spec: AuditSpec): MethodDecorator => SetMetadata(AUDIT, spec);

/** Where a handler leaves what only it can know. */
const AUDIT_DETAIL = 'auditDetail';

export interface AuditDetail {
  entityId?: string;
  summary?: string;
  /** The row as it was. Redacted before it is stored. */
  before?: unknown;
  /** The row as it now is. Defaults to the response body. */
  after?: unknown;
}

interface AuditableRequest {
  [CURRENT_USER]?: OfficeSession;
  [AUDIT_DETAIL]?: AuditDetail;
}

/**
 * Add detail to the row this request will write.
 *
 * The interceptor can see the response and the path; it cannot see what a row looked
 * like *before* the handler changed it, or what a person would want the summary to say.
 * A handler that cares calls this; one that does not gets the response body as `after`
 * and a generated summary, which is enough for "who did what to which id".
 *
 * Merges rather than replaces, so two call sites in one handler both survive.
 */
export function recordAuditDetail(request: Request, detail: AuditDetail): void {
  const target = request as Request & AuditableRequest;
  target[AUDIT_DETAIL] = { ...target[AUDIT_DETAIL], ...detail };
}

/**
 * Writes one audit row per successful audited request.
 *
 * Bound globally and inert without `@Audited`, for the reason the idempotency
 * interceptor is: a per-controller binding that somebody forgets fails silently, and the
 * failure here is an action with no trace.
 *
 * **On failure, the response still goes out.** The mutation has already committed by the
 * time this runs, so turning a failed audit write into a 500 would tell the caller their
 * action did not happen when it did. The row is missing and the log says so, loudly.
 * Closing that gap properly means writing the audit row inside the same transaction as
 * the mutation, which is a service-layer change rather than an interceptor — worth doing
 * if audit completeness ever becomes a compliance requirement rather than an operational
 * one.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.getAllAndOverride<AuditSpec | undefined>(AUDIT, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (spec === undefined) return next.handle();

    const request = context.switchToHttp().getRequest<Request & AuditableRequest>();
    // Captured here rather than inside the write: the correlation scope belongs to the
    // request, and reading it from a later tick would answer '-'.
    const correlation = correlationId();

    return next.handle().pipe(
      // mergeMap rather than tap, so the row is written before the response is emitted.
      // A trace that lands after the caller has already acted on the answer is a trace
      // that can be missing during exactly the window somebody is looking at it.
      mergeMap(async (body: unknown) => {
        await this.write(spec, request, body, correlation);
        return body;
      }),
    );
  }

  private async write(
    spec: AuditSpec,
    request: Request & AuditableRequest,
    body: unknown,
    correlation: string,
  ): Promise<void> {
    const session = request[CURRENT_USER];

    if (session === undefined) {
      this.logger.error(`audited route ${request.path} ran without an office session`);
      return;
    }

    const detail = request[AUDIT_DETAIL] ?? {};
    // Express 5 types a path parameter as `string | string[]`, because a route may
    // declare the same name twice. `:id` never is, but narrowing beats asserting.
    const fromPath = request.params.id;
    const entityId =
      detail.entityId ?? idFrom(body) ?? (typeof fromPath === 'string' ? fromPath : '-');

    try {
      await this.prisma.auditLog.create({
        data: {
          organizationId: session.organizationId,
          officeUserId: session.officeUserId,
          action: spec.action,
          entityType: spec.entityType,
          entityId,
          summary: detail.summary ?? `${spec.action} ${spec.entityType} ${entityId}`,
          ...(detail.before === undefined ? {} : { before: toJson(detail.before) }),
          after: toJson(detail.after ?? body),
          correlationId: correlation,
          // Express resolves this through `trust proxy`, which main.ts sets, so it is
          // the client address rather than the reverse proxy's.
          ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
        },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        `could not write the audit row for ${spec.action} ${entityId} ` +
          `(correlation ${correlation}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The id in a response body, when it has one. */
function idFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;

  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** Redacted, and reduced to what a JSONB column can hold. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(redactForAudit(value) ?? null)) as Prisma.InputJsonValue;
}
