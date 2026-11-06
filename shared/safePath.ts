/** A same-site path to return to after sign-in: one leading slash, no second slash or backslash (browsers read "/\" as "//"), no control characters. */
export function safeReturnPath(value: string | null | undefined, fallback: string): string {
  const v = value ?? '';
  if (!v.startsWith('/') || v[1] === '/' || v[1] === String.fromCharCode(92)) return fallback;
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 127 || c === 92) return fallback;
  }
  return v;
}
