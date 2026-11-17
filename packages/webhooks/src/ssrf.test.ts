import { describe, expect, it } from 'vitest';
import { isPrivateAddress, parseIPv4, parseIPv6, validateWebhookUrl } from './index.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2002:c0a8:0101::1',
    '2001:db8::1',
    'ff02::1',
    '[::1]',
    'fe80::1%eth0',
  ])('treats %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('treats %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('throws on non-IP input', () => {
    expect(() => isPrivateAddress('example.com')).toThrow(TypeError);
  });
});

describe('parseIPv4', () => {
  it('understands decimal, hex, octal and short forms', () => {
    expect(parseIPv4('2130706433')).toBe(0x7f000001);
    expect(parseIPv4('0x7f000001')).toBe(0x7f000001);
    expect(parseIPv4('0177.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4('127.1')).toBe(0x7f000001);
    expect(parseIPv4('256.0.0.1')).toBeNull();
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
    expect(parseIPv4('a.b.c.d')).toBeNull();
  });
});

describe('parseIPv6', () => {
  it('expands :: and rejects malformed literals', () => {
    expect(parseIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('12345::1')).toBeNull();
    expect(parseIPv6('1.2.3.4')).toBeNull();
  });
});

describe('validateWebhookUrl', () => {
  it('accepts a public https URL', () => {
    const result = validateWebhookUrl('https://hooks.example.com/codai');
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not a url', 'invalid_url'],
    ['http://example.com/x', 'scheme_not_allowed'],
    ['ftp://example.com/x', 'scheme_not_allowed'],
    ['https://user:pw@example.com/', 'credentials_in_url'],
    ['https://127.0.0.1/', 'private_address'],
    ['https://2130706433/', 'private_address'],
    ['https://0x7f.1/', 'private_address'],
    ['https://0177.0.0.1/', 'private_address'],
    ['https://[::1]/', 'private_address'],
    ['https://[::ffff:169.254.169.254]/', 'private_address'],
    ['https://169.254.169.254/latest/meta-data', 'private_address'],
    ['https://localhost/', 'blocked_hostname'],
    ['https://api.localhost/', 'blocked_hostname'],
    ['https://printer.local/', 'blocked_hostname'],
    ['https://db.internal/', 'blocked_hostname'],
    ['https://metadata.google.internal/', 'blocked_hostname'],
    ['https://metadata/', 'blocked_hostname'],
    ['https://intranet/', 'blocked_hostname'],
  ])('rejects %s (%s)', (url, reason) => {
    expect(validateWebhookUrl(url)).toEqual({ ok: false, reason });
  });

  it('allows http and private targets only when opted in', () => {
    expect(validateWebhookUrl('http://example.com/', { allowHttp: true }).ok).toBe(true);
    expect(
      validateWebhookUrl('http://localhost:3000/', { allowHttp: true, allowPrivate: true }).ok,
    ).toBe(true);
    expect(validateWebhookUrl('https://8.8.8.8/').ok).toBe(true);
  });
});
