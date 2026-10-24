-- HirePool update 03: mobile number at signup, candidate auto-delete, expired jobs,
-- admin "reactivate with plan", agency logo on the public application form.
-- Run AFTER 01_schema.sql and 02_migration_supabase_only.sql (SQL Editor > New query > Run).
-- Safe to run twice. It does not delete any data.

-- ===========================================================================
-- 1. AGENCY OWNER MOBILE NUMBER (international format, e.g. +919848012345)
--    Strict per-country rules are checked in the signup form. The database
--    accepts only a well-formed international number (+, 8 to 15 digits).
-- ===========================================================================
alter table public.agencies add column if not exists phone text;
alter table public.agencies drop constraint if exists agencies_phone_check;
alter table public.agencies add constraint agencies_phone_check
  check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$');
grant select (phone) on public.agencies to authenticated;   -- own row only (RLS); admin reads through admin_list_agencies()

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m  jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  p  text  := m->>'plan';
  ph text  := regexp_replace(coalesce(m->>'phone', ''), '[ -]', '', 'g');
begin
  if m ? 'agency_name' then
    if ph !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Enter a valid mobile number.'; end if;
    insert into public.agencies (user_id, name, email, plan, logo_key, phone)
    values (
      new.id,
      left(trim(m->>'agency_name'), 120),
      lower(new.email),
      case when p in ('1 month','3 months','6 months') then p else '1 month' end,
      case when (m->>'logo_key') ~ '^[a-f0-9-]{36}\.(png|jpg)$' then m->>'logo_key' end,
      ph);
  end if;
  return new;
end $$;

-- ===========================================================================
-- 2. CANDIDATE RETENTION: delete after 7 days; shortlisting adds 7 more days (once)
--    The real deletion (resume files + rows) is done by the "purge-expired" Edge Function,
--    because files can only be removed through the Storage API, not by SQL.
-- ===========================================================================
alter table public.candidates add column if not exists expires_at  timestamptz;
alter table public.candidates add column if not exists extended_at timestamptz;

-- Existing candidates get a fresh 7 days from now so nothing is deleted by surprise.
update public.candidates set expires_at = greatest(created_at + interval '7 days', now() + interval '7 days')
 where expires_at is null;
alter table public.candidates alter column expires_at set not null;
alter table public.candidates alter column expires_at set default (now() + interval '7 days');
create index if not exists cand_expires_idx on public.candidates (expires_at);

-- First time a candidate reaches Shortlisted (or later), keep them 7 more days. Only once.
create or replace function public.candidate_keep_alive()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status
     and new.status in ('Shortlisted','Interview','Selected')
     and old.extended_at is null then
    new.expires_at  := old.expires_at + interval '7 days';
    new.extended_at := now();
  end if;
  return new;
end $$;
drop trigger if exists cand_keep_alive on public.candidates;
create trigger cand_keep_alive before update of status on public.candidates
  for each row execute function public.candidate_keep_alive();

-- Agencies stop seeing (and cannot change) candidates after the deadline, even before the cleanup runs.
drop policy if exists cand_select on public.candidates;
create policy cand_select on public.candidates for select to authenticated
  using (agency_id = public.my_agency_id() and resume_uploaded and expires_at > now());
drop policy if exists cand_update on public.candidates;
create policy cand_update on public.candidates for update to authenticated
  using (agency_id = public.my_agency_id() and expires_at > now())
  with check (agency_id = public.my_agency_id());

-- ===========================================================================
-- 3. JOB POSTS: closed on the last date, removed once their applicants are gone
--    (submit_application / public_job already refuse a job whose last date has passed)
-- ===========================================================================
create or replace function public.purge_expired_jobs()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with gone as (
    delete from public.jobs j
     where j.deadline is not null and j.deadline < public.today_ist()
       and not exists (select 1 from public.candidates c where c.job_id = j.id)
    returning 1)
  select count(*) into n from gone;
  return n;
end $$;
revoke all on function public.purge_expired_jobs() from public, anon, authenticated;
grant execute on function public.purge_expired_jobs() to service_role;

-- One daily alert e-mail per agency at most (used by the Edge Function)
create table if not exists public.alert_log (
  agency_id uuid not null references public.agencies(id) on delete cascade,
  day       date not null,
  sent      boolean not null default false,
  primary key (agency_id, day)
);
alter table public.alert_log enable row level security;
revoke all on public.alert_log from anon, authenticated;

-- ===========================================================================
-- 4. ADMIN: REACTIVATE = CONFIRM THE PLAN AGAIN, TERM STARTS TODAY
-- ===========================================================================
create or replace function public.admin_approve(p_id uuid, p_months int)
returns public.agencies language plpgsql security definer set search_path = public as $$
declare r public.agencies;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_months not in (1,3,6) then raise exception 'plan must be 1, 3 or 6 months'; end if;
  update public.agencies
     set status = 'Active',
         code = public.make_code(),
         plan = p_months || case when p_months = 1 then ' month' else ' months' end,
         expires = (public.today_ist() + make_interval(months => p_months))::date
   where id = p_id
   returning * into r;
  if not found then raise exception 'agency not found'; end if;
  return r;
end $$;

-- Suspending is the only thing this function does now. Activating needs a plan: admin_reactivate().
create or replace function public.admin_set_status(p_id uuid, p_status text)
returns public.agencies language plpgsql security definer set search_path = public as $$
declare r public.agencies;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_status <> 'Suspended' then raise exception 'Use Reactivate and confirm a plan to activate an agency.'; end if;
  update public.agencies set status = 'Suspended'
   where id = p_id and code is not null and status = 'Active'
   returning * into r;
  if not found then raise exception 'only an active agency can be suspended'; end if;
  delete from public.agency_sessions where agency_id = p_id;
  return r;
end $$;

create or replace function public.admin_reactivate(p_id uuid, p_months int)
returns public.agencies language plpgsql security definer set search_path = public as $$
declare r public.agencies;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_months not in (1,3,6) then raise exception 'plan must be 1, 3 or 6 months'; end if;
  update public.agencies
     set status = 'Active',
         plan = p_months || case when p_months = 1 then ' month' else ' months' end,
         expires = (public.today_ist() + make_interval(months => p_months))::date   -- the new term starts today
   where id = p_id and status = 'Suspended'
   returning * into r;
  if not found then raise exception 'only a suspended agency can be reactivated'; end if;
  delete from public.agency_sessions where agency_id = p_id;   -- they log in again with their access code
  return r;
end $$;
revoke all on function public.admin_reactivate(uuid,int) from public, anon;
grant execute on function public.admin_reactivate(uuid,int) to authenticated;

-- ===========================================================================
-- 5. PUBLIC APPLICATION FORM SHOWS THE AGENCY LOGO
-- ===========================================================================
create or replace function public.public_job(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  select j.id, j.heading, j.positions, a.name, a.logo_key into r
    from public.jobs j join public.agencies a on a.id = j.agency_id
   where j.id = p_id and j.status = 'Open' and a.status = 'Active'
     and a.expires >= public.today_ist() and (j.deadline is null or j.deadline >= public.today_ist());
  if not found then return null; end if;
  return jsonb_build_object('id', r.id, 'heading', r.heading, 'positions', to_jsonb(r.positions),
                            'agency', r.name, 'logo', r.logo_key);
end $$;
