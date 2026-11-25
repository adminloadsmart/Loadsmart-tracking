import { describe, expect, it } from 'vitest';
import { isValidVehicleNumber } from './vehicle-number';

describe('isValidVehicleNumber', () => {
  it('accepts state-series and BH-series registrations', () => {
    for (const n of [
      'PB65RF6106',
      'DL1CAB1234',
      'HR84A4138',
      'MH120001',
      'KA01AB0001',
      '22BH1234AA',
    ])
      expect(isValidVehicleNumber(n), n).toBe(true);
  });

  it('refuses unknown state codes, a zero RTO and malformed numbers', () => {
    for (const n of [
      'GH12GH1233',
      'PB00AB1234',
      'PB65RF610',
      'PB65RFXY6106',
      'PB65RF61066',
      '1234',
      'N-L1',
    ])
      expect(isValidVehicleNumber(n), n).toBe(false);
  });
});
