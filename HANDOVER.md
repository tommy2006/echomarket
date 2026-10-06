# Echo Market — handover notes

*Written October 2026, when the market was rebuilt after the original developer (falcc00) left.*

## What was wrong with the old app

The old app lived in two repos and two Vercel projects owned by falcc00 (github.com/falcc00/echo-market-buyer and echo-market-seller).

| Symptom | Root cause |
|---|---|
| **HTTP 404s, orders never arrived** | The buyer site called `/api/orders` and `/api/push`, but those server functions were never committed to GitHub. No order could be placed. Worse, checkout showed "success" and emptied the cart *before* the request failed. |
| **Airline profiles disappeared** | They existed only in each browser's localStorage. A new device, private mode, the Discord in-app browser, or a domain change all start empty. |
| **Seller carrier not shown** | Never built. The seller's name was a free-text box, and there was no "take order" step. |
| **100% price level** | It was in the list, and no server checked prices. A buyer could send any price. |

**Other problems:**
- The buyer's links pointed at someone else's site (`echo-market.vercel.app`) and at a seller site that doesn't exist.
- The airline name box couldn't hold spaces.
- Checkout could send orders as airline "Unknown".
- Item notes were dropped.
- The daily limit was browser-only.
- The alliance lists were out of sync, and CDN versions weren't pinned.

**Old data could not be migrated:**
- Orders were in falcc00's Upstash Redis, and the keys left with him.
- Airline profiles live in players' browsers on the *old* domain. Browsers keep data per site, so the new site can't read it. Players re-create their airlines, which takes seconds.

## What it is now

**One repo ([tommy2006/echomarket](https://github.com/tommy2006/echomarket)), two Vercel projects (`buyer/` and `seller/` as Root Directories), one Supabase project.** Code both apps use lives in `shared/` and is copied into each app by `npm run sync`. Seller access is controlled by Discord login plus the `sellers` table, which replaces the old shared password.

| Area | Now |
|---|---|
| Accounts | Discord login only, so one market account per Discord user (also enforced by a unique `discord_id`). |
| Airlines | Up to 20 per account, saved in the database, on every device. |
| Orders | Validated server-side: prices recalculated from `aircraft_pricelist.json`, levels 90/80/70/60/50% only, max 500 per line and 20 lines, $10B per account per rolling 24h. |
| Sellers | Curated list (`sellers` table). "Take order" makes the seller choose which of their airlines sells, and the buyer sees it. |
| Statuses | Waiting for seller → Seller assigned → Delivering → Delivered, plus Cancelled (buyer, only before it's taken) and Declined (seller, with a reason). Sellers can release an order back to the queue if nothing was delivered. |
| Alliance hint | Sellers see **NO SHARED ALLIANCE** when none of their airlines is in the buyer's alliance. When taking an order, same-alliance airlines are preferred and labelled, and a warning appears otherwise. Taking the order is still allowed. |
| Notifications | An in-app 🔔 inbox (stored, so it survives reloads), browser alerts while the tab is open, and **Discord DMs** from the Echo Market bot when an order is taken, delivered (partly or fully) or declined. Each player can turn DMs off and send themselves a test DM. |
| Discord channels | One message per order, moved between the request, progress and done channels by webhook. New and released orders ping the seller role. |
| Moderation | Normal / Suspicious / Blacklisted flags, visible to sellers only. |
| Setup checks | `/api/health` shows what's configured, without revealing secrets. |

## Order rules added later (October 2026)

| Rule | How it works |
|---|---|
| **Delivery per aircraft type** | Each line in `orders.items` has `filled` (delivered so far) and `locked` (delivered before the current seller took over). Sellers update each type separately; buyers see one bar per type. |
| **Team decline** | **Decline** on an open order is a *pass* for that seller only, stored in `order_declines` and visible only to sellers. The order is declined for the buyer only when every active seller has passed; the last one must write the reason the buyer sees. Admins can still decline for everyone (spam, rule breaks). A seller who passed can change their mind and take the order. |
| **Pass on the rest** | A seller who can't finish clicks **Pass on the rest**. The order goes back to the open queue as *Partly delivered · needs seller*, delivered aircraft stay counted and locked, and the seller is recorded in `orders.previous_sellers`. The buyer gets a DM and can no longer cancel. |
| **Order numbers** | Every order has a serial number (`orders.serial`, #1, #2, … in the order they were placed) next to its code (ECH-…). Both show on both sites, in Discord posts and in DMs. Older orders were numbered by date when the schema was re-run. Numbers of deleted orders are not reused. |
| **Sellers from the Discord role** | `seller/api/enroll.js`, called when someone opens the seller desk: having the seller role (`DISCORD_ROLE_ID`) in a server the bot is in adds them (`sellers.source = 'discord_role'`); losing it switches them off. Rows added by hand (`source = 'manual'`) are never touched, which is also how to block someone who has the role. |
| **Buyer info for sellers** | Clicking the buyer's airline name (or the Buyer card in an order) shows their Discord profile, ID, a copyable @mention, whether bot DMs reach them, and all their orders. |
| **Several delivery airlines** | At checkout the buyer picks one or more of their airlines (buttons, like the alliance picker). They are stored in `orders.airlines`; the first is also `airline_id` / `airline_name` / `alliance`. Sellers see every airline, the "no shared alliance" warning checks all of them, and taking an order says which buyer airline to deliver to. The number of aircraft doesn't change. |
| **Phone & browser alerts** | Web push (`buyer/sw.js`, `push_subscriptions`, `/api/push`) when an order is **fully delivered**. Needs the VAPID keys (SETUP.md Part 10). iPhone users must add the site to their Home Screen first. |

## Security rules (October 2026)

A player took over seller access by editing their own Supabase user metadata (`supabase.auth.updateUser({ data: { provider_id } })`), which the old account trigger copied into `accounts.discord_id`. Fixed, and these rules now hold:

| Rule | Where |
|---|---|
| A player's Discord ID, name and avatar come **only** from `auth.identities` (written by Supabase during the Discord login). `raw_user_meta_data` / `user_metadata` is player-editable and is never read. | `public.sync_account()` in schema.sql |
| Every API request re-checks the stored Discord ID against the login and repairs it if they differ. | `requireUser()` in shared/lib/server.js |
| Accounts that were tampered with are logged in `public.security_repairs` (SQL Editor only) and lose role-based seller access. | schema.sql section 8 |
| Avatars must be on `cdn.discordapp.com`. | `sync_account()` |
| Player text in Discord posts and DMs is markdown-escaped (no masked links, fake formatting or mentions); only the seller role can be pinged. | `md()` in server.js |
| Phone-alert subscriptions must point at a real browser push service. | `pushEndpointAllowed()` |
| At most 5 orders per account per 10 minutes (each pings the seller role). Orders sent at the same moment can't get around the 24-hour limit. | buyer/api/orders.js |
| `/api/health` is cached for a minute, so reloading it can't run the bot into Discord's rate limit. | health.js |

## Decisions you made (October 2026)

1. **Price level** = the seller sells at that % of the in-game list price. It's a discount-buying app. A lower % *might* be accepted less quickly. The shop explains this.
2. Keep $10B per 24h per account, and 500 per line. The limit counts aircraft at **100% list price**, so ordering at 50% doesn't let anyone buy twice as many.
3. No cancelling after a seller has taken the order.
4. Don't restrict by alliance, but warn sellers when they share no alliance with the buyer.
5. Airline names are unique only within one account. Alliances have overlapping names.
6. Add Discord DMs to buyers (done, via the bot).
7. Start fresh under your own accounts; you direct the technical vision from here.

## Ideas for later

- **Admin page to add and remove sellers** (most sellers now come in through the Discord role; admins are still added by SQL).
- **Account-level blacklist,** blocking a player from ordering at all. Today flags are per order.
- **Seller DMs for new orders** (opt-in), using the same bot.
- **Custom domain** (e.g. `market.yourdomain.com`). Vercel supports this for free if you own a domain.

## Testing done before handover

- **Database:** real Postgres 17 with the actual schema. Checked the 20-airline cap, one account per Discord ID, and that users can't see each other's data, can't edit orders or flags directly, and can only change their own notification settings.
- **API:** 52 automated checks, run against the buyer and seller apps as two separate servers just like on Vercel, through PostgREST (Supabase's REST layer) with a fake Discord, all passing. They cover pricing, rejecting 100%, the 24h limit, the claim/release/progress/decline/flag/delete permissions and races, cancel rules, DMs (sent, DMs closed, turned off, no DM on corrections), the health check and the config.
- **Browser click-through:** onboarding → airline → order → seller takes it → deliveries → the buyer sees the seller and progress, plus the alliance warnings, the DM toggle and test DM, and the phone layout.
- **Only testable on the real services:** Discord's OAuth redirect, Supabase Realtime (live updates; the pages also refresh when you return to the tab), and real Discord delivery.
