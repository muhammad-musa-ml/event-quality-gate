import { describe, expect, it } from 'vitest';
import { detectPii } from '../src/pii.js';

describe('detectPii: email shapes', () => {
  const emails = [
    'jane.doe@example.com',
    'a@b.co',
    'first+tag@mail.example.org',
    'x_y-z@sub.domain.example.net',
    'write to jane.doe@example.com for access',
    'JANE@EXAMPLE.COM',
  ];
  for (const value of emails) {
    it(`flags ${value}`, () => expect(detectPii(value)).toBe('email'));
  }
});

describe('detectPii: phone shapes', () => {
  const phones = [
    '(555) 010-0199',
    '555-010-0199',
    '555.010.0199',
    '555 010 0199',
    '+1 555 010 0199',
    '+44 20 7946 0958',
    '+15550100199',
    'call me on 555-010-0199 tonight',
  ];
  for (const value of phones) {
    it(`flags ${value}`, () => expect(detectPii(value)).toBe('phone'));
  }
});

describe('detectPii: values that are not flagged', () => {
  const clean = [
    '',
    'email',
    'user@',
    '@handle',
    'a@b',
    '123e4567-e89b-12d3-a456-426614174000',
    '2026-11-02T10:15:30Z',
    '2026-11-02',
    '1730000000000',
    '5550100199',
    '1.2.3',
    '$19.99',
    '10.0.0.1',
    '555-0199',
    'page 12 of 300',
    'workspace_8f31c2',
  ];
  for (const value of clean) {
    it(`does not flag ${JSON.stringify(value)}`, () => expect(detectPii(value)).toBeNull());
  }

  it('does not match inside a longer digit run', () => {
    expect(detectPii('1555010019912')).toBeNull();
    expect(detectPii('9555-010-01990')).toBeNull();
  });
});
