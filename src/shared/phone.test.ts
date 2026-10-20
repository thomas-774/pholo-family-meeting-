import { describe, expect, it } from 'vitest';
import { cleanText, normalizePhone, validateRegistration } from './phone';

describe('normalizePhone', () => {
  it.each([
    ['01001234567', '01001234567'],
    ['+20 100 123 4567', '01001234567'],
    ['0020 100 123 4567', '01001234567'],
    ['(010) 0123-4567', '01001234567'],
    ['٠١٠٠١٢٣٤٥٦٧', '01001234567'],
    ['\u200e+20 112 345 6789', '01123456789'],
  ])('%j → %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe('cleanText', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanText('  مينا \n  جرجس  ')).toBe('مينا جرجس');
  });
});

describe('validateRegistration', () => {
  const ok = { fullName: 'مينا جرجس', gender: 'male', phone: '01001234567', faculty: 'هندسة', university: 'القاهرة' };

  it('accepts a valid form', () => {
    expect(validateRegistration(ok)).toBeNull();
  });

  it('returns the first invalid field', () => {
    expect(validateRegistration({ ...ok, fullName: ' م ' })).toBe('full_name');
    expect(validateRegistration({ ...ok, gender: '' })).toBe('gender');
    expect(validateRegistration({ ...ok, gender: 'other' })).toBe('gender');
    expect(validateRegistration({ ...ok, phone: '01312345678' })).toBe('phone');
    expect(validateRegistration({ ...ok, phone: '0100123456' })).toBe('phone');
    expect(validateRegistration({ ...ok, faculty: '  ' })).toBe('faculty');
    expect(validateRegistration({ ...ok, university: 'x'.repeat(101) })).toBe('university');
  });
});
