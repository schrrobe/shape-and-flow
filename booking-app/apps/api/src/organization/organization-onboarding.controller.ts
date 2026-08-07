import { Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute } from '../auth/office-session.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited } from '../common/audit/audit.interceptor.js';
import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationContextService } from './organization-context.service.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { AppConfig } from '../config/env.schema.js';

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
  async requestOnboardingLink(): Promise<{ onboardingLink: string }> {
    const organization = this.organizations.get();
    const returnUrl = `${this.config.PUBLIC_WEB_ORIGIN}/office/onboarding-status`;

    let stripeAccountId = organization.stripeAccountId;

    if (stripeAccountId === null) {
      const created = await this.stripeConnect.createExpressAccount({
        email: organization.contactEmail,
        country: organization.country,
        businessType: organization.entityType === 'ORGANIZATION' ? 'company' : 'individual',
      });
      stripeAccountId = created.stripeAccountId;

      await this.prisma.organization.update({
        where: { id: organization.id },
        data: { stripeAccountId },
      });
    }

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
}
