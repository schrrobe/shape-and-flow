import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import CalendarGrid from './CalendarGrid.vue';

import type { CalendarBooking, OfficeCalendarResponse } from '@shape-and-flow/booking-contracts';

/**
 * 2026-08-14 is a Friday in German summer time, so Berlin is UTC+2.
 *
 * Every instant below is written in UTC and asserted in local time, which is the whole
 * point: a grid that read the browser's clock would place `07:00Z` at seven for an
 * operator in London and at three in the morning for one in New York.
 */
const DATE = '2026-08-14';

function booking(overrides: Partial<CalendarBooking> = {}): CalendarBooking {
  return {
    id: 'cka00000000000000000booking',
    reference: 'SF-ABC123',
    status: 'CONFIRMED',
    displayStatus: 'CONFIRMED',
    startsAt: '2026-08-14T07:00:00.000Z',
    endsAt: '2026-08-14T07:30:00.000Z',
    blockStartsAt: '2026-08-14T07:00:00.000Z',
    blockEndsAt: '2026-08-14T07:30:00.000Z',
    employeeId: 'cka0000000000000000employe1',
    serviceId: 'cka0000000000000000service1',
    serviceName: 'Facial Massage 30',
    customerName: 'Anna Becker',
    origin: 'ONLINE',
    price: { amountCents: 4500, currency: 'EUR' },
    ...overrides,
  };
}

const EMPLOYEE_ONE = { id: 'cka0000000000000000employe1', displayName: 'Mara' };
const EMPLOYEE_TWO = { id: 'cka0000000000000000employe2', displayName: 'Jonas' };

function calendar(overrides: Partial<OfficeCalendarResponse> = {}): OfficeCalendarResponse {
  return {
    bookings: [],
    blockedTimes: [],
    timeOff: [],
    closedDays: [],
    workingHours: [
      {
        employeeId: EMPLOYEE_ONE.id,
        weekday: 'FRIDAY',
        startMinute: 540,
        endMinute: 1080,
        breaks: [{ startMinute: 720, endMinute: 750, label: 'Lunch' }],
      },
    ],
    ...overrides,
  };
}

const gridProps = { date: DATE, employees: [EMPLOYEE_ONE], calendar: calendar() };

describe('CalendarGrid', () => {
  it('positions an appointment by its Berlin-local time, not by UTC', () => {
    const wrapper = mount(CalendarGrid, {
      props: { ...gridProps, calendar: calendar({ bookings: [booking()] }) },
    });

    // 07:00Z is 09:00 in Berlin in August. This is the assertion the whole layout module
    // exists for.
    expect(wrapper.get('[data-test=slot]').attributes('data-local-start')).toBe('09:00');
  });

  it('renders buffers distinctly from the appointment itself', () => {
    const withBuffers = booking({
      blockStartsAt: '2026-08-14T06:50:00.000Z',
      blockEndsAt: '2026-08-14T07:35:00.000Z',
    });

    const wrapper = mount(CalendarGrid, {
      props: { ...gridProps, calendar: calendar({ bookings: [withBuffers] }) },
    });

    // Two bands: the prep before and the cleanup after. Drawn separately because they
    // mean something different from the customer's hour — they are why the next slot is
    // unavailable.
    expect(wrapper.findAll('[data-test=buffer]')).toHaveLength(2);
  });

  it('draws no buffer band when there is no buffer', () => {
    const wrapper = mount(CalendarGrid, {
      props: { ...gridProps, calendar: calendar({ bookings: [booking()] }) },
    });

    expect(wrapper.findAll('[data-test=buffer]')).toHaveLength(0);
  });

  it('renders blocked time, time off and closed days as non-clickable', () => {
    const wrapper = mount(CalendarGrid, {
      props: {
        ...gridProps,
        calendar: calendar({
          blockedTimes: [
            {
              id: 'cka000000000000000000block1',
              employeeId: EMPLOYEE_ONE.id,
              startsAt: '2026-08-14T11:00:00.000Z',
              endsAt: '2026-08-14T12:00:00.000Z',
              reason: 'Dentist',
            },
          ],
          timeOff: [
            {
              id: 'cka0000000000000000timeoff1',
              employeeId: EMPLOYEE_ONE.id,
              startDate: DATE,
              endDate: DATE,
              reason: null,
            },
          ],
          closedDays: [{ date: DATE, reason: 'Public holiday' }],
        }),
      },
    });

    for (const selector of ['[data-test=blocked]', '[data-test=timeoff]', '[data-test=closed]']) {
      expect(wrapper.get(selector).attributes('aria-disabled'), selector).toBe('true');
      // Not a button, so it cannot be reached by keyboard either — `aria-disabled` alone
      // would still leave a focusable element that does nothing.
      expect(wrapper.get(selector).element.tagName, selector).not.toBe('BUTTON');
    }
  });

  it('keeps a column per visible employee, and one for a single employee', () => {
    expect(
      mount(CalendarGrid, {
        props: { ...gridProps, employees: [EMPLOYEE_ONE, EMPLOYEE_TWO] },
      }).findAll('[data-test=column]'),
    ).toHaveLength(2);

    expect(mount(CalendarGrid, { props: gridProps }).findAll('[data-test=column]')).toHaveLength(1);
  });

  it('is navigable by keyboard between days', async () => {
    const wrapper = mount(CalendarGrid, { props: gridProps });

    await wrapper.get('[data-test=grid]').trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('changeDate')?.[0]).toEqual(['2026-08-15']);

    await wrapper.get('[data-test=grid]').trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.emitted('changeDate')?.[1]).toEqual(['2026-08-13']);
  });

  it('ignores keys it does not handle', async () => {
    const wrapper = mount(CalendarGrid, { props: gridProps });

    await wrapper.get('[data-test=grid]').trigger('keydown', { key: 'a' });
    expect(wrapper.emitted('changeDate')).toBeUndefined();
  });

  it('splits the working band around a break', () => {
    const wrapper = mount(CalendarGrid, { props: gridProps });

    // 09:00–12:00 and 12:30–18:00. One band would mean the lunch break is invisible, and
    // an operator would offer a slot the engine will refuse.
    expect(wrapper.findAll('[data-test=working]')).toHaveLength(2);
  });

  it('emits the booking id when an appointment is clicked', async () => {
    const wrapper = mount(CalendarGrid, {
      props: { ...gridProps, calendar: calendar({ bookings: [booking()] }) },
    });

    await wrapper.get('[data-test=slot]').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual([booking().id]);
  });

  it('clamps a booking that started on the previous day', () => {
    const overnight = booking({
      startsAt: '2026-08-13T22:00:00.000Z',
      endsAt: '2026-08-14T06:00:00.000Z',
      blockStartsAt: '2026-08-13T22:00:00.000Z',
      blockEndsAt: '2026-08-14T06:00:00.000Z',
    });

    const wrapper = mount(CalendarGrid, {
      props: { ...gridProps, calendar: calendar({ bookings: [overnight] }) },
    });

    // Pinned to the top of the day rather than given a negative offset, which would place
    // it above the grid and out of view.
    expect(wrapper.get('[data-test=slot]').attributes('data-local-start')).toBe('00:00');
  });
});
