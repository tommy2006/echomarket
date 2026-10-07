-- Echo Market: every buyer account (anyone who has signed in with Discord).
-- Run in Supabase → SQL Editor. Read-only: it changes nothing.
-- Newest first. "orders" counts every order ever placed; "active" = waiting or being delivered.
select
    a.display_name                                              as name,
    a.discord_username                                          as discord_username,
    a.discord_id                                                as discord_id,
    a.created_at::date                                          as joined,
    (select count(*) from public.airlines l where l.owner_id = a.id)                                     as airlines,
    (select string_agg(l.name || ' (' || l.alliance || ')', ', ' order by l.created_at)
       from public.airlines l where l.owner_id = a.id)                                                   as airline_names,
    (select count(*) from public.orders o where o.buyer_id = a.id)                                       as orders,
    (select count(*) from public.orders o where o.buyer_id = a.id and o.status in ('PENDING', 'CLAIMED', 'PARTIAL')) as active,
    (select count(*) from public.orders o where o.buyer_id = a.id and o.status = 'FULFILLED')            as delivered,
    (select coalesce(sum(o.filled), 0) from public.orders o where o.buyer_id = a.id
        and o.status not in ('CANCELLED', 'DECLINED'))                                                   as aircraft_received,
    (select max(o.created_at)::date from public.orders o where o.buyer_id = a.id)                        as last_order,
    case when a.dm_enabled = false then 'off' else coalesce(a.dm_status, 'not tried') end                as bot_dms,
    exists (select 1 from public.sellers s where s.user_id = a.id and s.active)                          as is_seller
from public.accounts a
order by a.created_at desc;
