import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { STRIPE_CLIENT } from '../providers/providers.module.js';

import type Stripe from 'stripe';

export interface ExpressAccountInput {
  email: string;
  country: string;
  businessType: 'individual' | 'company';
  /**
   * Derived from the organization, not generated per call.
   *
   * Creating an account is not naturally idempotent — two requests make two accounts,
   * and the one nobody finishes onboarding is an orphan whose completion events are
   * ignored forever. A key tied to the organization makes Stripe answer both requests
   * with the same account.
   */
  idempotencyKey?: string | undefined;
}

/**
 * Creates Stripe Express accounts and onboarding links for newly registered
 * Organizations.
 *
 * Kept separate from `PAYMENT_PROVIDER`: that port is the checkout side (creating
 * Checkout Sessions, handling refunds), this is the Connect side (onboarding the
 * merchant itself). The two never need the same abstraction.
 */
@Injectable()
export class StripeConnectService {
  constructor(@Inject(STRIPE_CLIENT) private readonly stripe: Stripe | null) {}

  async createExpressAccount(input: ExpressAccountInput): Promise<{ stripeAccountId: string }> {
    const stripe = this.require();
    const account = await stripe.accounts.create(
      {
        type: 'express',
        country: input.country,
        email: input.email,
        business_type: input.businessType,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      },
      input.idempotencyKey === undefined ? undefined : { idempotencyKey: input.idempotencyKey },
    );

    return { stripeAccountId: account.id };
  }

  async createAccountLink(stripeAccountId: string, returnUrl: string): Promise<{ url: string }> {
    const stripe = this.require();
    const link = await stripe.accountLinks.create({
      account: stripeAccountId,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: returnUrl,
    });

    return { url: link.url };
  }

  private require(): Stripe {
    if (!this.stripe) {
      throw new AppError('ONBOARDING_LINK_ERROR', {
        message: 'PAYMENT_PROVIDER is not "stripe"; Stripe Connect onboarding is unavailable.',
      });
    }
    return this.stripe;
  }
}
