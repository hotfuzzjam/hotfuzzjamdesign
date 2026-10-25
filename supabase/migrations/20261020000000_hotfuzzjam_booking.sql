-- HOTFUZZJAM Studio — bookings schema
-- Rooms, profiles, bookings with double-booking protection, public roster RPC,
-- self-service cancel, and hooks for confirmation + reminder emails.

create extension if not exists btree_gist with schema extensions;

-- ---------- rooms ----------
create table if not exists public.rooms (
  id          text primary key,
  name        text not null,
  rate_cents  integer not null check (rate_cents > 0),
  capacity    text,
  sort        smallint not null default 0
);
alter table public.rooms enable row level security;
drop policy if exists "rooms are public" on public.rooms;
create policy "rooms are public" on public.rooms for select to anon, authenticated using (true);

insert into public.rooms (id, name, rate_cents, capacity, sort) values
  ('a', 'The Room', 4000, 'Up to 6 players', 1)
on conflict (id) do update set name = excluded.name, rate_cents = excluded.rate_cents, capacity = excluded.capacity;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  band_name   text,
  phone       text,
  created_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "own profile read" on public.profiles;
drop policy if exists "own profile update" on public.profiles;
create policy "own profile read"   on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, band_name, phone)
  values (new.id,
          new.raw_user_meta_data ->> 'full_name',
          new.raw_user_meta_data ->> 'band_name',
          new.raw_user_meta_data ->> 'phone')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- bookings ----------
create table if not exists public.bookings (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id) on delete cascade,
  room_id               text not null references public.rooms(id),
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  status                text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  band_name             text check (char_length(band_name) <= 80),
  notes                 text check (char_length(notes) <= 400),
  contact_email         text,
  confirmation_sent_at  timestamptz,
  reminder_sent_at      timestamptz,
  created_at            timestamptz not null default now(),
  cancelled_at          timestamptz,
  constraint ends_after_start check (ends_at > starts_at),
  -- the core guarantee: two confirmed bookings can never overlap in the same room
  constraint no_double_booking exclude using gist (
    room_id with =, tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed')
);
create index if not exists bookings_user_idx on public.bookings (user_id, starts_at);
create index if not exists bookings_reminder_idx on public.bookings (starts_at) where status = 'confirmed' and reminder_sent_at is null;

alter table public.bookings enable row level security;
drop policy if exists "own bookings read" on public.bookings;
drop policy if exists "own bookings insert" on public.bookings;
create policy "own bookings read"   on public.bookings for select to authenticated using (user_id = (select auth.uid()));
create policy "own bookings insert" on public.bookings for insert to authenticated with check (user_id = (select auth.uid()));
-- no update/delete policies: cancellation goes through cancel_booking()

-- Validate studio rules on insert (Gold Coast time, no DST)
create or replace function public.validate_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ls timestamp := new.starts_at at time zone 'Australia/Brisbane';
  le timestamp := new.ends_at   at time zone 'Australia/Brisbane';
  hrs numeric  := extract(epoch from (new.ends_at - new.starts_at)) / 3600;
begin
  if new.starts_at <= now() then raise exception 'That time has already passed. Pick a later slot.'; end if;
  if new.starts_at > now() + interval '61 days' then raise exception 'Bookings open 60 days ahead.'; end if;
  if date_trunc('hour', ls) <> ls then raise exception 'Sessions start on the hour.'; end if;
  if hrs < 1 or hrs > 4 or hrs <> floor(hrs) then raise exception 'Sessions run 1 to 4 whole hours.'; end if;
  if extract(hour from ls) < 10 or le > date_trunc('day', ls) + interval '23 hours' then
    raise exception 'Studio hours are 10:00 to 23:00.';
  end if;
  new.status := 'confirmed';
  new.confirmation_sent_at := null;
  new.reminder_sent_at := null;
  select u.email into new.contact_email from auth.users u where u.id = new.user_id;
  return new;
end $$;
drop trigger if exists bookings_validate on public.bookings;
create trigger bookings_validate before insert on public.bookings
  for each row execute function public.validate_booking();

-- ---------- public roster (times only, no names) ----------
create or replace function public.get_roster(p_from timestamptz, p_to timestamptz)
returns table (id uuid, room_id text, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select b.id, b.room_id, b.starts_at, b.ends_at
  from public.bookings b
  where b.status = 'confirmed'
    and b.ends_at > p_from
    and b.starts_at < least(p_to, p_from + interval '75 days')
  order by b.starts_at;
$$;
revoke all on function public.get_roster(timestamptz, timestamptz) from public;
grant execute on function public.get_roster(timestamptz, timestamptz) to anon, authenticated;

-- ---------- self-service cancel ----------
create or replace function public.cancel_booking(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.bookings
     set status = 'cancelled', cancelled_at = now()
   where id = p_id
     and user_id = (select auth.uid())
     and status = 'confirmed'
     and starts_at > now();
  if not found then raise exception 'That booking can''t be cancelled. It may have started or already been cancelled.'; end if;
end $$;
revoke all on function public.cancel_booking(uuid) from public;
grant execute on function public.cancel_booking(uuid) to authenticated;
