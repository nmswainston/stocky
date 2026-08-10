import { describe, expect, it } from 'vitest';
import { bar } from './testing/fixtures.js';
import { createBarWindow } from './window.js';

const bars = [bar(0, '100', '101'), bar(1, '101', '102'), bar(2, '102', '103')];

describe('BarWindow', () => {
  it('exposes exactly the bars up to its limit', () => {
    const window = createBarWindow(bars, 2);
    expect(window.length).toBe(2);
    expect(window.at(1)).toBe(bars[1]);
    expect(window.last).toBe(bars[1]);
    expect(window.lastN(2).map((b) => b.close)).toEqual(['101', '102']);
  });

  it('throws on any access past the limit, so the future is unreachable', () => {
    const window = createBarWindow(bars, 2);
    expect(() => window.at(2)).toThrow(RangeError);
    expect(() => window.at(-1)).toThrow(RangeError);
    expect(() => window.lastN(3)).toThrow(RangeError);
  });

  it('a stashed window keeps its old limit even as the engine moves on', () => {
    const stale = createBarWindow(bars, 1);
    createBarWindow(bars, 3);
    expect(stale.length).toBe(1);
    expect(() => stale.at(1)).toThrow(RangeError);
    expect(stale.last.close).toBe('101');
  });
});
