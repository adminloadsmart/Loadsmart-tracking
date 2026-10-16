import type { Socket } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { extractHandshakeToken } from './handshake-token';

function handshake(parts: {
  auth?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}): Socket['handshake'] {
  return { auth: {}, query: {}, headers: {}, ...parts } as unknown as Socket['handshake'];
}

describe('extractHandshakeToken', () => {
  it('reads the token from auth, query or the Authorization header', () => {
    expect(extractHandshakeToken(handshake({ auth: { token: 'a' } }))).toBe('a');
    expect(extractHandshakeToken(handshake({ query: { token: 'q' } }))).toBe('q');
    expect(extractHandshakeToken(handshake({ headers: { authorization: 'Bearer h' } }))).toBe('h');
  });

  it('prefers auth, then query, then the header', () => {
    const all = {
      auth: { token: 'a' },
      query: { token: 'q' },
      headers: { authorization: 'Bearer h' },
    };
    expect(extractHandshakeToken(handshake(all))).toBe('a');
    expect(extractHandshakeToken(handshake({ ...all, auth: {} }))).toBe('q');
    expect(extractHandshakeToken(handshake({ ...all, auth: {}, query: {} }))).toBe('h');
  });

  it('strips a Bearer prefix from any source', () => {
    expect(extractHandshakeToken(handshake({ auth: { token: 'bearer a' } }))).toBe('a');
    expect(extractHandshakeToken(handshake({ query: { token: 'Bearer q' } }))).toBe('q');
  });

  it('skips empty and non-string values', () => {
    expect(extractHandshakeToken(handshake({}))).toBeNull();
    expect(extractHandshakeToken(handshake({ auth: { token: 42 } }))).toBeNull();
    expect(extractHandshakeToken(handshake({ query: { token: ['x', 'y'] } }))).toBeNull();
    expect(extractHandshakeToken(handshake({ headers: { authorization: 'Bearer ' } }))).toBeNull();
    expect(
      extractHandshakeToken(
        handshake({ auth: { token: '' }, headers: { authorization: 'Bearer h' } }),
      ),
    ).toBe('h');
  });
});
