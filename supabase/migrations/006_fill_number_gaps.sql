-- 006_fill_number_gaps.sql — a new confirmed member gets the LOWEST free attendance number.
-- If #1 was deleted and #2 is still there, the next confirmed member gets #1, not #3.
-- Numbers already held never change. settings.last_attendance_number now means
-- "highest number in use" (shown on the dashboard).

-- Lowest positive number nobody holds. Caller must already hold the settings lock.
create or replace function private.take_attendance_number()
returns int
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_number int;
begin
  if not exists (select 1 from private.registrations where attendance_number = 1) then
    v_number := 1;
  else
    select min(a.attendance_number) + 1 into v_number
    from private.registrations a
    where a.attendance_number is not null
      and not exists (
        select 1 from private.registrations b where b.attendance_number = a.attendance_number + 1);
  end if;

  update private.settings
     set last_attendance_number = greatest(last_attendance_number, v_number)
   where id = 1;

  return v_number;
end;
$$;

---------------------------------------------------------------------------
-- register_member: same as 002, step 6 uses take_attendance_number()
---------------------------------------------------------------------------
create or replace function public.register_member(
  p_full_name     text,
  p_phone         text,
  p_faculty       text,
  p_university    text,
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
  v_sub        uuid;
  v_hits       int;
  v_settings   private.settings;
  v_row        private.registrations;
  v_confirmed  int;
  v_number     int;
  v_token      text;
begin
  -- 1. Validate
  if char_length(v_name) not between 2 and 100 then
    return jsonb_build_object('result', 'invalid', 'field', 'full_name');
  end if;
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
      'result', 'ok', 'token', private.new_token(), 'fullName', v_name,
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
  select * into v_settings from private.settings where id = 1 for update;

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

  -- 6. Confirmed or waiting
  select count(*) into v_confirmed from private.registrations where status = 'confirmed';
  v_token := private.new_token();

  if v_confirmed < v_settings.capacity then
    v_number := private.take_attendance_number();

    insert into private.registrations
      (full_name, phone, faculty, university, status, attendance_number,
       token_hash, submission_id, confirmed_at)
    values
      (v_name, v_phone, v_faculty, v_university, 'confirmed', v_number,
       private.hash_token(v_token), v_sub, now())
    returning * into v_row;
  else
    insert into private.registrations
      (full_name, phone, faculty, university, status, token_hash, submission_id)
    values
      (v_name, v_phone, v_faculty, v_university, 'waiting', private.hash_token(v_token), v_sub)
    returning * into v_row;
  end if;

  -- 7-8. Return the raw token once; only its hash is stored
  return jsonb_build_object('result', 'ok', 'token', v_token) || private.registration_payload(v_row);
end;
$$;

---------------------------------------------------------------------------
-- set_capacity: same as 002, each promoted member takes the lowest free number
---------------------------------------------------------------------------
create or replace function public.set_capacity(p_new_capacity int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_confirmed int;
  v_free      int;
  v_number    int;
  v_promoted  jsonb := '[]'::jsonb;
  w           record;
begin
  perform private.assert_admin();

  -- Same lock as register_member: no registration can slip in mid-promotion
  perform 1 from private.settings where id = 1 for update;
  select count(*) into v_confirmed from private.registrations where status = 'confirmed';

  if p_new_capacity is null or p_new_capacity < 1 or p_new_capacity > 100000 then
    return jsonb_build_object('result', 'invalid', 'reason', 'out_of_range');
  end if;
  if p_new_capacity < v_confirmed then
    return jsonb_build_object('result', 'invalid', 'reason', 'below_confirmed', 'confirmed', v_confirmed);
  end if;

  v_free := p_new_capacity - v_confirmed;

  if v_free > 0 then
    for w in
      select id, full_name
      from private.registrations
      where status = 'waiting'
      order by id
      limit v_free
      for update
    loop
      v_number := private.take_attendance_number();
      update private.registrations
         set status = 'confirmed', attendance_number = v_number, confirmed_at = now()
       where id = w.id;
      v_promoted := v_promoted || jsonb_build_array(
        jsonb_build_object('id', w.id, 'fullName', w.full_name, 'attendanceNumber', v_number));
    end loop;
  end if;

  update private.settings set capacity = p_new_capacity where id = 1;

  return jsonb_build_object(
    'result', 'ok',
    'capacity', p_new_capacity,
    'promotedCount', jsonb_array_length(v_promoted),
    'promoted', v_promoted);
end;
$$;

---------------------------------------------------------------------------
-- remove_registration: the promoted waiting member takes the lowest free number
---------------------------------------------------------------------------
create or replace function private.remove_registration(p_id bigint)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_row       private.registrations;
  v_capacity  int;
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
    update private.settings
       set last_attendance_number = coalesce(
             (select max(r.attendance_number) from private.registrations r), 0)
     where id = 1;

    select s.capacity into v_capacity from private.settings s where s.id = 1;
    select count(*) into v_confirmed from private.registrations where status = 'confirmed';
    if v_confirmed < v_capacity then
      select * into v_next
      from private.registrations
      where status = 'waiting'
      order by id
      limit 1
      for update;

      if found then
        v_number := private.take_attendance_number();

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

revoke all on function private.take_attendance_number()    from public, anon, authenticated;
revoke all on function private.remove_registration(bigint) from public, anon, authenticated;
