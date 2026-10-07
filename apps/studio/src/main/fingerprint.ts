/** Chromium reports certificate fingerprints as "sha256/<base64>"; Studio pins Node's "AB:CD:..." form. */
export function chromiumFingerprint(hexWithColons: string): string {
  return `sha256/${Buffer.from(hexWithColons.replace(/:/g, ''), 'hex').toString('base64')}`;
}
