-- Echo Market: public launch.
-- Run once in Supabase → SQL Editor. Safe to run again (it just moves the reset date to "now").
--
-- 1. Fresh statistics: the seller desk's Sellers leaderboard and Alliances statistics only count activity
--    from this moment on, also for "All time". Nothing is deleted: orders, their timelines and the buyers'
--    history stay as they are.
insert into public.market_settings (key, value, updated_by)
values ('stats_reset_at', to_jsonb(now()), 'launch reset')
on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;

-- 2. The 10th division: Uzuri (shown after the other nine in every alliance list and in the Discord bot).
insert into public.alliances (name, sort_order) values ('Uzuri', 10)
on conflict (name) do nothing;

-- Check: should show the reset time and 10 divisions.
select (select value from public.market_settings where key = 'stats_reset_at') as leaderboard_counts_from,
       (select string_agg(name, ', ' order by sort_order) from public.alliances) as divisions;
