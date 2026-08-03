import { Injectable } from '@nestjs/common';

import type { EmailMessage, EmailProvider, EmailSendResult } from './email-provider.js';

/**
 * An in-memory mail server.
 *
 * Keeps every message so a test can assert on the recipient, the subject, the
 * locale and the body — which is how the end-to-end suite reads the management
 * link out of a confirmation email without a mail provider in the loop.
 */
@Injectable()
export class FakeEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];

  private nextFailure: Error | null = null;
  private counter = 0;

  failNextWith(error: Error): void {
    this.nextFailure = error;
  }

  /** Messages for one recipient, in send order. */
  to(recipient: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === recipient);
  }

  lastTo(recipient: string): EmailMessage | undefined {
    return this.to(recipient).at(-1);
  }

  reset(): void {
    this.sent.length = 0;
    this.nextFailure = null;
    this.counter = 0;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      throw failure;
    }

    this.sent.push(message);
    this.counter += 1;

    return { providerMessageId: `email_fake_${String(this.counter)}` };
  }
}
