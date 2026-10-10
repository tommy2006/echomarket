-- Echo Market: every seller on the seller list (active and switched off).
-- Run in Supabase → SQL Editor. Read-only: it changes nothing.
--   rank     Lead Ambassador / Ambassador / Verified Seller (from their Discord role, or set by hand)
--   admin    true for Lead Ambassadors and anyone made admin by hand
--   source   'manual'       = added by hand (never changed automatically)
--            'discord_role' = added because of their Discord role (Verified Seller, Ambassador, Lead Ambassador)
--   active   false          = switched off (lost the role, or blocked by hand)
-- Active first, then by rank (Lead Ambassador, Ambassador, Verified Seller), then by name.
select
    a.display_name                                              as name,
    a.discord_username                                          as discord_username,
    a.discord_id                                                as discord_id,
    case s.rank when 'lead' then 'Lead Ambassador' when 'ambassador' then 'Ambassador' when 'admin' then 'Admin (no seller role)' else 'Verified Seller' end as rank,
    (s.is_admin or s.rank = 'lead')                             as admin,
    s.is_admin                                                  as admin_by_hand,
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
order by s.active desc, case s.rank when 'lead' then 0 when 'admin' then 1 when 'ambassador' then 2 else 3 end, s.is_admin desc, a.display_name;
