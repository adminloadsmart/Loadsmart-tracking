import { describe, expect, it } from 'vitest';
import { signalLossStep } from './signal-loss.monitor';

const H = 60 * 60_000;

describe('signalLossStep (LS_N_0029)', () => {
  it('4 h, 12 h, then once a day', () => {
    expect(signalLossStep(3.9 * H)).toBeNull();
    expect(signalLossStep(4 * H)).toBe('4h');
    expect(signalLossStep(11.9 * H)).toBe('4h');
    expect(signalLossStep(12 * H)).toBe('12h');
    expect(signalLossStep(35 * H)).toBe('12h');
    expect(signalLossStep(36 * H)).toBe('day_1');
    expect(signalLossStep(60 * H)).toBe('day_2');
  });
});
