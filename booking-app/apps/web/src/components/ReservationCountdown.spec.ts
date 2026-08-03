import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { i18n } from '../i18n/index.js';

import ReservationCountdown from './ReservationCountdown.vue';

const NOW = new Date('2026-08-14T06:00:00.000Z');

function mountAt(expiresAt: Date) {
  return mount(ReservationCountdown, {
    props: { expiresAt },
    global: { plugins: [i18n] },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReservationCountdown', () => {
  it('counts down in mm:ss', async () => {
    const wrapper = mountAt(new Date('2026-08-14T06:05:00.000Z'));
    expect(wrapper.text()).toContain('05:00');

    vi.advanceTimersByTime(90_000);
    await nextTick();

    expect(wrapper.text()).toContain('03:30');
  });

  it('styles the last minute as urgent, and a lapsed reservation differently again', async () => {
    const wrapper = mountAt(new Date('2026-08-14T06:05:00.000Z'));
    const classes = () => wrapper.classes().join(' ');

    expect(classes()).not.toMatch(/warning|danger/);

    vi.advanceTimersByTime(4 * 60_000 + 30_000);
    await nextTick();

    // Under a minute is when somebody has to hurry, so that is when the styling changes.
    expect(wrapper.text()).toContain('00:30');
    expect(classes()).toMatch(/warning/);

    vi.advanceTimersByTime(31_000);
    await nextTick();

    // "Hurry" and "too late" are different messages. Styled the same, the change of state is
    // the one thing the countdown fails to communicate.
    expect(classes()).toMatch(/danger/);
    expect(classes()).not.toMatch(/warning/);
  });

  it('emits expired exactly once and stops ticking', async () => {
    const wrapper = mountAt(new Date(NOW.getTime() + 1000));

    vi.advanceTimersByTime(10_000);
    await nextTick();

    // A repeated event would re-trigger whatever the parent does about it.
    expect(wrapper.emitted('expired')).toHaveLength(1);
  });

  it('says so immediately when it is already expired', async () => {
    const wrapper = mountAt(new Date(NOW.getTime() - 1000));
    await nextTick();

    // Waiting a second to notice would show a countdown that was never true.
    expect(wrapper.emitted('expired')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('00:00');
  });

  it('announces politely and hides the ticking digits', () => {
    const wrapper = mountAt(new Date('2026-08-14T06:05:00.000Z'));

    // Announcing a new number every second makes the page unusable with a screen reader; the
    // surrounding sentence is what gets announced.
    expect(wrapper.attributes('aria-live')).toBe('polite');
    expect(wrapper.get('[aria-hidden="true"]').text()).toBe('05:00');
  });

  it('stops its timer when unmounted', () => {
    const wrapper = mountAt(new Date('2026-08-14T06:05:00.000Z'));
    wrapper.unmount();

    // A leaked interval keeps a component alive after navigation and emits into nothing.
    expect(vi.getTimerCount()).toBe(0);
  });
});
