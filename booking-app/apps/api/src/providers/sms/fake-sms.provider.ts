import { Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';

import { SMS_MAX_LENGTH } from './sms-provider.js';

import type { SmsMessage, SmsProvider, SmsSendResult } from './sms-provider.js';

/**
 * An in-memory SMS gateway.
 *
 * Enforces the same length limit as the real adapter, deliberately: a template
 * that grows past three segments should fail in a unit test, not on the phone bill.
 */
@Injectable()
export class FakeSmsProvider implements SmsProvider {
  readonly sent: SmsMessage[] = [];

  private nextFailure: Error | null = null;
  private counter = 0;

  failNextWith(error: Error): void {
    this.nextFailure = error;
  }

  to(recipient: string): SmsMessage[] {
    return this.sent.filter((message) => message.to === recipient);
  }

  reset(): void {
    this.sent.length = 0;
    this.nextFailure = null;
    this.counter = 0;
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      throw failure;
    }

    // Checked before "sending", exactly as the real adapter does, so a test
    // written against the fake proves something about production.
    if (message.body.length > SMS_MAX_LENGTH) {
      throw new AppError('SMS_TOO_LONG', {
        message:
          `SMS body is ${String(message.body.length)} characters, over the ` +
          `${String(SMS_MAX_LENGTH)}-character limit.`,
      });
    }

    this.sent.push(message);
    this.counter += 1;

    return { providerMessageId: `sms_fake_${String(this.counter)}` };
  }
}
