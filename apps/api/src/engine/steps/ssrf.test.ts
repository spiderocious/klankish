import { describe, expect, it } from 'vitest';

import { isBlockedAddress } from './http.js';

/**
 * SSRF address rules.
 *
 * A unit test rather than part of the executor integration suite, and deliberately so: that suite
 * sets HTTP_STEP_ALLOW_PRIVATE=true in order to reach its own 127.0.0.1 test server, which would
 * disable the very guard being tested. Asserting the rules directly means the coverage cannot be
 * accidentally switched off by an environment variable.
 *
 * The `http` step fetches a USER-SUPPLIED URL from inside our network. Without these rules, any
 * user could read the cloud metadata endpoint and walk off with the instance's credentials.
 */

describe('blocked addresses', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback range, not just .0.1'],
    ['10.0.0.1', 'private class A'],
    ['10.255.255.255', 'private class A upper bound'],
    ['172.16.0.1', 'private class B lower bound'],
    ['172.31.255.255', 'private class B upper bound'],
    ['192.168.1.1', 'private class C'],
    ['169.254.169.254', 'CLOUD METADATA — the one that matters most'],
    ['169.254.0.1', 'link-local'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 'public DNS'],
    ['1.1.1.1', 'public DNS'],
    ['93.184.216.34', 'example.com'],
    ['172.15.255.255', 'just BELOW the private class B range'],
    ['172.32.0.1', 'just ABOVE the private class B range'],
    ['11.0.0.1', 'just above private class A'],
    ['192.167.255.255', 'just below 192.168/16'],
    ['126.255.255.255', 'just below loopback'],
    ['128.0.0.1', 'just above loopback'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('IPv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 addresses', () => {
    // The bypass this closes: ::ffff:169.254.169.254 reaches cloud metadata while looking like an
    // IPv6 address, so it slips straight past a v4-only check.
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows a public IPv4-mapped address', () => {
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isBlockedAddress('FE80::1')).toBe(true);
    expect(isBlockedAddress('FC00::1')).toBe(true);
  });
});
