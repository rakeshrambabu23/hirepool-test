-- HirePool database schema for Supabase (PostgreSQL)
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Safe to re-run: objects use "if not exists" / "create or replace" where possible.

-- ---------------------------------------------------------------------------
-- 1. AGENCIES + ADMINS
-- ---------------------------------------------------------------------------

create table if not exists public.agencies (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique not null references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 2 and 120),
  email       text not null,
  logo_key    text,                       -- logo file name stored in Cloudflare R2 (logos/<key>)
  plan        text not null default '1 month' check (plan in ('1 month','3 months','6 months')),
  status      text not null default 'Pending' check (status in ('Pending','Active','Suspended','Rejected')),
  code        text unique,                -- access code, created by admin_approve()
  expires     date,
  requested   date not null default current_date,
  created_at  timestamptz not null default now()
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 2. HELPER FUNCTIONS (used by the security policies)
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Returns the agency id of the logged-in user, only while the agency is Active and not expired.
create or replace function public.my_agency_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.agencies
  where user_id = auth.uid() and status = 'Active' and expires >= current_date
  limit 1;
$$;

-- Access code generator (same alphabet as before, cryptographically random).
create or replace function public.make_code()
returns text language plpgsql volatile set search_path = public, extensions as $$
declare
  alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea; s text; c text; i int;
begin
  loop
    b := gen_random_bytes(8); s := '';
    for i in 0..7 loop
      s := s || substr(alpha, (get_byte(b, i) % 31) + 1, 1);
    end loop;
    c := 'HP-' || substr(s, 1, 4) || '-' || substr(s, 5, 4);
    exit when not exists (select 1 from public.agencies where code = c);
  end loop;
  return c;
end $$;
revoke all on function public.make_code() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. JOBS, CANDIDATES, NOTES
-- ---------------------------------------------------------------------------

create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  agency_id   uuid not null default public.my_agency_id() references public.agencies(id) on delete cascade,
  heading     text not null check (char_length(heading) between 1 and 120),
  country     text not null check (char_length(country) between 1 and 80),
  sector      text not null check (char_length(sector) between 1 and 80),
  positions   text[] not null check (cardinality(positions) between 1 and 60),
  status      text not null default 'Open' check (status in ('Open','Closed')),
  urgent      boolean not null default false,
  deadline    date,
  description text check (char_length(description) <= 4000),
  posted      date not null default current_date,
  created_at  timestamptz not null default now()
);
create index if not exists jobs_agency_idx on public.jobs (agency_id, created_at desc);

create table if not exists public.candidates (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs(id) on delete cascade,
  agency_id    uuid not null references public.agencies(id) on delete cascade,
  name         text not null check (char_length(name) between 2 and 100),
  email        text not null check (char_length(email) <= 120),
  phone        text not null check (char_length(phone) <= 20),
  position     text not null check (char_length(position) <= 100),
  exp          numeric(4,1) not null check (exp between 0 and 50),
  loc          text check (char_length(loc) <= 100),
  pref         text check (char_length(pref) <= 100),
  certs        text[] not null default '{}',
  status       text not null default 'New' check (status in ('New','Reviewed','Shortlisted','Interview','Selected','Rejected')),
  resume_key   text,                        -- object key in the private Cloudflare R2 bucket
  resume_size  numeric(5,2),                -- MB
  consent_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists cand_agency_idx on public.candidates (agency_id, created_at desc);
create index if not exists cand_job_idx on public.candidates (job_id);
-- the same person cannot apply twice for the same position of the same job
create unique index if not exists cand_unique_apply on public.candidates (job_id, lower(email), position);

create table if not exists public.notes (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references public.candidates(id) on delete cascade,
  agency_id     uuid not null default public.my_agency_id() references public.agencies(id) on delete cascade,
  text          text not null check (char_length(text) between 1 and 2000),
  created_at    timestamptz not null default now()
);
create index if not exists notes_cand_idx on public.notes (candidate_id, created_at);

-- ---------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
--    Every agency only sees its own rows. The anon (not logged in) role sees nothing.
--    Public applications are written by the Cloudflare Worker using the service role key.
-- ---------------------------------------------------------------------------

alter table public.agencies   enable row level security;
alter table public.admins     enable row level security;
alter table public.jobs       enable row level security;
alter table public.candidates enable row level security;
alter table public.notes      enable row level security;

revoke all on public.agencies, public.admins, public.jobs, public.candidates, public.notes from anon;
revoke insert, update, delete on public.agencies from authenticated;   -- changed only by admin_* functions
revoke all on public.admins from authenticated;                        -- read only through is_admin()

-- agencies: owner reads own row (even while Pending), admin reads all
drop policy if exists agencies_select on public.agencies;
create policy agencies_select on public.agencies for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- jobs: full control of own jobs while the agency is Active
drop policy if exists jobs_all on public.jobs;
create policy jobs_all on public.jobs for all to authenticated
  using (agency_id = public.my_agency_id())
  with check (agency_id = public.my_agency_id());
revoke delete on public.jobs from authenticated;           -- deleting goes through the Worker (also removes resumes)
revoke update on public.jobs from authenticated;
grant  update (status) on public.jobs to authenticated;

-- candidates: agency can read and change the status of its own candidates. New rows only from the Worker.
drop policy if exists cand_select on public.candidates;
create policy cand_select on public.candidates for select to authenticated
  using (agency_id = public.my_agency_id());
drop policy if exists cand_update on public.candidates;
create policy cand_update on public.candidates for update to authenticated
  using (agency_id = public.my_agency_id()) with check (agency_id = public.my_agency_id());
revoke insert, delete, update on public.candidates from authenticated;
grant  update (status) on public.candidates to authenticated;

-- notes: agency reads and adds notes on its own candidates
drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select to authenticated
  using (agency_id = public.my_agency_id());
drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes for insert to authenticated
  with check (
    agency_id = public.my_agency_id()
    and exists (select 1 from public.candidates c where c.id = candidate_id and c.agency_id = public.my_agency_id())
  );
revoke update, delete on public.notes from authenticated;

-- ---------------------------------------------------------------------------
-- 5. NEW SIGNUP -> PENDING AGENCY ROW (trigger on auth.users)
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  p text := m->>'plan';
begin
  if m ? 'agency_name' then
    insert into public.agencies (user_id, name, email, plan, logo_key)
    values (
      new.id,
      left(trim(m->>'agency_name'), 120),
      lower(new.email),
      case when p in ('1 month','3 months','6 months') then p else '1 month' end,
      case when (m->>'logo_key') ~ '^[a-f0-9-]{36}\.(png|jpg)$' then m->>'logo_key' end
    );
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 6. PLATFORM ADMIN FUNCTIONS (only callable by users listed in public.admins)
-- ---------------------------------------------------------------------------

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
         expires = (current_date + make_interval(months => p_months))::date
   where id = p_id
   returning * into r;
  if not found then raise exception 'agency not found'; end if;
  return r;
end $$;

create or replace function public.admin_reject(p_id uuid)
returns public.agencies language plpgsql security definer set search_path = public as $$
declare r public.agencies;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.agencies set status = 'Rejected' where id = p_id and status = 'Pending' returning * into r;
  if not found then raise exception 'only pending requests can be rejected'; end if;
  return r;
end $$;

create or replace function public.admin_set_status(p_id uuid, p_status text)
returns public.agencies language plpgsql security definer set search_path = public as $$
declare r public.agencies;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if p_status not in ('Active','Suspended') then raise exception 'status must be Active or Suspended'; end if;
  update public.agencies set status = p_status
   where id = p_id and code is not null and status in ('Active','Suspended')
   returning * into r;
  if not found then raise exception 'agency not found or not approved yet'; end if;
  return r;
end $$;

create or replace function public.admin_regen_code(p_id uuid)
returns public.agencies language plpgsql security definer set search_path = public as $$
declare r public.agencies;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.agencies set code = public.make_code()
   where id = p_id and status in ('Active','Suspended')
   returning * into r;
  if not found then raise exception 'agency not found or not approved yet'; end if;
  return r;
end $$;

revoke all on function public.admin_approve(uuid,int), public.admin_reject(uuid),
              public.admin_set_status(uuid,text), public.admin_regen_code(uuid) from public, anon;
grant execute on function public.admin_approve(uuid,int), public.admin_reject(uuid),
              public.admin_set_status(uuid,text), public.admin_regen_code(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. CREATE YOUR PLATFORM ADMIN (do this AFTER the admin user exists)
--    a) Supabase Dashboard -> Authentication -> Users -> Add user (tick "Auto confirm user")
--    b) Then run this one line with that email:
--
--    insert into public.admins (user_id) select id from auth.users where email = 'YOU@EXAMPLE.COM';
-- ---------------------------------------------------------------------------
