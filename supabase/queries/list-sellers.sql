-- Echo Market: every seller on the seller list (active and switched off).
-- Run in Supabase → SQL Editor. Read-only: it changes nothing.
--   source   'manual'       = added by hand (never changed automatically)
--            'discord_role' = added because they have the Alliance Ambassador role on Discord
--   active   false          = switched off (lost the role, or blocked by hand)
-- Admins first, then active sellers, then by name.
select
    a.display_name                                              as name,
    a.discord_username                                          as discord_username,
    a.discord_id                                                as discord_id,
    s.is_admin                                                  as admin,
    s.active                                                    as active,
    s.source                                                    as source,
    s.added_at::date                                            as added,
    s.role_checked_at                                           as role_last_confirmed,
    (select count(*) from public.order_events e where e.actor_id = s.user_id and e.kind = 'CLAIMED')     as orders_taken,
    (select count(*) from public.orders o where o.seller_id = s.user_id and o.status in ('CLAIMED', 'PARTIAL')) as in_progress_now,
    (select max(e.created_at)::date from public.order_events e where e.actor_id = s.user_id)            as last_active,
    s.note                                                      as note
from public.sellers s
join public.accounts a on a.id = s.user_id
order by s.is_admin desc, s.active desc, a.display_name;
