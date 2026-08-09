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

  /**
   * A single-use secret that lets the office area mount Connect embedded components for
   * this organizer's account.
   *
   * The enabled features are a deliberate short list rather than everything on offer:
   *
   *  - **`refund_management`** and **`dispute_management`** are on because the organizer
   *    is the merchant of record on their own account and answers the chargeback either
   *    way. Note that this is a *second* way to refund, alongside the office refund flow
   *    in `RefundService` — a refund issued here does not pass our `refund.issue`
   *    capability check and leaves no `REFUND_ISSUED` audit row.
   *  - **`capture_payments`** is off: Checkout captures automatically, so there is no
   *    manual capture flow for the control to act on.
   *  - **`instant_payouts`** is off: the platform has not enabled it, so the button would
   *    only ever produce an error.
   */
  async createAccountSession(stripeAccountId: string): Promise<{ clientSecret: string }> {
    const stripe = this.require();
    const session = await stripe.accountSessions.create({
      account: stripeAccountId,
      components: {
        payments: {
          enabled: true,
          features: {
            refund_management: true,
            dispute_management: true,
            capture_payments: false,
          },
        },
        payouts: { enabled: true, features: { instant_payouts: false } },
      },
    });

    return { clientSecret: session.client_secret };
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
