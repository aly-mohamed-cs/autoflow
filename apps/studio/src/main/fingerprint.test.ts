import { createHash, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chromiumFingerprint } from './fingerprint';

describe('chromiumFingerprint', () => {
  it('converts Node hex fingerprints to the Chromium sha256/base64 form', () => {
    const der = Buffer.from('any certificate bytes');
    const hex = createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
    expect(chromiumFingerprint(hex)).toBe(`sha256/${createHash('sha256').update(der).digest('base64')}`);
    expect(X509Certificate).toBeDefined();
  });
});
