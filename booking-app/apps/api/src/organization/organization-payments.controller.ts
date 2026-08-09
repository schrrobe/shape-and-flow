import { Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute } from '../auth/office-session.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited, recordAuditDetail } from '../common/audit/audit.interceptor.js';
import { AppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';

import { OrganizationContextService } from './organization-context.service.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { AccountSessionResponse } from '@shape-and-flow/booking-contracts';
import type { Request } from 'express';

/**
 * What backs `/office/payments`, where an organizer sees their own payouts and payments.
 *
 * Separate from `OrganizationOnboardingController` even though both sit under
 * `office/organization` and both talk to Stripe Connect: onboarding is about getting an
 * account into existence, this is about operating one that already works. They share a
 * URL prefix, not a lifecycle.
 *
 * Nothing here is a redirect. The embedded components render inside our own layout, so
 * the only thing crossing the wire is the short-lived AccountSession secret the browser
 * needs to open them.
 */
@Controller('office/organization')
@UseGuards(CsrfHeaderGuard, RolesGuard)
@OfficeRoute()
export class OrganizationPaymentsController {
  constructor(
    private readonly organizations: OrganizationContextService,
    private readonly stripeConnect: StripeConnectService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  /**
   * OWNER-only, and for the same reason the onboarding retry is: the components this
   * unlocks can move money off the account.
   */
  @Post('account-session')
  @Roles('OWNER')
  @Audited({ action: 'ORGANIZATION_ACCOUNT_SESSION_CREATED', entityType: 'Organization' })
  async createAccountSession(@Req() request: Request): Promise<AccountSessionResponse> {
    const organization = this.organizations.get();

    // Both flags, not just the account id. An account that exists but has not finished
    // onboarding renders an embedded component that is empty or stuck, which reads as our
    // bug; saying so here sends the owner back to the link flow instead.
    if (organization.stripeAccountId === null || !organization.stripeChargesEnabled) {
      throw new AppError('ORGANIZATION_ONBOARDING_INCOMPLETE', {
        message:
          'Finish your Stripe onboarding before opening the payments page. Start it again from the onboarding status screen.',
      });
    }

    // Named explicitly, because the default is the response body — and that body carries
    // a live AccountSession secret. What the audit row is for is answering "who opened
    // the refund-capable surface, and when"; the secret itself would only sit in the
    // table and its backups.
    recordAuditDetail(request, {
      entityId: organization.id,
      after: {
        stripeAccountId: organization.stripeAccountId,
        components: ['payments', 'payouts'],
      },
    });

    try {
      const { clientSecret } = await this.stripeConnect.createAccountSession(
        organization.stripeAccountId,
      );

      return { clientSecret, publishableKey: this.publishableKey() };
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError('ONBOARDING_LINK_ERROR', {
        message: 'Could not open your Stripe payments view. Please try again shortly.',
        cause: error,
      });
    }
  }

  /**
   * The env schema requires this key whenever `PAYMENT_PROVIDER` is `stripe`, so reaching
   * the `undefined` branch means the provider is `fake` and Stripe is not configured at
   * all — the same condition `StripeConnectService.require()` reports.
   */
  private publishableKey(): string {
    const key = this.config.STRIPE_PUBLISHABLE_KEY;

    if (key === undefined || key === '') {
      throw new AppError('ONBOARDING_LINK_ERROR', {
        message: 'STRIPE_PUBLISHABLE_KEY is not configured; the payments view is unavailable.',
      });
    }

    return key;
  }
}
