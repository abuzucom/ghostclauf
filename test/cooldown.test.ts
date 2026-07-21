import { describe, expect, it } from 'vitest';
import { CooldownGate } from '../src/core/cooldown.js';

describe('CooldownGate', () => {
  it('lets the first invocation through and throttles repeats in the window', () => {
    const gate = new CooldownGate(10_000);
    expect(gate.shouldThrottle('a', 0)).toBe(false);
    expect(gate.shouldThrottle('a', 5_000)).toBe(true);
    expect(gate.shouldThrottle('a', 9_999)).toBe(true);
  });

  it('allows again once the window has elapsed', () => {
    const gate = new CooldownGate(10_000);
    expect(gate.shouldThrottle('a', 0)).toBe(false);
    expect(gate.shouldThrottle('a', 10_000)).toBe(false);
  });

  it('tracks keys independently', () => {
    const gate = new CooldownGate(10_000);
    expect(gate.shouldThrottle('a', 0)).toBe(false);
    expect(gate.shouldThrottle('b', 1)).toBe(false);
    expect(gate.shouldThrottle('a', 2)).toBe(true);
  });

  it('never throttles when the cooldown is zero', () => {
    const gate = new CooldownGate(0);
    expect(gate.shouldThrottle('a', 0)).toBe(false);
    expect(gate.shouldThrottle('a', 0)).toBe(false);
  });

  it('prunes expired entries when the map hits the entry limit', () => {
    const gate = new CooldownGate(1_000, 2);
    expect(gate.shouldThrottle('a', 0)).toBe(false);
    expect(gate.shouldThrottle('b', 1)).toBe(false);
    // 'a' and 'b' are both expired at t=5000; inserting 'c' prunes them.
    expect(gate.shouldThrottle('c', 5_000)).toBe(false);
    expect(gate.size).toBe(1);
  });
});
