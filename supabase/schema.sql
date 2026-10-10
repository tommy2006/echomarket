-- =====================================================================
--  Echo Market — Supabase schema
--  Run this ONCE in Supabase Dashboard → SQL Editor → New query → Run.
--  It is safe to re-run: every statement is idempotent.
--
--  Shared by BOTH apps (buyer + seller point at the same Supabase project).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  Settings you might want to change later
-- ---------------------------------------------------------------------
--  Max airline profiles per market account: see enforce_airline_limit().
--  Alliances: edit rows in public.alliances (no code change needed).

-- ---------------------------------------------------------------------
--  1. Market accounts — exactly one per Discord user.
--     Rows are created automatically when someone signs in with Discord.
-- ---------------------------------------------------------------------
create table if not exists public.accounts (
    id                    uuid primary key references auth.users(id) on delete cascade,
    discord_id            text unique,
    discord_username      text,
    display_name          text,
    avatar_url            text,
    notifications_seen_at timestamptz not null default now(),
    dm_enabled            boolean not null default true,   -- buyer wants Discord DMs about their orders
    dm_status             text,                            -- 'ok' | 'blocked' (set by the server after a DM attempt)
    created_at            timestamptz not null default now()
);
-- Kept by the API from the account's Discord membership (DISCORD_GUILD_ID): only members of the Echo
-- server may use the market, and the "Market Banned" Discord role blocks it like a market ban.
alter table public.accounts add column if not exists in_guild boolean;
alter table public.accounts add column if not exists guild_checked_at timestamptz;
alter table public.accounts add column if not exists market_banned_role boolean not null default false;

-- SECURITY: the Discord ID, name and avatar come ONLY from auth.identities, which Supabase writes
-- during the Discord login itself. Never read auth.users.raw_user_meta_data here: any signed-in user
-- can rewrite it from the browser (supabase.auth.updateUser({ data: { provider_id: … } })) and
-- would become someone else on the market (their DMs, their seller role).
create or replace function public.sync_account(uid uuid)
returns void language plpgsql security definer set search_path = public, auth as $$
declare
    pid text;
    d jsonb;
    avatar text;
begin
    if not exists (select 1 from auth.users where id = uid) then return; end if;   -- user being deleted
    select i.provider_id, i.identity_data into pid, d
    from auth.identities i
    where i.user_id = uid and i.provider = 'discord'
    order by i.created_at
    limit 1;
    d := coalesce(d, '{}'::jsonb);
    avatar := d->>'avatar_url';
    if avatar !~ '^https://cdn\.discordapp\.com/' then avatar := null; end if;   -- no tracking pixels
    -- A Discord account belongs to exactly one market account: take it back from anyone else holding it.
    if pid is not null then
        update public.accounts set discord_id = null where discord_id = pid and id <> uid;
    end if;
    insert into public.accounts (id, discord_id, discord_username, display_name, avatar_url)
    values (
        uid, pid,
        coalesce(d->>'user_name', d->>'name', d->>'full_name'),
        coalesce(d->'custom_claims'->>'global_name', d->>'full_name', d->>'name'),
        avatar
    )
    on conflict (id) do update set
        discord_id       = excluded.discord_id,
        discord_username = coalesce(excluded.discord_username, accounts.discord_username),
        display_name     = coalesce(excluded.display_name, accounts.display_name),
        avatar_url       = coalesce(excluded.avatar_url, accounts.avatar_url);
end $$;
revoke all on function public.sync_account(uuid) from public, anon, authenticated;

create or replace function public.sync_account_from_auth()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    perform public.sync_account(new.id);
    return new;
end $$;

create or replace function public.sync_account_from_identity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    perform public.sync_account(coalesce(new.user_id, old.user_id));
    return coalesce(new, old);
end $$;

drop trigger if exists on_auth_user_saved on auth.users;
create trigger on_auth_user_saved
    after insert on auth.users
    for each row execute function public.sync_account_from_auth();
drop trigger if exists on_auth_identity_saved on auth.identities;
create trigger on_auth_identity_saved
    after insert or update or delete on auth.identities
    for each row execute function public.sync_account_from_identity();

-- ---------------------------------------------------------------------
--  2. Alliances (lookup table — add/rename rows here)
-- ---------------------------------------------------------------------
create table if not exists public.alliances (
    name       text primary key,
    sort_order int not null default 0
);
insert into public.alliances (name, sort_order) values
    ('Kyra', 1), ('Proxima', 2), ('Aegis', 3), ('Elysium', 4), ('Rhea', 5),
    ('Vilis', 6), ('Elion', 7), ('Aura', 8), ('Eos', 9)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
--  3. Airline profiles — up to 20 per account
-- ---------------------------------------------------------------------
create table if not exists public.airlines (
    id         uuid primary key default gen_random_uuid(),
    owner_id   uuid not null default auth.uid() references public.accounts(id) on delete cascade,
    name       text not null check (char_length(btrim(name)) between 2 and 60),
    alliance   text not null references public.alliances(name) on update cascade,
    created_at timestamptz not null default now()
);
create unique index if not exists airlines_owner_name_uq
    on public.airlines (owner_id, lower(btrim(name)));

create or replace function public.enforce_airline_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    max_airlines constant int := 20;   -- <- change the per-account limit here
begin
    new.name := btrim(new.name);
    -- Inserting into someone else's account: leave it to RLS to reject.
    if auth.uid() is not null and new.owner_id is distinct from auth.uid() then
        return new;
    end if;
    -- serialise concurrent inserts for the same owner so the count is exact
    perform pg_advisory_xact_lock(hashtext(new.owner_id::text));
    if (select count(*) from public.airlines where owner_id = new.owner_id) >= max_airlines then
        raise exception 'You can have at most % airline profiles.', max_airlines
            using errcode = 'P0001';
    end if;
    return new;
end $$;

-- Airline names are shown in official Discord posts: no web addresses or invite links in them.
-- (NOT VALID: only new and edited names are checked, existing ones are left alone.)
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'airlines_name_no_links') then
        alter table public.airlines add constraint airlines_name_no_links
            check (name !~* '(://|www\.|discord\.(gg|com/invite)|\.(com|net|org|gg|io|xyz|ru|ly)(/|$))') not valid;
    end if;
end $$;

drop trigger if exists airlines_limit on public.airlines;
create trigger airlines_limit before insert on public.airlines
    for each row execute function public.enforce_airline_limit();

create or replace function public.trim_airline_name()
returns trigger language plpgsql set search_path = public as $$
begin
    new.name := btrim(new.name);
    new.owner_id := old.owner_id;  -- ownership can never be transferred
    return new;
end $$;

drop trigger if exists airlines_trim on public.airlines;
create trigger airlines_trim before update on public.airlines
    for each row execute function public.trim_airline_name();

-- ---------------------------------------------------------------------
--  4. Sellers — the curated list.
--     Automatic: anyone with the seller role (DISCORD_ROLE_ID) in a server the bot is in is added
--     when they open the seller desk (source 'discord_role'), and removed again if they lose the role.
--     By hand:
--     insert into public.sellers (user_id)
--       select id from public.accounts where discord_id = '<DISCORD USER ID>';
--  (the person must have signed in with Discord once first)
--     To block someone who has the role: update public.sellers set active = false, source = 'manual'
--       where user_id = (select id from public.accounts where discord_id = '<DISCORD USER ID>');
-- ---------------------------------------------------------------------
create table if not exists public.sellers (
    user_id  uuid primary key references public.accounts(id) on delete cascade,
    is_admin boolean not null default false,
    active   boolean not null default true,
    note     text,
    added_at timestamptz not null default now()
);
-- 'manual' (added by hand: never changed automatically) or 'discord_role' (follows the Discord role)
alter table public.sellers add column if not exists source text not null default 'manual';
-- When a 'discord_role' seller's role was last confirmed with Discord. Their access only counts while
-- this is recent (1 hour for reading orders, 10 minutes for seller actions; see is_seller() and the API).
alter table public.sellers add column if not exists role_checked_at timestamptz;
-- Rank in the Echo hierarchy: 'lead' = Lead Ambassador (also an admin), 'ambassador' = Ambassador,
-- 'verified' = Verified Seller, 'admin' = admin added by hand who has none of the Discord seller roles
-- (only a look on the seller desk: being an admin still comes from is_admin). Role-based sellers get it from their Discord roles on every role check;
-- for sellers added by hand, set it yourself (SETUP.md 8.2). is_admin = true makes anyone an admin.
alter table public.sellers add column if not exists rank text not null default 'verified';
-- true while the seller has the "Market Admin" Discord role (admin rights; kept with the role checks).
alter table public.sellers add column if not exists market_admin boolean not null default false;
alter table public.sellers drop constraint if exists sellers_rank_check;
alter table public.sellers add constraint sellers_rank_check check (rank in ('lead', 'ambassador', 'verified', 'admin'));

create or replace function public.is_seller()
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.sellers
        where user_id = auth.uid() and active
          and (source <> 'discord_role' or role_checked_at > now() - interval '1 hour')
    );
$$;

-- ---------------------------------------------------------------------
--  5. Orders
--     Status flow:  PENDING → CLAIMED → PARTIAL → FULFILLED
--     Closed early: CANCELLED (by buyer, only while PENDING)
--                   DECLINED  (by a seller, with a reason)
-- ---------------------------------------------------------------------
create or replace function public.new_order_id()
returns text language sql volatile set search_path = public as $$
    select 'ECH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

create table if not exists public.orders (
    id                  text primary key default public.new_order_id(),
    buyer_id            uuid references public.accounts(id) on delete set null,
    buyer_discord_id    text,
    buyer_name          text,
    airline_id          uuid references public.airlines(id) on delete set null,
    airline_name        text not null,
    alliance            text,
    items               jsonb not null,
    total_qty           int not null check (total_qty > 0),
    total_usd           bigint not null check (total_usd >= 0),
    buyer_note          text,
    status              text not null default 'PENDING'
                        check (status in ('PENDING','CLAIMED','PARTIAL','FULFILLED','CANCELLED','DECLINED')),
    filled              int not null default 0 check (filled >= 0),
    seller_id           uuid references public.accounts(id) on delete set null,
    seller_name         text,
    seller_airline_id   uuid references public.airlines(id) on delete set null,
    seller_airline_name text,
    seller_alliance     text,
    claimed_at          timestamptz,
    seller_note         text,
    closed_reason       text,
    discord_channel     text,
    discord_message_id  text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index if not exists orders_buyer_idx   on public.orders (buyer_id, created_at desc);
create index if not exists orders_status_idx  on public.orders (status, created_at desc);
create index if not exists orders_seller_idx  on public.orders (seller_id);

-- Sellers who handed a partly delivered order back to the team:
-- [{ seller_id, seller_name, seller_airline_name, seller_alliance, delivered, at }]
alter table public.orders add column if not exists previous_sellers jsonb not null default '[]'::jsonb;
-- Every buyer airline the aircraft may be delivered to (the buyer can accept several, in different
-- alliances): [{ id, name, alliance }]. The first one is also in airline_id / airline_name / alliance.
-- Empty for older orders, which only have that one airline.
alter table public.orders add column if not exists airlines jsonb not null default '[]'::jsonb;
-- Each entry of orders.items also carries "filled" (delivered so far for that aircraft type)
-- and "locked" (delivered before the current seller took over, which they cannot undo).

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
    for each row execute function public.touch_updated_at();

-- Status timestamps, kept by the database itself so every status change is recorded:
--   status_changed_at  when the current status started (for an open order: when it (re)entered the queue)
--   status_history     [{ status, at }] for every change, oldest first
--   fulfilled_at       when it was fully delivered
alter table public.orders add column if not exists status_changed_at timestamptz;
alter table public.orders add column if not exists status_history jsonb not null default '[]'::jsonb;
alter table public.orders add column if not exists fulfilled_at timestamptz;

create or replace function public.track_order_status()
returns trigger language plpgsql set search_path = public as $$
begin
    if tg_op = 'INSERT' then
        new.status_changed_at := coalesce(new.status_changed_at, new.created_at, now());
        if coalesce(jsonb_array_length(new.status_history), 0) = 0 then
            new.status_history := jsonb_build_array(jsonb_build_object('status', new.status, 'at', new.status_changed_at));
        end if;
        if new.status = 'FULFILLED' and new.fulfilled_at is null then new.fulfilled_at := new.status_changed_at; end if;
    elsif new.status is distinct from old.status then
        new.status_changed_at := now();
        new.status_history := coalesce(old.status_history, '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object('status', new.status, 'at', now()));
        new.fulfilled_at := case when new.status = 'FULFILLED' then now() else null end;
    end if;
    return new;
end $$;

drop trigger if exists orders_track_status on public.orders;
create trigger orders_track_status before insert or update on public.orders
    for each row execute function public.track_order_status();

-- One-off backfill for orders placed before status tracking existed (best guess from what's stored).
update public.orders set
    status_changed_at = case when status = 'PENDING' and filled = 0 then created_at else updated_at end,
    status_history = case
        when status = 'PENDING' and filled = 0 then jsonb_build_array(jsonb_build_object('status', 'PENDING', 'at', created_at))
        else jsonb_build_array(jsonb_build_object('status', 'PENDING', 'at', created_at),
                               jsonb_build_object('status', status, 'at', updated_at))
    end,
    fulfilled_at = case when status = 'FULFILLED' then updated_at end
where status_changed_at is null;

create index if not exists orders_queue_idx on public.orders (status, status_changed_at);

-- Order serial number: #1, #2, #3 … in the order orders were placed (shown next to the ECH- code).
create sequence if not exists public.order_serial_seq;
alter table public.orders add column if not exists serial bigint;
do $$
declare base bigint;
begin
    if exists (select 1 from public.orders where serial is null) then
        -- Number older orders by when they were placed. Triggers are paused so their updated_at stays put.
        alter table public.orders disable trigger orders_touch;
        alter table public.orders disable trigger orders_track_status;
        select coalesce(max(serial), 0) into base from public.orders;
        update public.orders o set serial = base + n.rn
        from (select id, row_number() over (order by created_at, id) as rn from public.orders where serial is null) n
        where o.id = n.id;
        alter table public.orders enable trigger orders_touch;
        alter table public.orders enable trigger orders_track_status;
    end if;
    -- The next order gets the highest number used so far + 1 (or #1 when there are none yet).
    -- Numbers of deleted orders are never reused.
    select greatest(coalesce((select max(serial) from public.orders), 0),
                    (select case when is_called then last_value else 0 end from public.order_serial_seq)) into base;
    perform setval('public.order_serial_seq', greatest(base, 1), base > 0);
end $$;
alter table public.orders alter column serial set default nextval('public.order_serial_seq');
alter sequence public.order_serial_seq owned by public.orders.serial;
create unique index if not exists orders_serial_uq on public.orders (serial);

-- Order timeline. Everything here is visible to the buyer of the order.
create table if not exists public.order_events (
    id         bigint generated always as identity primary key,
    order_id   text not null references public.orders(id) on delete cascade,
    buyer_id   uuid,              -- copy of orders.buyer_id (for RLS + realtime filters)
    kind       text not null,     -- CREATED, CLAIMED, RELEASED, PROGRESS, NOTE, FULFILLED, CANCELLED, DECLINED
    actor_id   uuid,
    actor_name text,
    filled     int,
    message    text,
    created_at timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events (order_id, created_at);
create index if not exists order_events_buyer_idx on public.order_events (buyer_id, created_at desc);

-- Sellers who passed on an open order. The order is only DECLINED for the buyer once every
-- active seller has passed (the last one writes the reason). Buyers can never read this table.
create table if not exists public.order_declines (
    order_id    text not null references public.orders(id) on delete cascade,
    seller_id   uuid not null references public.accounts(id) on delete cascade,
    seller_name text,
    note        text,
    created_at  timestamptz not null default now(),
    primary key (order_id, seller_id)
);

-- Phone / browser push subscriptions for "order delivered" alerts. Written by the API only.
create table if not exists public.push_subscriptions (
    endpoint   text primary key,
    account_id uuid not null references public.accounts(id) on delete cascade,
    p256dh     text not null,
    auth       text not null,
    user_agent text,
    created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_account_idx on public.push_subscriptions (account_id);

-- Per-account rate limits for API actions that call Discord or push services (test DMs, test alerts,
-- seller-role checks). Only the Vercel API (service role) can use hit_rate_limit().
create table if not exists public.rate_limits (
    key          text primary key,     -- e.g. 'test-dm:<account id>'
    window_start timestamptz not null default now(),
    hits         int not null default 0
);
alter table public.rate_limits enable row level security;   -- no policies: API only

-- Counts one hit for "key"; true while there are at most p_max hits in the current p_seconds window.
create or replace function public.hit_rate_limit(p_key text, p_max int, p_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
    insert into public.rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
    on conflict (key) do update set
        hits = case when r.window_start < now() - make_interval(secs => p_seconds) then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_seconds) then now() else r.window_start end
    returning hits into n;
    return n <= p_max;
end $$;
revoke all on function public.hit_rate_limit(text, int, int) from public, anon, authenticated;
revoke all on public.rate_limits from anon, authenticated;

-- Market bans, issued by admins. Attached to the Discord account, so they cover every airline of that
-- person, and also people who haven't signed in to the market yet. Active = not revoked and not ended.
create table if not exists public.market_bans (
    id              bigint generated always as identity primary key,
    discord_id      text not null,
    account_id      uuid references public.accounts(id) on delete set null,
    reason          text not null,
    duration        text not null check (duration in ('week', 'month', 'permanent')),
    starts_at       timestamptz not null default now(),
    ends_at         timestamptz,               -- null = permanent
    issued_by       uuid references public.accounts(id) on delete set null,
    issued_by_name  text,
    source          text not null default 'web',   -- 'web' or 'bot'
    revoked_at      timestamptz,
    revoked_by_name text,
    created_at      timestamptz not null default now()
);
create index if not exists market_bans_discord_idx on public.market_bans (discord_id);

-- Messages from Market Admins to a buyer (information or a formal warning). Shown in the buyer's
-- notifications and sent as a Discord DM.
create table if not exists public.market_messages (
    id           bigint generated always as identity primary key,
    account_id   uuid references public.accounts(id) on delete cascade,
    discord_id   text not null,
    kind         text not null check (kind in ('info', 'warning')),
    body         text not null,
    sent_by      uuid references public.accounts(id) on delete set null,
    sent_by_name text,
    source       text not null default 'web',
    created_at   timestamptz not null default now()
);
create index if not exists market_messages_account_idx on public.market_messages (account_id, created_at desc);
create index if not exists market_messages_discord_idx on public.market_messages (discord_id);

-- Messages between a buyer and the seller team about one order. Buyers can start once an order has
-- waited 5 days without being fully delivered; any seller can answer.
create table if not exists public.order_messages (
    id          bigint generated always as identity primary key,
    order_id    text not null references public.orders(id) on delete cascade,
    buyer_id    uuid,                          -- copy of orders.buyer_id (for RLS + realtime filters)
    author_id   uuid references public.accounts(id) on delete set null,
    author_name text,
    from_role   text not null check (from_role in ('buyer', 'seller')),
    body        text not null,
    created_at  timestamptz not null default now()
);
create index if not exists order_messages_order_idx on public.order_messages (order_id, created_at);
create index if not exists order_messages_buyer_idx on public.order_messages (buyer_id, created_at desc);

-- Seller-only moderation flags. Buyers can never read this table.
create table if not exists public.order_flags (
    order_id   text primary key references public.orders(id) on delete cascade,
    status     text not null default 'NORMAL' check (status in ('NORMAL','SUSPICIOUS','BLACKLISTED')),
    reason     text,
    flagged_by text,
    flagged_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  6. Row Level Security
--     Browsers use the public "anon" key, so RLS is what keeps data private.
--     Orders/events/flags are only WRITTEN by the Vercel API (service role),
--     which validates prices, permissions and sends Discord messages.
-- ---------------------------------------------------------------------
alter table public.accounts     enable row level security;
alter table public.alliances    enable row level security;
alter table public.airlines     enable row level security;
alter table public.sellers      enable row level security;
alter table public.orders       enable row level security;
alter table public.order_events enable row level security;
alter table public.order_flags  enable row level security;
alter table public.order_declines     enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.market_bans        enable row level security;
alter table public.market_messages    enable row level security;
alter table public.order_messages     enable row level security;

-- May this signed-in person use the market (create/edit airlines)? Member of the Echo server (checked
-- by the API) and not market-banned (ban record or the Market Banned role).
create or replace function public.has_market_access()
returns boolean language sql stable security definer set search_path = public as $$
    select exists (
        select 1 from public.accounts a
        where a.id = auth.uid() and a.in_guild is true and not a.market_banned_role
          and not exists (select 1 from public.market_bans b
                          where b.discord_id = a.discord_id and b.revoked_at is null
                            and (b.ends_at is null or b.ends_at > now()))
    );
$$;

drop policy if exists "accounts: read own or seller" on public.accounts;
create policy "accounts: read own or seller" on public.accounts
    for select to authenticated using (id = auth.uid() or public.is_seller());
drop policy if exists "accounts: update own" on public.accounts;
create policy "accounts: update own" on public.accounts
    for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- Users may only change their notification settings; Discord fields come from the trigger.
revoke update on public.accounts from authenticated, anon;
grant update (notifications_seen_at, dm_enabled) on public.accounts to authenticated;

drop policy if exists "alliances: public read" on public.alliances;
create policy "alliances: public read" on public.alliances
    for select to anon, authenticated using (true);

drop policy if exists "airlines: owner full access" on public.airlines;
drop policy if exists "airlines: owner read" on public.airlines;
drop policy if exists "airlines: owner write with market access" on public.airlines;
drop policy if exists "airlines: owner insert with market access" on public.airlines;
drop policy if exists "airlines: owner delete" on public.airlines;
create policy "airlines: owner read" on public.airlines
    for select to authenticated using (owner_id = auth.uid());
create policy "airlines: owner insert with market access" on public.airlines
    for insert to authenticated with check (owner_id = auth.uid() and public.has_market_access());
create policy "airlines: owner write with market access" on public.airlines
    for update to authenticated using (owner_id = auth.uid() and public.has_market_access())
    with check (owner_id = auth.uid());
create policy "airlines: owner delete" on public.airlines
    for delete to authenticated using (owner_id = auth.uid());

drop policy if exists "bans: own or seller read" on public.market_bans;
create policy "bans: own or seller read" on public.market_bans
    for select to authenticated using (
        public.is_seller() or discord_id = (select a.discord_id from public.accounts a where a.id = auth.uid()));
drop policy if exists "market messages: own or seller read" on public.market_messages;
create policy "market messages: own or seller read" on public.market_messages
    for select to authenticated using (account_id = auth.uid() or public.is_seller());
drop policy if exists "order messages: buyer or seller read" on public.order_messages;
create policy "order messages: buyer or seller read" on public.order_messages
    for select to authenticated using (buyer_id = auth.uid() or public.is_seller());

drop policy if exists "sellers: read self or team" on public.sellers;
create policy "sellers: read self or team" on public.sellers
    for select to authenticated using (user_id = auth.uid() or public.is_seller());

drop policy if exists "orders: buyer or seller read" on public.orders;
create policy "orders: buyer or seller read" on public.orders
    for select to authenticated using (buyer_id = auth.uid() or public.is_seller());

drop policy if exists "events: buyer or seller read" on public.order_events;
create policy "events: buyer or seller read" on public.order_events
    for select to authenticated using (buyer_id = auth.uid() or public.is_seller());

drop policy if exists "flags: seller read" on public.order_flags;
drop policy if exists "declines: seller read" on public.order_declines;
create policy "declines: seller read" on public.order_declines
    for select to authenticated using (public.is_seller());

drop policy if exists "push: read own" on public.push_subscriptions;
create policy "push: read own" on public.push_subscriptions
    for select to authenticated using (account_id = auth.uid());

create policy "flags: seller read" on public.order_flags
    for select to authenticated using (public.is_seller());

-- ---------------------------------------------------------------------
--  Table access for the website. Newer Supabase projects can have
--  "automatically expose new tables" switched off, so grant explicitly.
--  Row Level Security above still decides WHICH rows each person sees.
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select on public.alliances to anon, authenticated;
grant select on public.accounts, public.sellers, public.orders, public.order_events, public.order_flags,
    public.order_declines, public.push_subscriptions, public.market_bans, public.market_messages,
    public.order_messages to authenticated;
grant execute on function public.has_market_access() to authenticated;
grant select, insert, update, delete on public.airlines to authenticated;
grant execute on function public.is_seller() to anon, authenticated;
-- Defence in depth: Supabase gives the browser roles every privilege on new tables by default and relies
-- on RLS alone. Take away what the website never does, so a future policy mistake can't open a write path.
-- (Orders, events, flags, declines, sellers and push devices are only written by the Vercel API.)
revoke insert, update, delete, truncate, references, trigger on
    public.orders, public.order_events, public.order_flags, public.order_declines,
    public.push_subscriptions, public.sellers, public.alliances,
    public.market_bans, public.market_messages, public.order_messages
    from anon, authenticated;
revoke all on public.market_bans, public.market_messages, public.order_messages from anon;
revoke insert, delete, truncate, references, trigger on public.accounts from anon, authenticated;
revoke all on public.airlines from anon;
revoke truncate, references, trigger on public.airlines from authenticated;
revoke execute on function public.new_order_id() from anon, authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- ---------------------------------------------------------------------
--  7. Realtime (live order updates in both apps)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
    foreach t in array array['orders', 'order_events', 'order_flags', 'order_declines',
                             'market_messages', 'order_messages', 'market_bans'] loop
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
        ) then
            execute format('alter publication supabase_realtime add table public.%I', t);
        end if;
    end loop;
end $$;

-- ---------------------------------------------------------------------
--  8. Security repair (October 2026, safe to re-run).
--     Accounts used to take their Discord ID from user-editable metadata. Every account whose stored
--     Discord ID differs from its real Discord login is logged in public.security_repairs, loses any
--     seller access it got through the Discord role, and gets its real identity back.
--     See who was affected:  select * from public.security_repairs order by repaired_at;
-- ---------------------------------------------------------------------
create table if not exists public.security_repairs (
    account_id         uuid,
    display_name       text,
    claimed_discord_id text,
    real_discord_id    text,
    seller_removed     boolean,
    repaired_at        timestamptz not null default now()
);
alter table public.security_repairs enable row level security;   -- no policies: SQL Editor / service role only
revoke all on public.security_repairs from anon, authenticated;

insert into public.security_repairs (account_id, display_name, claimed_discord_id, real_discord_id, seller_removed)
select a.id, a.display_name, a.discord_id, i.provider_id,
       exists (select 1 from public.sellers s where s.user_id = a.id and s.source = 'discord_role')
from public.accounts a
left join auth.identities i on i.user_id = a.id and i.provider = 'discord'
where a.discord_id is distinct from i.provider_id;

delete from public.sellers s
using public.security_repairs r
where s.user_id = r.account_id and s.source = 'discord_role' and r.claimed_discord_id is distinct from r.real_discord_id;

-- Re-read every account from its real Discord login (fixes the ID, name and avatar).
update public.accounts set discord_id = null
where id in (select account_id from public.security_repairs where claimed_discord_id is distinct from real_discord_id);
select public.sync_account(u.id) from auth.users u;

-- Orders keep a copy of the buyer's Discord ID (for Discord mentions): bring those back in line too.
do $$
begin
    if exists (select 1 from public.orders o join public.accounts a on a.id = o.buyer_id
               where o.buyer_discord_id is distinct from a.discord_id) then
        alter table public.orders disable trigger orders_touch;
        alter table public.orders disable trigger orders_track_status;
        update public.orders o set buyer_discord_id = a.discord_id
        from public.accounts a
        where a.id = o.buyer_id and o.buyer_discord_id is distinct from a.discord_id;
        alter table public.orders enable trigger orders_touch;
        alter table public.orders enable trigger orders_track_status;
    end if;
end $$;

-- ---------------------------------------------------------------------
--  9. Make the API notice new tables/columns right away (otherwise it can
--     briefly report "could not find the ... column in the schema cache").
-- ---------------------------------------------------------------------
notify pgrst, 'reload schema';
