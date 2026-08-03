import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NAVIGATION } from '../../office/navigation.js';
import { router } from '../../router/index.js';
import { useSession } from '../../stores/session.js';

import OfficeLayout from './OfficeLayout.vue';

import type { OfficeUserDto } from '@shape-and-flow/booking-contracts';
import type { Pinia } from 'pinia';

function officeUser(overrides: Partial<OfficeUserDto> = {}): OfficeUserDto {
  return {
    id: 'u1',
    email: 'mara@shapeandflow.test',
    firstName: 'Mara',
    lastName: 'Vogt',
    role: 'OWNER',
    canIssueRefunds: true,
    employeeId: null,
    ...overrides,
  };
}

/**
 * Mounted apps are torn down between tests.
 *
 * Without this they stay installed in the module-singleton router, and a `beforeEach` guard —
 * which resolves its store through whichever app context the router still holds — reads a
 * previous test's session. That made a signed-out user look signed in and redirected the
 * login route away.
 */
enableAutoUnmount(afterEach);

let pinia: Pinia;
let logoutCalls = 0;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  logoutCalls = 0;

  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/auth/logout')) {
      logoutCalls += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    throw new Error(`unexpected request: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountLayout(user: OfficeUserDto = officeUser()) {
  useSession(pinia).user = user;

  return mount(OfficeLayout, {
    global: { plugins: [pinia, router], stubs: { RouterView: true } },
  });
}

describe('OfficeLayout', () => {
  it('names the signed-in user and their role', () => {
    const wrapper = mountLayout(officeUser({ role: 'ADMIN' }));

    expect(wrapper.get('[data-test=current-user]').text()).toContain('Mara Vogt');
    expect(wrapper.get('[data-test=current-user]').text()).toContain('ADMIN');
  });

  it('offers its own skip link, pointing at a landmark that exists', () => {
    const wrapper = mountLayout();

    expect(wrapper.find('a[href="#office-main"]').exists()).toBe(true);
    expect(wrapper.find('#office-main').exists()).toBe(true);
  });

  it('links only to destinations that have been built', () => {
    const wrapper = mountLayout();

    const rendered = NAVIGATION.filter((entry) =>
      wrapper.find(`[data-test=nav-${entry.name}]`).exists(),
    ).map((entry) => entry.name);

    // An owner holds every capability and every route now exists, so the whole sidebar
    // renders. A link to an unregistered name would resolve to the customer-facing 404,
    // which is what this has been guarding against since 10.1.
    expect(rendered).toEqual(NAVIGATION.map((entry) => entry.name));
  });

  it('hides what a role may not reach', () => {
    // Now that every route exists, this isolates the capability half: an owner sees
    // Settings and an employee does not, from the same layout and the same table.
    // `navigation.spec.ts` covers the matrix across all three roles.
    const employee = mountLayout(officeUser({ role: 'EMPLOYEE', employeeId: 'e1' }));
    expect(employee.find('[data-test=nav-office-settings]').exists()).toBe(false);
    expect(employee.find('[data-test=nav-office-users]').exists()).toBe(false);
    // An employee still gets their own calendar and their own bookings.
    expect(employee.find('[data-test=nav-office-calendar]').exists()).toBe(true);

    const owner = mountLayout();
    expect(owner.find('[data-test=nav-office-settings]').exists()).toBe(true);
  });

  it('signs out and returns to the login page', async () => {
    const wrapper = mountLayout();

    await wrapper.get('[data-test=sign-out]').trigger('click');
    await flushPromises();

    expect(logoutCalls).toBe(1);
    expect(useSession(pinia).isAuthenticated).toBe(false);
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('office-login');
    });
  });

  it('sets the document language to English while it is open', () => {
    // The office copy is English and the customer side may well have set `lang="de"` first;
    // leaving it there has a screen reader read English aloud with German phonetics.
    mountLayout();

    expect(document.documentElement.lang).toBe('en');
  });
});
