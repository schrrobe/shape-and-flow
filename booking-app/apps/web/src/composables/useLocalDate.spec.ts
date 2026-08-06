import { describe, expect, it } from 'vitest';

import { addMonths } from './useLocalDate.js';

describe('addMonths', () => {
  it('clamps into February when the anchor day does not exist there', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2024-01-30', 1)).toBe('2024-02-29');
    expect(addMonths('2024-01-29', 1)).toBe('2024-02-29');
  });

  it('clamps to Feb 28 in a non-leap year', () => {
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
  });

  it('does not clamp when the target month has enough days', () => {
    expect(addMonths('2024-01-15', 1)).toBe('2024-02-15');
    expect(addMonths('2024-01-31', 2)).toBe('2024-03-31');
  });
});
