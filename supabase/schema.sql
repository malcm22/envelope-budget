-- Envelope Budget — database setup.
-- Run once in a new Supabase project (SQL editor, or `supabase db push`).
-- Everything a household sees lives in `docs`; bank tokens and push keys are server-only.

create extension if not exists pgcrypto;

-- ---------- households & membership ----------
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our budget',
  created_at timestamptz not null default now()
);

create table if not exists members (
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index if not exists members_user_idx on members(user_id);

create table if not exists invites (
  household_id uuid not null references households(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, email)
);

create or replace function is_member(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where household_id = hid and user_id = auth.uid());
$$;

-- ---------- the app's data (buckets, purchases, paydays, moves, settings) ----------
create table if not exists docs (
  household_id uuid not null references households(id) on delete cascade,
  coll text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (household_id, coll, id)
);
alter table docs replica identity full;

-- ---------- server-only tables ----------
create table if not exists plaid_items (
  item_id text primary key,
  household_id uuid not null references households(id) on delete cascade,
  access_token text not null,
  cursor text,
  institution text,
  start_date date not null default current_date,
  last_sync timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists push_subs (
  endpoint text primary key,
  household_id uuid not null references households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  person_key text,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create table if not exists locks (
  household_id uuid not null,
  name text not null,
  holder text,
  expires_at timestamptz not null,
  primary key (household_id, name)
);

create table if not exists server_config (
  key text primary key,
  value text not null
);

-- ---------- row level security ----------
alter table households enable row level security;
alter table members enable row level security;
alter table invites enable row level security;
alter table docs enable row level security;
alter table plaid_items enable row level security;
alter table push_subs enable row level security;
alter table locks enable row level security;
alter table server_config enable row level security;

drop policy if exists hh_read on households;
create policy hh_read on households for select to authenticated using (is_member(id));
drop policy if exists hh_update on households;
create policy hh_update on households for update to authenticated using (is_member(id)) with check (is_member(id));

drop policy if exists members_read on members;
create policy members_read on members for select to authenticated using (is_member(household_id));
drop policy if exists members_delete on members;
create policy members_delete on members for delete to authenticated using (is_member(household_id));

drop policy if exists invites_all on invites;
create policy invites_all on invites for all to authenticated using (is_member(household_id)) with check (is_member(household_id));

drop policy if exists docs_all on docs;
create policy docs_all on docs for all to authenticated using (is_member(household_id)) with check (is_member(household_id));

-- plaid_items, push_subs, locks, server_config: no policies = no direct client access (server/RPC only).

-- ---------- RPCs used by the app ----------
-- Find (or join by invite, or create) the signed-in person's household.
create or replace function bootstrap() returns uuid
language plpgsql security definer set search_path = public as $$
declare hid uuid; em text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select household_id into hid from members where user_id = auth.uid() order by created_at limit 1;
  if hid is not null then return hid; end if;
  select lower(email) into em from auth.users where id = auth.uid();
  select household_id into hid from invites where lower(email) = em order by created_at limit 1;
  if hid is null then
    insert into households default values returning id into hid;
  else
    delete from invites where household_id = hid and lower(email) = em;
  end if;
  insert into members(household_id, user_id, email) values (hid, auth.uid(), em) on conflict do nothing;
  return hid;
end $$;

-- Merge fields into an existing document (fails if it doesn't exist).
create or replace function doc_update(hid uuid, c text, i text, patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update docs set data = data || patch, updated_at = now()
   where household_id = hid and coll = c and id = i;
  if not found then raise exception 'document does not exist' using errcode = 'P0002'; end if;
end $$;

-- Short cooperative lease so two phones don't add the same payday at once.
create or replace function try_lock(hid uuid, lname text, who text, ttl_ms int) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(hid) then return false; end if;
  insert into locks(household_id, name, holder, expires_at)
       values (hid, lname, who, now() + make_interval(secs => ttl_ms / 1000.0))
  on conflict (household_id, name) do update
       set holder = excluded.holder, expires_at = excluded.expires_at
     where locks.expires_at < now() or locks.holder = excluded.holder;
  return found;
end $$;

-- Save this phone's notification subscription.
create or replace function save_push_sub(hid uuid, ep text, k_p256dh text, k_auth text, pkey text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_member(hid) then raise exception 'not a member'; end if;
  insert into push_subs(endpoint, household_id, user_id, person_key, p256dh, auth)
       values (ep, hid, auth.uid(), pkey, k_p256dh, k_auth)
  on conflict (endpoint) do update set household_id = excluded.household_id, user_id = excluded.user_id,
       person_key = excluded.person_key, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function delete_push_sub(ep text) returns void
language sql security definer set search_path = public as $$
  delete from push_subs where endpoint = ep and user_id = auth.uid();
$$;

-- What the app may know about the bank link (never the token).
create or replace function bank_status(hid uuid) returns table(item_id text, institution text, last_sync timestamptz, last_error text, start_date date)
language sql stable security definer set search_path = public as $$
  select item_id, institution, last_sync, last_error, start_date from plaid_items where household_id = hid and is_member(hid);
$$;

create or replace function my_push_count(hid uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from push_subs where household_id = hid and user_id = auth.uid();
$$;

-- Table access for signed-in users (row level security above still limits them to their own household).
grant usage on schema public to authenticated;
grant select, update on households to authenticated;
grant select, delete on members to authenticated;
grant select, insert, update, delete on invites to authenticated;
grant select, insert, update, delete on docs to authenticated;
revoke all on plaid_items, push_subs, locks, server_config from anon, authenticated;

revoke execute on function bootstrap, doc_update, try_lock, save_push_sub, delete_push_sub, bank_status, my_push_count, is_member from public, anon;
grant execute on function bootstrap, doc_update, try_lock, save_push_sub, delete_push_sub, bank_status, my_push_count, is_member to authenticated;

-- ---------- live updates ----------
do $$ begin
  alter publication supabase_realtime add table docs;
exception when duplicate_object then null; end $$;
