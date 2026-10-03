# Echo Market

Aircraft ordering for the Echo UA virtual airline world.
- **Buyers** sign in with Discord, create airline profiles (up to 20) and order aircraft at a chosen price level.
- **Sellers** take orders as one of their airlines, sell the aircraft in-game, and record deliveries.
- **Buyers follow along** live and get Discord DMs, and the seller channels get order posts.

One repo, **two Vercel projects**, one Supabase database:

| Folder | Vercel project (Root Directory) | Who uses it |
|---|---|---|
| [`buyer/`](buyer) | buyer site, e.g. `echomarket-buyer.vercel.app` | everyone: the market |
| [`seller/`](seller) | seller site, e.g. `echomarket-seller.vercel.app` | accounts in the `sellers` table |
| [`shared/`](shared) | not deployed | code both apps use; copied into each by `npm run sync` |
| [`supabase/`](supabase) | not deployed | `schema.sql`: tables, security rules, triggers |

Both sites have `/api/health`, a setup checklist that never shows secrets.

- **New here? → [SETUP.md](SETUP.md)** walks through everything, step by step.
- **Background and decisions → [HANDOVER.md](HANDOVER.md).**

## How it's built

There is no build step: plain HTML plus ES modules, using React and [htm](https://github.com/developit/htm) loaded from a CDN, and Tailwind via its CDN. Edit a file, push to GitHub, and Vercel redeploys both sites.

```
buyer/
  index.html, js/app.js        the market
  api/orders.js                place an order (prices recalculated server-side)
  api/orders/[orderId].js      buyer cancels an untaken order
  api/test-dm.js               "send me a test DM"
  lib/pricing.js               price levels (90–50%), limits
  aircraft_pricelist.json      the catalog; edit prices here
seller/
  seller.html, js/seller.js    the seller desk (served at /)
  api/orders/[orderId].js      seller actions: claim, release, progress, note, decline, flag, delete
shared/                        ← edit these, then `npm run sync`
  lib/server.js                Supabase admin client, auth, Discord channel posts + DMs
  js/ui.js                     shared components (buttons, modals, status badges…)
  api/config.js                public settings for the browser
  api/health.js                setup checklist
buyer/lib/site.js, seller/lib/site.js   the only per-app difference in lib/ ("buyer" / "seller")
```

**Shared code:** each Vercel project only sees its own folder, so `npm run sync` copies `shared/` into `buyer/` and `seller/`. Run `npm run check` before committing; it fails if a copy is stale.

**Data flow:**
- Browsers **read** straight from Supabase. Row Level Security means buyers only see their own data, and sellers see all orders.
- Every **change to an order** goes through the app's `/api`. It checks permissions and prices, writes the order and its timeline, then updates Discord.

## Settings (Vercel environment variables, same values in both projects)

| Key | Needed for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | everything |
| `BUYER_URL`, `SELLER_URL` | links between the two sites, Discord post links, DM links |
| `DISCORD_BOT_TOKEN` | DMs to buyers |
| `DISCORD_WEBHOOK_REQUEST` / `_PROGRESS` / `_FULFILLED` (or one `DISCORD_WEBHOOK_URL`) | posts in seller channels |
| `DISCORD_ROLE_ID` | pinging sellers on new orders |

## Rules that live in code

| Rule | Where |
|---|---|
| Price levels 90/80/70/60/50% (no 100%) | `buyer/lib/pricing.js` + `buyer/js/app.js` |
| $10B per account per rolling 24h; max 500 per line, 20 lines | `buyer/lib/pricing.js` |
| Max 20 airlines per account | `supabase/schema.sql` (`enforce_airline_limit`) |
| One account per Discord user | Discord-only login + unique `discord_id` |
| Buyer can cancel only before a seller takes the order | `buyer/api/orders/[orderId].js` |
| Alliances list | `alliances` table (edit in Supabase, no code change) |
