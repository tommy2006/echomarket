-- =====================================================================
--  Clear the disciplinary record (warnings + market bans) of one or more
--  Discord accounts. For wiping test warnings/bans before going live.
--
--  How to use (Supabase → SQL Editor):
--    1. Put the Discord user ID(s) in BOTH lists below (right-click the user
--       in Discord → Copy User ID). One per line: ('123…'), ('456…')
--    2. Run STEP 1 first: it only shows what would be removed.
--    3. Run STEP 2: removes it and shows how many were removed.
--
--  Removed: warnings (market_messages, kind 'warning') and every market ban
--  (active and old). Kept: ordinary info messages, orders, airlines.
--  This can't be undone.
--
--  ⚠️ Active bans: deleting the ban doesn't remove the "Market Banned" ROLE
--  in Discord. STEP 2 reports "active_bans_removed": for those people,
--  remove the Market Banned role by hand in Discord (Server Settings →
--  Members), or lift their ban on the seller desk BEFORE running STEP 2
--  (that removes the role and DMs them).
-- =====================================================================

-- ---------------------------------------------------------------- STEP 1: preview (changes nothing)
with target(discord_id) as (values
    ('PASTE_DISCORD_ID_HERE')
    -- , ('ANOTHER_DISCORD_ID')
)
select t.discord_id,
       (select coalesce(a.display_name, a.discord_username) from public.accounts a where a.discord_id = t.discord_id) as name,
       (select count(*) from public.market_messages m where m.discord_id = t.discord_id and m.kind = 'warning') as warnings,
       (select count(*) from public.market_bans b where b.discord_id = t.discord_id) as bans,
       (select count(*) from public.market_bans b where b.discord_id = t.discord_id and b.revoked_at is null
            and (b.ends_at is null or b.ends_at > now())) as active_bans
from target t;

-- ---------------------------------------------------------------- STEP 2: clear (run after checking STEP 1)
with target(discord_id) as (values
    ('PASTE_DISCORD_ID_HERE')
    -- , ('ANOTHER_DISCORD_ID')
),
active as (
    select b.id from public.market_bans b join target t on t.discord_id = b.discord_id
    where b.revoked_at is null and (b.ends_at is null or b.ends_at > now())
),
warnings_removed as (
    delete from public.market_messages m using target t
    where m.discord_id = t.discord_id and m.kind = 'warning'
    returning m.id
),
bans_removed as (
    delete from public.market_bans b using target t
    where b.discord_id = t.discord_id
    returning b.id
)
select (select count(*) from warnings_removed) as warnings_removed,
       (select count(*) from bans_removed)     as bans_removed,
       (select count(*) from active)           as active_bans_removed;   -- > 0: remove their Market Banned role in Discord
