import type { CheckoutSessionStatus, PaymentStatusValue } from './payment-provider.js';
import type { Redis } from 'ioredis';

/**
 * Where the fake payment provider keeps what it has been told.
 *
 * Separated from the provider because the fake stands in for Stripe, and Stripe is
 * one service that the API and the worker both talk to. With the state inside the
 * provider instance it was one service *per process*: the API created a Checkout
 * session, and the expiry job — which runs in the worker — asked about a session
 * its own instance had never heard of and raised FAKE_PROVIDER_UNKNOWN_SESSION.
 * The slot then stayed blocked forever, because the saga treats "no answer from
 * the provider" as a reason not to release. The refund processor had the same
 * hole. Neither shows up in a test that builds one container.
 *
 * So: two implementations. In-memory for the unit and integration suites, where
 * one process is the whole world, and Redis-backed for a real deployment, where
 * both processes already hold a connection to the same server.
 *
 * Records are plain data rather than domain objects on purpose — anything stored
 * here has to survive JSON, and a `Money` that round-trips as `{}` would be found
 * late and in the wrong place.
 */

export interface FakeSessionRecord {
  sessionId: string;
  status: CheckoutSessionStatus;
  paymentStatus: PaymentStatusValue;
  amountCents: number;
  currency: string;
  clientReferenceId: string;
  /** ISO 8601. A `Date` does not survive the round trip. */
  expiresAt: string;
  paymentIntentId?: string;
  chargeId?: string;
  paymentMethodType?: string;
  idempotencyKey?: string;
}

export interface FakeRefundRecord {
  refundId: string;
  chargeId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

export interface FakePaymentStore {
  putSession(session: FakeSessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<FakeSessionRecord | undefined>;
  allSessions(): Promise<FakeSessionRecord[]>;
  /** The session a previous call with this idempotency key produced, if any. */
  sessionIdForKey(key: string): Promise<string | undefined>;
  rememberKey(key: string, sessionId: string): Promise<void>;
  /**
   * Record this refund, or return the one that already holds its idempotency key.
   *
   * One operation rather than a read followed by a write, and that is the whole point:
   * two retries of the same refund job can be in flight at once — the outbox is
   * at-least-once — and a check-then-insert lets both see an empty store and both
   * refund. Stripe is atomic on an idempotency key, so the stand-in has to be too.
   * Found by the refund suite the day the store became asynchronous.
   */
  claimRefund(refund: FakeRefundRecord): Promise<FakeRefundRecord>;
  allRefunds(): Promise<FakeRefundRecord[]>;
  clear(): Promise<void>;
}

/**
 * One process, one world. The default, and what every test suite gets.
 *
 * Every method returns a resolved promise rather than being `async`: there is nothing
 * to await, and the interface is asynchronous only because the other implementation
 * has to be.
 */
export class InMemoryFakePaymentStore implements FakePaymentStore {
  private readonly sessions = new Map<string, FakeSessionRecord>();
  private readonly keys = new Map<string, string>();
  private readonly refunds: FakeRefundRecord[] = [];
  private readonly refundsByKey = new Map<string, FakeRefundRecord>();

  putSession(session: FakeSessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, session);
    return Promise.resolve();
  }

  getSession(sessionId: string): Promise<FakeSessionRecord | undefined> {
    return Promise.resolve(this.sessions.get(sessionId));
  }

  allSessions(): Promise<FakeSessionRecord[]> {
    return Promise.resolve([...this.sessions.values()]);
  }

  sessionIdForKey(key: string): Promise<string | undefined> {
    return Promise.resolve(this.keys.get(key));
  }

  rememberKey(key: string, sessionId: string): Promise<void> {
    this.keys.set(key, sessionId);
    return Promise.resolve();
  }

  claimRefund(refund: FakeRefundRecord): Promise<FakeRefundRecord> {
    // Synchronous check-and-set, so there is no point at which another caller can
    // interleave: within one process this is the atomicity HSETNX provides across them.
    const existing = this.refundsByKey.get(refund.idempotencyKey);
    if (existing !== undefined) return Promise.resolve(existing);

    this.refundsByKey.set(refund.idempotencyKey, refund);
    this.refunds.push(refund);
    return Promise.resolve(refund);
  }

  allRefunds(): Promise<FakeRefundRecord[]> {
    return Promise.resolve([...this.refunds]);
  }

  clear(): Promise<void> {
    this.sessions.clear();
    this.keys.clear();
    this.refunds.length = 0;
    this.refundsByKey.clear();
    return Promise.resolve();
  }
}

/**
 * Shared between processes, the way the service it imitates is.
 *
 * Hashes rather than one key per session, so `clear()` is three DELs and a
 * development database can be inspected with a single HGETALL. Everything lives
 * under the queue prefix, which the environment schema already constrains to a
 * key-safe token, so a test prefix and a development prefix cannot collide.
 */
export class RedisFakePaymentStore implements FakePaymentStore {
  private readonly sessionsKey: string;
  private readonly keysKey: string;
  private readonly refundsKey: string;
  private readonly refundKeysKey: string;

  constructor(
    private readonly redis: Redis,
    prefix: string,
  ) {
    this.sessionsKey = `${prefix}:fake-payments:sessions`;
    this.keysKey = `${prefix}:fake-payments:idempotency`;
    this.refundsKey = `${prefix}:fake-payments:refunds`;
    this.refundKeysKey = `${prefix}:fake-payments:refund-keys`;
  }

  async putSession(session: FakeSessionRecord): Promise<void> {
    await this.redis.hset(this.sessionsKey, session.sessionId, JSON.stringify(session));
  }

  async getSession(sessionId: string): Promise<FakeSessionRecord | undefined> {
    const raw = await this.redis.hget(this.sessionsKey, sessionId);
    return raw === null ? undefined : (JSON.parse(raw) as FakeSessionRecord);
  }

  async allSessions(): Promise<FakeSessionRecord[]> {
    const stored = await this.redis.hvals(this.sessionsKey);
    return stored.map((raw) => JSON.parse(raw) as FakeSessionRecord);
  }

  async sessionIdForKey(key: string): Promise<string | undefined> {
    return (await this.redis.hget(this.keysKey, key)) ?? undefined;
  }

  async rememberKey(key: string, sessionId: string): Promise<void> {
    await this.redis.hset(this.keysKey, key, sessionId);
  }

  async claimRefund(refund: FakeRefundRecord): Promise<FakeRefundRecord> {
    const serialised = JSON.stringify(refund);

    // HSETNX is the atomic half: exactly one caller gets the 1, whichever process it
    // is in. The loser reads back the winner's record rather than writing its own.
    const claimed = await this.redis.hsetnx(this.refundKeysKey, refund.idempotencyKey, serialised);

    if (claimed === 0) {
      const existing = await this.redis.hget(this.refundKeysKey, refund.idempotencyKey);
      return existing === null ? refund : (JSON.parse(existing) as FakeRefundRecord);
    }

    // A list as well, because `refundCalls()` reports the order a retry test asserts
    // on and a hash has none. Only the winner reaches this, so it appears once.
    await this.redis.rpush(this.refundsKey, serialised);

    return refund;
  }

  async allRefunds(): Promise<FakeRefundRecord[]> {
    const stored = await this.redis.lrange(this.refundsKey, 0, -1);
    return stored.map((raw) => JSON.parse(raw) as FakeRefundRecord);
  }

  async clear(): Promise<void> {
    await this.redis.del(this.sessionsKey, this.keysKey, this.refundsKey, this.refundKeysKey);
  }
}
