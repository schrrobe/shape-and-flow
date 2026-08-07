import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, readonly, ref } from 'vue';

import { FEATURE_FLAG_CLIENT, type FeatureFlagClient } from '../feature-flags/client.js';

import { useFeatureFlag } from './useFeatureFlag.js';

const Consumer = defineComponent({
  props: {
    fallback: { type: Boolean, default: false },
  },
  setup(props) {
    const enabled = useFeatureFlag('booking.new-flow', props.fallback);
    return () => h('span', String(enabled.value));
  },
});

describe('useFeatureFlag', () => {
  it('returns the fallback before readiness and recomputes after an update', async () => {
    const ready = ref(false);
    const version = ref(0);
    const isEnabled = vi.fn().mockReturnValue(true);
    const client: FeatureFlagClient = {
      ready: readonly(ready),
      version: readonly(version),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      isEnabled,
    };
    const wrapper = mount(Consumer, {
      global: { provide: { [FEATURE_FLAG_CLIENT as symbol]: client } },
    });

    expect(wrapper.text()).toBe('false');
    expect(isEnabled).not.toHaveBeenCalled();

    ready.value = true;
    version.value += 1;
    await nextTick();

    expect(wrapper.text()).toBe('true');
    expect(isEnabled).toHaveBeenCalledWith('booking.new-flow', false);
  });

  it('falls back when no feature-flag client was provided', () => {
    expect(mount(Consumer, { props: { fallback: true } }).text()).toBe('true');
  });
});
