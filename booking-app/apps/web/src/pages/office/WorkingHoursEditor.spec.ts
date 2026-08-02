import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import WorkingHoursEditor from './WorkingHoursEditor.vue';

import type { ReplaceWorkingHoursRequest, Weekday } from '@shape-and-flow/booking-contracts';

type Wrapper = ReturnType<typeof mount<typeof WorkingHoursEditor>>;

function seg(weekday: Weekday, startMinute: number, endMinute: number) {
  return { weekday, startMinute, endMinute, breaks: [] };
}

/** Add a shift and fill it in, the way an operator would. */
async function addSegment(
  wrapper: Wrapper,
  input: { weekday: Weekday; start: string; end: string },
): Promise<void> {
  await wrapper.get('[data-test=add-segment]').trigger('click');

  const index = wrapper.findAll('[data-test^=start-]').length - 1;
  await wrapper.get(`[data-test=weekday-${String(index)}]`).setValue(input.weekday);
  await wrapper.get(`[data-test=start-${String(index)}]`).setValue(input.start);
  await wrapper.get(`[data-test=end-${String(index)}]`).setValue(input.end);
}

async function addBreak(
  wrapper: Wrapper,
  segmentIndex: number,
  input: { start: string; end: string },
): Promise<void> {
  await wrapper.get(`[data-test=add-break-${String(segmentIndex)}]`).trigger('click');

  const breakIndex =
    wrapper.findAll(`[data-test^=break-start-${String(segmentIndex)}-]`).length - 1;
  await wrapper
    .get(`[data-test=break-start-${String(segmentIndex)}-${String(breakIndex)}]`)
    .setValue(input.start);
  await wrapper
    .get(`[data-test=break-end-${String(segmentIndex)}-${String(breakIndex)}]`)
    .setValue(input.end);
}

function savedBody(wrapper: Wrapper): ReplaceWorkingHoursRequest {
  const emitted = wrapper.emitted('save');
  if (emitted === undefined) throw new Error('nothing was saved');

  return emitted[0]?.[0] as ReplaceWorkingHoursRequest;
}

describe('WorkingHoursEditor', () => {
  it('edits in local time and submits minutes from midnight', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [] } });

    await addSegment(wrapper, { weekday: 'MONDAY', start: '09:00', end: '18:00' });
    await wrapper.get('[data-test=save]').trigger('click');

    expect(savedBody(wrapper)).toMatchObject({
      segments: [{ weekday: 'MONDAY', startMinute: 540, endMinute: 1080, breaks: [] }],
    });
  });

  it('flags an overlap before submitting, so the round trip is not the first feedback', async () => {
    const wrapper = mount(WorkingHoursEditor, {
      props: { segments: [seg('MONDAY', 540, 720)] },
    });

    await addSegment(wrapper, { weekday: 'MONDAY', start: '11:00', end: '14:00' });

    expect(wrapper.text()).toMatch(/overlap/i);
    expect(wrapper.get('[data-test=save]').attributes('disabled')).toBeDefined();
  });

  it('allows two shifts on one day that do not overlap', async () => {
    const wrapper = mount(WorkingHoursEditor, {
      props: { segments: [seg('MONDAY', 540, 720)] },
    });

    // Split shifts are ordinary — a studio that closes over lunch and reopens.
    await addSegment(wrapper, { weekday: 'MONDAY', start: '14:00', end: '18:00' });

    expect(wrapper.find('[data-test=problems]').exists()).toBe(false);
  });

  it('flags a break outside its segment', async () => {
    const wrapper = mount(WorkingHoursEditor, {
      props: { segments: [seg('MONDAY', 540, 720)] },
    });

    await addBreak(wrapper, 0, { start: '13:00', end: '13:30' });

    expect(wrapper.text()).toMatch(/inside/i);
    expect(wrapper.get('[data-test=save]').attributes('disabled')).toBeDefined();
  });

  it('flags an end before its start', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [] } });

    await addSegment(wrapper, { weekday: 'TUESDAY', start: '18:00', end: '09:00' });

    expect(wrapper.get('[data-test=save]').attributes('disabled')).toBeDefined();
  });

  it('refuses a time that is not a time', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [] } });

    await addSegment(wrapper, { weekday: 'MONDAY', start: 'nine', end: '18:00' });

    expect(wrapper.get('[data-test=save]').attributes('disabled')).toBeDefined();
  });

  it('supports 24:00 as the end of a segment', async () => {
    const wrapper = mount(WorkingHoursEditor, { props: { segments: [] } });

    await addSegment(wrapper, { weekday: 'FRIDAY', start: '20:00', end: '24:00' });
    await wrapper.get('[data-test=save]').trigger('click');

    // 1440 is legal and means the next midnight. `00:00` would read as the shift starting.
    expect(savedBody(wrapper).segments[0]?.endMinute).toBe(1440);
  });

  it('renders the conflicting bookings the server reports after a save', () => {
    const wrapper = mount(WorkingHoursEditor, {
      props: {
        segments: [],
        conflicts: [
          {
            id: 'cka00000000000000000booking',
            reference: 'SF-ABC123',
            startsAt: '2026-08-17T07:00:00.000Z',
            endsAt: '2026-08-17T07:30:00.000Z',
            customerName: 'Anna Becker',
            serviceName: 'Facial Massage 30',
          },
        ],
      },
    });

    expect(wrapper.get('[data-test=conflicts]').text()).toContain('SF-');
    expect(wrapper.get('[data-test=conflicts]').text()).toContain('Anna Becker');
  });

  it('shows the stored week when it arrives', () => {
    const wrapper = mount(WorkingHoursEditor, {
      props: {
        segments: [
          {
            weekday: 'MONDAY',
            startMinute: 540,
            endMinute: 1080,
            breaks: [{ startMinute: 720, endMinute: 750, label: 'Lunch' }],
          },
        ],
      },
    });

    expect((wrapper.get('[data-test=start-0]').element as HTMLInputElement).value).toBe('09:00');
    expect((wrapper.get('[data-test=break-start-0-0]').element as HTMLInputElement).value).toBe(
      '12:00',
    );
  });

  it('submits an empty week, which is how a shift is removed', async () => {
    const wrapper = mount(WorkingHoursEditor, {
      props: { segments: [seg('MONDAY', 540, 1080)] },
    });

    await wrapper.get('[data-test=remove-segment-0]').trigger('click');
    await wrapper.get('[data-test=save]').trigger('click');

    expect(savedBody(wrapper).segments).toEqual([]);
  });
});
