import { describe, expect, it } from 'vitest';
import { parseRoles, ROLES } from './roles';

describe('parseRoles', () => {
  it('expands "all" to every role in start order', () => {
    expect(parseRoles('all')).toEqual([...ROLES]);
  });

  it('returns a subset in canonical start order regardless of input order, trimming and lowercasing', () => {
    expect(parseRoles(' API , processor')).toEqual(['processor', 'api']);
  });

  it('dedupes repeated roles', () => {
    expect(parseRoles('api,api')).toEqual(['api']);
  });

  it('rejects unknown roles', () => {
    expect(() => parseRoles('api,tcp-intake')).toThrow(/tcp-intake/);
  });

  it('rejects empty and "all" mixed with others', () => {
    expect(() => parseRoles(' , ')).toThrow(/empty/);
    expect(() => parseRoles('all,api')).toThrow(/cannot be combined/);
  });
});
