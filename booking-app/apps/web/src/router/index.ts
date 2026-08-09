import { createRouter, createWebHistory } from 'vue-router';

import {
  ORGANIZER_PARAM,
  readOrganizerParam,
  rememberTenantSlug,
  tenantSlug,
} from '../api/tenant.js';

import { installOfficeSessionHandling } from './office-guard.js';

import type { RouteRecordRaw } from 'vue-router';

/**
 * The routes that exist today.
 *
 * The booking wizard, the post-payment pages and the management pages add their own records as
 * they are built — a route pointing at a component that does not exist yet is a build that
 * passes and a link that 404s.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('../pages/public/HomePage.vue') },

  {
    path: '/booking',
    component: () => import('../pages/public/BookingLayout.vue'),
    children: [
      { path: '', redirect: { name: 'booking-service' } },
      {
        path: 'service',
        name: 'booking-service',
        component: () => import('../pages/public/StepService.vue'),
      },
      {
        path: 'employee',
        name: 'booking-employee',
        component: () => import('../pages/public/StepEmployee.vue'),
      },
      {
        path: 'slot',
        name: 'booking-slot',
        component: () => import('../pages/public/StepSlot.vue'),
      },
      {
        path: 'details',
        name: 'booking-details',
        component: () => import('../pages/public/StepDetails.vue'),
      },
      {
        path: 'checkout',
        name: 'booking-checkout',
        component: () => import('../pages/public/RedirectToCheckout.vue'),
      },
    ],
  },
  {
    path: '/booking/success',
    name: 'booking-success',
    component: () => import('../pages/public/BookingSuccess.vue'),
  },
  {
    path: '/booking/canceled',
    name: 'booking-canceled',
    component: () => import('../pages/public/BookingCanceled.vue'),
  },

  {
    path: '/organizer/registrieren',
    name: 'register-organizer',
    component: () => import('../pages/public/RegisterOrganizerPage.vue'),
  },

  {
    path: '/manage',
    name: 'manage',
    component: () => import('../pages/public/ManageBooking.vue'),
  },
  {
    path: '/manage/reschedule',
    name: 'manage-reschedule',
    component: () => import('../pages/public/ManageReschedule.vue'),
  },

  /**
   * The office area.
   *
   * `meta.area` marks it so the application shell renders the office chrome instead of the
   * customer header, and `meta.requiresSession` is what the guard reads. The three
   * authentication screens sit outside the layout: it builds a sidebar from capabilities,
   * and there is no user to build one from until one of them has done its job.
   */
  {
    path: '/office/login',
    name: 'office-login',
    component: () => import('../pages/office/OfficeLogin.vue'),
    meta: { area: 'office' },
  },
  {
    path: '/office/forgot-password',
    name: 'office-forgot-password',
    component: () => import('../pages/office/OfficeForgotPassword.vue'),
    meta: { area: 'office' },
  },
  {
    path: '/office/reset-password',
    name: 'office-reset-password',
    component: () => import('../pages/office/OfficeResetPassword.vue'),
    meta: { area: 'office' },
  },
  {
    path: '/office',
    component: () => import('../pages/office/OfficeLayout.vue'),
    meta: { area: 'office', requiresSession: true },
    children: [
      // No `meta` of its own: vue-router merges every matched record's meta into
      // `route.meta`, so a child inherits the parent's `area` and `requiresSession`.
      //
      {
        path: '',
        name: 'office-dashboard',
        component: () => import('../pages/office/OfficeDashboard.vue'),
      },
      {
        path: 'calendar',
        name: 'office-calendar',
        component: () => import('../pages/office/OfficeCalendar.vue'),
      },
      {
        path: 'bookings',
        name: 'office-bookings',
        component: () => import('../pages/office/BookingList.vue'),
      },
      // Before `bookings/:id` for the same reason the detail sits after the list: the
      // resolution order does not depend on it, but a reader should not have to know that
      // to be sure "new" is a screen rather than a booking id.
      {
        path: 'bookings/new',
        name: 'office-booking-new',
        component: () => import('../pages/office/NewBooking.vue'),
      },
      // After the list, so `/office/bookings` matches the list rather than the detail with
      // an empty id — vue-router resolves static segments before dynamic ones, but the
      // order is what makes that visible to a reader.
      {
        path: 'bookings/:id',
        name: 'office-booking',
        component: () => import('../pages/office/BookingDetail.vue'),
      },
      {
        path: 'requests',
        name: 'office-requests',
        component: () => import('../pages/office/RequestsPage.vue'),
      },
      {
        path: 'employees',
        name: 'office-employees',
        component: () => import('../pages/office/EmployeesPage.vue'),
      },
      {
        path: 'services',
        name: 'office-services',
        component: () => import('../pages/office/ServicesPage.vue'),
      },
      {
        path: 'availability',
        name: 'office-availability',
        component: () => import('../pages/office/AvailabilityPage.vue'),
      },
      {
        path: 'customers',
        name: 'office-customers',
        component: () => import('../pages/office/CustomersPage.vue'),
      },
      {
        path: 'exports',
        name: 'office-exports',
        component: () => import('../pages/office/ExportsPage.vue'),
      },
      {
        path: 'users',
        name: 'office-users',
        component: () => import('../pages/office/UsersPage.vue'),
      },
      {
        path: 'settings',
        name: 'office-settings',
        component: () => import('../pages/office/SettingsPage.vue'),
      },
      {
        path: 'payments',
        name: 'office-payments',
        component: () => import('../pages/office/PaymentsPage.vue'),
      },
      {
        path: 'onboarding-status',
        name: 'onboarding-status',
        component: () => import('../pages/office/OnboardingStatusPage.vue'),
      },
    ],
  },

  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../pages/public/NotFoundPage.vue'),
  },
];

/**
 * The routes whose fragment is a credential rather than an anchor.
 *
 * The management link carries its token in the hash, deliberately — a fragment is not sent to
 * the server and stays out of access logs. That makes it the wrong thing to hand to a selector
 * lookup: no element matches, so the router logs a development warning *containing the token*,
 * and a token that is not a valid CSS id can make the lookup throw mid-navigation.
 *
 * Matched on the route name, not on the shape of the hash: a rule that guesses which fragments
 * look like secrets would be wrong the first time the token alphabet changes.
 */
const HASH_IS_A_CREDENTIAL: ReadonlySet<string> = new Set([
  'manage',
  'manage-reschedule',
  'office-reset-password',
]);

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (to, _from, savedPosition) => {
    // Restore on back, jump to the top otherwise: a wizard step that opens halfway down the
    // previous step's scroll position looks broken.
    if (savedPosition !== null) return savedPosition;

    const credential = typeof to.name === 'string' && HASH_IS_A_CREDENTIAL.has(to.name);
    if (to.hash !== '' && !credential) return { el: to.hash };

    return { top: 0 };
  },
});

/**
 * Keep `?organizer=` on every public URL.
 *
 * The customer arrives on `/?organizer=acme` and the first `router.push` — to a wizard
 * step, or back to the slot list after a taken slot — would drop the parameter. The page
 * would still work, because the API client remembers the slug, but the address bar would
 * stop naming the organizer: a reloaded, bookmarked or shared link would land on the
 * default tenant instead. Putting it back makes the URL mean what the session means.
 *
 * Office routes are left alone. They resolve their tenant from the session cookie, and a
 * slug on an authenticated URL would be a second way to name a tenant that nothing reads.
 */
router.beforeEach((to) => {
  // Before the parameter is read at all, not just before it is put back: an office URL
  // that carries `?organizer=` names nothing the office reads, so honouring it would let
  // `/office?organizer=other` repoint the tab's booking tenant and send a later public
  // navigation to an organizer the customer never chose.
  if (to.meta.area === 'office') return true;

  const explicit = readOrganizerParam(to.query[ORGANIZER_PARAM]);
  if (explicit !== null) {
    rememberTenantSlug(explicit);
    return true;
  }

  const slug = tenantSlug();
  if (slug === null) return true;

  // Covers the absent case and the malformed ones — `?organizer=` and repeated values,
  // both of which the API rejects — by replacing whatever was there with the slug this
  // visit is actually for.
  return { ...to, query: { ...to.query, [ORGANIZER_PARAM]: slug } };
});

installOfficeSessionHandling(router);
