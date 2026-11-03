export type PiiShape = 'email' | 'phone';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

// Phone shapes: an international number written with a leading "+", or a North American number
// written as three digit groups (3-3-4) split by a space, dot or dash, with optional parentheses
// around the area code. Bare digit runs are not matched: they look the same as numeric ids.
const PHONE_INTL = /(?<![\d.+])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?!\d)/;
const PHONE_NANP = /(?<![\d.])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\d])/;

/** Returns the PII shape a string value looks like, or null. A shape match is a hint, not proof. */
export function detectPii(value: string): PiiShape | null {
  if (EMAIL.test(value)) return 'email';
  if (PHONE_INTL.test(value) || PHONE_NANP.test(value)) return 'phone';
  return null;
}
