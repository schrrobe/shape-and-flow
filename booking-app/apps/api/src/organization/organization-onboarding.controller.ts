import { Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute } from '../auth/office-session.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited, recordAuditDetail } from '../common/audit/audit.interceptor.js';
import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationContextService } from './organization-context.service.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { EntityType } from '../prisma/client.js';
import type { Request } from 'express';

/**
 * The recovery path for Task 6's `POST /public/organizations`.
 *
 * That endpoint tries to create a Stripe Express account and onboarding link as part of
 * registration, but does not roll back the organization if Stripe fails — the
 * organization is real and useful even without payments configured yet. This endpoint is
 * how an owner gets back into onboarding afterwards: authenticated, so the tenant comes
 * from the office session rather than a query parameter, and OWNER-only, since it is the
 * one who registered who should decide when to retry.
 */
@Controller('office/organization')
@UseGuards(CsrfHeaderGuard, RolesGuard)
@OfficeRoute()
export class OrganizationOnboardingController {
  constructor(
    private readonly organizations: OrganizationContextService,
    private readonly stripeConnect: StripeConnectService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  current(): { stripeChargesEnabled: boolean } {
    return { stripeChargesEnabled: this.organizations.get().stripeChargesEnabled };
  }

  @Post('onboarding-link')
  @Roles('OWNER')
  @Audited({ action: 'ORGANIZATION_ONBOARDING_LINK_REQUESTED', entityType: 'Organization' })
  async requestOnboardingLink(@Req() request: Request): Promise<{ onboardingLink: string }> {
    const organization = this.organizations.get();
    const returnUrl = `${this.config.PUBLIC_WEB_ORIGIN}/office/onboarding-status`;

    const stripeAccountId = await this.provisionAccount(organization);

    // Named explicitly, because the default is the response body — and that body is a
    // live Account Link. Whoever reads the audit row wants to know an owner asked for a
    // link and which account it was for; the link itself would only sit in the audit
    // table and its backups, usable by anyone who can read them.
    recordAuditDetail(request, {
      entityId: organization.id,
      after: { stripeAccountId, onboardingLinkIssued: true },
    });

    try {
      const { url } = await this.stripeConnect.createAccountLink(stripeAccountId, returnUrl);
      return { onboardingLink: url };
    } catch (error) {
      throw new AppError('ONBOARDING_LINK_ERROR', {
        message: 'Could not create a Stripe onboarding link. Please try again shortly.',
        cause: error,
      });
    }
  }

  /**
   * The organization's Express account id, creating the account if it has none.
   *
   * Two things make this safe to call twice at once, which a double-click on the retry
   * button readily does:
   *
   *  - **A stable idempotency key.** Both requests reach Stripe with the same key, so
   *    Stripe returns the same account to both instead of opening a second one that
   *    nobody will ever finish onboarding.
   *  - **A conditional write.** `updateMany` only claims the row while `stripeAccountId`
   *    is still null, so the loser of the race does not overwrite the winner's id. It
   *    then reads back what was actually stored and returns that, which is what keeps the
   *    link the browser follows pointed at the account the row names.
   *
   * The organization here comes from the request's tenant snapshot, which was taken
   * before either request started — that is exactly why the null check cannot be trusted
   * on its own.
   */
  private async provisionAccount(organization: {
    id: string;
    stripeAccountId: string | null;
    contactEmail: string;
    country: string;
    entityType: EntityType | null;
  }): Promise<string> {
    if (organization.stripeAccountId !== null) return organization.stripeAccountId;

    const created = await this.stripeConnect.createExpressAccount({
      email: organization.contactEmail,
      country: organization.country,
      businessType: organization.entityType === 'ORGANIZATION' ? 'company' : 'individual',
      idempotencyKey: `org-${organization.id}-express-account`,
    });

    const { count } = await this.prisma.organization.updateMany({
      where: { id: organization.id, stripeAccountId: null },
      data: { stripeAccountId: created.stripeAccountId },
    });

    if (count === 1) return created.stripeAccountId;

    // Another request stored an id first. With the shared idempotency key that id is
    // this same account, but the stored value is the one everything else will use, so it
    // is the one to hand back rather than the one this request happens to hold.
    const stored = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organization.id },
      select: { stripeAccountId: true },
    });

    return stored.stripeAccountId ?? created.stripeAccountId;
  }
}
