// Loads the real migrations into an in-memory Postgres (PGlite) with small stubs
// for what Supabase provides: the anon/authenticated roles, auth.users, auth.uid().
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`;

export type Db = PGlite;

export async function freshDb(): Promise<Db> {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

/** Runs one query as an API role, like PostgREST does. */
export async function asRole<T>(
  db: Db,
  role: 'anon' | 'authenticated',
  sql: string,
  params: unknown[] = [],
  opts: { uid?: string; ip?: string } = {},
): Promise<T> {
  await db.exec('begin');
  try {
    await db.query(`select set_config('test.uid', $1, true)`, [opts.uid ?? '']);
    await db.query(`select set_config('request.headers', $1, true)`, [
      JSON.stringify({ 'x-forwarded-for': opts.ip ?? '10.0.0.1' }),
    ]);
    await db.exec(`set local role ${role}`);
    const res = await db.query<Record<string, unknown>>(sql, params);
    await db.exec('commit');
    return Object.values(res.rows[0] ?? {})[0] as T;
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}

export interface RegisterResult {
  result: string;
  field?: string;
  token?: string;
  fullName?: string;
  gender?: 'male' | 'female';
  status?: 'confirmed' | 'waiting';
  attendanceNumber?: number;
  waitingPosition?: number;
}

let counter = 0;

export function phoneFor(i: number): string {
  return '010' + String(i).padStart(8, '0');
}

export function uuid(): string {
  counter++;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export function register(
  db: Db,
  fields: Partial<{ name: string; phone: string; faculty: string; university: string; gender: string; sub: string; website: string }> = {},
  opts: { ip?: string } = {},
): Promise<RegisterResult> {
  return asRole<RegisterResult>(
    db,
    'anon',
    'select public.register_member($1, $2, $3, $4, $5, $6, $7)',
    [
      fields.name ?? 'مينا جرجس',
      fields.phone ?? phoneFor(counter + 1),
      fields.faculty ?? 'هندسة',
      fields.university ?? 'جامعة القاهرة',
      fields.gender ?? 'male',
      fields.sub ?? uuid(),
      fields.website ?? '',
    ],
    opts,
  );
}
