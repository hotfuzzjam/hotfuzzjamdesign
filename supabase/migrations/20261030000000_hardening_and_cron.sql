-- HOTFUZZJAM Studio — API hardening and the scheduled-job secret
-- Runs after 20261025000000_scheduling_suite.sql.

-- Trigger functions, the retired cancel RPC and service-role helpers are never called through the API.
-- (Supabase's default privileges grant anon/authenticated on create, so revoke them explicitly.)
revoke execute on function public.handle_new_user()           from public, anon, authenticated;
revoke execute on function public.validate_booking()          from public, anon, authenticated;
revoke execute on function public.cancel_booking(uuid)        from public, anon, authenticated;
revoke execute on function public.gift_reserve(text, integer) from public, anon, authenticated;
revoke execute on function public.gift_release(text, integer) from public, anon, authenticated;
revoke execute on function public.coupon_used(text)           from public, anon, authenticated;
revoke execute on function public.expire_holds()              from public, anon, authenticated;

-- The send-reminders function checks the x-cron-secret header against the Vault secret pg_cron sends,
-- so the secret is generated in the database and never has to be copied anywhere.
create or replace function public.cron_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets
                  where name = 'hfj_cron_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.cron_secret_ok(text) to service_role;
