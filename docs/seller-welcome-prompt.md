# Build the Echo Market sellers' welcome: "A new era begins" (Kibori-style hangar showroom)

You are working in the existing seller desk (`seller/`). Build a full-screen, scroll-driven, immersive welcome that
every seller completes once before taking orders. It borrows the **structure and feel** of ThreeUI's free *Kibori*
landing page: a loader with a glowing ring, a top navigation, a run of eight interactive 3D objects you can drag to
turn and open for details, glowing transitions between sections, an index of the objects, a closing call to action and
a detailed footer. It is re-themed as a **night hangar showroom** for Echo Alliances' sellers. Its main purpose: sellers
check **who bought each listing in-game before claiming the sale money**, so wrong buyers and thieves are caught.

## 0. Licence and source
- Only ThreeUI's free tier is used: **do not copy** `kibori.html`, its scripts, shaders or images. Write original code
  that recreates the layout and interaction patterns above. No Japanese text or woodworking art.
- Three.js 0.160.1 (MIT) is already self-hosted in `buyer/vendor/three-0.160.1/`. The seller site needs its own copy
  (each Vercel app only serves its own folder): copy the same file, no new download.

## 1. How it fits the seller desk
- Stack as on the buyer welcome: `seller/welcome.html` + `seller/js/welcome.js` + `seller/css/welcome.css`, no inline
  scripts (CSP `script-src 'self'`), same Supabase session, the Echo loader (`css/echo-loader.css`).
- **Who:** every seller, admins included, once. Current sellers see it on their next visit, new sellers right after
  they are enrolled. Remembered on the seller (`sellers.welcome_done_at timestamptz`, idempotent in `schema.sql`).
- **Gate:** while `welcome_done_at` is empty, the desk sends the seller to `/welcome.html`, and the API refuses
  taking (`claim`) and taking over (`join`) an order with a clear message and a link. Everything else (reading,
  messages, theft reports) keeps working.
- `POST /api/enroll`-style endpoint (or the existing seller API) `{ action: 'welcome-done', pledge: true }` sets it.
- **Replay:** account menu → "Seller welcome", no gate on a replay.
- The existing short desk tour (`SELLER_TOUR`) still runs afterwards, as now.
- Same scene on every device; `prefers-reduced-motion` turns off camera motion, the exhaust shimmer and the bursts.

## 2. Look
- **Modern / futuristic fonts only** (owner's choice): Orbitron (display: "A NEW ERA BEGINS", numbers, labels,
  buttons) and Exo 2 (headings and body). **English only**: no second script.
- A dark hangar at night: polished concrete floor with reflections, steel roof trusses, big hangar doors open to a
  starry apron, display stands with spotlights, small price tags and order tickets.
- **One division colour per page**, in this order (9 pages: the opening + eight objects):
  `#7d34ff`, `#ff456a`, `#e76fff`, `#81fbfe`, `#ff7b3e`, `#5eff94`, `#7f9ff2`, `#eba09d`, `#fdecd8`, `#fae246`.
  The colour drives spotlights, the object's rim light, labels, buttons and progress. Dark button text on light colours.
- **Transitions:** Kibori's fire becomes **jet-exhaust glow**: a hot engine-glow and heat-shimmer wipe that carries the
  next page's division colour across the screen (the same right-to-left direction as the Echo loader).
- Loader: the Echo winglet with the division colours swiping through it, "Opening the hangar" and a percentage.

## 3. "A NEW ERA BEGINS"
At the **start** and the **end**, a strong bursting moment: the words **A NEW ERA BEGINS** burst onto the screen (scale
and light burst, division-coloured sparks / exhaust flare, hangar doors opening at the start, every spotlight
lighting up at the end), welcoming sellers to the alliance's new era of taking orders on the web.

## 4. The eight objects (a mix of aircraft and marketplace props)
Each is a 3D object on its own spotlit stand. Drag to turn. "Open" shows the detail panel (Kibori's close-up view,
"Close · Esc"). Each has a short plain-English heading, 2–4 short lines on its stand card and the full detail inside.
An index (Kibori's workshop index) lists all eight with numbers.

1. **Order ticket** (prop): *Taking an order.* Choose the airline you sell as (Selling as); prefer a buyer in the same
   alliance. The amber **list value** is your estimated cost of buying those aircraft new.
2. **A320neo** (aircraft): *Buy new, list in public.* Buy the aircraft new in-game, then list them on the **public**
   in-game market under **your airline**, at the buyer's price level, with the exact model and quantity.
3. **Departures board** (prop): *Update progress straight away.* After listing, record what **you** listed per
   aircraft type. The buyer is told immediately (DM + order page) which airline listed what.
4. **Magnifying glass over a sold listing** (prop), **the key object, given the most weight**:
   *Check who bought, before you claim the money.* Each sold listing in-game shows the **buyer's airline**. Before
   claiming the sale money, check it matches an airline on the order (the order lists the buyer's airline(s)).
   Wrong buyer? Note their airline (and Discord name if you know it) and keep it: **don't act yet**, wait for the
   buyer's missing-plane report (you sell to many orders and run FFA events, so the report is what confirms it).
   When the report comes in, you already know the culprit.
5. **Two aircraft nose to nose, e.g. 737 MAX + E-Jet** (aircraft): *Take-over and passing on.* An order taken but not
   finished after 12 hours can be taken over; the buyer sees how many each airline listed. Pass on the rest or
   release an order you can't finish; decline with a reason.
6. **Shield** (prop): *Theft reports.* A buyer's report DMs you. Check in-game, then **Theft confirmed** with every
   culprit's Discord ID (each is warned automatically), or **Under investigation**. Anyone can later warn culprits
   from **Theft reports** on the front page. **Clear theft** once they re-listed the planes for the buyer.
7. **Warning beacon** (prop): *Caution and the alert list.* A caution badge marks buyers on the alert list; each
   order shows the buyer's disciplinary record line; flag suspicious or blacklisted orders.
8. **A350 under the brightest spotlight** (aircraft): *Your desk.* Open queue, My orders, All orders, filters and
   sorting, "only orders I delivered on", unread buyer messages: then the finale.

## 5. Finale (Kibori's "Commission")
"A NEW ERA BEGINS" bursts again. Then a pledge (no quiz):
> ☐ I check who bought every listing before I claim the money, and I keep a note of any wrong buyer for the theft report.

A second pledge, ticked separately:
> ☐ I'm ready to serve Echo to the fullest of my ability in the alliance's new era: fair, fast and honest with every buyer.

Button **Open the seller desk** (disabled until both are ticked) records `welcome_done_at` and sends the seller to the desk.
On a replay: "Back to the desk", no pledge needed. Footer as Kibori's: Echo Market · Echo Alliances, where to ask
(#market-chat / admins), "Replay any time from the menu".

## 6. Done means
- Every seller is sent there once; finishing records it on the seller and unlocks taking orders; replay works.
- `claim` / `join` are refused (with a link) until it's done; nothing else is blocked.
- No inline scripts; CSP unchanged. Verified at desktop and phone widths: loader, bursts, eight objects (drag, open,
  close), the colour per page, exhaust transitions, pledge gate, reduced motion.
