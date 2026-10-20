// Browser-side validation. Mirrors private.clean_text / private.normalize_phone
// in supabase/migrations/002_functions.sql — the database result is the one that counts.

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export const PHONE_PATTERN = /^01[0125]\d{8}$/;

export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizePhone(value: string): string {
  let v = '';
  for (const ch of value) {
    const a = ARABIC_DIGITS.indexOf(ch);
    const p = PERSIAN_DIGITS.indexOf(ch);
    v += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
  }
  v = v.replace(/[\s()‎‏‪-‮⁦-⁩-]/g, '');
  if (v.startsWith('+20')) return '0' + v.slice(3);
  if (v.startsWith('0020')) return '0' + v.slice(4);
  return v;
}

export function isValidPhone(normalized: string): boolean {
  return PHONE_PATTERN.test(normalized);
}

export type Field = 'full_name' | 'gender' | 'phone' | 'faculty' | 'university';

export type Gender = 'male' | 'female';

export const GENDER_LABEL: Record<Gender, string> = { male: 'ولاد', female: 'بنات' };

export interface RegistrationInput {
  fullName: string;
  gender: string;
  phone: string;
  faculty: string;
  university: string;
}

/** Returns the first invalid field, or null. Limits match §5 of the plan. */
export function validateRegistration(input: RegistrationInput): Field | null {
  const name = cleanText(input.fullName);
  if (name.length < 2 || name.length > 100) return 'full_name';
  if (input.gender !== 'male' && input.gender !== 'female') return 'gender';
  if (!isValidPhone(normalizePhone(input.phone))) return 'phone';
  const faculty = cleanText(input.faculty);
  if (faculty.length < 1 || faculty.length > 100) return 'faculty';
  const university = cleanText(input.university);
  if (university.length < 1 || university.length > 100) return 'university';
  return null;
}
