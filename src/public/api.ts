// Plain-fetch wrappers for the public RPCs. No supabase-js on the public page (plan §7b).
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../shared/config';
import type { Gender } from '../shared/phone';

export type Status = 'confirmed' | 'waiting';

export interface Registration {
  fullName: string;
  gender: Gender;
  status: Status;
  attendanceNumber?: number;
  waitingPosition?: number;
}

export type RegisterResponse =
  | ({ result: 'ok'; token: string } & Registration)
  | { result: 'invalid'; field: string }
  | { result: 'phone_taken' }
  | { result: 'rate_limited' };

export interface RegisterParams {
  p_full_name: string;
  p_phone: string;
  p_faculty: string;
  p_university: string;
  p_gender: Gender;
  p_submission_id: string;
  p_website: string;
}

/** Network error, timeout, 429 or 5xx — worth retrying. */
export class TransientError extends Error {}

const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1000, 2000, 4000];

function headers(): HeadersInit {
  const h: Record<string, string> = {
    apikey: SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
  // Legacy anon keys are JWTs and go in Authorization too; new publishable keys must not.
  if (SUPABASE_ANON_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return h;
}

async function rpcOnce<T>(fn: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new TransientError('network');
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 500 || res.status === 429) throw new TransientError(`http ${res.status}`);
  if (!res.ok) throw new Error(`http ${res.status}`);
  return (await res.json()) as T;
}

/** Up to 3 retries with 1 s / 2 s / 4 s back-off. Safe because every RPC is idempotent. */
async function rpc<T>(fn: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpcOnce<T>(fn, body);
    } catch (err) {
      if (!(err instanceof TransientError) || attempt >= BACKOFF_MS.length) throw err;
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }
}

export function registerMember(params: RegisterParams): Promise<RegisterResponse> {
  return rpc<RegisterResponse>('register_member', params);
}

/** 'not_found' after a retried success is fine: the registration is gone either way. */
export function cancelMyRegistration(token: string): Promise<{ result: 'ok' | 'not_found' }> {
  return rpc<{ result: 'ok' | 'not_found' }>('cancel_my_registration', { p_token: token });
}

export function getMyRegistration(token: string): Promise<Registration | null> {
  return rpc<Registration | null>('get_my_registration', { p_token: token });
}
