import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { router } from '../../router/index.js';
import { useSession } from '../../stores/session.js';

import OfficeLogin from './OfficeLogin.vue';

import type { OfficeUserDto } from '@shape-and-flow/booking-contracts';
import type { VueWrapper } from '@vue/test-utils';
import type { Pinia } from 'pinia';

const USER: OfficeUserDto = {
  id: 'u1',
  email: 'mara@shapeandflow.test',
  firstName: 'Mara',
  lastName: 'Vogt',
  role: 'ADMIN',
  canIssueRefunds: false,
  employeeId: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What `POST /auth/login` answers. */
let loginAnswer: () => Response | never = () => json({ user: USER });

/**
 * One Pinia, shared by the test and the mounted component, and passed to `useSession`
 * explicitly rather than left to the active instance.
 *
 * Handing `createPinia()` to `mount` while the test held another one meant the store the form
 * wrote to was not the store the assertions read — and the router guard, resolving through a
 * third route, saw a third view of the world.
 */
/**
 * Mounted apps are torn down between tests, so the module-singleton router does not keep a
 * previous test's app — and with it a previous test's session — as the context its guards
 * resolve stores through.
 */
enableAutoUnmount(afterEach);

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  loginAnswer = () => json({ user: USER });

  vi.stubGlobal('fetch', (url: string) => {
    // Nobody is signed in unless a test signs them in, so the guard lets the form render.
    if (url.includes('/auth/me')) {
      return Promise.resolve(json({ code: 'UNAUTHENTICATED', correlationId: 'c1' }, 401));
    }

    if (url.includes('/auth/login')) return Promise.resolve(loginAnswer());

    throw new Error(`unexpected request: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submit(wrapper: VueWrapper, password = 'correct horse battery'): Promise<void> {
  const fields = wrapper.findAll('input');
  await fields[0]?.setValue('mara@shapeandflow.test');
  await fields[1]?.setValue(password);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
}

/** The destination, once the navigation has settled. */
async function landedOn(path: string): Promise<void> {
  // A successful sign-in navigates to a lazily-imported route, so the destination is several
  // microtask turns away — one `flushPromises` sees the old path and reads as a failure.
  await vi.waitFor(() => {
    expect(router.currentRoute.value.fullPath).toBe(path);
  });
}

/**
 * Mount first, navigate second.
 *
 * The navigation runs the office guard, and the guard resolves its store through the app the
 * router is installed into. Mounting first means that app is this test's, holding this test's
 * Pinia — navigating before the mount ran the guard against whatever was left over.
 */
async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(OfficeLogin, { global: { plugins: [pinia, router] } });

  await router.replace('/office/login');
  await flushPromises();

  return wrapper;
}

describe('OfficeLogin', () => {
  it('signs in and goes to the office', async () => {
    const wrapper = await mountPage();
    await submit(wrapper);

    expect(useSession(pinia).isAuthenticated).toBe(true);
    await landedOn('/office');
  });

  it('returns to the screen an expired session was on', async () => {
    useSession(pinia).markExpired('/office?filter=today');

    const wrapper = await mountPage();
    await submit(wrapper);

    await landedOn('/office?filter=today');
  });

  it('says one thing for every rejected credential', async () => {
    loginAnswer = () => json({ code: 'UNAUTHENTICATED', correlationId: 'c1' }, 401);

    const wrapper = await mountPage();
    await submit(wrapper, 'wrong');

    const text = wrapper.get('[data-test=failed]').text();

    // Unknown address, wrong password, archived account, locked account: the API answers all
    // four identically so the form cannot be used to discover which addresses have accounts.
    // Saying more here would hand that back.
    expect(text).not.toMatch(/unknown|no account|locked|archived|does not exist/i);
    expect(text).toMatch(/not accepted/i);
  });

  it('does not leave the password in the field after a refusal', async () => {
    loginAnswer = () => json({ code: 'UNAUTHENTICATED', correlationId: 'c1' }, 401);

    const wrapper = await mountPage();
    await submit(wrapper, 'wrong');

    expect(wrapper.findAll('input')[1]?.element.value).toBe('');
  });

  it('separates a rate limit from a wrong password', async () => {
    loginAnswer = () => json({ code: 'RATE_LIMITED', correlationId: 'c1' }, 429);

    const wrapper = await mountPage();
    await submit(wrapper);

    // Ten attempts per quarter hour. Telling somebody their details were wrong when the
    // server never checked them sends them round the loop again.
    expect(wrapper.find('[data-test=failed]').exists()).toBe(false);
    expect(wrapper.get('[data-test=problem]').text()).toMatch(/too many/i);
  });

  it('separates an unreachable server from a wrong password', async () => {
    loginAnswer = () => {
      throw new TypeError('Failed to fetch');
    };

    const wrapper = await mountPage();
    await submit(wrapper);

    expect(wrapper.find('[data-test=failed]').exists()).toBe(false);
    expect(wrapper.get('[data-test=problem]').text()).toMatch(/no connection/i);
  });

  it('explains an expired session rather than looking like a plain login', async () => {
    useSession(pinia).markExpired('/office');

    const wrapper = await mountPage();
    await flushPromises();

    expect(wrapper.text()).toMatch(/signed out after a period of inactivity/i);
  });

  it('says nothing about inactivity to a first-time visitor', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    expect(wrapper.text()).not.toMatch(/signed out/i);
  });
});
