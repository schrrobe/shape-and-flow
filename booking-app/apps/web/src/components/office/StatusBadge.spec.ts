import { displayStatusSchema } from '@shape-and-flow/booking-contracts';
import { mount } from '@vue/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '../../i18n/index.js';

import { STATUS_PRESENTATION } from './status-presentation.js';
import StatusBadge from './StatusBadge.vue';

/**
 * The enum is iterated rather than listed.
 *
 * A hand-written list here would pass on the day somebody adds a status to the contract
 * and forgets the presentation — which is exactly when the badge starts rendering an
 * empty pill for a booking nobody can classify.
 */
const ALL_DISPLAY_STATUSES = displayStatusSchema.options;

describe('StatusBadge', () => {
  // The badge resolves through the shared i18n instance, whose default is German. These
  // assertions are all written against the English wording.
  beforeAll(() => {
    i18n.global.locale.value = 'en';
  });

  afterAll(() => {
    i18n.global.locale.value = 'de';
  });

  it('covers every status the contract defines', () => {
    expect(Object.keys(STATUS_PRESENTATION).sort()).toEqual([...ALL_DISPLAY_STATUSES].sort());
  });

  it('renders a label and a tone for every display status', () => {
    for (const status of ALL_DISPLAY_STATUSES) {
      const wrapper = mount(StatusBadge, { props: { status } });

      expect(wrapper.text(), status).not.toBe('');
      expect(wrapper.get(`[data-status="${status}"]`).classes().join(' '), status).toMatch(
        /bg-(surface-muted|success|warning|danger)/,
      );
    }
  });

  it('does not rely on colour alone', () => {
    // Roughly one operator in twelve cannot tell the green from the amber. A calendar
    // where "cancelled" and "confirmed" differ only by hue is one where somebody keeps an
    // appointment that is not happening.
    for (const status of ALL_DISPLAY_STATUSES) {
      expect(
        mount(StatusBadge, { props: { status } }).text().trim().length,
        status,
      ).toBeGreaterThan(1);
    }
  });

  it('keeps the label readable to a screen reader when compact', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'CONFIRMED', compact: true } });

    // `sr-only` hides it visually and keeps it in the accessibility tree; `display: none`
    // would take it out of both.
    expect(wrapper.text()).toContain('Confirmed');
    expect(wrapper.html()).toContain('sr-only');
  });

  it('marks the glyph decorative, so it is not read out as punctuation', () => {
    const wrapper = mount(StatusBadge, { props: { status: 'NO_SHOW' } });

    expect(wrapper.get('[aria-hidden="true"]').text()).toBe(STATUS_PRESENTATION.NO_SHOW.mark);
  });

  it('gives the two derived statuses their own wording', () => {
    // They are not booking statuses — the row stays CONFIRMED — so a label that said
    // "confirmed" would hide the fact that somebody is waiting for an answer.
    expect(STATUS_PRESENTATION.CANCELLATION_REQUESTED.labelKey).not.toBe(
      STATUS_PRESENTATION.CONFIRMED.labelKey,
    );
    expect(STATUS_PRESENTATION.RESCHEDULE_REQUESTED.labelKey).not.toBe(
      STATUS_PRESENTATION.CONFIRMED.labelKey,
    );
  });
});
