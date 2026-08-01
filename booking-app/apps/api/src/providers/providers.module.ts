import { Global, Inject, Logger, Module } from '@nestjs/common';
import Stripe from 'stripe';

import { ENV } from '../config/env.schema.js';
import { CLOCK } from '../domain/time/clock.js';

import { EMAIL_PROVIDER } from './email/email-provider.js';
import { FakeEmailProvider } from './email/fake-email.provider.js';
import { FakePaymentProvider } from './payment/fake-payment.provider.js';
import { PAYMENT_PROVIDER } from './payment/payment-provider.js';
import { StripePaymentProvider } from './payment/stripe-payment.provider.js';
import { FakeSmsProvider } from './sms/fake-sms.provider.js';
import { SMS_PROVIDER } from './sms/sms-provider.js';

import type { AppConfig } from '../config/env.schema.js';
import type { EmailProvider } from './email/email-provider.js';
import type { PaymentProvider } from './payment/payment-provider.js';
import type { SmsProvider } from './sms/sms-provider.js';
import type { Clock } from '../domain/time/clock.js';
import type { OnApplicationBootstrap } from '@nestjs/common';

/**
 * Binds each port to an implementation from configuration.
 *
 * Refusing `fake` in production is *not* re-checked here: the environment schema
 * already rejects that combination, and duplicating the rule would create two
 * places for it to drift. What this adds is a bootstrap log line naming which
 * implementation each port resolved to, so a misconfigured deployment is visible in
 * the first few lines of output rather than at the first payment.
 *
 * Selecting an adapter that does not exist yet throws at start-up rather than
 * falling back to a fake. A deployment that believes it is talking to a provider
 * while silently talking to an in-memory stub is the worst available outcome.
 */
@Global()
@Module({
  providers: [
    FakePaymentProvider,
    FakeEmailProvider,
    FakeSmsProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ENV, CLOCK, FakePaymentProvider],
      useFactory: (config: AppConfig, clock: Clock, fake: FakePaymentProvider): PaymentProvider =>
        config.PAYMENT_PROVIDER === 'fake' ? fake : buildStripeProvider(config, clock),
    },
    {
      provide: EMAIL_PROVIDER,
      inject: [ENV, FakeEmailProvider],
      useFactory: (config: AppConfig, fake: FakeEmailProvider): EmailProvider =>
        config.EMAIL_PROVIDER === 'fake'
          ? fake
          : notImplemented('EMAIL_PROVIDER', config.EMAIL_PROVIDER),
    },
    {
      provide: SMS_PROVIDER,
      inject: [ENV, FakeSmsProvider],
      useFactory: (config: AppConfig, fake: FakeSmsProvider): SmsProvider =>
        config.SMS_PROVIDER === 'fake' ? fake : notImplemented('SMS_PROVIDER', config.SMS_PROVIDER),
    },
  ],
  exports: [PAYMENT_PROVIDER, EMAIL_PROVIDER, SMS_PROVIDER],
})
export class ProvidersModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('Providers');

  constructor(@Inject(ENV) private readonly config: AppConfig) {}

  onApplicationBootstrap(): void {
    this.logger.log(
      `payment=${this.config.PAYMENT_PROVIDER} ` +
        `email=${this.config.EMAIL_PROVIDER} ` +
        `sms=${this.config.SMS_PROVIDER} ` +
        `stripeApiVersion=${Stripe.API_VERSION}`,
    );
  }
}

function buildStripeProvider(config: AppConfig, clock: Clock): StripePaymentProvider {
  // The environment schema already requires both when PAYMENT_PROVIDER is stripe.
  // Re-checking here is cheap and turns a schema regression into a named start-up
  // failure rather than a confusing Stripe authentication error later.
  const secretKey = required(config.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY');
  const webhookSecret = required(config.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET');

  const stripe = new Stripe(secretKey, {
    // Only the SDK's own pinned version typechecks, so this cannot drift by
    // configuration — only by upgrade, which a test catches.
    apiVersion: Stripe.API_VERSION,
    // Stripe's client retries idempotent requests itself; two is enough to absorb
    // a blip without turning a slow outage into a long request.
    maxNetworkRetries: 2,
    timeout: 15_000,
  });

  return new StripePaymentProvider(stripe, clock, { webhookSecret });
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required when the matching provider is not "fake".`);
  }
  return value;
}

function notImplemented(port: string, choice: string): never {
  throw new Error(
    `${port}="${choice}" is not implemented yet. The real adapter arrives in a later task; ` +
      'set it to "fake" until then rather than starting with a port that cannot send anything.',
  );
}
