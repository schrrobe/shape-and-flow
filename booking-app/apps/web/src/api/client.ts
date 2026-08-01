import { ApiError, toApiError } from './errors.js';

import type {
  AvailabilityQuery,
  AvailabilityResponse,
  BookingBySessionResponse,
  ChangePasswordRequest,
  CreateBookingRequest,
  CreateBookingResponse,
  LoginRequest,
  LoginResponse,
  ManageBookingResponse,
  ManageCancelResponse,
  ManageRescheduleResponse,
  OrganizationCurrentResponse,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  ServiceCategoryListResponse,
  ServiceEmployeesResponse,
  ServiceListResponse,
} from '@shape-and-flow/booking-contracts';

/**
 * The `/manage` request shapes.
 *
 * Declared here because the contracts package exports these schemas but not their inferred
 * types — and importing a name a package does not export resolves to `any`, which is how a typed
 * client quietly stops being typed. The exports belong in contracts; until they exist, being
 * explicit here is better than three silent `any`s.
 */
interface ManageAvailabilityQuery {
  from: string;
  to: string;
}

interface ManageCancelRequest {
  reason?: string;
}

interface ManageRescheduleRequest {
  requestedStartsAt: string;
  requestedEmployeeId?: string;
  reason?: string;
}

/**
 * Same origin, always.
 *
 * The dev server proxies `/api` to the API, so development and production make the same
 * request. A configurable base URL would mean the session cookie and the CSRF header behave
 * differently in the two, which is the class of bug that only appears in production.
 */
const BASE = '/api';

/** One retry for reads only. A retried POST is a second booking. */
const GET_RETRIES = 1;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Extra headers. `Idempotency-Key` and `Authorization` arrive this way. */
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  query?: Record<string, string | number | undefined>;
  /**
   * This call depends on the office session cookie.
   *
   * Set only where a `401` means "your session went away", which is why it is a flag
   * rather than something inferred from the path: `POST /auth/login` answers `401` for a
   * wrong password, and treating that as an expiry would bounce somebody who is trying
   * to sign in to the page they are already on.
   */
  session?: boolean;
}

/**
 * What to do when an office session turns out to be gone.
 *
 * Registered by the office area rather than imported by it, because the client must not
 * depend on the router — and a public page has no handler, so a stray `401` there stays
 * an ordinary error instead of navigating somebody away from a booking.
 */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function url(path: string, query: RequestOptions['query']): string {
  if (query === undefined) return `${BASE}${path}`;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }

  const search = params.toString();
  return search === '' ? `${BASE}${path}` : `${BASE}${path}?${search}`;
}

/** Jittered, so a queue of clients retrying after an outage does not arrive in lockstep. */
function backoffMs(attempt: number): number {
  return 200 * 2 ** attempt + Math.random() * 200;
}

/**
 * Every call goes through here.
 *
 * Three things it does that a bare `fetch` does not:
 *
 *  - **`credentials: 'include'` and `X-Requested-With` on mutations.** The office session is a
 *    cookie, and the API's CSRF guard requires a header a cross-site form post cannot set.
 *  - **Envelope parsing.** A failure arrives as a typed `ApiError` carrying the code and the
 *    correlation id, so a component branches on a code and a support request has an id.
 *  - **A single retry, GETs only.** A read that failed on a transient 5xx is worth repeating; a
 *    write is not, even with an idempotency key, because the key is per attempt and a retry
 *    would consume the customer's one chance to see the real error.
 *
 * An `AbortError` propagates untouched. A component that navigated away is not looking at an
 * error message, and turning an abort into one would show it a spurious failure.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const mutating = method !== 'GET';

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    // Not a token: a cross-site form post cannot set a custom header, so its presence proves
    // the request came from script on our own origin.
    ...(mutating ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    ...options.headers,
  };

  const attempts = mutating ? 1 : GET_RETRIES + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url(path, options.query), {
        method,
        headers,
        // The office session is a cookie; the public endpoints ignore it.
        credentials: 'include',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      if (response.ok) {
        // 204, or any empty body: `json()` would throw on it.
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const error = await toApiError(response);

      // Retrying a 4xx repeats a request the server already understood and refused.
      if (error.status < 500 || attempt === attempts - 1) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status < 500 || attempt === attempts - 1) {
          // Every `ApiError` leaves through here — the `throw` above is inside this
          // `try`, so it lands in this branch too. One exit means one place to notice
          // that the session is gone.
          if (options.session === true && error.status === 401) unauthorizedHandler?.();
          throw error;
        }
        lastError = error;
      } else {
        // An abort is the caller's own doing; a network failure is worth one retry.
        if ((error as Error).name === 'AbortError' || attempt === attempts - 1) throw error;
        lastError = error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
  }

  throw lastError;
}

/** A management token travels as a bearer header, never in the URL. */
function bearer(token: string): Record<string, string> {
  // A query parameter would land in the server access log, the browser history and any
  // `Referer` header — three places a credential must not be.
  return { Authorization: `Bearer ${token}` };
}

export const api = {
  public: {
    organization: (signal?: AbortSignal) =>
      request<OrganizationCurrentResponse>('/public/organizations/current', { signal }),

    serviceCategories: (signal?: AbortSignal) =>
      request<ServiceCategoryListResponse>('/public/service-categories', { signal }),

    services: (signal?: AbortSignal) =>
      request<ServiceListResponse>('/public/services', { signal }),

    employeesFor: (serviceId: string, signal?: AbortSignal) =>
      request<ServiceEmployeesResponse>(`/public/services/${serviceId}/employees`, { signal }),

    availability: (query: AvailabilityQuery, signal?: AbortSignal) =>
      request<AvailabilityResponse>('/public/availability', {
        query: { ...query },
        signal,
      }),

    createBooking: (body: CreateBookingRequest, idempotencyKey: string, signal?: AbortSignal) =>
      request<CreateBookingResponse>('/public/bookings', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': idempotencyKey },
        signal,
      }),

    bookingBySession: (checkoutSessionId: string, signal?: AbortSignal) =>
      request<BookingBySessionResponse>(`/public/bookings/by-session/${checkoutSessionId}`, {
        signal,
      }),
  },

  /**
   * Office authentication.
   *
   * Only `changePassword` carries `session: true`, and the omissions are each deliberate.
   * Login and the password-reset pair answer `401` for a wrong credential, not an expiry —
   * treating that as one would navigate a failed sign-in away from the message it was about
   * to show. And `/auth/me` is the call that *asks* whether a session exists, so its `401`
   * is the answer rather than a failure: routing it through the expiry handler made the
   * guard redirect twice and told a first-time visitor their session had ended.
   */
  auth: {
    login: (body: LoginRequest, signal?: AbortSignal) =>
      request<LoginResponse>('/auth/login', { method: 'POST', body, signal }),

    logout: (signal?: AbortSignal) =>
      request<undefined>('/auth/logout', { method: 'POST', signal }),

    me: (signal?: AbortSignal) => request<LoginResponse>('/auth/me', { signal }),

    requestPasswordReset: (body: PasswordResetRequest, signal?: AbortSignal) =>
      request<undefined>('/auth/password-reset/request', { method: 'POST', body, signal }),

    confirmPasswordReset: (body: PasswordResetConfirmRequest, signal?: AbortSignal) =>
      request<undefined>('/auth/password-reset/confirm', { method: 'POST', body, signal }),

    changePassword: (body: ChangePasswordRequest, signal?: AbortSignal) =>
      request<undefined>('/auth/password', { method: 'POST', body, session: true, signal }),
  },

  manage: {
    booking: (token: string, signal?: AbortSignal) =>
      request<ManageBookingResponse>('/manage/booking', { headers: bearer(token), signal }),

    availability: (token: string, query: ManageAvailabilityQuery, signal?: AbortSignal) =>
      request<AvailabilityResponse>('/manage/availability', {
        headers: bearer(token),
        query: { ...query },
        signal,
      }),

    cancel: (token: string, body: ManageCancelRequest, signal?: AbortSignal) =>
      request<ManageCancelResponse>('/manage/cancel', {
        method: 'POST',
        headers: bearer(token),
        body,
        signal,
      }),

    requestReschedule: (token: string, body: ManageRescheduleRequest, signal?: AbortSignal) =>
      request<ManageRescheduleResponse>('/manage/reschedule-requests', {
        method: 'POST',
        headers: bearer(token),
        body,
        signal,
      }),
  },
};

export { ApiError } from './errors.js';
