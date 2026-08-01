import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import SfAlert from './SfAlert.vue';
import SfBadge from './SfBadge.vue';
import SfButton from './SfButton.vue';
import SfIcon from './SfIcon.vue';
import SfInput from './SfInput.vue';
import SfModal from './SfModal.vue';
import SfSelect from './SfSelect.vue';
import SfSkeleton from './SfSkeleton.vue';
import SfSpinner from './SfSpinner.vue';
import SfTextarea from './SfTextarea.vue';

describe('SfButton', () => {
  it('renders a visible focus ring', () => {
    const wrapper = mount(SfButton, { slots: { default: 'Buchen' } });

    // A keyboard user's only indication of where they are.
    expect(wrapper.classes().join(' ')).toMatch(/focus-visible:ring/);
  });

  it('disables, shows a spinner and sets aria-busy while loading', () => {
    const wrapper = mount(SfButton, { props: { loading: true } });

    expect(wrapper.attributes('disabled')).toBeDefined();
    expect(wrapper.attributes('aria-busy')).toBe('true');
    expect(wrapper.findComponent(SfSpinner).exists()).toBe(true);
  });

  it('does not emit click while loading', async () => {
    const wrapper = mount(SfButton, { props: { loading: true } });
    await wrapper.trigger('click');

    // The idempotency key catches a double submit server-side, but a UI that fires twice is
    // still a UI that lies about what it did.
    expect(wrapper.emitted('click')).toBeUndefined();
  });

  it('does not emit click while disabled', async () => {
    const wrapper = mount(SfButton, { props: { disabled: true } });
    await wrapper.trigger('click');

    expect(wrapper.emitted('click')).toBeUndefined();
  });

  it('emits click when it is neither', async () => {
    const wrapper = mount(SfButton);
    await wrapper.trigger('click');

    expect(wrapper.emitted('click')).toHaveLength(1);
  });
});

describe('SfInput', () => {
  it('links its label to the field', () => {
    const wrapper = mount(SfInput, { props: { modelValue: '', label: 'E-Mail' } });

    expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('input').attributes('id'));
  });

  it('describes the field with its hint and its error, in that order', () => {
    const wrapper = mount(SfInput, {
      props: { modelValue: '', label: 'E-Mail', description: 'hint', error: 'wrong' },
    });

    const describedBy = wrapper.get('input').attributes('aria-describedby')?.split(' ') ?? [];
    const ids = wrapper.findAll('p').map((p) => p.attributes('id'));

    expect(describedBy).toEqual(ids);
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true');
  });

  it('sets no aria-invalid and no describedby when there is nothing to say', () => {
    const wrapper = mount(SfInput, { props: { modelValue: '', label: 'E-Mail' } });

    expect(wrapper.get('input').attributes('aria-invalid')).toBeUndefined();
    expect(wrapper.get('input').attributes('aria-describedby')).toBeUndefined();
  });

  it('emits the new value on input', async () => {
    const wrapper = mount(SfInput, { props: { modelValue: '', label: 'E-Mail' } });
    await wrapper.get('input').setValue('a@b.c');

    expect(wrapper.emitted('update:modelValue')).toEqual([['a@b.c']]);
  });
});

describe('SfTextarea', () => {
  it('announces the counter only when the limit is close', () => {
    const far = mount(SfTextarea, {
      props: { modelValue: 'x', label: 'Notiz', maxlength: 500 },
    });
    const near = mount(SfTextarea, {
      props: { modelValue: 'x'.repeat(480), label: 'Notiz', maxlength: 500 },
    });

    // Announcing every keystroke makes the field unusable with a screen reader; announcing
    // nothing lets somebody discover the limit by being truncated.
    expect(far.get('[aria-live]').attributes('aria-live')).toBe('off');
    expect(near.get('[aria-live]').attributes('aria-live')).toBe('polite');
  });

  it('shows how many characters are left', () => {
    const wrapper = mount(SfTextarea, {
      props: { modelValue: 'abc', label: 'Notiz', maxlength: 500 },
    });

    expect(wrapper.get('[aria-live]').text()).toBe('497');
  });
});

describe('SfSelect', () => {
  it('links its label and emits the chosen value', async () => {
    const wrapper = mount(SfSelect, {
      props: {
        modelValue: 'a',
        label: 'Sprache',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    });

    expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('select').attributes('id'));

    await wrapper.get('select').setValue('b');
    expect(wrapper.emitted('update:modelValue')).toEqual([['b']]);
  });
});

describe('SfIcon', () => {
  it('is hidden from assistive technology when it is decoration', () => {
    const wrapper = mount(SfIcon, { props: { name: 'calendar' } });

    expect(wrapper.attributes('aria-hidden')).toBe('true');
    expect(wrapper.attributes('role')).toBeUndefined();
  });

  it('becomes an image with a name when it carries meaning', () => {
    const wrapper = mount(SfIcon, { props: { name: 'check', label: 'Bestätigt' } });

    expect(wrapper.attributes('role')).toBe('img');
    expect(wrapper.attributes('aria-label')).toBe('Bestätigt');
    expect(wrapper.attributes('aria-hidden')).toBeUndefined();
  });

  it('renders the path from the curated set', () => {
    const wrapper = mount(SfIcon, { props: { name: 'whatsapp' } });

    expect(wrapper.get('path').attributes('d')?.length).toBeGreaterThan(50);
  });
});

describe('SfSpinner', () => {
  it('says what it is doing', () => {
    const wrapper = mount(SfSpinner, { props: { label: 'Slots werden geladen' } });

    expect(wrapper.attributes('role')).toBe('status');
    expect(wrapper.get('.sr-only').text()).toBe('Slots werden geladen');
  });
});

describe('SfAlert', () => {
  it('interrupts for a failure and stays polite for a confirmation', () => {
    const danger = mount(SfAlert, { props: { tone: 'danger' } });
    const success = mount(SfAlert, { props: { tone: 'success' } });

    // `alert` interrupts a screen reader immediately: right for a failure, rude for a
    // confirmation.
    expect(danger.attributes('role')).toBe('alert');
    expect(danger.attributes('aria-live')).toBe('assertive');
    expect(success.attributes('role')).toBe('status');
    expect(success.attributes('aria-live')).toBe('polite');
  });
});

describe('SfBadge and SfSkeleton', () => {
  it('never carries meaning in colour alone', () => {
    const wrapper = mount(SfBadge, { props: { tone: 'danger' }, slots: { default: 'Storniert' } });

    // Survives greyscale, colour blindness and a screen reader.
    expect(wrapper.text()).toBe('Storniert');
  });

  it('hides the loading placeholder from assistive technology', () => {
    const wrapper = mount(SfSkeleton, { props: { lines: 2 } });

    expect(wrapper.attributes('aria-hidden')).toBe('true');
  });
});

/** The modal teleports to `body`, so its element is not inside the wrapper's tree. */
function dialog(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (element === null) throw new Error('the dialog is not open');
  return element;
}

describe('SfModal', () => {
  it('is a labelled modal dialog', () => {
    const wrapper = mount(SfModal, {
      props: { open: true, title: 'Termin stornieren?' },
      attachTo: document.body,
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(
      document.body.querySelector('h2')?.id ?? null,
    );

    wrapper.unmount();
  });

  it('closes on Escape', () => {
    const wrapper = mount(SfModal, {
      props: { open: true, title: 'x' },
      attachTo: document.body,
    });

    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    wrapper.unmount();
  });

  it('wraps Tab from the last control back to the first', async () => {
    const wrapper = mount(SfModal, {
      props: { open: true, title: 'x' },
      attachTo: document.body,
    });

    const buttons = [...document.body.querySelectorAll('button')];
    const last = buttons.at(-1);
    last?.focus();

    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await nextTick();

    // Without the wrap, Tab walks into the page behind the overlay, which a keyboard user
    // cannot escape.
    expect(document.activeElement).toBe(buttons[0]);

    wrapper.unmount();
  });

  it('restores focus to whatever opened it', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const wrapper = mount(SfModal, {
      props: { open: false, title: 'x' },
      attachTo: document.body,
    });

    await wrapper.setProps({ open: true });
    // The watcher focuses after a tick, so the assertion has to wait for it too.
    await flushPromises();
    expect(document.activeElement).not.toBe(trigger);

    await wrapper.setProps({ open: false });
    await flushPromises();
    expect(document.activeElement).toBe(trigger);

    wrapper.unmount();
    trigger.remove();
  });

  it('emits confirm from the confirm button', () => {
    const wrapper = mount(SfModal, {
      props: { open: true, title: 'x', confirmLabel: 'Ja' },
      attachTo: document.body,
    });

    const confirm = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Ja',
    );
    confirm?.click();

    expect(wrapper.emitted('confirm')).toHaveLength(1);

    wrapper.unmount();
  });
});
