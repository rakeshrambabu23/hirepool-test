-- HirePool migration: Supabase-only (no Cloudflare Worker / R2)
-- Run AFTER 01_schema.sql, in: Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Safe to re-run. It does not drop tables or data.

-- ===========================================================================
-- 0. SMALL SCHEMA CHANGES
-- ===========================================================================
alter table public.candidates add column if not exists resume_uploaded boolean not null default false;

-- Old R2-era rows (keys start with "resumes/") keep their data but have no openable file any more.
update public.candidates set resume_uploaded = true, resume_key = null
 where resume_uploaded = false and resume_key like 'resumes/%';

-- Jobs can now be Drafts (not public) before being published (Open).
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add  constraint jobs_status_check check (status in ('Draft','Open','Closed'));

create or replace function public.today_ist() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- ===========================================================================
-- 1. ACCESS CODE ENFORCED BY THE DATABASE (not just by browser JavaScript)
--    A logged-in agency only gets data after redeem_access_code() succeeded for THIS login session.
-- ===========================================================================
create table if not exists public.agency_sessions (
  session_id uuid primary key,
  agency_id  uuid not null references public.agencies(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.code_failures (
  user_id uuid not null,
  at      timestamptz not null default now()
);
alter table public.agency_sessions enable row level security;
alter table public.code_failures   enable row level security;
revoke all on public.agency_sessions, public.code_failures from anon, authenticated;

create or replace function public.my_agency_id()
returns uuid language sql stable security definer set search_path = public as $$
  select a.id
    from public.agencies a
    join public.agency_sessions s on s.agency_id = a.id
   where a.user_id = auth.uid()
     and a.status = 'Active'
     and a.expires >= public.today_ist()
     and s.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid
   limit 1;
$$;

create or replace function public.session_ok()
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_agency_id() is not null;
$$;

create or replace function public.redeem_access_code(p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  a public.agencies;
  sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  if auth.uid() is null or sid is null then return false; end if;
  delete from public.code_failures where at < now() - interval '1 day';
  if (select count(*) from public.code_failures
       where user_id = auth.uid() and at > now() - interval '15 minutes') >= 8 then
    raise exception 'Too many attempts. Try again in 15 minutes.';
  end if;
  select * into a from public.agencies
   where user_id = auth.uid() and status = 'Active' and expires >= public.today_ist()
     and code is not null and code = upper(trim(coalesce(p_code, '')));
  if not found then
    insert into public.code_failures (user_id) values (auth.uid());
    return false;
  end if;
  delete from public.agency_sessions where created_at < now() - interval '60 days';
  insert into public.agency_sessions (session_id, agency_id) values (sid, a.id)
    on conflict (session_id) do update set agency_id = excluded.agency_id;
  return true;
end $$;

-- Agencies can no longer read their own access code through the API (admin sends it to them).
revoke select on public.agencies from authenticated;
grant  select (id, user_id, name, email, logo_key, plan, status, expires, requested, created_at)
  on public.agencies to authenticated;

-- A new code (or suspension) kills all existing login sessions of that agency.
create or replace function public.admin_regen_code(p_id uuid)
returns public.agencies language plpgsql security definer set search_path = public as $$
declare r public.agencies;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.agencies set code = public.make_code()
   where id = p_id and status in ('Active','Suspended')
   returning * into r;
  if not found then raise exception 'agency not found or not approved yet'; end if;
  delete from public.agency_sessions where agency_id = p_id;
  return r;
end $$;

-- ===========================================================================
-- 2. TABLE POLICIES (agency can edit and delete its own jobs/candidates)
-- ===========================================================================
drop policy if exists jobs_all on public.jobs;
create policy jobs_all on public.jobs for all to authenticated
  using (agency_id = public.my_agency_id())
  with check (agency_id = public.my_agency_id());
grant delete on public.jobs to authenticated;
grant update (heading, country, sector, positions, status, urgent, deadline, description)
  on public.jobs to authenticated;

-- Agencies only see applications whose resume upload was completed.
drop policy if exists cand_select on public.candidates;
create policy cand_select on public.candidates for select to authenticated
  using (agency_id = public.my_agency_id() and resume_uploaded);
drop policy if exists cand_delete on public.candidates;
create policy cand_delete on public.candidates for delete to authenticated
  using (agency_id = public.my_agency_id());
grant delete on public.candidates to authenticated;

-- ===========================================================================
-- 3. PUBLIC APPLICATION FLOW (applicants have no account)
--    1) public_job()            read the form details of ONE open job
--    2) submit_application()    validate + create a pending row, returns the upload path
--    3) browser uploads the PDF to that exact path (Storage policy below allows only that)
--    4) finalize_application()  confirms the file exists, records its real size
-- ===========================================================================
create or replace function public.public_job(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  select j.id, j.heading, j.positions, a.name into r
    from public.jobs j join public.agencies a on a.id = j.agency_id
   where j.id = p_id and j.status = 'Open' and a.status = 'Active'
     and a.expires >= public.today_ist() and (j.deadline is null or j.deadline >= public.today_ist());
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
     and a.expires >= public.today_ist() and (j.deadline is null or j.deadline >= public.today_ist());
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

-- Storage policy helper: may an anonymous browser write THIS exact object path right now?
create or replace function public.can_upload_resume(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.candidates c
     where c.resume_key = p_name and not c.resume_uploaded
       and c.created_at > now() - interval '30 minutes');
$$;

create or replace function public.finalize_application(p_candidate uuid)
returns boolean language plpgsql security definer set search_path = public, storage as $$
declare k text; sz numeric;
begin
  select resume_key into k from public.candidates
   where id = p_candidate and not resume_uploaded and created_at > now() - interval '30 minutes';
  if k is null then return false; end if;
  select (metadata ->> 'size')::numeric into sz from storage.objects where bucket_id = 'resumes' and name = k;
  if sz is null or sz < 100 or sz > 20971520 then return false; end if;
  update public.candidates set resume_uploaded = true, resume_size = round(sz / 1048576.0, 2) where id = p_candidate;
  return true;
end $$;

-- ===========================================================================
-- 4. AGENCY LOGO + ADMIN DASHBOARD FUNCTIONS
-- ===========================================================================
create or replace function public.set_my_logo(p_key text)
returns void language plpgsql security definer set search_path = public as $$
declare aid uuid := public.my_agency_id();
begin
  if aid is null then raise exception 'forbidden'; end if;
  if p_key !~ ('^' || aid::text || '/logo-[0-9]+\.(png|jpg)$') then raise exception 'invalid logo path'; end if;
  update public.agencies set logo_key = p_key where id = aid;
end $$;

create or replace function public.admin_list_agencies()
returns setof public.agencies language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select * from public.agencies order by created_at desc;
end $$;

create or replace function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = public, storage as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'agencies',     (select count(*) from public.agencies where status <> 'Pending'),
    'active',       (select count(*) from public.agencies where status = 'Active'),
    'suspended',    (select count(*) from public.agencies where status = 'Suspended'),
    'pending',      (select count(*) from public.agencies where status = 'Pending'),
    'jobs',         (select count(*) from public.jobs),
    'applications', (select count(*) from public.candidates where resume_uploaded),
    'storage_bytes',(select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects where bucket_id = 'resumes'),
    'new_agencies_7d', (select count(*) from public.agencies where created_at > now() - interval '7 days'),
    'new_jobs_7d',     (select count(*) from public.jobs where created_at > now() - interval '7 days'),
    'new_apps_7d',     (select count(*) from public.candidates where resume_uploaded and created_at > now() - interval '7 days'));
end $$;

create or replace function public.admin_agency_usage()
returns table (agency_id uuid, jobs bigint, applications bigint, storage_bytes bigint)
language plpgsql stable security definer set search_path = public, storage as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select a.id,
           (select count(*) from public.jobs j where j.agency_id = a.id),
           (select count(*) from public.candidates c where c.agency_id = a.id and c.resume_uploaded),
           (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o
             where o.bucket_id = 'resumes' and split_part(o.name, '/', 1) = a.id::text)
      from public.agencies a;
end $$;

-- Function permissions
revoke all on function
  public.redeem_access_code(text), public.session_ok(), public.set_my_logo(text),
  public.admin_list_agencies(), public.admin_stats(), public.admin_agency_usage(),
  public.public_job(uuid), public.finalize_application(uuid), public.can_upload_resume(text),
  public.submit_application(uuid,text,text,text,text,numeric,text,text,text[],boolean)
  from public, anon, authenticated;
grant execute on function
  public.redeem_access_code(text), public.session_ok(), public.set_my_logo(text),
  public.admin_list_agencies(), public.admin_stats(), public.admin_agency_usage()
  to authenticated;
grant execute on function
  public.public_job(uuid), public.finalize_application(uuid), public.can_upload_resume(text),
  public.submit_application(uuid,text,text,text,text,numeric,text,text,text[],boolean)
  to anon, authenticated;

-- ===========================================================================
-- 5. STORAGE: private "resumes" bucket + public "logos" bucket
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 20971520, allowed_mime_types = array['application/pdf'];

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 524288, array['image/png','image/jpeg'])
on conflict (id) do update
  set public = true, file_size_limit = 524288, allowed_mime_types = array['image/png','image/jpeg'];

-- Resumes: object path is  <agency_id>/<job_id>/<candidate_id>.pdf
-- No UPDATE policy exists, so nobody can overwrite or replace a file.
drop policy if exists "resumes_applicant_upload" on storage.objects;
create policy "resumes_applicant_upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'resumes' and public.can_upload_resume(name));

drop policy if exists "resumes_agency_read" on storage.objects;
create policy "resumes_agency_read" on storage.objects for select to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = public.my_agency_id()::text);

drop policy if exists "resumes_agency_delete" on storage.objects;
create policy "resumes_agency_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = public.my_agency_id()::text);

-- Logos: public to read (bucket is public); only the owning agency can write inside its own folder.
drop policy if exists "logos_agency_insert" on storage.objects;
create policy "logos_agency_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and (storage.foldername(name))[1] = public.my_agency_id()::text);
drop policy if exists "logos_agency_delete" on storage.objects;
create policy "logos_agency_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = public.my_agency_id()::text);
