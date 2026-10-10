# Echo Market bot: banning and ordering from Discord (plan)

Status: plan only, nothing built yet. It reuses what already works on the website: the Echo Market bot,
market bans, warnings, the Market Banned role, the log channel, airline profiles and the order rules.

---

## 1. How it works (no bot running 24/7)

Discord can send each slash command to a web address. We add one function to the **buyer** Vercel site:

`https://echomarket-buyer.vercel.app/api/discord/interactions`

- **Signed requests.** Discord signs every command. The function checks the signature with the app's public
  key and refuses anything unsigned or older than 5 minutes, so nobody can fake a command.
- **3-second rule.** Discord wants a reply within 3 seconds. The function replies "working on it…" straight
  away, finishes the slow parts (DMs, role changes, log post), then edits the reply.
- **Private replies.** All replies are visible only to the person who ran the command.
- **Same code as the website.** The ban, warning and order logic moves into the shared server code, and both the
  website and the bot call it. One set of rules, no drift.

---

## 2. Ban via bot (Market Admins only)

### Commands

| Command | Fields | What it does |
|---|---|---|
| `/market ban` | **user**, **length** (1 week / 1 month / permanent), **reason** | Bans that Discord account from the buyer market |
| `/market unban` | **user**, note (optional) | Lifts their active ban early |
| `/market warn` | **user**, **message** | Sends a formal warning |
| `/market message` | **user**, **message** | Sends an information message |
| `/market info` | **user** | Shows active ban, number of warnings, recent orders |

**user** is Discord's member picker, so you choose the person directly and nobody types IDs.

### What happens on a ban (same as the seller desk)
1. Saved as a market ban (marked "via bot"), so it shows on the seller desk's **Moderation** tab.
2. The user gets the **Market Banned** role.
3. The user gets a **DM** with the length and reason.
4. A post goes to the **log channel**: who, by whom, length, reason.
5. They can't use the buyer market until it ends. When it ends, the role is removed: on their next visit, or by
   the daily clean-up that already runs.

It works for people who have **never used the web market**, because bans are tied to the Discord account.
Warnings and messages work the same way: saved, DMed, logged, and shown on the website if the person uses it.

### Who can use them: Market Admins only, checked twice
1. **Discord:** the `/market` commands are registered as hidden. In Server Settings → Integrations → Echo
   Market, you allow them for the **Market Admin** role only.
2. **Our code:** every command checks the signed request for the Market Admin role. If someone without it gets
   through (for example after a wrong Discord setting), they get "Only Market Admins can do this".

Extra safety: you can't ban yourself, and the bot refuses to ban another Market Admin.

---

## 3. Order via bot (any member)

### Commands

| Command | Fields | What it does |
|---|---|---|
| `/airline create` | **name**, **alliance** (choose from the 9) | Creates an airline profile |
| `/airline list` | — | Lists your airline profiles |
| `/order` | **airline**, extra airlines (up to 2 more, optional), **price level**, **aircraft**, **quantity** | Prepares an order and asks you to confirm |

- **airline:** a dropdown with your own profiles, including ones made on the website. Profiles made with the
  bot appear on the website too. Both count toward the same **20-profile cap**.
- **price level:** 90 % / 80 % / 70 % / 60 % / 50 % of the in-game list price, shown as "70 % (30 % off)".
- **aircraft:** type part of the **model name** ("a320", "777-9") and pick from the suggestions. Codes are
  never needed.
- **quantity:** 1–500.

### Confirming
`/order` replies privately with a summary and two buttons, **Send order** and **Cancel**. The summary shows:
- the aircraft, quantity and price level
- the total
- the airline(s) it can be delivered to
- how much of the 24-hour limit it uses

Pressing **Send order** places it exactly like a web order:
- it gets its **#number**
- it appears on the **seller desk** instantly
- it is posted to the **request channel**, pinging the Verified Seller role
- the buyer gets the **"Order received" DM**

It then shows up under **Orders** on the website, where the buyer can follow it, cancel it while nobody has
taken it, or message the seller team after 5 days.

### Same rules as the website
Every bot command checks the same things as the website:
- **Members only:** you must be a member of the Echo Alliances server.
- **No bans:** neither a market ban nor the Market Banned role.
- **Pricing:** the price level must be one of the allowed ones, and the server recalculates every price.
- **24-hour limit:** $10B, counted at list price.
- **Order cap:** 5 orders per 10 minutes.
- **Profiles:** at most 20 airline profiles.

### One-time link to the website
A bot order needs a market account, and that account is created the first time someone **signs in on the
website with Discord**. That sign-in is what securely ties a Discord account to the market. People who haven't
signed in yet get a private reply with the link, then everything works from Discord.

### Limits of the first version
- **One aircraft type per `/order`.** For a mixed order, run `/order` twice or use the website. Version 2 could
  add an **Add another aircraft** button to the summary.
- **Website only for now:** order status, cancelling and messaging the seller team.

---

## 4. What you would set up (≈15 minutes)

1. **Fix the log channel first:** give the bot View Channel, Send Messages and Embed Links there. The health
   page currently says it can't see it.
2. **Discord Developer Portal → your app → General Information:** copy the **Application ID** and **Public Key**.
3. **Vercel, buyer project → Environment Variables:** add these, then redeploy.
   - `DISCORD_APP_ID`
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_MARKET_ADMIN_ROLE_ID`
   - `DISCORD_LOG_CHANNEL_ID`
4. **Developer Portal → General Information → Interactions Endpoint URL:** set it to
   `https://echomarket-buyer.vercel.app/api/discord/interactions` and save. Discord tests it on save.
5. **Give the bot permission to add commands:** open the bot's invite link again with
   `scope=bot%20applications.commands`. The bot stays in the server; this only adds the commands.
6. **Register the commands:** I run a one-off script with you that adds them to the Echo Alliances server, so
   they appear straight away.
7. **Server Settings → Integrations → Echo Market:** allow `/market` for **Market Admin** only, and `/airline`
   and `/order` for everyone (or a role you pick).
8. **Check:** ask me to check the health page. It will show new lines for the commands.

---

## 5. How it gets tested before going live

Same as everything so far, on a local copy with a fake Discord that sends properly signed commands:
- unsigned or tampered commands are refused
- `/market` from someone without Market Admin is refused
- a ban saves the ban, gives the role, DMs, logs, blocks the website and shows on the Moderation tab;
  `/market unban` undoes all of it
- warnings and messages are saved, DMed and logged
- `/airline create` respects the 20 cap, and its profiles show on the website
- the aircraft suggestions find models by name
- `/order` → Send order lands on the seller desk with the ping and DM; Cancel does nothing
- non-members, banned users and people over the limits get a clear private refusal

---

## 6. Effort

About two working sessions:
- **Session 1:** the signed endpoint plus the `/market` commands.
- **Session 2:** `/airline` and `/order`.
