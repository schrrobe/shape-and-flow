import { createRouter, createWebHistory } from 'vue-router';

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
    ],
  },

  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../pages/public/NotFoundPage.vue'),
  },
];

/**
 * A fragment on these routes is a credential, not an anchor.
 *
 * `{ el: to.hash }` hands the fragment to `document.querySelector`, and a token is not a
 * valid CSS selector the moment it starts with a digit — which throws rather than missing.
 * Both routes that receive a token this way are listed, so scrolling stays on for the
 * anchors it is actually for.
 */
const CREDENTIAL_IN_FRAGMENT: readonly string[] = ['/manage', '/office/reset-password'];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (to, _from, savedPosition) => {
    // Restore on back, jump to the top otherwise: a wizard step that opens halfway down the
    // previous step's scroll position looks broken.
    if (savedPosition !== null) return savedPosition;
    if (to.hash !== '' && !CREDENTIAL_IN_FRAGMENT.includes(to.path)) return { el: to.hash };
    return { top: 0 };
  },
});

installOfficeSessionHandling(router);
