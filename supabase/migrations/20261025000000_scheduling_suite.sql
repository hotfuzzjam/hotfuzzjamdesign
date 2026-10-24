-- HOTFUZZJAM Studio — scheduling suite
-- Payments & deposits (Stripe), coupons, gift certificates, waitlist, reschedule/cancel links,
-- SMS opt-in, follow-ups, owner settings, block-outs and admin access.
-- Runs after 20261020000000_hotfuzzjam_booking.sql.

-- ================================================================
-- Owner settings (one row). Public can read: nothing in here is secret.
-- ================================================================
create table if not exists public.settings (
  id                    smallint primary key default 1 check (id = 1),
  open_hour             smallint not null default 10 check (open_hour between 0 and 23),
  close_hour            smallint not null default 23 check (close_hour between 1 and 24),
  max_hours             smallint not null default 4  check (max_hours between 1 and 12),
  days_ahead            smallint not null default 60 check (days_ahead between 1 and 365),
  cancel_cutoff_hours   smallint not null default 24 check (cancel_cutoff_hours between 0 and 168),
  -- full: pay everything online · deposit: pay deposit_pct online · choice: client picks · on_arrival: pay at the studio
  payment_mode          text not null default 'choice' check (payment_mode in ('full','deposit','choice','on_arrival')),
  deposit_pct           smallint not null default 50 check (deposit_pct between 1 and 100),
  hold_minutes          smallint not null default 30 check (hold_minutes between 30 and 120),
  followup_delay_hours  smallint not null default 2  check (followup_delay_hours between 0 and 72),
  sms_enabled           boolean not null default false,
  updated_at            timestamptz not null default now(),
  constraint hours_order check (close_hour > open_hour)
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- single-room studio: drop any unused extra rooms
delete from public.rooms r where r.id <> 'a' and not exists (select 1 from public.bookings b where b.room_id = r.id);
alter table public.settings enable row level security;

-- ================================================================
-- Admins
-- ================================================================
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

drop policy if exists "admins see admins" on public.admins;
create policy "admins see admins" on public.admins for select to authenticated using ((select public.is_admin()));

drop policy if exists "settings are public" on public.settings;
drop policy if exists "admins edit settings" on public.settings;
create policy "settings are public" on public.settings for select to anon, authenticated using (true);
create policy "admins edit settings" on public.settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "admins edit rooms" on public.rooms;
create policy "admins edit rooms" on public.rooms for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "admins read profiles" on public.profiles;
create policy "admins read profiles" on public.profiles for select to authenticated using ((select public.is_admin()));

-- ================================================================
-- Bookings: payment, hold, manage link, SMS, follow-up
-- ================================================================
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check check (status in ('pending','confirmed','cancelled'));

-- owner-made phone/walk-in bookings may not have a client account
alter table public.bookings alter column user_id drop not null;

alter table public.bookings
  add column if not exists contact_name         text check (char_length(contact_name) <= 80),
  add column if not exists amount_cents         integer not null default 0,
  add column if not exists discount_cents       integer not null default 0,
  add column if not exists gift_applied_cents   integer not null default 0,
  add column if not exists due_cents            integer not null default 0,
  add column if not exists charge_now_cents     integer not null default 0,
  add column if not exists paid_cents           integer not null default 0,
  add column if not exists refunded_cents       integer not null default 0,
  add column if not exists studio_paid_cents    integer not null default 0,     -- cash/EFTPOS taken at the studio (never refunded through Stripe)
  add column if not exists pay_mode             text not null default 'on_arrival' check (pay_mode in ('full','deposit','on_arrival','free')),
  add column if not exists payment_status       text not null default 'unpaid' check (payment_status in ('unpaid','deposit_paid','paid','refunded','part_refunded')),
  add column if not exists coupon_code          text,
  add column if not exists gift_code            text,
  add column if not exists stripe_session_id    text,
  add column if not exists stripe_payment_intent text,
  add column if not exists manage_token         uuid not null default gen_random_uuid(),
  add column if not exists hold_expires_at      timestamptz,
  add column if not exists sms_opt_in           boolean not null default false,
  add column if not exists phone                text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column if not exists sms_sent_at          timestamptz,
  add column if not exists followup_sent_at     timestamptz,
  add column if not exists reschedule_count     smallint not null default 0,
  add column if not exists source               text not null default 'web' check (source in ('web','admin'));

create unique index if not exists bookings_manage_token_idx on public.bookings (manage_token);
create index if not exists bookings_pending_idx on public.bookings (hold_expires_at) where status = 'pending';
create index if not exists bookings_followup_idx on public.bookings (ends_at) where status = 'confirmed' and followup_sent_at is null;

-- a pending (awaiting payment) booking holds its slot exactly like a confirmed one
alter table public.bookings drop constraint if exists no_double_booking;
alter table public.bookings add constraint no_double_booking exclude using gist (
  room_id with =, tstzrange(starts_at, ends_at, '[)') with &&
) where (status in ('pending','confirmed'));

-- bookings are now created only by the create-checkout function (service role) or by admins,
-- so prices, coupons and gift balances can't be set from the browser
drop policy if exists "own bookings insert" on public.bookings;
drop policy if exists "admins read bookings" on public.bookings;
drop policy if exists "admins update bookings" on public.bookings;
create policy "admins read bookings"   on public.bookings for select to authenticated using ((select public.is_admin()));
create policy "admins update bookings" on public.bookings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ================================================================
-- Block-outs (owner closes the room: maintenance, holidays, private use)
-- ================================================================
create table if not exists public.blackouts (
  id          uuid primary key default gen_random_uuid(),
  room_id     text references public.rooms(id),       -- null = whole studio
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text check (char_length(reason) <= 120),
  created_at  timestamptz not null default now(),
  constraint blackout_order check (ends_at > starts_at)
);
create index if not exists blackouts_range_idx on public.blackouts using gist (tstzrange(starts_at, ends_at, '[)'));
alter table public.blackouts enable row level security;
drop policy if exists "admins manage blackouts" on public.blackouts;
create policy "admins manage blackouts" on public.blackouts for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ================================================================
-- Studio rules, now driven by settings and block-outs (insert + time changes)
-- ================================================================
create or replace function public.validate_booking()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  s   public.settings;
  ls  timestamp := new.starts_at at time zone 'Australia/Brisbane';
  le  timestamp := new.ends_at   at time zone 'Australia/Brisbane';
  hrs numeric   := extract(epoch from (new.ends_at - new.starts_at)) / 3600;
begin
  if tg_op = 'UPDATE' and new.starts_at = old.starts_at and new.ends_at = old.ends_at then
    return new;                       -- status/payment updates skip the time rules
  end if;
  select * into s from public.settings where id = 1;
  if new.starts_at <= now() then raise exception 'That time has already passed. Pick a later slot.'; end if;
  if new.source = 'web' and new.starts_at > now() + make_interval(days => s.days_ahead + 1) then
    raise exception 'Bookings open % days ahead.', s.days_ahead;
  end if;
  if date_trunc('hour', ls) <> ls then raise exception 'Sessions start on the hour.'; end if;
  if hrs < 1 or hrs <> floor(hrs) or (new.source = 'web' and hrs > s.max_hours) then
    raise exception 'Sessions run 1 to % whole hours.', s.max_hours;
  end if;
  if extract(hour from ls) < s.open_hour or le > date_trunc('day', ls) + make_interval(hours => s.close_hour) then
    raise exception 'Studio hours are %:00 to %:00.', lpad(s.open_hour::text, 2, '0'), lpad(s.close_hour::text, 2, '0');
  end if;
  if exists (select 1 from public.blackouts x
             where (x.room_id is null or x.room_id = new.room_id)
               and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')) then
    raise exception 'The studio is closed for part of that time. Pick another slot.' using errcode = '23P01';
  end if;
  if tg_op = 'INSERT' then
    new.confirmation_sent_at := null;
    new.reminder_sent_at := null;
    if new.contact_email is null then
      select u.email into new.contact_email from auth.users u where u.id = new.user_id;
    end if;
  else
    new.reminder_sent_at := null;     -- a moved session gets a fresh reminder and follow-up
    new.sms_sent_at := null;
    new.followup_sent_at := null;
  end if;
  return new;
end $$;
drop trigger if exists bookings_validate on public.bookings;
create trigger bookings_validate before insert or update of starts_at, ends_at on public.bookings
  for each row execute function public.validate_booking();

-- ================================================================
-- Public roster: bookings and block-outs as anonymous busy blocks
-- ================================================================
drop function if exists public.get_roster(timestamptz, timestamptz);
create or replace function public.get_roster(p_from timestamptz, p_to timestamptz)
returns table (id uuid, room_id text, starts_at timestamptz, ends_at timestamptz, kind text)
language sql stable security definer set search_path = '' as $$
  select b.id, b.room_id, b.starts_at, b.ends_at, 'booking'::text
    from public.bookings b
   where b.status in ('pending','confirmed')
     and b.ends_at > p_from and b.starts_at < least(p_to, p_from + interval '75 days')
  union all
  select x.id, r.id, x.starts_at, x.ends_at, 'closed'::text
    from public.blackouts x
    join public.rooms r on x.room_id is null or r.id = x.room_id
   where x.ends_at > p_from and x.starts_at < least(p_to, p_from + interval '75 days')
  order by 3;
$$;
revoke all on function public.get_roster(timestamptz, timestamptz) from public;
grant execute on function public.get_roster(timestamptz, timestamptz) to anon, authenticated;

-- the old RPC cancelled without refunds; cancellations now go through manage-booking
revoke execute on function public.cancel_booking(uuid) from authenticated;

-- ================================================================
-- Coupons
-- ================================================================
create table if not exists public.coupons (
  code        text primary key check (code = upper(code) and code ~ '^[A-Z0-9_-]{3,24}$'),
  kind        text not null check (kind in ('percent','amount')),
  value       integer not null check (value > 0),              -- percent (1–100) or cents
  active      boolean not null default true,
  starts_at   timestamptz,
  expires_at  timestamptz,
  max_uses    integer check (max_uses is null or max_uses > 0),
  uses        integer not null default 0,
  min_hours   smallint not null default 1,
  note        text,
  created_at  timestamptz not null default now(),
  constraint percent_range check (kind <> 'percent' or value between 1 and 100)
);
alter table public.coupons enable row level security;
drop policy if exists "admins manage coupons" on public.coupons;
create policy "admins manage coupons" on public.coupons for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- returns the discount for a code without exposing the coupon list
create or replace function public.check_coupon(p_code text, p_hours integer, p_amount_cents integer)
returns table (valid boolean, discount_cents integer, message text)
language plpgsql stable security definer set search_path = '' as $$
declare c public.coupons;
begin
  select * into c from public.coupons where code = upper(trim(p_code));
  if not found or not c.active then return query select false, 0, 'That code isn''t valid.'; return; end if;
  if c.starts_at is not null and now() < c.starts_at then return query select false, 0, 'That code isn''t active yet.'; return; end if;
  if c.expires_at is not null and now() > c.expires_at then return query select false, 0, 'That code has expired.'; return; end if;
  if c.max_uses is not null and c.uses >= c.max_uses then return query select false, 0, 'That code has been fully used.'; return; end if;
  if p_hours < c.min_hours then return query select false, 0, format('That code needs a booking of %s hours or more.', c.min_hours); return; end if;
  return query select true,
    least(p_amount_cents, case when c.kind = 'percent' then (p_amount_cents * c.value) / 100 else c.value end),
    case when c.kind = 'percent' then format('%s%% off', c.value) else format('$%s off', (c.value / 100.0)::numeric(10,2)) end;
end $$;
revoke all on function public.check_coupon(text, integer, integer) from public;
grant execute on function public.check_coupon(text, integer, integer) to anon, authenticated;

-- ================================================================
-- Gift certificates
-- ================================================================
create table if not exists public.gift_cards (
  code              text primary key check (code ~ '^HFJ-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  initial_cents     integer not null check (initial_cents between 1000 and 200000),
  balance_cents     integer not null check (balance_cents >= 0),
  status            text not null default 'pending' check (status in ('pending','active','void')),
  purchaser_name    text, purchaser_email text not null,
  recipient_name    text, recipient_email text,
  message           text check (char_length(message) <= 300),
  deliver_to        text not null default 'recipient' check (deliver_to in ('recipient','purchaser')),
  stripe_session_id text,
  delivered_at      timestamptz,
  created_at        timestamptz not null default now()
);
alter table public.gift_cards enable row level security;
drop policy if exists "admins manage gift cards" on public.gift_cards;
create policy "admins manage gift cards" on public.gift_cards for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create or replace function public.check_gift(p_code text)
returns table (valid boolean, balance_cents integer, message text)
language plpgsql stable security definer set search_path = '' as $$
declare g public.gift_cards;
begin
  select * into g from public.gift_cards where code = upper(trim(p_code));
  if not found or g.status <> 'active' then return query select false, 0, 'That gift code isn''t valid.'; return; end if;
  if g.balance_cents = 0 then return query select false, 0, 'That gift card has been fully used.'; return; end if;
  return query select true, g.balance_cents, format('$%s available', (g.balance_cents / 100.0)::numeric(10,2));
end $$;
revoke all on function public.check_gift(text) from public;
grant execute on function public.check_gift(text) to anon, authenticated;

-- atomic reserve/release, called only by edge functions (service role)
create or replace function public.gift_reserve(p_code text, p_cents integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare bal integer; applied integer;
begin
  select balance_cents into bal from public.gift_cards
   where code = upper(trim(p_code)) and status = 'active' for update;
  if bal is null or bal = 0 or p_cents <= 0 then return 0; end if;
  applied := least(bal, p_cents);
  update public.gift_cards set balance_cents = bal - applied where code = upper(trim(p_code));
  return applied;
end $$;
create or replace function public.gift_release(p_code text, p_cents integer)
returns void language sql security definer set search_path = '' as $$
  update public.gift_cards set balance_cents = least(initial_cents, balance_cents + greatest(p_cents, 0))
   where code = upper(trim(p_code));
$$;
revoke all on function public.gift_reserve(text, integer) from public, anon, authenticated;
revoke all on function public.gift_release(text, integer) from public, anon, authenticated;

create or replace function public.coupon_used(p_code text)
returns void language sql security definer set search_path = '' as $$
  update public.coupons set uses = uses + 1 where code = upper(trim(p_code));
$$;
revoke all on function public.coupon_used(text) from public, anon, authenticated;

-- ================================================================
-- Waitlist
-- ================================================================
create table if not exists public.waitlist (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email        text not null,
  name         text,
  room_id      text not null references public.rooms(id),
  day          date not null,
  from_hour    smallint not null check (from_hour between 0 and 23),
  to_hour      smallint not null check (to_hour between 1 and 24),
  hours_needed smallint not null default 1 check (hours_needed between 1 and 12),
  status       text not null default 'waiting' check (status in ('waiting','notified','removed')),
  notified_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint wait_order check (to_hour > from_hour),
  constraint wait_one_per_day unique (user_id, room_id, day)
);
create index if not exists waitlist_open_idx on public.waitlist (day) where status = 'waiting';
alter table public.waitlist enable row level security;
drop policy if exists "own waitlist" on public.waitlist;
drop policy if exists "admins manage waitlist" on public.waitlist;
create policy "own waitlist" on public.waitlist for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and day >= (now() at time zone 'Australia/Brisbane')::date);
create policy "admins manage waitlist" on public.waitlist for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ================================================================
-- Housekeeping: release unpaid holds (also run by cron every 5 minutes)
-- ================================================================
create or replace function public.expire_holds()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in update public.bookings set status = 'cancelled', cancelled_at = now()
            where status = 'pending' and hold_expires_at < now()
        returning gift_code, gift_applied_cents
  loop
    if r.gift_code is not null and r.gift_applied_cents > 0 then perform public.gift_release(r.gift_code, r.gift_applied_cents); end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.expire_holds() from public, anon, authenticated;
