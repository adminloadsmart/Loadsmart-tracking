import { describe, expect, it } from 'vitest';
import { lateNoticeDue } from './delay';

describe('lateNoticeDue (LS_N_0030)', () => {
  const none = { lateConsec: 0, lateNotifiedMin: 0 };

  it('needs the limit crossed on consecutive evaluations', () => {
    const first = lateNoticeDue(none, 1500, 1440, 2);
    expect(first).toEqual({ lateConsec: 1, due: false });
    expect(lateNoticeDue({ ...none, lateConsec: 1 }, 1500, 1440, 2).due).toBe(true);
    expect(lateNoticeDue({ ...none, lateConsec: 1 }, 1400, 1440, 2)).toEqual({
      lateConsec: 0,
      due: false,
    });
  });

  it('after a notice, only again once the delay has doubled', () => {
    const sent = { lateConsec: 5, lateNotifiedMin: 1500 };
    expect(lateNoticeDue(sent, 2900, 1440, 2).due).toBe(false);
    expect(lateNoticeDue(sent, 3000, 1440, 2).due).toBe(true);
  });
});
