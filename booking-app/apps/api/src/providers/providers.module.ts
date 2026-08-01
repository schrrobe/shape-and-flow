import { Global, Inject, Logger, Module } from '@nestjs/common';

import { ENV } from '../config/env.schema.js';

import { EMAIL_PROVIDER } from './email/email-provider.js';
import { FakeEmailProvider } from './email/fake-email.provider.js';
import { FakePaymentProvider } from './payment/fake-payment.provider.js';
import { PAYMENT_PROVIDER } from './payment/payment-provider.js';
import { FakeSmsProvider } from './sms/fake-sms.provider.js';
import { SMS_PROVIDER } from './sms/sms-provider.js';

import type { AppConfig } from '../config/env.schema.js';
import type { EmailProvider } from './email/email-provider.js';
import type { PaymentProvider } from './payment/payment-provider.js';
import type { SmsProvider } from './sms/sms-provider.js';
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
 * falling back to a fake. A deployment that believes it is talking to Stripe and is
 * silently talking to an in-memory stub is the worst of the available outcomes.
 */
@Global()
@Module({
  providers: [
    FakePaymentProvider,
    FakeEmailProvider,
    FakeSmsProvider,
    {
      provide: PAYMENT_PROVIDER,
      inject: [ENV, FakePaymentProvider],
      useFactory: (config: AppConfig, fake: FakePaymentProvider): PaymentProvider =>
        selectProvider('PAYMENT_PROVIDER', config.PAYMENT_PROVIDER, fake),
    },
    {
      provide: EMAIL_PROVIDER,
      inject: [ENV, FakeEmailProvider],
      useFactory: (config: AppConfig, fake: FakeEmailProvider): EmailProvider =>
        selectProvider('EMAIL_PROVIDER', config.EMAIL_PROVIDER, fake),
    },
    {
      provide: SMS_PROVIDER,
      inject: [ENV, FakeSmsProvider],
      useFactory: (config: AppConfig, fake: FakeSmsProvider): SmsProvider =>
        selectProvider('SMS_PROVIDER', config.SMS_PROVIDER, fake),
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
        `sms=${this.config.SMS_PROVIDER}`,
    );
  }
}

function selectProvider<T>(port: string, choice: string, fake: T): T {
  if (choice === 'fake') return fake;

  throw new Error(
    `${port}="${choice}" is not implemented yet. The real adapter arrives in a later task; ` +
      'set it to "fake" until then rather than starting with a port that cannot send anything.',
  );
}
