# Echo Market bot: banning and ordering from Discord (plan)

Status: **built** (October 2026). Setup steps: SETUP.md Part 12. It reuses what already works on the website: the
Echo Market bot, market bans, warnings, the Market Banned role, the log channel, airline profiles and the order rules.

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
| `/airline rename` | **airline** (yours), **name** | Renames it; open orders for it show the new name too |
| `/airline list` | — | Lists your airline profiles |
| `/order` | **airline**, extra airlines (up to 2 more, optional), **price level**, **aircraft** + **quantity** (up to 3 types: aircraft2/quantity2, aircraft3/quantity3) | Prepares an order and asks you to confirm |

Deleting an airline profile is **website only** (on purpose: it's the one step that can't be undone).

- **airline:** a dropdown with your own profiles, including ones made on the website. Profiles made with the
  bot appear on the website too. Both count toward the same **20-profile cap**.
- **price level:** 90 % / 80 % / 70 % / 60 % / 50 % of the in-game list price, shown as "70 % (30 % off)".
- **aircraft:** type part of the **model name** ("a320", "777-9") and pick from the suggestions. Codes are
  never needed.
- **quantity:** 1–500.

### Confirming
`/order` replies privately with a summary and the buttons **Send order**, **Add aircraft**, **Remove last** (when there are
several lines) and **Cancel**. **Add aircraft** opens a small form: model name ("A350-900", "777-9"), quantity, and
optionally its own price level. The same model at the same price level is merged into one line. Up to 20 lines,
like the website. The summary shows:
- each aircraft line with quantity and price level
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
- **Website only for now:** order status, cancelling and messaging the seller team.

---

## 4. Setup

See SETUP.md Part 12 (the order matters: the website must have the public key before Discord can verify the URL).

---

## 5. How it was tested

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
