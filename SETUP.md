# Echo Market — setup guide (start to finish)

This guide takes you from "code on GitHub" to "players are ordering planes". Nothing is assumed: every click, every copy-paste, and every place where you can just ask Claude to do it for you.

**Time:** about 2 hours in total, split into 9 parts. You can stop after any step; each part ends at a safe checkpoint.

**Cost:** €0. Everything uses free plans (GitHub Free, Vercel Hobby, Supabase Free, Discord).

---

## How to read this guide

| Mark | Meaning |
|---|---|
| 🧑 **You** | You click or type in a website. |
| 💬 **Tell Claude** | Copy the quoted sentence into the Claude Code chat. Claude does the work and tells you the result. |
| ▶ **Run** | A terminal command. In the Claude app, code blocks have a **Run** button, or you can ask Claude to run it. |
| 🔒 **Secret** | A password-like value. Copy it **straight from the website into Vercel**. Never paste it into the chat, Discord or a file. |
| 🙋 **Admin** | Needs a Discord server admin. There's a ready-made message for them in Part 6. |

> **Starting a new Claude session later?** Begin with:
> 💬 *"I'm setting up Echo Market from the echomarket repo (github.com/tommy2006/echomarket), following SETUP.md. I just finished step X."*

### The 4 values that must never go in the chat

1. Supabase **secret key** (starts with `sb_secret_`, or the legacy `service_role` key)
2. Discord **Client Secret**
3. Discord **bot token**
4. Discord **webhook URLs** (anyone holding one can post in that channel)

Claude never needs them. When something is wrong, Claude checks `/api/health` on either site, which reports *whether* each value works without ever showing it.

---

## The big picture

```
                          Players / sellers
                     ┌───────────┴───────────┐
                     ▼                       ▼
        ┌──────────────────────┐ ┌──────────────────────┐
        │ Vercel project:      │ │ Vercel project:      │
        │ BUYER (market)       │ │ SELLER (desk)        │      ┌──────────────────────┐
        │ root dir: buyer/     │ │ root dir: seller/    │ ◄─── │ GitHub: one repo     │
        └──────────┬───────────┘ └───────────┬──────────┘      │ tommy2006/echomarket │
                   └───────────┬─────────────┘                  └──────────────────────┘
                               ▼
   ┌──────────────────────┐          ┌──────────────────────┐
   │ Supabase             │ ◄──────► │ Discord              │
   │ database + logins    │          │ login, channel posts,│
   └──────────────────────┘          │ DM bot               │
                                     └──────────────────────┘
```

- **One GitHub repo, two websites.** Vercel builds the buyer site from the `buyer/` folder and the seller site from the `seller/` folder.
- **One shared database.** Both sites use the same Supabase project.
- **Automatic deploys.** Every push to GitHub redeploys both sites.

**Words used below**

- **BUYER-SITE**: the name you give the buyer Vercel project, e.g. `echomarket-buyer`. Its address is `https://BUYER-SITE.vercel.app`.
- **SELLER-SITE**: the name you give the seller Vercel project, e.g. `echomarket-seller`. Its address is `https://SELLER-SITE.vercel.app`.
- **PROJECT-REF**: the 20-letter ID of your Supabase project, e.g. `abcdefghijklmnopqrst`.

---

## Part 1 — The code on GitHub (≈10 min)

The code is already in **https://github.com/tommy2006/echomarket**:

```
buyer/      the market players use
seller/     the seller desk
shared/     code both apps use (copied into each by "npm run sync")
supabase/   schema.sql, the database setup
SETUP.md    this guide
```

**1.1 🧑 Make sure your GitHub account can use the repo**
- If you are **tommy2006**, you're set.
- If not, the owner (tommy2006) adds you: **repo → Settings → Collaborators → Add people**. Then accept the email invite.

Vercel can only import repos your GitHub account owns or collaborates on.

**1.2 💬 Log the GitHub tool in** (so Claude can push changes for you later). Tell Claude:
> *"Log me into the GitHub CLI using the web browser flow, in my terminal panel."*

Claude opens a terminal tab and runs `gh auth login --web`. Then:
1. The terminal shows an 8-character code like `ABCD-1234`. Copy it.
2. A browser window opens at github.com/login/device. Paste the code and click **Authorize**.
3. The terminal says "Logged in as …".

✅ **Checkpoint:** https://github.com/tommy2006/echomarket shows the `buyer`, `seller`, `shared` and `supabase` folders.

---

## Part 2 — Database: Supabase (≈20 min)

Supabase holds accounts, airlines and orders, and handles "Sign in with Discord". **Both** sites use this one project.

**2.1 🧑 Create a Supabase account**
1. Go to https://supabase.com/dashboard.
2. Choose **Continue with GitHub** and authorize it.
3. If asked, create an **organization**. Name it e.g. "Echo Market" and pick the **Free** plan.

**2.2 Connect Claude to Supabase** (recommended)
1. Click **Connect** on the *Supabase* card Claude showed in the chat. You can also add it from the Connectors section of the Claude app's settings.
2. Log in and approve your organization.

💬 Then tell Claude:
> *"Using the Supabase connector, create a free project called echomarket in the region closest to most of our players, then run supabase/schema.sql on it."*

Claude shows you the cost (**$0** on Free) and asks you to confirm before creating anything.

<details><summary>Do it by hand instead</summary>

1. In the Supabase dashboard, click **New project**.
   - Name: `echomarket`.
   - Database password: click **Generate a password**, then save it in your password manager.
   - Region: closest to your players.
   - Plan: Free.
2. Wait about 2 minutes for it to finish setting up.
3. Left menu → **SQL Editor** → **New query**.
4. On GitHub, open `supabase/schema.sql` and click **Copy raw file**. Paste it into the editor.
5. Click **Run** (or press Ctrl+Enter). You should see *"Success. No rows returned"*.
</details>

**2.3 Collect the three Supabase values.** You'll paste them into Vercel in Part 4. Leave the tab open.

- **Project URL** and **publishable key** (both public). Tell Claude:
  > 💬 *"What's my Supabase project URL, project ref and publishable key?"*

  Or find them by hand:
  - The URL is under **Project Settings → Data API**.
  - The publishable key is under **Project Settings → API Keys** and starts with `sb_publishable_`.
- 🔒 **Secret key.** Go to **Project Settings → API Keys → Secret keys**, click **Reveal**, then **Copy**. It starts with `sb_secret_`.
  - Copy it **only when you're about to paste it into Vercel**.
  - If your project only shows a **Legacy API keys** tab, use `anon` as the publishable key and `service_role` as the secret key. Both pairs work.

✅ **Checkpoint:** In Supabase, **Table Editor** lists `accounts`, `airlines`, `alliances`, `orders`, `order_events`, `order_flags` and `sellers`.

---

## Part 3 — Discord application: login + DM bot (≈20 min)

One Discord "application" powers **Sign in with Discord** on both sites. Its **bot** DMs players about their orders.

**3.1 🧑 Create the application**
1. Go to https://discord.com/developers/applications and log in with your normal Discord account.
2. Click **New Application**.
3. Name it **Echo Market**, tick the box to accept the Developer Terms, and click **Create**.
4. Optional: upload `buyer/echo_logo.png` as the **App Icon**.

**3.2 🧑 Login settings (OAuth2 page)**
1. Left menu → **OAuth2**.
2. Under **Client information**:
   - Copy the **Client ID**. It's public.
   - Click **Reset Secret**, then **Yes, do it!**, and copy the 🔒 **Client Secret**. You'll paste it into Supabase in the next step.
3. Under **Redirects**, click **Add Redirect** and paste the callback URL, then click **Save Changes**:

   ```
   https://PROJECT-REF.supabase.co/auth/v1/callback
   ```

   > 💬 *"What's my exact Supabase auth callback URL for Discord?"*

**3.3 🧑 Turn on Discord login in Supabase**
1. Supabase → **Authentication → Sign In / Providers**.
2. Click **Discord**:
   - Turn on **Enable Sign in with Discord**.
   - Paste the **Client ID** and the 🔒 **Client Secret**.
   - Click **Save**.
3. Click **Email**, turn it **off**, and click **Save**. With Discord as the only way in, each Discord user gets exactly one market account.

**3.4 🧑 Create the bot (for DMs)**
1. Developer portal → **Bot**.
2. Click **Reset Token**, then **Yes, do it!**, and copy the 🔒 **token**. Discord shows it **only once**, but you can reset it again any time.
3. Settings on the same page:
   - **Public Bot: ON** only while it is being invited. Once it is in the Echo Alliances server, turn it **OFF** so nobody else can add it to their own servers (security report MKT-03).
   - **Requires OAuth2 Code Grant: OFF.**
   - **Privileged Gateway Intents: all OFF.**
4. Click **Save Changes**.

**3.5 💬 Make the bot invite link.** Tell Claude:
> *"Make me the Discord bot invite link. My Client ID is 123456789012345678."*

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=0
```

`permissions=0` means the bot can't read, post or moderate anything in the server.

✅ **Checkpoint:** Supabase shows Discord **Enabled** and Email **Disabled**, and you have the invite link.

---

## Part 4 — Two websites on Vercel (≈25 min)

You create **two** Vercel projects from the same repo. They differ only in name and **Root Directory**.

**4.1 🧑 Create a Vercel account**
1. Go to https://vercel.com/signup and choose the **Hobby** plan.
2. Choose **Continue with GitHub** and authorize it.

Optional: click **Connect** on the *Vercel* card in the chat, so Claude can read deployments and error logs.

**4.2 🧑 Choose the two names first.** You need both addresses as settings in *both* projects, so decide them up front:

| | Project Name | Address |
|---|---|---|
| Buyer | `echomarket-buyer` (example) | `https://echomarket-buyer.vercel.app` |
| Seller | `echomarket-seller` (example) | `https://echomarket-seller.vercel.app` |

If Vercel says a name is taken, pick another and use *that* address below.

**4.3 🧑 Create the BUYER project**
1. **Add New… → Project** → find `echomarket` under **Import Git Repository** → **Import**.
   - Don't see it? Click **Adjust GitHub App Permissions** and allow the repo.
2. **Project Name:** your BUYER-SITE name.
3. **Framework Preset:** `Other`.
4. **Root Directory:** click **Edit**, choose **`buyer`**, then **Continue**.
5. **Environment Variables:** add each row (Key, Value, **Add**):

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | Project URL from 2.3 |
   | `SUPABASE_PUBLISHABLE_KEY` | publishable key from 2.3 |
   | `SUPABASE_SECRET_KEY` | 🔒 secret key from 2.3 |
   | `BUYER_URL` | `https://BUYER-SITE.vercel.app` |
   | `SELLER_URL` | `https://SELLER-SITE.vercel.app` |
   | `DISCORD_BOT_TOKEN` | 🔒 bot token from 3.4 |

6. Click **Deploy**. Wait about 1 minute.

**4.4 🧑 Create the SELLER project.** Repeat 4.3 with **Add New… → Project → `echomarket` → Import** again, with these differences:
- **Project Name:** your SELLER-SITE name.
- **Root Directory:** **`seller`**.
- **The same six environment variables** with the same values. The seller site also needs the bot token, because it sends the "taken" and "delivered" DMs.

> Tip: after the first project is set up, you can paste all six variables in one go. Copy them as `KEY=value` lines and paste into the first **Key** box; Vercel splits them up.

**4.5 🧑 Tell Supabase about both sites.** Without this, logins bounce back to the wrong address.
1. Supabase → **Authentication → URL Configuration**.
2. **Site URL:** `https://BUYER-SITE.vercel.app`.
3. **Redirect URLs** → **Add URL**, twice:
   - `https://BUYER-SITE.vercel.app/**`
   - `https://SELLER-SITE.vercel.app/**`
4. Save.

**4.6 💬 Check both.** Tell Claude:
> *"Check https://BUYER-SITE.vercel.app/api/health and https://SELLER-SITE.vercel.app/api/health and tell me what's left."*

Each is a checklist: ✅ done, ❌ required and missing, ➖ optional. At this point "at least one seller", "bot is in your server" and the webhooks are expected to be missing.

✅ **Checkpoint:**
- The buyer address shows the Echo Market home page.
- The seller address shows **"Echo Market seller desk — Sign in with Discord"**.
- Both `/api/health` pages say `"ready": true`.

---

## Part 5 — First sign-in: make yourself the admin seller (≈10 min)

**5.1 🧑 Sign in on the buyer site**
1. Open `https://BUYER-SITE.vercel.app` → **Sign in with Discord** → **Authorize**.
2. You land back signed in. The banner says *Step 2 of 3: Create your first airline profile*.

**5.2 🧑 Create your airline** there: **Create airline**, enter a name, pick an alliance.

**5.3 🧑 Get your Discord ID**
1. Open `https://SELLER-SITE.vercel.app` and sign in with Discord. It's quick the second time.
2. It says **"You're not on the seller list yet"** and shows your Discord ID. Click it to copy.

**5.4 💬 Make yourself admin.** Tell Claude:
> *"Using the Supabase connector, make Discord ID 123456789012345678 an admin seller."*

<details><summary>Do it by hand instead</summary>

In Supabase **SQL Editor**, open a **New query**, paste this, and click **Run**:

```sql
insert into public.sellers (user_id, is_admin)
select id, true from public.accounts where discord_id = 'PASTE_YOUR_DISCORD_ID';
```

It should say "1 row affected". If it says 0 rows, sign in first (5.1).
</details>

✅ **Checkpoint:** after a refresh, the seller site shows the desk with **Selling as: (your airline)** at the top.

---

## Part 6 — Discord server pieces (needs an admin) (≈10 min for you, plus admin time)

You need three things:
1. **Channel webhooks**, so orders get posted to seller channels.
2. **The bot in the server.** Discord only lets a bot DM people who share a server with it.
3. **The seller role ID**, so new orders ping sellers.

**6.1 🧑 Turn on Discord Developer Mode:** **User Settings → Advanced → Developer Mode**.

**6.2 🙋 Send this to your admins** (edit the bits in [brackets]):

> Hi! I've taken over the Echo Market app after [old dev] left, and rebuilt it so it actually works: Discord login, saved airlines, sellers taking orders, and order updates.
> Market: https://BUYER-SITE.vercel.app · Seller desk: https://SELLER-SITE.vercel.app
>
> Could you help with 3 small things?
> 1. **Webhooks**: in each of these channels go to *Edit Channel → Integrations → Webhooks → New Webhook*, name it "Echo Market", click *Copy Webhook URL*, and DM me the URL. Treat these like passwords.
>    - [#market-requests]: new orders
>    - [#market-in-progress]: orders a seller has taken
>    - [#market-done]: finished orders
>
>    One channel for all three is fine too.
> 2. **Invite the Echo Market bot**: [BOT INVITE LINK]. It asks for **no permissions**. It can't read or post in channels. It only DMs players when *their own* order is taken or delivered, and players can turn that off.
> 3. **Seller role**: is @[Seller role] still the one to ping for new orders?
>
> Alternatively, you could give me "Manage Webhooks" on those channels and I'll set them up myself. Thanks!

**6.3 🧑 Copy the seller role ID:** **Server Settings → Roles** → right-click the seller role → **Copy Role ID**.

**6.4 🧑 Add the new values to BOTH Vercel projects**
1. Open the buyer project → **Settings → Environment Variables** and add these. Then do the same in the seller project:

   | Key | Value |
   |---|---|
   | `DISCORD_WEBHOOK_REQUEST` | 🔒 webhook URL for new orders |
   | `DISCORD_WEBHOOK_PROGRESS` | 🔒 webhook URL for taken / partly delivered |
   | `DISCORD_WEBHOOK_FULFILLED` | 🔒 webhook URL for finished |
   | `DISCORD_ROLE_ID` | the role ID number |

   If you only have **one** webhook, add it once as `DISCORD_WEBHOOK_URL` instead.
2. **Redeploy both:** in each project, go to **Deployments**, click **⋯** on the top deployment, and choose **Redeploy**.

> Why both? The buyer site posts **new** orders; the seller site **moves** them as sellers work. Both need the webhooks.

**6.5 💬 Check:** *"Check /api/health on both of my Echo Market sites again."* Every line should be ✅.

**6B — Testing DMs before the admins reply (your own server)**

Discord only lets a bot DM people who share a server with it. Any server works, including your own.
1. Open the bot invite link from 3.5: `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=0`
2. Under **Add to server**, pick your server, then click **Continue → Authorize** and complete Discord's check.
3. The bot appears in the member list as **offline**. That's normal: it never "logs in", it only sends DMs.
4. Testers must be in that server too, with **Server menu → Privacy Settings → Direct Messages** on.

When the admins add the bot to the main server later, nothing else changes. A bot can be in several servers.

**6.6 🧑 Test the DM**
1. On the buyer site, click the 🔔 bell, then **Send me a test DM**.
2. If it says Discord wouldn't let the bot DM you:
   - Make sure you're in the server the bot joined.
   - In Discord, open the server name menu → **Privacy Settings** and turn on **Direct Messages**.

---

## Part 7 — Full test run (≈10 min)

1. 🧑 **Buyer site → Shop:**
   - Click **Add** on any aircraft, choose quantity 1 and **50%**, then **Add to order**.
   - Open 🛒, pick your airline, and click **Send order to sellers**.
   - ✅ **Orders** shows it as *Waiting for seller*.
   - ✅ The requests channel gets a post that pings the seller role.
2. 🧑 **Seller site:**
   - The order is in **Open queue**. Click **Take order**, pick your airline, and confirm.
   - ✅ You get a DM: *"Your order … was taken"*.
   - ✅ The Discord post moves to in-progress.
3. 🧑 **Seller site:** click **Update delivery**, then **All delivered**, then **Save**.
   - ✅ DM: *"… is complete"*.
   - ✅ The post moves to the done channel.
   - ✅ The buyer site shows **Delivered**.
4. 🧑 **Clean up.** On the seller site, open the order and click **Delete** (admins only).

✅ **Checkpoint:** everything worked. 🎉 **The market is live.**

---

## Part 8 — Go live

**8.1 🙋 Announce the new address** (ask an admin to pin it):

> 📢 **Echo Market has moved:** https://BUYER-SITE.vercel.app
> - Sign in with Discord. Your airlines are now saved to your account, on every device.
> - Create your airline (up to 20), pick aircraft, choose your price level (the % of the in-game list price you pay), and send.
> - You'll see which airline is selling to you, and get a DM when it's taken and delivered.
>
> The old site no longer accepts orders. Please re-create your airlines on the new one; it takes 10 seconds.

Send sellers the seller desk address separately: `https://SELLER-SITE.vercel.app`.

**8.2 Seller hierarchy: who gets the seller desk (automatic, from Discord roles).**

| Discord role | Seller desk rank | Can do | Tint on the seller desk |
|---|---|---|---|
| **Lead Ambassador** | `lead` | Everything, **as an admin**: decline for everyone, delete orders, manage any order, **Sellers** tab (performance) | bright pink |
| **Ambassador** | `ambassador` | Take and deliver orders | softer pink |
| **Verified Seller** | `verified` | Take and deliver orders | light pink-purple |
| **Market Admin** (role) | `admin` if they have no seller role | Everything an admin can do, plus market bans and messages (Part 11) | black and white, soft white aurora (with a seller role: that role's colour) |

Anyone with one of these roles in the Echo Alliances server gets the seller desk the first time they sign in there, with the rank of their **highest** role (people keep their lower roles when promoted; that's fine). Promotions and demotions on Discord are picked up within about 10 minutes (or when they reopen the desk). Remove all three roles and they lose access. Verified Sellers apply through the separate application form; once accepted, giving them the role on Discord is all that's needed.

**Vercel settings** (Settings → Environment Variables; get each ID with Server Settings → Roles → right-click the role → **Copy Role ID**, Developer Mode on):

| Key | Project | Value |
|---|---|---|
| `DISCORD_LEAD_ROLE_ID` | seller | the **Lead Ambassador** role ID |
| `DISCORD_AMBASSADOR_ROLE_ID` | seller | the **Ambassador** role ID (the old "Alliance Ambassador" role, renamed, so this is the ID that is in `DISCORD_ROLE_ID` today) |
| `DISCORD_VERIFIED_SELLER_ROLE_ID` | seller | the **Verified Seller** role ID |
| `DISCORD_ROLE_ID` | **both** | the role **pinged for new orders**: change it to the **Verified Seller** role ID (they complete the orders) |
| `DISCORD_GUILD_ID` | seller | the Echo Alliances server ID (right-click the server icon → **Copy Server ID**) |

Redeploy both projects afterwards. `/api/health` on the seller site lists each role under **Discord roles**.
- If none of the three role IDs is set, `DISCORD_ROLE_ID` counts as the Verified Seller role (the old setup).
- Got the role a minute ago? On the "not on the seller list" screen, click **Check again**.

By hand, for people without a role, or for admins: 💬 *"Add Discord ID 123… as a seller."* People added by hand keep their access and admin status whatever their Discord roles are. Their **rank** (title and colour) still follows the highest seller role on their Discord profile, if they have one; without any seller role it stays what you set (below).

**Making someone an admin by hand** (anyone besides the Lead Ambassador, who is an admin through the role). Admins can decline an order for everyone, delete orders, manage any seller's order, and see the **Sellers** tab. In Supabase → **SQL Editor**, replace the Discord ID, pick the rank they should show as (`'lead'`, `'ambassador'` or `'verified'`), and run:

```sql
insert into public.sellers (user_id, is_admin, active, source, rank, note)
select id, true, true, 'manual', 'ambassador', 'Made admin by hand'
from public.accounts where discord_id = '123456789012345678'
on conflict (user_id) do update set is_admin = true, active = true, source = 'manual', rank = excluded.rank;
```

- It works whether or not they are already a seller. They must have signed in on the market once (otherwise nothing happens: check with `supabase/queries/list-buyers.sql`).
- `source = 'manual'` means losing the Discord role no longer removes them: admin is your decision, not the role's. Their rank (and tint) stays what you set.
- To only change someone's rank (no admin): `update public.sellers set rank = 'ambassador', source = 'manual' where user_id = (select id from public.accounts where discord_id = '123456789012345678');` Leave `source` alone if they should keep following their Discord role.
- To take admin away again (they stay a normal seller): `update public.sellers set is_admin = false where user_id = (select id from public.accounts where discord_id = '123456789012345678');`
- They see the change after reloading the seller desk.

**Lists of everyone.** `supabase/queries/list-buyers.sql` (every account, with airlines and orders) and `supabase/queries/list-sellers.sql` (every seller, with admin/role status and activity). Paste either into the SQL Editor and run; they only read.

To block someone who still has the role: 💬 *"Block seller with Discord ID 123… (set active = false, source = manual)."* Their history is kept.

---

## Part 9 — Everyday changes and fixing problems

### Changing things (just ask)

| You want to… | 💬 Tell Claude |
|---|---|
| Change a price / add an aircraft | *"In buyer/aircraft_pricelist.json change the A320neo price to 112 million, then commit and push."* |
| Add or rename an alliance | *"Using the Supabase connector, add the alliance 'Nova' to the alliances table."* |
| Change the daily limit / max quantity | *"Change the 24-hour limit to 15 billion in buyer/lib/pricing.js, commit and push."* |
| Change something both sites share (buttons, Discord posts, DMs) | *"Edit shared/…, run npm run sync, commit and push."* |
| See who the sellers are | *"List all sellers with their Discord names."* |
| See today's orders | *"Show me orders from the last 24 hours."* |

Every push to GitHub redeploys both sites, usually within a minute.

> **Shared code rule:** files in `shared/` are copied into `buyer/` and `seller/`. Always edit the `shared/` version, then run ▶ `npm run sync` at the repo root. `npm run check` tells you if a copy is out of date.

### When something breaks

| Symptom | Likely cause and fix |
|---|---|
| A site says **"Echo Market isn't connected yet"** | That project is missing its Supabase keys, or wasn't redeployed after adding them. Open its `/api/health`. |
| Discord login shows **"Invalid OAuth2 redirect_uri"** | The redirect in Discord (3.2) doesn't exactly match `https://PROJECT-REF.supabase.co/auth/v1/callback`. |
| After login you land on the **wrong site or an error page** | Supabase **Site URL / Redirect URLs** (4.5). Both sites must be listed. |
| The "Seller desk" link or "Create airline" button goes nowhere | `BUYER_URL` / `SELLER_URL` are missing in that project. Check `/api/health`. |
| Login works but **"Market account not found"** | `schema.sql` didn't run fully. Run it again; that's safe. |
| Seller site says **not on the seller list** | Give them the seller role on Discord, then **Check again** (8.2). Or add the Discord ID by hand (5.4). |
| **No Discord channel posts** | `/api/health → Discord channels` on *both* sites. Both need the webhooks. |
| **No DMs** | `/api/health → Discord DMs` on both sites. The bot must be in the server, and the player must allow DMs from server members. |
| A site was idle for a week and now **fails to load data** | Supabase Free pauses inactive projects. Go to Dashboard → project → **Restore**. No data is lost. |
| Anything else | 💬 *"Something's wrong on my Echo Market [buyer/seller] site: [describe]. Check /api/health and the latest Vercel deployment logs."* |

### Optional: speed

Vercel runs the `/api` code in Washington DC by default. If your Supabase region is elsewhere:
> 💬 *"Set the Vercel function region in buyer/vercel.json and seller/vercel.json to match my Supabase region, commit and push."*

### When an update says "re-run the schema"

Some updates add tables or columns. `supabase/schema.sql` is written so it is **safe to run again**: it only adds what is missing and never deletes data.
1. Open [schema.sql on GitHub](https://github.com/tommy2006/echomarket/blob/main/supabase/schema.sql) and click **Copy raw file**.
2. In Supabase, go to **SQL Editor → New query**, paste it and click **Run**.
3. ▶ Check it: `node scripts/check-supabase.mjs <project-url> <publishable-key>`, or 💬 *"check my Supabase"*.

---

## Part 10 — Phone & browser alerts (optional, ≈10 min)

Buyers can turn on an alert that pops up on their phone or computer when an order is **fully delivered**, even with Echo Market closed. It works on Android, Windows, Mac and Linux browsers. On **iPhone/iPad**, the buyer must first add the site to the Home Screen and open it from there; Apple only allows alerts for installed web apps.

The sites need a key pair ("VAPID keys") to sign these alerts.

**10.1 ▶ Make the keys on your computer.** In a terminal (Claude app → Terminal panel, or Windows Terminal), run:

```bash
npx web-push generate-vapid-keys
```

It prints a **Public Key** and a 🔒 **Private Key**. Keep the window open. Don't paste the private key into the chat.

**10.2 🧑 Add them to BOTH Vercel projects** (**Settings → Environment Variables**):

| Key | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the Public Key |
| `VAPID_PRIVATE_KEY` | 🔒 the Private Key |
| `VAPID_SUBJECT` | `mailto:` followed by your email, e.g. `mailto:you@example.com` (alert services contact this address if something goes wrong) |

Then **redeploy both** projects. Both need the keys: the seller site sends the "delivered" alert, and the buyer site sends test alerts.

**10.3 🧑 Turn it on as a buyer.**
1. On the buyer site, click 🔔 → **Phone & browser alerts** → switch it on.
2. Allow notifications when the browser asks.
3. Click **Send me a test alert**.

Each device has to be switched on separately. A phone and a laptop are two devices.

**10.4 💬 Check:** *"Check both health pages."* The **Phone alerts** line should be ✅.

---

## Part 11 — Market Admins, members only, bans and messages (≈15 min)

What this switches on:
- **Members only:** only Discord accounts that are in the Echo Alliances server can use the buyer market. Others see "Echo Market is for Echo Alliances members".
- **Market Admin role:** gives admin rights on the seller desk (Sellers and **Moderation** tabs, decline for everyone, delete). With no seller role they get the black-and-white Admin look; with a seller role, that role's colour.
- **Market bans** (1 week, 1 month or permanent) and **messages/warnings** to buyers, from the seller desk: click a buyer's airline name, or use the **Moderation** tab (also works with a Discord user ID for people who never used the market). Each is DMed to the person and posted in the log channel; a ban also gives the **Market Banned** role, which is taken away again when the ban ends.
- **Market Banned role:** anyone who has it (also when given by hand on Discord) can't use the buyer market.
- **Order messages:** a buyer can write to the seller team once an order has waited 5 days without being fully delivered. Sellers see it live on the seller desk (badge + notification); the seller handling the order also gets a DM. Any seller can answer; the buyer gets a notification and a DM.

**11.1 🧑 Re-run `supabase/schema.sql`** in the SQL Editor (safe to run again).

**11.2 🧑 Discord → Server Settings → Roles** (Developer Mode on):
1. Copy the role IDs of **Market Admin** and **Market Banned** (right-click → Copy Role ID).
2. Give the bot's role (**Echo Market**) the **Manage Roles** permission, and drag it **above Market Banned** in the role list. Without this the bot can't give or take the Market Banned role.
3. In the logging channel: Edit Channel → Permissions → add the bot with **View Channel**, **Send Messages** and **Embed Links**. Right-click the channel → **Copy Channel ID**.

**11.3 🧑 Vercel → Settings → Environment Variables**, then redeploy both projects:

| Key | Project | Value |
|---|---|---|
| `DISCORD_GUILD_ID` | **both** (buyer is new) | Echo Alliances server ID: only its members can use the market |
| `DISCORD_MARKET_BANNED_ROLE_ID` | **both** | Market Banned role ID |
| `DISCORD_MARKET_ADMIN_ROLE_ID` | seller | Market Admin role ID |
| `DISCORD_LOG_CHANNEL_ID` | seller | logging channel ID |
| `CRON_SECRET` | seller | any random text, 16+ characters (lets Vercel run the daily clean-up of ended bans) |

**11.4 💬 Check:** *"Check both health pages."* New lines: **DISCORD_GUILD_ID (Echo server: members only)**, **Market Admin**, **Market Banned**, **bot can give the Market Banned role**, **moderation log**, **CRON_SECRET**.

> Admins added by hand (SQL, 8.2) keep admin rights without the Market Admin role, but only Market Admins get the black-and-white Admin look.
