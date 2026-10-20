-- 005_reset_number_after_delete.sql — after a delete, the counter falls back to the
-- highest attendance number still in use. Deleting everyone restarts numbering at 1;
-- deleting the newest confirmed member frees their number. Numbers held by remaining
-- members never change, so gaps in the middle stay.

-- Shared by both entry points. Caller must already hold the settings lock.
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
        update private.settings
           set last_attendance_number = last_attendance_number + 1
         where id = 1
        returning last_attendance_number into v_number;

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

revoke all on function private.remove_registration(bigint) from public, anon, authenticated;

-- One-time fix for the current data (e.g. everyone already deleted but counter still at 3).
update private.settings
   set last_attendance_number = coalesce(
         (select max(r.attendance_number) from private.registrations r), 0)
 where id = 1;
