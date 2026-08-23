import { describe, expect, it } from 'vitest';

import { canonicalRemoteUrl, exactRemoteOriginPattern, isExactRemoteOriginPattern, isPlainHttpUrl, isSafeRemoteUrl } from './remoteUrl';

describe('remote URL safety', () => {
  it('accepts credential-free HTTP and HTTPS URLs, including non-default ports', () => {
    expect(isSafeRemoteUrl('https://dav.example.test:8443/photos/a')).toBe(true);
    expect(isSafeRemoteUrl('http://192.168.1.8:5005/photos/')).toBe(true);
    expect(isSafeRemoteUrl(new URL('http://nas.local/photos/'))).toBe(true);
    expect(canonicalRemoteUrl('http://nas.local/photos')).toBe('http://nas.local/photos');
    expect(exactRemoteOriginPattern('http://192.168.1.8:5005/photos/a')).toBe('http://192.168.1.8:5005/*');
    expect(exactRemoteOriginPattern('https://dav.example.test:8443/photos/a')).toBe('https://dav.example.test:8443/*');
    expect(isExactRemoteOriginPattern('http://nas.local/*')).toBe(true);
    expect(isExactRemoteOriginPattern('https://images.example.test/*')).toBe(true);
  });

  it('rejects credentials, non-http(s) schemes, and non-origin permission patterns', () => {
    expect(isSafeRemoteUrl('https://ada:secret@dav.example.test/photos')).toBe(false);
    expect(isSafeRemoteUrl('ftp://dav.example.test/photos')).toBe(false);
    expect(canonicalRemoteUrl('javascript:alert(1)')).toBeUndefined();
    expect(exactRemoteOriginPattern('https://ada:secret@dav.example.test/photos')).toBeUndefined();
    expect(isExactRemoteOriginPattern('https://images.example.test/path/*')).toBe(false);
    expect(isExactRemoteOriginPattern('ftp://files.example.test/*')).toBe(false);
    expect(isExactRemoteOriginPattern('http://user:secret@nas.local/*')).toBe(false);
  });

  it('detects plain HTTP URLs for credential warnings', () => {
    expect(isPlainHttpUrl('http://nas.local/photos/')).toBe(true);
    expect(isPlainHttpUrl('  HTTP://NAS.LOCAL/photos/  ')).toBe(true);
    expect(isPlainHttpUrl('https://dav.example/photos/')).toBe(false);
    expect(isPlainHttpUrl('not a url')).toBe(false);
  });
});
