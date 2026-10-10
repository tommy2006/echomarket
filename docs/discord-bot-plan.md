# Plan: Echo Market bot commands on Discord

Status: **plan, not built yet**. Everything below reuses what the market already has: the Echo Market bot, the
moderation rules, the order rules, the Market Banned role and the moderation log channel.

## 1. How the bot would receive commands

The bot today only *sends* (DMs, role changes, log posts). To answer slash commands it does **not** need to run
24/7: Discord can deliver each command as a web request to an **Interactions Endpoint URL**, which a Vercel
function answers, exactly like our other `/api` functions. No new hosting, no extra cost.

- New function: `buyer/api/discord/interactions.js` (the buyer project, because ordering needs the aircraft
  price list that lives there; the moderation code is shared, so it works from either project).
- Every request is **signed by Discord**. The function verifies the Ed25519 signature with the app's public key
  (`DISCORD_PUBLIC_KEY`) and rejects anything unsigned or older than 5 minutes. This is mandatory: without it
  anyone could fake commands.
- Discord wants an answer within 3 seconds. Slow work (Discord role changes, DMs) is answered with "thinking…"
  first and finished in the background (`waitUntil`), then the reply is edited.
- Commands are registered once for the Echo server with a small script (`npm run register-commands`), so they
  appear immediately and only in our server.

## 2. Moderation commands (Market Admins only)

| Command | Options | Does |
|---|---|---|
| `/market warn` | user, message | Same as "Send message → Warning" on the seller desk |
| `/market message` | user, message | Information message |
| `/market ban` | user, length (1 week / 1 month / permanent), reason | Same as the seller desk ban |
| `/market unban` | user, note (optional) | Lifts the active ban |
| `/market info` | user | Active ban, number of warnings, recent orders (private reply) |

**Only Market Admins**, enforced twice:
1. Discord side: the commands are registered hidden from everyone ("default permissions: none"); a server admin
   then allows the **Market Admin** role under Server Settings → Integrations → Echo Market.
2. Our side: every command re-checks that the person running it has the Market Admin role (from the signed
   request), so a wrong Discord setting can't open it up. (Lead Ambassadors and hand-added admins can keep using
   the seller desk; on Discord it is Market Admins only, as asked.)

What happens on a ban or warning (identical to the seller desk, the code is shared):
- saved in `market_bans` / `market_messages` with `source = 'bot'` (so the seller desk Moderation tab shows it);
- **DM to the user**; **post in the logging channel**; a ban gives the **Market Banned** role;
- works for people who never used the web market (it's tied to the Discord account);
- the role is removed when the ban ends (on their next visit, or by the daily clean-up already in place);
- all replies to the admin are private ("only you can see this").

Prep work in the code: move the ban / unban / message logic out of `seller/api/admin/moderation.js` into
`shared/lib/server.js` (`issueBan`, `liftBan`, `sendMarketMessage`), so the website and the bot run exactly the
same rules.

## 3. Buyer commands (airlines and orders)

| Command | Options | Does |
|---|---|---|
| `/airline create` | name, alliance (choice of the 9) | Creates an airline profile (counts toward the 20) |
| `/airline list` | — | Lists your airline profiles |
| `/order` | airline (autocomplete, up to 3 options for several airlines), price level (90 % … 50 % of list price), aircraft model (autocomplete by **name**), quantity (1–500) | Shows a private summary with the total and your 24-hour limit, and **Send order** / **Cancel** buttons |

- **Profiles:** the bot reads the same `airlines` table as the website, so profiles made on either side show up
  on both, and the 20-profile cap applies to both together.
- **Model names:** autocomplete searches the price list by model name as you type (e.g. "a320" → "Airbus
  A320neo"); codes are never asked for.
- **Sending:** "Send order" calls the same order code the website uses (move the body of `buyer/api/orders.js`
  into a shared `placeOrder()`), so the order gets its number, the seller ping and channel post, the buyer's DM,
  and appears on the seller desk live, exactly like a web order. Same checks: Echo member, not market-banned,
  price levels, 24-hour limit at list price, 5 orders per 10 minutes.
- **One aircraft model per `/order`** in the first version (Discord commands have fixed options). Version 2: an
  "Add another aircraft" button that builds a multi-line order in the private summary.
- **Who can use it:** anyone in the server who has signed in on the website **once**. Their market account is
  created by that first Discord sign-in (it's what links the Discord account to the market safely). People who
  haven't get a private reply with the link. (Creating accounts from the bot alone would need changes to how
  accounts are created; possible later, not needed to start.)
- Not in v1: cancelling, order status and messaging the seller team from Discord (they stay on the website and
  in DMs). Easy to add later with the same pattern.

## 4. What you'd set up (≈15 min)

1. Discord Developer Portal → your app → **General Information**: copy the **Application ID** and **Public Key**.
2. Vercel (buyer project): `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, plus `DISCORD_MARKET_ADMIN_ROLE_ID` and
   `DISCORD_LOG_CHANNEL_ID` (the buyer project would now also post moderation logs). Redeploy.
3. Developer Portal → General Information → **Interactions Endpoint URL**:
   `https://echomarket-buyer.vercel.app/api/discord/interactions` (Discord tests it when you save).
4. Re-authorise the bot with the commands scope (same invite link with `scope=bot%20applications.commands`).
   It stays in the server; this only adds slash commands.
5. Server Settings → Integrations → Echo Market: allow the `/market` commands for **Market Admin** only;
   `/airline` and `/order` for everyone (or for a role you choose).
6. Run `npm run register-commands` once (I'd do it with you).

## 5. Testing

Same approach as everything else: a local fake Discord that sends signed command requests to the function,
covering: bad signature refused, non-Market-Admin refused, ban/warn/unban results (DM, role, log, database),
airline creation and the 20 cap, autocomplete, order placement (seller ping, DM, seller desk), banned and
non-member users refused.

## 6. Effort

Roughly two working sessions: one for the endpoint, signature checks and moderation commands, one for airlines
and orders.
