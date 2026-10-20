// Rush simulation (plan §7b). Run against the TEST Supabase project only.
//
//   k6 run -e SITE_URL=https://<test-site>.pages.dev \
//          -e SUPABASE_URL=https://<test-ref>.supabase.co \
//          -e SUPABASE_ANON_KEY=<test anon key> \
//          loadtest/rush.k6.js
//
// Before: empty test project, capacity 100 boys + 100 girls, and raise the rate limit (k6 uses one IP):
//   update private.settings set rate_limit_per_minute = 100000 where id = 1;
// After: check numbering with loadtest/verify.sql, then set the rate limit back to 30.
//
// Page load p95 on simulated 4G is measured separately with Lighthouse / Chrome DevTools
// (k6 measures CDN response times, not rendering on a throttled phone).
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const SITE_URL = __ENV.SITE_URL;
const SUPABASE_URL = __ENV.SUPABASE_URL;
const KEY = __ENV.SUPABASE_ANON_KEY;

const serverErrors = new Counter('server_errors');

export const options = {
  scenarios: {
    // 2,000 page loads spread over 2 minutes
    page_loads: {
      executor: 'constant-arrival-rate',
      exec: 'pageLoad',
      rate: 1000,
      timeUnit: '1m',
      duration: '2m',
      preAllocatedVUs: 50,
      maxVUs: 300,
    },
    // 400 registrations spread over 2 minutes ...
    register_steady: {
      executor: 'constant-arrival-rate',
      exec: 'register',
      rate: 200,
      timeUnit: '1m',
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
    // ... plus 100 within the same 5 seconds (500 total)
    register_spike: {
      executor: 'constant-arrival-rate',
      exec: 'register',
      rate: 20,
      timeUnit: '1s',
      duration: '5s',
      startTime: '30s',
      preAllocatedVUs: 100,
      maxVUs: 200,
    },
  },
  thresholds: {
    server_errors: ['count==0'],
    'http_req_duration{name:register_member}': ['p(95)<800'],
    'http_req_duration{name:page}': ['p(95)<1500'],
    checks: ['rate>0.99'],
  },
};

const rpcHeaders = {
  apikey: KEY,
  'Content-Type': 'application/json',
  ...(KEY && KEY.startsWith('eyJ') ? { Authorization: `Bearer ${KEY}` } : {}),
};

function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`;
}

export function pageLoad() {
  const res = http.get(`${SITE_URL}/`, { tags: { name: 'page' } });
  if (res.status >= 500) serverErrors.add(1);
  check(res, { 'page 200': (r) => r.status === 200 });
}

export function register() {
  // Unique phone per iteration: 0100 + 7 digits
  const n = exec.scenario.name === 'register_spike' ? 5000000 + exec.scenario.iterationInTest : exec.scenario.iterationInTest;
  const phone = '0100' + String(n).padStart(7, '0');
  const res = http.post(
    `${SUPABASE_URL}/rest/v1/rpc/register_member`,
    JSON.stringify({
      p_full_name: `حمل ${n}`,
      p_phone: phone,
      p_faculty: 'هندسة',
      p_university: 'جامعة الاختبار',
      p_gender: n % 2 === 0 ? 'male' : 'female',
      p_submission_id: uuid(),
      p_website: '',
    }),
    { headers: rpcHeaders, tags: { name: 'register_member' }, timeout: '10s' },
  );
  if (res.status >= 500) serverErrors.add(1);
  check(res, {
    'register 200': (r) => r.status === 200,
    'register ok': (r) => r.status === 200 && r.json('result') === 'ok',
  });
}
