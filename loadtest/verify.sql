-- Run in the TEST project's SQL editor after the k6 rush (plan §7b pass criteria).

-- Expect, for each gender: confirmed = 100, min = 1, max = 100, distinct = 100
select gender,
       count(*)                          as confirmed,
       min(attendance_number)            as min_number,
       max(attendance_number)            as max_number,
       count(distinct attendance_number) as distinct_numbers
from private.registrations
where status = 'confirmed'
group by gender;

-- Expect: everyone else waiting (500 - 200 = 300 for the full scenario)
select gender, status, count(*) from private.registrations group by gender, status order by 1, 2;

-- Expect: no rows (no gaps in 1..100 for either gender)
select g.gender, n as missing_number
from unnest(enum_range(null::private.gender)) g(gender)
cross join generate_series(1, 100) n
where not exists (
  select 1 from private.registrations r where r.gender = g.gender and r.attendance_number = n);

-- Afterwards: restore the rate limit
-- update private.settings set rate_limit_per_minute = 30 where id = 1;
