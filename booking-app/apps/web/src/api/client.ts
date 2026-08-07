import { ApiError, toApiError } from './errors.js';

import type {
  AuditLogQuery,
  AuditLogResponse,
  AvailabilityQuery,
  AvailabilityResponse,
  AvailabilityExceptionListResponse,
  BlockedTime,
  BlockedTimeListQuery,
  BlockedTimeListResponse,
  BookingBySessionResponse,
  BookingManualPayment,
  CancelBookingRequest,
  ChangePasswordRequest,
  ClosedDay,
  ClosedDayListQuery,
  ClosedDayListResponse,
  CreateAvailabilityExceptionRequest,
  CreateAvailabilityExceptionResponse,
  CreateBlockedTimeRequest,
  CreateClosedDayRequest,
  CreateEmployeeRequest,
  CreateManualBookingRequest,
  CreateManualBookingResponse,
  CreateManualPaymentRequest,
  CreateOfficeUserRequest,
  CreateRefundRequest,
  CreateServiceCategoryRequest,
  CreateServiceRequest,
  CreateTimeOffRequest,
  CustomerListQuery,
  CustomerListResponse,
  DecideCancellationRequest,
  DecideRescheduleRequest,
  EmployeeListResponse,
  EmployeeServicesResponse,
  EraseCustomerResponse,
  FeatureFlagClientConfig,
  CreateBookingRequest,
  CreateBookingResponse,
  ExportQuery,
  LoginRequest,
  LoginResponse,
  ManageBookingResponse,
  ManageCancelResponse,
  ManageRescheduleResponse,
  OfficeBookingDetail,
  OfficeBookingListQuery,
  OfficeBookingListResponse,
  OfficeCalendarQuery,
  OfficeCalendarResponse,
  OfficeCustomer,
  OfficeCustomerDetail,
  OfficeDashboardResponse,
  OfficeEmployee,
  OfficeService,
  OfficeServiceCategory,
  OfficeServiceCategoryListResponse,
  OfficeServiceListResponse,
  OfficeSettingsResponse,
  OfficeUserListResponse,
  OfficeUserMutationResponse,
  OrganizationCurrentResponse,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  RefundListResponse,
  ReplaceEmployeeServicesRequest,
  ReplaceWorkingHoursRequest,
  ReplaceWorkingHoursResponse,
  RequestListQuery,
  CancellationRequestListResponse,
  RescheduleRequestListResponse,
  ServiceCategoryListResponse,
  ServiceEmployeesResponse,
  ServiceListResponse,
  ServiceListQuery,
  TimeOffEntry,
  TimeOffListQuery,
  TimeOffListResponse,
  UpdateCustomerRequest,
  UpdateEmployeeRequest,
  UpdateOfficeSettingsRequest,
  UpdateOfficeUserRequest,
  UpdateServiceCategoryRequest,
  UpdateServiceRequest,
  UpdateTimeOffRequest,
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
  /** An array becomes a repeated key, which is how the API's list filters arrive. */
  query?: Record<string, string | number | readonly string[] | undefined>;
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
    if (value === undefined) continue;
    // Appended, not set: `?status=CONFIRMED&status=COMPLETED` is what Express turns into
    // an array and what the API's `z.union([enum, array(enum)])` accepts. Joining them
    // with a comma would send one value that is not a member of the enum.
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
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
 *  - **A single retry, GETs only.** A read that failed on a transient 5xx is worth repeating;
 *    writes are retried only by the caller, which owns the operation's idempotency key and
 *    can keep it stable while the user decides whether to try again.
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

/**
 * A contract query object as query parameters.
 *
 * The office query schemas carry booleans and repeated values. Arrays survive as arrays
 * and `url` repeats the key; booleans become `'true'`/`'false'`, which is what
 * `booleanQuery` parses; `undefined` drops out entirely rather than arriving as the
 * string `"undefined"`, which is a real filter value the API would then reject.
 */
function flatten(
  query: Record<string, unknown>,
): Record<string, string | number | readonly string[] | undefined> {
  const flat: Record<string, string | number | readonly string[] | undefined> = {};

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) flat[key] = (value as unknown[]).map(String);
      continue;
    }
    flat[key] = typeof value === 'boolean' ? String(value) : (value as string | number);
  }

  return flat;
}

/** A management token travels as a bearer header, never in the URL. */
function bearer(token: string): Record<string, string> {
  // A query parameter would land in the server access log, the browser history and any
  // `Referer` header — three places a credential must not be.
  return { Authorization: `Bearer ${token}` };
}

export const api = {
  public: {
    featureFlagConfig: () =>
      request<FeatureFlagClientConfig>('/public/feature-flags/config'),

    organization: (signal?: AbortSignal) =>
      request<OrganizationCurrentResponse>('/public/organizations/current', { signal }),

    serviceCategories: (signal?: AbortSignal) =>
      request<ServiceCategoryListResponse>('/public/service-categories', { signal }),

    services: (signal?: AbortSignal) =>
      request<ServiceListResponse>('/public/services', { signal }),

    employeesFor: (serviceId: string, signal?: AbortSignal) =>
      request<ServiceEmployeesResponse>(
        `/public/services/${encodeURIComponent(serviceId)}/employees`,
        { signal },
      ),

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
      request<BookingBySessionResponse>(
        `/public/bookings/by-session/${encodeURIComponent(checkoutSessionId)}`,
        { signal },
      ),
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

  /**
   * The office API.
   *
   * Every call carries `session: true`, unlike the auth block: a `401` here always means
   * the cookie stopped working, never "wrong credentials", so it should bounce the
   * operator to the login screen with their destination remembered.
   *
   * Query objects are spread rather than passed, because `RequestOptions['query']` takes
   * strings and numbers and the contracts' query types carry arrays and booleans. The
   * spread is where those are flattened, once, instead of at eleven call sites.
   */
  office: {
    dashboard: (signal?: AbortSignal) =>
      request<OfficeDashboardResponse>('/office/dashboard', { session: true, signal }),

    calendar: (query: Partial<OfficeCalendarQuery>, signal?: AbortSignal) =>
      request<OfficeCalendarResponse>('/office/calendar', {
        query: flatten(query),
        session: true,
        signal,
      }),

    bookings: {
      list: (query: Partial<OfficeBookingListQuery>, signal?: AbortSignal) =>
        request<OfficeBookingListResponse>('/office/bookings', {
          query: flatten(query),
          session: true,
          signal,
        }),

      detail: (id: string, signal?: AbortSignal) =>
        request<OfficeBookingDetail>(`/office/bookings/${id}`, { session: true, signal }),

      create: (body: CreateManualBookingRequest, idempotencyKey: string) =>
        request<CreateManualBookingResponse>('/office/bookings', {
          method: 'POST',
          body,
          headers: { 'Idempotency-Key': idempotencyKey },
          session: true,
        }),

      cancel: (id: string, body: CancelBookingRequest, idempotencyKey: string) =>
        request<{ bookingId: string; refundId: string | null }>(`/office/bookings/${id}/cancel`, {
          method: 'POST',
          body,
          headers: { 'Idempotency-Key': idempotencyKey },
          session: true,
        }),

      complete: (id: string) =>
        request<{ bookingId: string }>(`/office/bookings/${id}/complete`, {
          method: 'POST',
          session: true,
        }),

      noShow: (id: string) =>
        request<{ bookingId: string }>(`/office/bookings/${id}/no-show`, {
          method: 'POST',
          session: true,
        }),

      recordPayment: (id: string, body: CreateManualPaymentRequest, idempotencyKey: string) =>
        request<BookingManualPayment>(`/office/bookings/${id}/manual-payments`, {
          method: 'POST',
          body,
          headers: { 'Idempotency-Key': idempotencyKey },
          session: true,
        }),

      refunds: (id: string, signal?: AbortSignal) =>
        request<RefundListResponse>(`/office/bookings/${id}/refunds`, { session: true, signal }),

      refund: (id: string, body: CreateRefundRequest, idempotencyKey: string) =>
        request<{ refundId: string }>(`/office/bookings/${id}/refunds`, {
          method: 'POST',
          body,
          headers: { 'Idempotency-Key': idempotencyKey },
          session: true,
        }),
    },

    requests: {
      cancellations: (query: Partial<RequestListQuery>, signal?: AbortSignal) =>
        request<CancellationRequestListResponse>('/office/cancellation-requests', {
          query: flatten(query),
          session: true,
          signal,
        }),

      decideCancellation: (id: string, body: DecideCancellationRequest) =>
        request<{ requestId: string }>(`/office/cancellation-requests/${id}/decide`, {
          method: 'POST',
          body,
          session: true,
        }),

      reschedules: (query: Partial<RequestListQuery>, signal?: AbortSignal) =>
        request<RescheduleRequestListResponse>('/office/reschedule-requests', {
          query: flatten(query),
          session: true,
          signal,
        }),

      decideReschedule: (id: string, body: DecideRescheduleRequest) =>
        request<{ requestId: string; newBookingId: string | null }>(
          `/office/reschedule-requests/${id}/decide`,
          { method: 'POST', body, session: true },
        ),
    },

    employees: {
      list: (includeArchived: boolean, signal?: AbortSignal) =>
        request<EmployeeListResponse>('/office/employees', {
          query: { includeArchived: String(includeArchived) },
          session: true,
          signal,
        }),

      create: (body: CreateEmployeeRequest) =>
        request<OfficeEmployee>('/office/employees', { method: 'POST', body, session: true }),

      update: (id: string, body: UpdateEmployeeRequest) =>
        request<OfficeEmployee>(`/office/employees/${id}`, {
          method: 'PATCH',
          body,
          session: true,
        }),

      archive: (id: string) =>
        request<OfficeEmployee>(`/office/employees/${id}/archive`, {
          method: 'POST',
          session: true,
        }),

      services: (id: string, signal?: AbortSignal) =>
        request<EmployeeServicesResponse>(`/office/employees/${id}/services`, {
          session: true,
          signal,
        }),

      replaceServices: (id: string, body: ReplaceEmployeeServicesRequest) =>
        request<EmployeeServicesResponse>(`/office/employees/${id}/services`, {
          method: 'PUT',
          body,
          session: true,
        }),

      replaceWorkingHours: (id: string, body: ReplaceWorkingHoursRequest) =>
        request<ReplaceWorkingHoursResponse>(`/office/employees/${id}/working-hours`, {
          method: 'PUT',
          body,
          session: true,
        }),

      exceptions: (id: string, signal?: AbortSignal) =>
        request<AvailabilityExceptionListResponse>(
          `/office/employees/${id}/availability-exceptions`,
          { session: true, signal },
        ),

      createException: (id: string, body: CreateAvailabilityExceptionRequest) =>
        request<CreateAvailabilityExceptionResponse>(
          `/office/employees/${id}/availability-exceptions`,
          { method: 'POST', body, session: true },
        ),

      deleteException: (employeeId: string, id: string) =>
        request<undefined>(`/office/employees/${employeeId}/availability-exceptions/${id}`, {
          method: 'DELETE',
          session: true,
        }),
    },

    availability: {
      /**
       * Slots the office may book, which is a wider set than a customer is offered.
       *
       * The same shapes as `public.availability`, because it is the same question — the
       * office route answers it without the minimum-notice window and without the
       * horizon, which is what makes "come in this afternoon" bookable from a screen.
       */
      slots: (query: AvailabilityQuery, signal?: AbortSignal) =>
        request<AvailabilityResponse>('/office/availability', {
          query: { ...query },
          session: true,
          signal,
        }),

      blockedTimes: (query: BlockedTimeListQuery, signal?: AbortSignal) =>
        request<BlockedTimeListResponse>('/office/blocked-times', {
          query: flatten(query),
          session: true,
          signal,
        }),

      createBlockedTime: (body: CreateBlockedTimeRequest) =>
        request<BlockedTime>('/office/blocked-times', { method: 'POST', body, session: true }),

      deleteBlockedTime: (id: string) =>
        request<undefined>(`/office/blocked-times/${id}`, { method: 'DELETE', session: true }),

      timeOff: (query: Partial<TimeOffListQuery>, signal?: AbortSignal) =>
        request<TimeOffListResponse>('/office/time-off', {
          query: flatten(query),
          session: true,
          signal,
        }),

      createTimeOff: (body: CreateTimeOffRequest) =>
        request<TimeOffEntry>('/office/time-off', { method: 'POST', body, session: true }),

      updateTimeOff: (id: string, body: UpdateTimeOffRequest) =>
        request<TimeOffEntry>(`/office/time-off/${id}`, { method: 'PATCH', body, session: true }),

      closedDays: (query: ClosedDayListQuery, signal?: AbortSignal) =>
        request<ClosedDayListResponse>('/office/closed-days', {
          query: flatten(query),
          session: true,
          signal,
        }),

      createClosedDay: (body: CreateClosedDayRequest) =>
        request<ClosedDay>('/office/closed-days', { method: 'POST', body, session: true }),

      deleteClosedDay: (id: string) =>
        request<undefined>(`/office/closed-days/${id}`, { method: 'DELETE', session: true }),
    },

    catalog: {
      categories: (includeArchived: boolean, signal?: AbortSignal) =>
        request<OfficeServiceCategoryListResponse>('/office/service-categories', {
          query: { includeArchived: String(includeArchived) },
          session: true,
          signal,
        }),

      createCategory: (body: CreateServiceCategoryRequest) =>
        request<OfficeServiceCategory>('/office/service-categories', {
          method: 'POST',
          body,
          session: true,
        }),

      updateCategory: (id: string, body: UpdateServiceCategoryRequest) =>
        request<OfficeServiceCategory>(`/office/service-categories/${id}`, {
          method: 'PATCH',
          body,
          session: true,
        }),

      archiveCategory: (id: string) =>
        request<OfficeServiceCategory>(`/office/service-categories/${id}/archive`, {
          method: 'POST',
          session: true,
        }),

      services: (query: Partial<ServiceListQuery>, signal?: AbortSignal) =>
        request<OfficeServiceListResponse>('/office/services', {
          query: flatten(query),
          session: true,
          signal,
        }),

      createService: (body: CreateServiceRequest) =>
        request<OfficeService>('/office/services', { method: 'POST', body, session: true }),

      updateService: (id: string, body: UpdateServiceRequest) =>
        request<OfficeService>(`/office/services/${id}`, {
          method: 'PATCH',
          body,
          session: true,
        }),

      archiveService: (id: string) =>
        request<OfficeService>(`/office/services/${id}/archive`, {
          method: 'POST',
          session: true,
        }),
    },

    customers: {
      list: (query: Partial<CustomerListQuery>, signal?: AbortSignal) =>
        request<CustomerListResponse>('/office/customers', {
          query: flatten(query),
          session: true,
          signal,
        }),

      detail: (id: string, signal?: AbortSignal) =>
        request<OfficeCustomerDetail>(`/office/customers/${id}`, { session: true, signal }),

      update: (id: string, body: UpdateCustomerRequest) =>
        request<OfficeCustomer>(`/office/customers/${id}`, {
          method: 'PATCH',
          body,
          session: true,
        }),

      erase: (id: string) =>
        request<EraseCustomerResponse>(`/office/customers/${id}/erase`, {
          method: 'POST',
          session: true,
        }),
    },

    settings: {
      read: (signal?: AbortSignal) =>
        request<OfficeSettingsResponse>('/office/settings', { session: true, signal }),

      update: (body: UpdateOfficeSettingsRequest) =>
        request<OfficeSettingsResponse>('/office/settings', {
          method: 'PATCH',
          body,
          session: true,
        }),
    },

    users: {
      list: (includeArchived: boolean, signal?: AbortSignal) =>
        request<OfficeUserListResponse>('/office/users', {
          query: { includeArchived: String(includeArchived) },
          session: true,
          signal,
        }),

      create: (body: CreateOfficeUserRequest) =>
        request<OfficeUserMutationResponse>('/office/users', {
          method: 'POST',
          body,
          session: true,
        }),

      update: (id: string, body: UpdateOfficeUserRequest) =>
        request<OfficeUserMutationResponse>(`/office/users/${id}`, {
          method: 'PATCH',
          body,
          session: true,
        }),

      archive: (id: string) =>
        request<OfficeUserMutationResponse>(`/office/users/${id}/archive`, {
          method: 'POST',
          session: true,
        }),
    },

    auditLog: (query: Partial<AuditLogQuery>, signal?: AbortSignal) =>
      request<AuditLogResponse>('/office/audit-log', {
        query: flatten(query),
        session: true,
        signal,
      }),

    /**
     * The export URLs, not the bytes.
     *
     * The response is a stream the browser has to save, and `fetch` would buffer it into
     * memory only to hand it back as a blob. Navigating a hidden anchor lets the browser
     * do what it already does well — including showing progress on a large range — and
     * the session cookie rides along because it is the same origin.
     */
    exportUrl: (kind: 'bookings' | 'payments', query: ExportQuery): string =>
      url(`/office/exports/${kind}.csv`, flatten(query)),
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
