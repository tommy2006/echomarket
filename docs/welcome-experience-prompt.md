# Build the Echo Market "Cleared for takeoff" welcome (Kage-style immersive tour)

You are working in the existing Echo Market buyer site (`buyer/`). Build a full-screen, scroll-driven, immersive
welcome that every signed-in buyer must complete once. It borrows the **structure and feel** of ThreeUI's free
*Kage* landing page (loader, top chapter navigation, full-height scroll chapters, a sub-panel sequence with
counters, a numbered list chapter, a closing call to action, a live Three.js world behind everything), re-themed
as a **night airport** for Echo Alliances. Its main purpose is to stop plane theft on the in-game market.

## 0. Licence and source
- ThreeUI's pricing page states that source code and commercial use come with **ThreeUI Pro**. We only use the
  free tier, so **do not copy** `kage.html`, its scripts, shaders or image assets. Write original code that
  recreates the layout and interaction patterns listed above.
- The temple illustrations are not used at all: every visual is drawn with Three.js and CSS (see §3).
- `three.min.js` (MIT licence) must be **self-hosted** in `buyer/vendor/` (the site's CSP only allows scripts from
  its own origin). Ask the owner before downloading it, stating the exact version, source and file size.
- If the owner later buys ThreeUI Pro, the original source may replace the custom implementation.

## 1. How it fits the existing app
- Stack: React 18 UMD + htm, Tailwind Play CDN self-hosted, no bundler. Content-Security-Policy:
  `script-src 'self'`, so no inline scripts and no script CDNs (Google Fonts stylesheets are allowed).
- Build it as its own page, `buyer/welcome.html` + `buyer/js/welcome.js` + `buyer/css/welcome.css` (no inline
  `<script>`). The page uses the same Supabase session as the market.
- **Who sees it:** every signed-in buyer, once, remembered on the **account** (not per device). Existing buyers
  see it on their next visit; new buyers right after their first sign-in.
  - Add `accounts.welcome_done_at timestamptz` in `supabase/schema.sql` (idempotent `add column if not exists`).
  - `/api/me` returns `welcomeDone`. Add `POST /api/me { action: 'welcome-done' }`, which sets it (and also sets
    `rules_seen_at`, because the welcome covers the rules).
  - If a signed-in buyer hasn't finished it, the market sends them to `/welcome.html`. They can't order until
    they finish (the server also refuses orders and bot `/order` with a clear message until it's done).
  - "Welcome & rules" in the account menu replays it at any time, with no quiz needed on a replay.
  - It **replaces** the first-sign-in rules pop-up. The existing short UI tour (ordering basics) still runs
    afterwards, as now. The 📜 rules button stays.
- **Performance:** the same full scene on every device (owner's choice). `prefers-reduced-motion` should still
  disable camera motion and blinking.

## 2. Typography and colour
- Keep Kage's typographic settings: font **Onest** (Google Fonts), headings weight 400 at 46px with letter
  spacing -0.012em, body weight 300 at 17px. Scale down sensibly on phones.
- Base: a night sky (near-black `#05060c` with a faint starfield).
- **One division colour per chapter**, in this order (accent for runway and edge lights, glows, the call-out
  label, links, buttons, progress): `#7d34ff`, `#ff456a`, `#e76fff`, `#81fbfe`, `#ff7b3e`, `#5eff94`, `#7f9ff2`,
  `#eba09d`, `#fdecd8`, `#fae246`. Colours move smoothly between chapters as you scroll. Text stays white or near-white for
  contrast. On light accents (`#81fbfe`, `#fdecd8`, `#fae246`), button text is dark.

## 3. The 3D world (Three.js, no image files)
A night airport that the camera taxis through as you scroll, one stop per chapter:
- a runway with edge lights and approach lights in the chapter colour, with sequenced strobes
- a taxiway with centre-line lights
- a low-poly jet silhouette that taxis ahead of the camera and lines up for take-off at the end
- a control tower with a rotating beacon
- low clouds or fog drifting across
- parked aircraft silhouettes at a gate
- a starfield

The last chapter ends with the jet taking off. Loader: "Lighting the runway" with a percentage.
Top navigation, with the brand "ECHO MARKET · Cleared for takeoff", links to each chapter, and a thin progress
bar in the current colour.

## 4. Chapters: call-out label + plain-English heading + content
Each chapter has an aviation call-out label (small, uppercase, in the chapter colour) and a clear plain-English
heading. Copy below is final unless marked as a suggestion; keep it short and readable.

**00 · `GATE 00 · BOARDING` – Welcome to Echo Market** (colour 1)
The aircraft market of Echo Alliances: sellers in the alliance sell you new aircraft below the in-game list
price. Before your first order, a 3-minute walk through how delivery works and the one thing that keeps the
market alive: **only buy the planes meant for you**. CTA: "Start taxiing" (scroll).

**01 · `TWR · CLEARANCE` – The market rules** (colour 2), the four rules word for word:
1. No arguments over the price or amount of aircraft(s).
2. Do not re-sell the planes that you have bought through the market to outside. (You can sell them back in our alliance if you do not need the planes anymore, but you must sell them back at the percentage which you purchased it at)
3. Do not buy any planes from the market if you did not order them.
4. Refrain from having a full-on conversation within the tickets.

Highlight rule 3 as the reason for this walkthrough.

**02 · `TWY A · HOW DELIVERY WORKS` – Your planes are listed in public** (colour 3). Three sub-panels with
counters (01/03 to 03/03), as in Kage's garden panels:
1. *Taken*: a seller takes your order and buys your aircraft new in-game.
2. *Listed*: they list them on the **public** in-game market under their **airline** (not their Discord
   username), at your price level. You get a DM / order update saying what was listed and by which airline.
3. *Bought*: you search for that **airline**, then buy exactly your model and quantity, straight away.
   Because the market is public, anyone browsing can see these listings. That's why everyone must only buy
   their own.

**03 · `HOLD SHORT · WHAT COUNTS AS STEALING` – Four ways to take someone's planes** (colour 4). A numbered
list, as in Kage's chapter list, each with a mini example:
1. **A cheap listing that isn't yours.** A discounted A350 from an airline that isn't your seller, and not in #ffa-listings, belongs to another buyer, however tempting.
2. **More than you ordered.** Your order is 4× A320neo, and your seller lists 6. The extra 2 are someone else's.
3. **The wrong model.** Sellers often list several models for several buyers at once. Buy only the models in *your* order.
4. **Buying for someone else.** Grabbing listings "for a friend" or for another account of yours still takes someone's order.

**04 · `FFA · OPEN STAND` – Free-for-all listings** (colour 5):
Read existing FFA sales carefully. Only that channel, **#ffa-listings**: all planes listed there are free for all.
If an airplane is not under FFA, it is ordered by someone other than you. If unsure whether an airplane is FFA,
feel free to ask on **#market-chat**.

**05 · `PRE-FLIGHT CHECK · BEFORE YOU BUY` – Your 5-point checklist** (colour 6). An interactive checklist; each
item ticks as you scroll past:
1. Wait for your seller's "listed" update (DM or your order page) before searching.
2. Search the seller's **airline** name shown on your order, not their username.
3. Match the **model** to your order.
4. Match the **quantity**. With more than one seller, your order shows **how many each airline listed**: buy that
   many from each.
5. Buy right away (anyone can see public listings). Anything doesn't match? Don't buy: ask on #market-chat.

**06 · `MAYDAY · IF SOMETHING GOES WRONG` – Mistakes, missing planes, consequences** (colour 7):
- *Bought planes that weren't yours by mistake?* Tell **#market-chat** or an admin right away, and follow the
  seller team's instruction (for example: re-list the same planes at the same price for the real buyer). Owning
  up quickly counts in your favour.
- *Your planes were gone before you could buy them?* Press **Report missing planes** on your order and say how
  many and which type. The sellers check in-game who bought them.
- *Order not fully delivered after 24 hours?* Use **Contact the seller team** on the order.
- **Consequences:** a confirmed theft gives a warning, and repeat cases lead to market bans, fully at the
  admins' discretion. Every incident is recorded on your disciplinary record. You must follow the seller team's
  follow-up instruction (it could be a re-list).

**07 · `RWY 09 · CLEARED FOR TAKEOFF` – Quick check, then you're in** (colour 8). The quiz, then the final
confirmation:
- **3 multiple-choice questions, all-or-nothing.** Any wrong answer scrolls the buyer back to the chapter that
  explains it (shown with a short note). They reread it, then retry the whole quiz.
  1. "Your order: 4× A320neo from Dave Air. Dave Air lists 6 A320neo at your price. How many do you buy?"
     Options 2 / **4** / 6. Wrong → chapter 03.
  2. "A cheap A350 is listed by an airline that isn't your seller and isn't in #ffa-listings. What is the first
     thing you should do?" Options: buy it quickly before someone else does / **ask on #market-chat** / buy it
     and re-list it later. Wrong → chapter 04.
  3. "You bought planes that weren't yours by mistake. What now?" Options: keep them, it was an accident / sell
     them to someone outside the alliance / **tell #market-chat or an admin and follow the seller team's
     instruction (e.g. re-list at the same price)**. Wrong → chapter 06.
- After all three are correct: a checkbox, "I understand: I only buy the planes in my own order, or listings in
  #ffa-listings", then the button **"Enter the market"** (disabled until both are done). The jet takes off and
  the buyer lands on the market home page (where the short UI tour starts for new buyers).

Footer: "Echo Market · Echo Alliances", plus links to #market-chat guidance and "Replay any time from the menu".

## 5. Done means
- Old and new signed-in buyers are sent to the welcome once. Finishing it records `welcome_done_at` and lets them
  order. A replay from the menu works and has no quiz gate.
- Orders (website and bot) are refused with a helpful message until the welcome is done.
- No inline scripts. CSP is unchanged apart from anything strictly necessary (document it).
  `buyer/vercel.json` serves the new files.
- Verify in the browser at desktop and phone widths:
  - loader, chapter navigation and colour transitions all work
  - the 3D world renders, taxis and takes off
  - each wrong quiz answer jumps to the right chapter
  - the checkbox and button gate works
  - the completion is saved on the account (works across devices)
  - reduced-motion mode works
  - nothing in the page leaks other buyers' data
