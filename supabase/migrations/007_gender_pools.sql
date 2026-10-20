-- 007_gender_pools.sql — boys and girls are two separate pools.
-- Each gender has its own capacity (default 100), its own attendance numbers (1, 2, 3 …)
-- and its own waiting list. All functions keep the single settings-row lock, so numbering
-- stays atomic; unique (gender, attendance_number) is the backstop.
--
-- WARNING: this deletes every existing registration (requested: start fresh).
-- Only private.registrations and private.settings change. The old settings.capacity and
-- settings.last_attendance_number columns stay but are no longer used.

create type private.gender as enum ('male', 'female');

delete from private.registrations;
update private.settings set last_attendance_number = 0 where id = 1;

alter table private.registrations
  add column gender private.gender not null,
  drop constraint registrations_attendance_number_key,
  add constraint registrations_gender_attendance_number_key unique (gender, attendance_number);

create index registrations_gender_status_id_idx on private.registrations (gender, status, id);

alter table private.settings
  add column capacity_male   int not null default 100 check (capacity_male >= 1),
  add column capacity_female int not null default 100 check (capacity_female >= 1);

-- Old signatures; replaced below with gender-aware ones.
drop function public.register_member(text, text, text, text, text, text);
drop function public.set_capacity(int);
drop function private.take_attendance_number();

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

create or replace function private.capacity_for(p_gender private.gender)
returns int
language sql
stable
set search_path = ''
as $$
  select case p_gender when 'male' then s.capacity_male else s.capacity_female end
  from private.settings s
  where s.id = 1;
$$;

-- Lowest positive number nobody of this gender holds. Caller must already hold the settings lock.
create or replace function private.take_attendance_number(p_gender private.gender)
returns int
language sql
stable
set search_path = ''
as $$
  select case
    when not exists (
      select 1 from private.registrations where gender = p_gender and attendance_number = 1) then 1
    else (
      select min(a.attendance_number) + 1
      from private.registrations a
      where a.gender = p_gender
        and a.attendance_number is not null
        and not exists (
          select 1 from private.registrations b
          where b.gender = p_gender and b.attendance_number = a.attendance_number + 1))
  end;
$$;

-- Rank among waiting rows of the same gender, by arrival (id).
create or replace function private.waiting_position(p_id bigint)
returns int
language sql
stable
set search_path = ''
as $$
  select count(*)::int
  from private.registrations w
  join private.registrations me on me.id = p_id
  where w.status = 'waiting' and w.gender = me.gender and w.id <= p_id;
$$;

create or replace function private.registration_payload(r private.registrations)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case r.status
    when 'confirmed' then pg_catalog.jsonb_build_object(
      'fullName', r.full_name,
      'gender', r.gender,
      'status', 'confirmed',
      'attendanceNumber', r.attendance_number)
    else pg_catalog.jsonb_build_object(
      'fullName', r.full_name,
      'gender', r.gender,
      'status', 'waiting',
      'waitingPosition', private.waiting_position(r.id))
  end;
$$;

---------------------------------------------------------------------------
-- register_member (anon)
---------------------------------------------------------------------------
create or replace function public.register_member(
  p_full_name     text,
  p_phone         text,
  p_faculty       text,
  p_university    text,
  p_gender        text,
  p_submission_id text,
  p_website       text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name       text := private.clean_text(p_full_name);
  v_phone      text := private.normalize_phone(p_phone);
  v_faculty    text := private.clean_text(p_faculty);
  v_university text := private.clean_text(p_university);
  v_gender     private.gender;
  v_sub        uuid;
  v_hits       int;
  v_row        private.registrations;
  v_confirmed  int;
  v_token      text;
begin
  -- 1. Validate (same order as the form)
  if char_length(v_name) not between 2 and 100 then
    return jsonb_build_object('result', 'invalid', 'field', 'full_name');
  end if;
  if coalesce(p_gender, '') not in ('male', 'female') then
    return jsonb_build_object('result', 'invalid', 'field', 'gender');
  end if;
  v_gender := p_gender::private.gender;
  if v_phone !~ '^01[0125][0-9]{8}$' then
    return jsonb_build_object('result', 'invalid', 'field', 'phone');
  end if;
  if char_length(v_faculty) not between 1 and 100 then
    return jsonb_build_object('result', 'invalid', 'field', 'faculty');
  end if;
  if char_length(v_university) not between 1 and 100 then
    return jsonb_build_object('result', 'invalid', 'field', 'university');
  end if;
  if coalesce(p_submission_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('result', 'invalid', 'field', 'submission_id');
  end if;
  v_sub := p_submission_id::uuid;

  -- 2. Honeypot: fake success, store nothing
  if coalesce(p_website, '') <> '' then
    return jsonb_build_object(
      'result', 'ok', 'token', private.new_token(), 'fullName', v_name, 'gender', v_gender,
      'status', 'waiting', 'waitingPosition', 1);
  end if;

  -- 3. Per-IP rate limit (fixed one-minute window)
  insert into private.rate_limits as rl (ip, window_start, count)
  values (private.client_ip(), date_trunc('minute', now()), 1)
  on conflict (ip, window_start) do update set count = rl.count + 1
  returning rl.count into v_hits;

  if random() < 0.01 then
    delete from private.rate_limits where window_start < now() - interval '10 minutes';
  end if;

  if v_hits > (select s.rate_limit_per_minute from private.settings s where s.id = 1) then
    return jsonb_build_object('result', 'rate_limited');
  end if;

  -- 4. One registration at a time from here on (held ~1 ms)
  perform 1 from private.settings where id = 1 for update;

  -- 5a. Same submission_id = retry / double-click: return it with a fresh token
  select * into v_row from private.registrations where submission_id = v_sub;
  if found then
    v_token := private.new_token();
    update private.registrations set token_hash = private.hash_token(v_token) where id = v_row.id;
    return jsonb_build_object('result', 'ok', 'token', v_token) || private.registration_payload(v_row);
  end if;

  -- 5b. Phone already used by another submission. Reveal nothing about it.
  if exists (select 1 from private.registrations where phone = v_phone) then
    return jsonb_build_object('result', 'phone_taken');
  end if;

  -- 6. Confirmed or waiting, within this gender's pool
  select count(*) into v_confirmed
  from private.registrations where status = 'confirmed' and gender = v_gender;
  v_token := private.new_token();

  if v_confirmed < private.capacity_for(v_gender) then
    insert into private.registrations
      (full_name, phone, faculty, university, gender, status, attendance_number,
       token_hash, submission_id, confirmed_at)
    values
      (v_name, v_phone, v_faculty, v_university, v_gender, 'confirmed',
       private.take_attendance_number(v_gender), private.hash_token(v_token), v_sub, now())
    returning * into v_row;
  else
    insert into private.registrations
      (full_name, phone, faculty, university, gender, status, token_hash, submission_id)
    values
      (v_name, v_phone, v_faculty, v_university, v_gender, 'waiting', private.hash_token(v_token), v_sub)
    returning * into v_row;
  end if;

  -- 7-8. Return the raw token once; only its hash is stored
  return jsonb_build_object('result', 'ok', 'token', v_token) || private.registration_payload(v_row);
end;
$$;

---------------------------------------------------------------------------
-- admin_dashboard (authenticated + private.admins)
---------------------------------------------------------------------------
create or replace function public.admin_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings private.settings;
  v_result   jsonb;
begin
  perform private.assert_admin();

  select * into v_settings from private.settings where id = 1;

  select jsonb_build_object(
    'male', jsonb_build_object(
      'capacity', v_settings.capacity_male,
      'confirmed', count(*) filter (where r.gender = 'male' and r.status = 'confirmed'),
      'waiting', count(*) filter (where r.gender = 'male' and r.status = 'waiting')),
    'female', jsonb_build_object(
      'capacity', v_settings.capacity_female,
      'confirmed', count(*) filter (where r.gender = 'female' and r.status = 'confirmed'),
      'waiting', count(*) filter (where r.gender = 'female' and r.status = 'waiting')),
    'confirmed', count(*) filter (where r.status = 'confirmed'),
    'waiting', count(*) filter (where r.status = 'waiting'),
    'total', count(*),
    'registrations', coalesce(
      jsonb_agg(jsonb_build_object(
        'id', r.id,
        'gender', r.gender,
        'attendanceNumber', r.attendance_number,
        'fullName', r.full_name,
        'phone', r.phone,
        'faculty', r.faculty,
        'university', r.university,
        'status', r.status,
        'waitingPosition', r.waiting_position,
        'createdAt', r.created_at,
        'confirmedAt', r.confirmed_at
      ) order by r.status, r.gender, r.attendance_number, r.id),
      '[]'::jsonb)
  )
  into v_result
  from (
    select x.*,
           case when x.status = 'waiting'
                then row_number() over (partition by x.status, x.gender order by x.id)
           end as waiting_position
    from private.registrations x
  ) r;

  return v_result;
end;
$$;

---------------------------------------------------------------------------
-- set_capacity (authenticated + private.admins) — one gender's pool
---------------------------------------------------------------------------
create or replace function public.set_capacity(p_gender text, p_new_capacity int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_gender    private.gender;
  v_confirmed int;
  v_number    int;
  v_promoted  jsonb := '[]'::jsonb;
  w           record;
begin
  perform private.assert_admin();

  if coalesce(p_gender, '') not in ('male', 'female') then
    return jsonb_build_object('result', 'invalid', 'reason', 'invalid_gender');
  end if;
  v_gender := p_gender::private.gender;

  -- Same lock as register_member: no registration can slip in mid-promotion
  perform 1 from private.settings where id = 1 for update;
  select count(*) into v_confirmed
  from private.registrations where status = 'confirmed' and gender = v_gender;

  if p_new_capacity is null or p_new_capacity < 1 or p_new_capacity > 100000 then
    return jsonb_build_object('result', 'invalid', 'reason', 'out_of_range');
  end if;
  if p_new_capacity < v_confirmed then
    return jsonb_build_object('result', 'invalid', 'reason', 'below_confirmed', 'confirmed', v_confirmed);
  end if;

  if v_gender = 'male' then
    update private.settings set capacity_male = p_new_capacity where id = 1;
  else
    update private.settings set capacity_female = p_new_capacity where id = 1;
  end if;

  for w in
    select id, full_name
    from private.registrations
    where status = 'waiting' and gender = v_gender
    order by id
    limit p_new_capacity - v_confirmed
    for update
  loop
    v_number := private.take_attendance_number(v_gender);
    update private.registrations
       set status = 'confirmed', attendance_number = v_number, confirmed_at = now()
     where id = w.id;
    v_promoted := v_promoted || jsonb_build_array(
      jsonb_build_object('id', w.id, 'fullName', w.full_name, 'attendanceNumber', v_number));
  end loop;

  return jsonb_build_object(
    'result', 'ok',
    'gender', v_gender,
    'capacity', p_new_capacity,
    'promotedCount', jsonb_array_length(v_promoted),
    'promoted', v_promoted);
end;
$$;

---------------------------------------------------------------------------
-- remove_registration: a freed seat goes to the first waiting member of the same gender
---------------------------------------------------------------------------
create or replace function private.remove_registration(p_id bigint)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_row       private.registrations;
  v_confirmed int;
  v_next      private.registrations;
  v_number    int;
  v_promoted  jsonb := null;
begin
  delete from private.registrations where id = p_id returning * into v_row;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_row.status = 'confirmed' then
    select count(*) into v_confirmed
    from private.registrations where status = 'confirmed' and gender = v_row.gender;
    if v_confirmed < private.capacity_for(v_row.gender) then
      select * into v_next
      from private.registrations
      where status = 'waiting' and gender = v_row.gender
      order by id
      limit 1
      for update;

      if found then
        v_number := private.take_attendance_number(v_row.gender);

        update private.registrations
           set status = 'confirmed', attendance_number = v_number, confirmed_at = now()
         where id = v_next.id;

        v_promoted := jsonb_build_object(
          'id', v_next.id, 'fullName', v_next.full_name, 'attendanceNumber', v_number);
      end if;
    end if;
  end if;

  return jsonb_build_object('result', 'ok', 'deletedId', v_row.id, 'promoted', v_promoted);
end;
$$;

---------------------------------------------------------------------------
-- Permissions (same pattern as 003)
---------------------------------------------------------------------------
revoke all on function private.capacity_for(private.gender)           from public, anon, authenticated;
revoke all on function private.take_attendance_number(private.gender) from public, anon, authenticated;
revoke all on function private.remove_registration(bigint)            from public, anon, authenticated;

revoke all on function public.register_member(text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.set_capacity(text, int)                                   from public, anon, authenticated;

grant execute on function public.register_member(text, text, text, text, text, text, text) to anon;
grant execute on function public.set_capacity(text, int)                                   to authenticated;
