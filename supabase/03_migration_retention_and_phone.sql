-- HirePool migration 03: mobile number at signup + automatic deletion of job posts
-- Run AFTER 01_schema.sql and 02_migration_supabase_only.sql.
-- Supabase Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to run twice. Deletes no tables.

-- ===========================================================================
-- 1. AGENCY MOBILE NUMBER (stored as +<country code><number>, e.g. +919876543210)
-- ===========================================================================
alter table public.agencies add column if not exists phone text;
alter table public.agencies drop constraint if exists agencies_phone_check;
alter table public.agencies add constraint agencies_phone_check
  check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$');

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  p text := m->>'plan';
begin
  if m ? 'agency_name' then
    insert into public.agencies (user_id, name, email, plan, logo_key, phone)
    values (
      new.id,
      left(trim(m->>'agency_name'), 120),
      lower(new.email),
      case when p in ('1 month','3 months','6 months') then p else '1 month' end,
      case when (m->>'logo_key') ~ '^[a-f0-9-]{36}\.(png|jpg)$' then m->>'logo_key' end,
      case when (m->>'phone') ~ '^\+[1-9][0-9]{7,14}$' then m->>'phone' end
    );
  end if;
  return new;
end $$;

-- ===========================================================================
-- 2. JOB POSTS DELETE THEMSELVES 10 DAYS AFTER POSTING (candidates + notes go with them)
--    To change the number of days: change BOTH '10 days' below, and RETENTION_DAYS in js/data.js.
-- ===========================================================================
alter table public.jobs add column if not exists expires_at timestamptz;
-- jobs that already exist get a fresh 10 days from now (so nothing is deleted by surprise)
update public.jobs set expires_at = now() + interval '10 days' where expires_at is null;
alter table public.jobs alter column expires_at set default (now() + interval '10 days');
alter table public.jobs alter column expires_at set not null;
create index if not exists jobs_expires_idx on public.jobs (expires_at);

-- Agencies must not be able to set or extend expires_at themselves: only these columns may be written.
revoke insert on public.jobs from authenticated;
grant insert (heading, country, sector, positions, status, urgent, deadline, description) on public.jobs to authenticated;

-- Resume files cannot be deleted from SQL (Supabase blocks it), so purged files are queued here
-- and the next agency/admin page load removes them through the Storage API.
create table if not exists public.purge_files (
  path       text primary key,
  agency_id  uuid not null,
  created_at timestamptz not null default now()
);
alter table public.purge_files enable row level security;
revoke all on public.purge_files from anon, authenticated;

create or replace function public.purge_expired_jobs()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.purge_files (path, agency_id)
  select c.resume_key, c.agency_id
    from public.candidates c join public.jobs j on j.id = c.job_id
   where j.expires_at <= now() and c.resume_key is not null and c.resume_key not like 'resumes/%'
  on conflict do nothing;
  delete from public.jobs where expires_at <= now();   -- cascades to candidates and notes
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.my_purge_files()
returns setof text language sql stable security definer set search_path = public as $$
  select path from public.purge_files
   where agency_id = public.my_agency_id() or public.is_admin()
   limit 500;
$$;

create or replace function public.clear_purge_files(p_paths text[])
returns void language sql security definer set search_path = public as $$
  delete from public.purge_files
   where path = any (p_paths) and (agency_id = public.my_agency_id() or public.is_admin());
$$;

revoke all on function public.purge_expired_jobs(), public.my_purge_files(), public.clear_purge_files(text[]) from public, anon;
grant execute on function public.purge_expired_jobs(), public.my_purge_files(), public.clear_purge_files(text[]) to authenticated;

-- The platform admin may also remove queued resume files (never read them).
drop policy if exists "resumes_admin_delete" on storage.objects;
create policy "resumes_admin_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'resumes' and public.is_admin());

-- Expired jobs stop accepting applications immediately (same functions as before + one extra condition).
create or replace function public.public_job(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  select j.id, j.heading, j.positions, a.name into r
    from public.jobs j join public.agencies a on a.id = j.agency_id
   where j.id = p_id and j.status = 'Open' and a.status = 'Active'
     and a.expires >= public.today_ist() and j.expires_at > now() and (j.deadline is null or j.deadline >= public.today_ist());
  if not found then return null; end if;
  return jsonb_build_object('id', r.id, 'heading', r.heading, 'positions', to_jsonb(r.positions), 'agency', r.name);
end $$;

create or replace function public.submit_application(
  p_job uuid, p_name text, p_email text, p_phone text, p_position text,
  p_exp numeric, p_loc text, p_pref text, p_certs text[], p_consent boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  jr record;
  cid uuid := gen_random_uuid();
  em text := lower(trim(coalesce(p_email, '')));
  nm text := trim(coalesce(p_name, ''));
  ph text := trim(coalesce(p_phone, ''));
  ps text := trim(coalesce(p_position, ''));
  lc text := nullif(trim(coalesce(p_loc, '')), '');
  pf text := nullif(trim(coalesce(p_pref, '')), '');
  cs text[];
  path text;
begin
  select j.id, j.agency_id, j.positions into jr
    from public.jobs j join public.agencies a on a.id = j.agency_id
   where j.id = p_job and j.status = 'Open' and a.status = 'Active'
     and a.expires >= public.today_ist() and j.expires_at > now() and (j.deadline is null or j.deadline >= public.today_ist());
  if not found then raise exception 'This job link is closed or invalid.'; end if;

  if char_length(nm) not between 2 and 100 then raise exception 'Enter your full name.'; end if;
  if ph !~ '^\+?[0-9 -]{8,15}$' then raise exception 'Enter a valid phone number.'; end if;
  if em !~ '^\S+@\S+\.\S+$' or char_length(em) > 120 then raise exception 'Enter a valid email.'; end if;
  if p_exp is null or p_exp < 0 or p_exp > 50 then raise exception 'Enter experience between 0 and 50 years.'; end if;
  if not (ps = any (jr.positions)) then raise exception 'Choose a position from the list.'; end if;
  if char_length(coalesce(lc,'')) > 100 or char_length(coalesce(pf,'')) > 100 then raise exception 'Location is too long.'; end if;
  if p_consent is not true then raise exception 'Please accept the privacy notice.'; end if;

  -- basic spam throttling (no CAPTCHA is possible without a trusted server; see SETUP.md)
  if (select count(*) from public.candidates where job_id = p_job and created_at > now() - interval '1 hour') >= 300 then
    raise exception 'This job is receiving too many applications right now. Please try again later.';
  end if;
  if (select count(*) from public.candidates where lower(email) = em and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Too many attempts. Please try again later.';
  end if;

  select coalesce(array_agg(left(trim(x), 60)), '{}') into cs
    from (select x from unnest(coalesce(p_certs, '{}')) x where trim(x) <> '' limit 20) s;

  -- a previous attempt that never finished uploading does not block a retry
  delete from public.candidates
   where job_id = p_job and lower(email) = em and position = ps and not resume_uploaded;

  path := jr.agency_id::text || '/' || p_job::text || '/' || cid::text || '.pdf';
  begin
    insert into public.candidates (id, job_id, agency_id, name, email, phone, position, exp, loc, pref, certs, resume_key, resume_uploaded)
    values (cid, p_job, jr.agency_id, nm, em, ph, ps, round(p_exp, 1), lc, pf, cs, path, false);
  exception when unique_violation then
    raise exception 'You have already applied for this position.';
  end;
  return jsonb_build_object('candidate_id', cid, 'path', path);
end $$;

-- ===========================================================================
-- 3. RUN THE CLEAN-UP AUTOMATICALLY EVERY 30 MINUTES (pg_cron, free on Supabase)
--    If this block prints a notice instead, enable it: Database -> Extensions -> pg_cron, then run this block again.
--    Without pg_cron the clean-up still runs every time an agency or the admin opens their page.
-- ===========================================================================
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('hirepool-purge-expired-jobs', '*/30 * * * *', 'select public.purge_expired_jobs()');
exception when others then
  raise notice 'pg_cron is not enabled yet: %', sqlerrm;
end $$;
