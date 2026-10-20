# Filo Family Meeting Registration

Registration site for **اجتماع فيلو فاميلي — بحضور الأنبا روفائيل**.

- Public page `/`: members register with name, gender, phone, faculty, and university. Boys and girls are separate pools: the first 100 boys get attendance numbers 1–100, and the first 100 girls also get 1–100. Everyone after that goes on their own gender's waiting list.
- Admin page `/admin`: view registrations (filter by gender) and change each pool's capacity. Raising capacity promotes waiting members of that gender automatically, in arrival order.

The site is static files on **Cloudflare Pages** plus a **Supabase** database. There is no server of our own. All rules run inside PostgreSQL functions (`supabase/migrations/`). The full design is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

> **Known limits (by design):** there is no identity verification. A phone number can be typed by anyone. A member's saved status only shows up again on the **same browser and device**. A member who lost their status must ask an admin, who can search for them in the dashboard. See plan §3.

---

## 1. Local development

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173  and  http://localhost:5173/admin/
npm test           # unit + database tests (runs the real migrations in an in-memory Postgres)
npm run build      # type-check + production build into dist/
```

To point local dev at a Supabase project without editing code, create `.env.local` (git-ignored):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon or publishable key>
```

## 2. Setting up Supabase (do this twice: `production` and `test`)

1. Create a project at [supabase.com](https://supabase.com). Choose region **Frankfurt (eu-central-1)**.
2. **Authentication → Sign In / Providers → Email:** keep email login on. Turn **"Allow new users to sign up" OFF.**
3. **SQL Editor:** run the files in order:
   1. `supabase/migrations/001_schema.sql`
   2. `supabase/migrations/002_functions.sql`
   3. `supabase/migrations/003_permissions.sql`
   4. `supabase/migrations/004_delete_registration.sql`
   5. `supabase/migrations/005_reset_number_after_delete.sql`
   6. `supabase/migrations/006_fill_number_gaps.sql`
   7. `supabase/migrations/007_gender_pools.sql`: **deletes all existing registrations**

   Or, with the [Supabase CLI](https://supabase.com/docs/guides/cli): `supabase link --project-ref <ref>` then `supabase db push`.
4. **Project Settings → API:** make sure **Exposed schemas** contains only `public` (and `graphql_public` if it is there by default). **Never add `private`.**
5. Copy the **Project URL** and the **anon / publishable key** (never the `service_role` / secret key) into [src/shared/config.ts](src/shared/config.ts) for production. For the test project, use `.env.local` instead.

### Adding an admin

1. Supabase dashboard → **Authentication → Users → Add user → Create new user**. Enter the email and a strong password, and tick "Auto Confirm User".
2. SQL Editor:

   ```sql
   insert into private.admins (user_id)
   select id from auth.users where email = 'admin@example.com';
   ```

To remove an admin: `delete from private.admins where user_id = (select id from auth.users where email = '...');`

### Checking the client IP header (for the rate limit)

The per-IP rate limit reads the client IP from the request headers in this order: `cf-connecting-ip`, then the first entry of `x-forwarded-for`, then `x-real-ip`. Confirm this once per project:

```sql
-- 1. Create a temporary function
create function public.debug_headers() returns json
language sql security definer set search_path = ''
as $$ select current_setting('request.headers', true)::json $$;
grant execute on function public.debug_headers() to anon;
```

```bash
# 2. Call it from your phone's network or your laptop
curl -s -X POST "https://<ref>.supabase.co/rest/v1/rpc/debug_headers" \
  -H "apikey: <anon key>" -H "Content-Type: application/json" -d '{}'
```

Your public IP should appear in one of those headers. If it appears under a different header, update `private.client_ip()` in `002_functions.sql`.

```sql
-- 3. Remove it
drop function public.debug_headers();
```

## 3. Deploying to Cloudflare Pages

1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → choose the repo.
3. Build settings: framework preset **None**, build command **`npm run build`**, output directory **`dist`**, environment variable `NODE_VERSION=20` (or newer).
4. Every push to `main` deploys automatically. The site is at `https://<name>.pages.dev`.

Cache and security headers are in [public/_headers](public/_headers). The Content-Security-Policy there contains a hash of the small inline script in `index.html`. **If you edit that script, recompute the hash:**

```bash
node -e "const s=require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];console.log(require('crypto').createHash('sha256').update(s).digest('base64'))"
```

## 4. Brand assets

Optimized images in `public/brand/` and fonts in `public/fonts/` are generated once and committed:

```bash
npm run images   # logo + photo → webp sizes, favicon, icons, og.png (uses sharp)
npm run fonts    # Cairo woff2, Arabic + Latin, weights 400/600/800
```

## 5. Testing

| What | How |
|---|---|
| Unit + database logic | `npm test`. Runs the real migrations in PGlite: numbering, waiting list, phone formats, idempotency, honeypot, rate limit, 200 → 210 promotion, capacity lowering, separate boys/girls pools, admin access, private-table access. |
| Security against a real project | `SUPABASE_URL=... SUPABASE_ANON_KEY=... node supabase/tests/remote-checks.mjs security`. Optionally also set `NONADMIN_EMAIL`/`NONADMIN_PASSWORD` for a user who is **not** in `private.admins`. |
| True parallel concurrency | On the **test** project, after resetting it (below) and raising its rate limit: `SUPABASE_URL=... SUPABASE_ANON_KEY=... ADMIN_EMAIL=... ADMIN_PASSWORD=... node supabase/tests/remote-checks.mjs concurrency --test-project`. This sends 250 parallel registrations, then a capacity change during 40 more. |
| Rush load test | [k6](https://k6.io): see the header of [loadtest/rush.k6.js](loadtest/rush.k6.js), then check with [loadtest/verify.sql](loadtest/verify.sql). |
| Page speed on 4G | Chrome DevTools → Lighthouse, mobile, on the deployed test site. Target: load p95 under 1.5 s. |

### Resetting the test project

```sql
truncate private.registrations, private.rate_limits restart identity;
update private.settings set capacity_male = 100, capacity_female = 100, rate_limit_per_minute = 100000 where id = 1;
-- after testing:
update private.settings set rate_limit_per_minute = 30 where id = 1;
```

## 6. Backups (manual: the free plan has none)

Supabase → **Table Editor** → schema `private` → `registrations` → **Export → CSV**.
Do this once a day while registration is open, and once after it closes.

## 7. Go-live checklist

- [ ] Test project: `npm test` passes, the `security` and `concurrency` remote checks pass, and the k6 thresholds pass (verify.sql shows exactly 1–100 for each gender).
- [ ] Production project: migrations applied, sign-ups **disabled**, exposed schemas = `public` only.
- [ ] Production project is empty: `select capacity_male, capacity_female, rate_limit_per_minute from private.settings;` → `(100, 100, 30)`, and `select count(*) from private.registrations;` → `0`.
- [ ] Client IP header checked (§2).
- [ ] First admin added. Log in at `/admin` and confirm the dashboard loads.
- [ ] `src/shared/config.ts` has the **production** URL and anon key. The deployed site loads over HTTPS.
- [ ] Smoke test on a real Android phone and a real iPhone: register, reload (the status card shows and no new row is created), open in incognito (the form shows again, which is expected). Then delete the smoke-test rows:
      `delete from private.registrations; update private.settings set last_attendance_number = 0 where id = 1;`
- [ ] Share the link on WhatsApp once to confirm the preview shows the logo and title.
- [ ] **The day before:** open the Supabase dashboard (free projects pause after about 7 days idle).
- [ ] **About 10 minutes before sharing:** open the site once yourself.
