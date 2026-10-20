// Checks against a REAL Supabase project (plan §12) — use the TEST project only.
//
//   Security (read-only, safe anywhere):
//     node supabase/tests/remote-checks.mjs security
//   Concurrency (writes ~300 rows; needs an EMPTY test project — see README "Resetting the test project"):
//     node supabase/tests/remote-checks.mjs concurrency --test-project
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY
//      ADMIN_EMAIL, ADMIN_PASSWORD          (an account listed in private.admins)
//      NONADMIN_EMAIL, NONADMIN_PASSWORD    (optional: an account NOT in private.admins)
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL, ADMIN_PASSWORD, NONADMIN_EMAIL, NONADMIN_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY');
  process.exit(2);
}

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const anonHeaders = {
  apikey: SUPABASE_ANON_KEY,
  'Content-Type': 'application/json',
  ...(SUPABASE_ANON_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } : {}),
};

const rest = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...anonHeaders, ...init.headers } });

async function client(email, password) {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return c;
}

async function security() {
  for (const table of ['registrations', 'settings', 'admins', 'rate_limits']) {
    const res = await rest(`${table}?select=*`);
    check(!res.ok, `anon cannot read ${table} via public schema`, `HTTP ${res.status}`);
    const res2 = await rest(`${table}?select=*`, { headers: { 'Accept-Profile': 'private' } });
    check(!res2.ok, `anon cannot read private.${table}`, `HTTP ${res2.status}`);
  }
  const ins = await rest('registrations', {
    method: 'POST',
    headers: { 'Content-Profile': 'private' },
    body: JSON.stringify({ full_name: 'x' }),
  });
  check(!ins.ok, 'anon cannot insert into private.registrations', `HTTP ${ins.status}`);

  for (const fn of ['admin_dashboard', 'set_capacity']) {
    const body = fn === 'set_capacity' ? { p_gender: 'male', p_new_capacity: 1000 } : {};
    const res = await rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });
    check(!res.ok, `anon cannot call ${fn}`, `HTTP ${res.status}`);
  }
  for (const fn of ['normalize_phone', 'new_token', 'assert_admin']) {
    const res = await rest(`rpc/${fn}`, { method: 'POST', body: '{}' });
    check(!res.ok, `private helper ${fn} is not callable`, `HTTP ${res.status}`);
  }

  const lookup = await rest('rpc/get_my_registration', { method: 'POST', body: JSON.stringify({ p_token: '0'.repeat(64) }) });
  check(lookup.ok && (await lookup.text()) === 'null', 'get_my_registration works for anon and returns null for unknown token');

  const signup = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: anonHeaders,
    body: JSON.stringify({ email: `probe-${Date.now()}@example.com`, password: 'Probe-password-123!' }),
  });
  check(!signup.ok, 'public sign-up is disabled', `HTTP ${signup.status}`);

  if (NONADMIN_EMAIL && NONADMIN_PASSWORD) {
    const c = await client(NONADMIN_EMAIL, NONADMIN_PASSWORD);
    const d = await c.rpc('admin_dashboard');
    check(!!d.error, 'logged-in non-admin cannot call admin_dashboard', d.error?.code);
    const s = await c.rpc('set_capacity', { p_gender: 'male', p_new_capacity: 1000 });
    check(!!s.error, 'logged-in non-admin cannot call set_capacity', s.error?.code);
  } else {
    console.log('SKIP  non-admin checks (set NONADMIN_EMAIL / NONADMIN_PASSWORD)');
  }
}

function phone(i) {
  return '015' + String(i).padStart(8, '0');
}

// Even i = boy, odd i = girl
const genderOf = (i) => (i % 2 === 0 ? 'male' : 'female');

function registerCall(i) {
  return rest('rpc/register_member', {
    method: 'POST',
    body: JSON.stringify({
      p_full_name: `اختبار ${i}`,
      p_phone: phone(i),
      p_faculty: 'هندسة',
      p_university: 'جامعة الاختبار',
      p_gender: genderOf(i),
      p_submission_id: randomUUID(),
      p_website: '',
    }),
  }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : await r.text() }));
}

async function concurrency() {
  if (!process.argv.includes('--test-project')) {
    console.error('Refusing to write: pass --test-project to confirm this is the TEST project.');
    process.exit(2);
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('Set ADMIN_EMAIL / ADMIN_PASSWORD (needed to verify results).');
    process.exit(2);
  }
  const admin = await client(ADMIN_EMAIL, ADMIN_PASSWORD);
  const before = await admin.rpc('admin_dashboard');
  if (before.error) throw new Error(before.error.message);
  const { male, female } = before.data;
  if (before.data.total !== 0 || male.capacity !== 100 || female.capacity !== 100) {
    console.error(`Test project must be empty with capacity 100 per gender (total=${before.data.total}, boys=${male.capacity}, girls=${female.capacity}).`);
    process.exit(2);
  }

  // 1. 250 registrations (125 boys, 125 girls) fired in parallel
  const results = await Promise.all(Array.from({ length: 250 }, (_, i) => registerCall(i)));
  const errors = results.filter((r) => r.status !== 200);
  check(errors.length === 0, '250 parallel register_member calls: no HTTP errors', errors[0] ? `${errors[0].status} ${errors[0].body}` : '');
  const rateLimited = results.filter((r) => r.body?.result === 'rate_limited').length;
  check(rateLimited === 0, 'no call was rate-limited (raise rate_limit_per_minute on the test project first)', `${rateLimited}`);

  for (const g of ['male', 'female']) {
    const mine = results.filter((r) => r.body?.gender === g);
    const numbers = mine.map((r) => r.body.attendanceNumber).filter((n) => n != null).sort((a, b) => a - b);
    check(numbers.length === 100 && numbers.every((n, i) => n === i + 1), `${g}: numbers are exactly 1–100, no gaps or duplicates`, `${numbers.length}`);
    const waiting = mine.map((r) => r.body.waitingPosition).filter((n) => n != null).sort((a, b) => a - b);
    check(waiting.length === 25 && waiting.every((n, i) => n === i + 1), `${g}: 25 waiting with positions 1–25`, `${waiting.length}`);
  }

  // 2. Registrations (20 boys, 20 girls) and a boys' capacity change at the same time
  const [capacity, ...more] = await Promise.all([
    admin.rpc('set_capacity', { p_gender: 'male', p_new_capacity: 115 }),
    ...Array.from({ length: 40 }, (_, i) => registerCall(1000 + i)),
  ]);
  check(!capacity.error && capacity.data.result === 'ok', 'set_capacity(male, 115) during registrations succeeded', capacity.error?.message);
  check(more.every((r) => r.status === 200 && r.body.result === 'ok'), '40 concurrent registrations succeeded');

  const after = await admin.rpc('admin_dashboard');
  const rows = after.data.registrations;
  check(after.data.total === 290, 'total is 290', `${after.data.total}`);
  for (const [g, cap] of [['male', 115], ['female', 100]]) {
    const confirmed = rows.filter((r) => r.gender === g && r.status === 'confirmed').map((r) => r.attendanceNumber).sort((a, b) => a - b);
    check(confirmed.length === cap && confirmed.every((n, i) => n === i + 1), `${g}: confirmed numbers are exactly 1–${cap}, no duplicates`, `${confirmed.length}`);
    const positions = rows.filter((r) => r.gender === g && r.status === 'waiting').map((r) => r.waitingPosition);
    check(positions.every((p, i) => p === i + 1), `${g}: waiting positions are 1..n in arrival order`, `${positions.length} waiting`);
  }

  // 3. Same phone in another format, and same submission_id twice
  const dup = await rest('rpc/register_member', {
    method: 'POST',
    body: JSON.stringify({ p_full_name: 'تكرار', p_phone: '+20 15 0000 0001', p_faculty: 'x', p_university: 'y', p_gender: 'female', p_submission_id: randomUUID(), p_website: '' }),
  }).then((r) => r.json());
  check(dup.result === 'phone_taken', 'same phone in another format → phone_taken');
}

const mode = process.argv[2];
if (mode === 'security') await security();
else if (mode === 'concurrency') await concurrency();
else {
  console.error('Usage: node supabase/tests/remote-checks.mjs <security|concurrency> [--test-project]');
  process.exit(2);
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
