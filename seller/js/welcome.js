// Sellers' welcome (welcome.html): "A new era begins". Every seller walks through it once before taking orders.
// A night hangar showroom drawn with Three.js (no image files): eight exhibits on spotlit stands that you can drag
// to turn and open for a close-up, one alliance division colour per page, jet-exhaust transitions.
// The layout borrows the feel of ThreeUI's free Kibori page; all code here is our own.
// Finishing it: POST /api/welcome { pledges: { check, serve } } (records sellers.welcome_done_at).
// Training videos (seller/media/training, at most 2 minutes each, subtitles in the picture) play on some exhibit cards, in players that tilt
// with the turning exhibit. They can't be sped up or skipped ahead, and new sellers watch the five seller videos to the
// end before the pledges. Admins also get the admin wing: four more exhibits, three admin videos and a third pledge,
// once (sellers.admin_training_at). Watching is recorded by the API (seller/lib/training.js), not trusted from here.
import { pickQuality, lowerThan, rememberQuality, pixelRatioFor, frameWatch, mixHex, inkFor, qualitySwitch } from './welcome-perf.js';
import { t, tx, setLang, savedLang, languageMenu, translatePage, onLangChange } from './i18n.js';
// three.js is loaded only when the device shows the 3D hangar (not at the 'lite' graphics level).
let THREE = null;
// Graphics level (js/welcome-perf.js): 'high', 'low' or 'lite'; lowered automatically if frames drop.
let quality = pickQuality();
document.documentElement.dataset.quality = quality;

// ------------------------------------------------------------------ setup
const CONFIG = window.ECHO_CONFIG || {};
const sb = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY
    ? supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
    })
    : null;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The ten division colours (Kyra, Aegis, Elysium, Lior, Rhea, Vilis, Elion, Aura, Eos, Uzuri): the opening, then one
// per exhibit (the nine views use the first nine; the sparks use all ten).
const COLOURS = ['#7d34ff', '#ff456a', '#e76fff', '#81fbfe', '#ff7b3e', '#5eff94', '#7f9ff2', '#eba09d', '#fdecd8', '#fae246'];

async function api(path, payload) {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload || {})
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok || !json?.ok) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);
    return json;
}

// ------------------------------------------------------------------ who is this?
// Decided before the pages are built: admins get the admin wing.
const ME = await (async () => {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    if (!data?.session) { window.location.replace('/'); return null; }   // sign in on the seller desk first
    const { data: row } = await sb.from('sellers').select('*').eq('user_id', data.session.user.id).maybeSingle();
    if (!row || row.active === false) { window.location.replace('/'); return null; }
    return row;
})().catch(() => null);
const ADMIN = Boolean(ME && (ME.is_admin || ME.rank === 'lead' || ME.market_admin));
const NEED_SELLER = Boolean(ME && 'welcome_done_at' in ME && !ME.welcome_done_at);
const NEED_ADMIN = Boolean(ADMIN && 'admin_training_at' in ME && !ME.admin_training_at);
// Replay (nothing due, or an older database without the column): the pledges and videos are optional.
const REPLAY = Boolean(ME && (!('welcome_done_at' in ME) || (!NEED_SELLER && !NEED_ADMIN)));

// ------------------------------------------------------------------ training videos
// [id, exhibit index, length in seconds, admin]; the files are media/training/<id>.mp4 / .jpg / .vtt.
const VIDEOS = [
    ['s1-getting-started', 0, 83.4], ['s3-taking-and-delivering', 2, 70.3], ['s4-teamwork-and-flags', 4, 68.3],
    ['s5-missing-planes', 5, 80.3], ['s2-finding-orders', 7, 67.4],
    ['a1-admin-orders-and-sellers', 8, 62.6, true], ['a2-moderation', 9, 49.3, true], ['a3-community', 10, 41.0, true]
].filter((v) => ADMIN || !v[3]).map(([id, exhibit, seconds, admin]) => ({ id, exhibit, seconds, admin: Boolean(admin) }));
const videoTitle = (id) => ({
    's1-getting-started': t('Getting started'), 's2-finding-orders': t('Finding orders'), 's3-taking-and-delivering': t('Taking & delivering'),
    's4-teamwork-and-flags': t('Teamwork & flags'), 's5-missing-planes': t('Missing planes & thefts'),
    'a1-admin-orders-and-sellers': t('Admin: orders & the Sellers tab'), 'a2-moderation': t('Admin: moderation'), 'a3-community': t('Admin: community')
}[id] || id);
const DONE = new Set(Object.entries(ME?.training?.videos || {}).filter(([, v]) => v?.done).map(([k]) => k));
// Videos that must be watched before the pledges: none on a replay or an older database.
const REQUIRED = ME && 'training' in ME && !REPLAY ? VIDEOS.filter((v) => NEED_ADMIN || !v.admin).map((v) => v.id) : [];
const missingVideos = () => REQUIRED.filter((id) => !DONE.has(id));

// ------------------------------------------------------------------ the exhibits (cards + close-ups)
// A function, so the texts follow the language (re-read when it changes).
const exhibits = () => [
    {
        kind: t('Prop · Order ticket'), title: t('Taking an order'), short: t('Selling as, alliance, list value'),
        lines: [
            t('Pick the airline you sell as (<b>Selling as</b>, top right). Buyers see it on their order.'),
            t('Prefer orders from your own alliance: your matching airline is offered first.'),
            t('The amber <b>list value</b> is your estimated cost of buying those aircraft new.')
        ],
        detail: [
            [t('Where'), t('The <b>Open queue</b> lists orders waiting for a seller, the longest-waiting first. Press <b>Take order</b> and choose the airline you deliver from.')],
            [t('Your airline'), t('You need an airline profile on the market site (same Discord login). The buyer sees it on their order and searches for it in-game.')],
            [t('The cost'), t('List value = the in-game price of each aircraft new × the quantity: roughly what you pay before reselling at the buyer\'s level.')],
            [t("Can't do it?"), t('Pass on it with a reason. It stays open for the other sellers; the buyer is only told once every seller has passed.')]
        ]
    },
    {
        kind: t('Aircraft · A320neo'), title: t('Buy new, list in public'), short: t('Exact model, exact quantity, your airline'),
        lines: [
            t('Buy the aircraft <b>new</b> in-game.'),
            t('List them on the <b>public</b> in-game market under <b>your airline</b>, at the buyer\'s price level.'),
            t('Exact model, exact quantity: nothing more, nothing less.')
        ],
        detail: [
            [t('Why it matters'), t('The in-game market is public: anyone browsing can see your listings. That is why buyers buy straight away, and why you check who bought (exhibit 04).')],
            [t('Price level'), t('Each order line shows its level, e.g. 70% of the list price. List every aircraft at that level.')],
            [t('Several types'), t('List each aircraft type for its own count, so the buyer can match it to their order.')],
            [t('Spare planes'), t('Never mix spares into someone\'s order. Free-for-all sales are announced in #ffa-listings.')]
        ]
    },
    {
        kind: t('Prop · Departures board'), title: t('Update progress straight away'), short: t('Per type, the moment you list'),
        lines: [
            t('As soon as you list, record what you listed, per aircraft type.'),
            t('The buyer gets a DM and sees which airline listed what.'),
            t('The order completes when everything is listed.')
        ],
        detail: [
            [t('How'), t('My orders → <b>Update progress</b> → the number you listed for each type. Add a note the buyer can see if it helps (e.g. where it is listed).')],
            [t('Why fast'), t('Buyers search after your update. The sooner they buy, the less time anyone else has to take the planes.')],
            [t('Several sellers'), t('Each seller records only what they listed themselves; the buyer sees the split per airline.')]
        ]
    },
    {
        key: true,
        kind: t('Prop · Sold listing + magnifier'), title: t('Check who bought, before you claim the money'), short: t('The key habit'),
        lines: [
            t('Every sold listing in-game shows the <b>buyer\'s airline</b>.'),
            t('Before claiming the money, check it is an airline on the order.'),
            t('Wrong buyer? Note their airline and keep it. <b>Don\'t act yet.</b>'),
            t('When the buyer reports missing planes, you already know the culprit.')
        ],
        detail: [
            [t('Every sale'), t('Open your sold listings. Compare each buyer\'s airline with the order\'s airline(s), shown on the order on the desk. Only then claim the sale money.')],
            [t('Wrong buyer'), t('Write down their airline (and Discord name if you know it) and which order it was. Don\'t chase them yet: you serve many orders and run FFA events, so the buyer\'s missing-plane report is what confirms a theft.')],
            [t('When the report comes'), t('You get a DM. Open the order and confirm the theft with the culprit\'s Discord ID (exhibit 06): they are warned automatically.')],
            [t('Why it matters'), t('This one check is how thieves get caught. Without it, a theft can\'t be traced back to anyone.')]
        ]
    },
    {
        kind: t('Aircraft · 737 MAX + E-Jet'), title: t('Take-over and passing on'), short: t('12 hours, shares, releasing'),
        lines: [
            t('Taken but not finished after <b>12 hours</b>? Another seller can take it over.'),
            t('The buyer sees how many each airline listed, and buys that many from each.'),
            t('Can\'t finish? Pass on the rest, or release it to the queue.')
        ],
        detail: [
            [t('Taking over'), t('<b>Take over</b> appears on orders taken more than 12 hours ago and not complete. Up to three sellers can join; the original seller stays on it.')],
            [t('Your share'), t('Update progress records what you listed. The buyer is shown each airline\'s share so they buy the right amount from each.')],
            [t('Passing on'), t('Release an order you can\'t finish: what you listed stays counted, the rest goes back to the queue (or to the seller who joined).')],
            [t('Declining'), t('Pass on an open order with a reason. Admins can decline it for everyone.')]
        ]
    },
    {
        kind: t('Prop · Shield'), title: t('Theft reports'), short: t('Confirm, warn every culprit, clear'),
        lines: [
            t('A buyer reports missing planes: the sellers on the order and the admins get a DM.'),
            t('Check in-game, then confirm the theft with every culprit\'s Discord ID, or <b>Under investigation</b>.'),
            t('Any seller can warn culprits later from <b>Theft reports</b> on the front page.')
        ],
        detail: [
            [t('Confirm'), t('<b>Theft confirmed</b> → I know who: add one or more Discord IDs (right-click the user → Copy User ID). Each gets an automatic warning: DM, moderation log, disciplinary record. The buyer never learns who.')],
            [t('Not sure yet'), t('Choose <b>Under investigation</b>. Found them later? <b>Identify & warn culprits</b>. Never found? Close the investigation.')],
            [t('Not a theft'), t('Tell the buyer what you found, e.g. the planes are still listed.')],
            [t('Clear theft'), t('Once the culprits re-listed the planes for the buyer (checked in-game), clear it: the buyer is told to buy them.')]
        ]
    },
    {
        kind: t('Prop · Warning beacon'), title: t('Caution and the alert list'), short: t('Badges, records, flags'),
        lines: [
            t('A <b>caution</b> badge marks orders from buyers on the alert list: deliver with extra care.'),
            t('Every order shows the buyer\'s disciplinary record in one line.'),
            t('Flag suspicious or blacklisted orders for the other sellers.')
        ],
        detail: [
            [t('Alert list'), t('Admins add buyers to it. Their orders carry a caution badge and banner; admins also see why.')],
            [t('Record'), t('"Buyer has N warnings on record", with <b>Show details</b> for the warnings and bans.')],
            [t('Flags'), t('Seller-only: buyers never see them. Use them to warn the team about an order.')]
        ]
    },
    {
        kind: t('Aircraft · A350'), title: t('Your desk'), short: t('Queues, filters, messages'),
        lines: [
            t('Open queue, My orders, All orders, and Theft reports on the front page.'),
            t('Sort and filter by price, alliance, types, aircraft count, list value, or orders you delivered on.'),
            t('Tap <b>💬 new buyer messages</b> in the greeting to see those orders.')
        ],
        detail: [
            [t('Messages'), t('Buyers can write once an order has waited 24 hours. Answer from the order; keep it short (no full conversations in tickets).')],
            [t('Paging'), t('Every list shows the latest 5 first, then 10 / 25 / 50 / All.')],
            [t('Next'), t('A short tour of the desk follows this welcome. You can replay both from the account menu.')]
        ]
    },
    // ---- the admin wing (admins only)
    {
        admin: true,
        title: t('Admin powers on orders'), short: t('Decline for all, delete, the Sellers tab'),
        lines: [
            t('<b>Decline for all</b> closes an order for the whole team at once (spam, rule breaks). The buyer sees your reason.'),
            t('<b>Delete</b> removes an order forever: only for spam or test orders.'),
            t('The <b>Sellers</b> tab ranks every seller: open one to see their orders, mark them Unranked, or grant vacation days.')
        ],
        detail: [
            [t('Decline for all'), t('Use it when an order breaks the rules or is spam. Write a reason the buyer can understand: they see it.')],
            [t('Delete'), t('Removes the order and its history for everyone. Prefer Decline for all; delete only spam or test orders.')],
            [t('Sellers tab'), t('Rankings over 7, 30 or 90 days or all time. Mark resigned sellers and tech-only admins <b>Unranked</b>, so they leave the leaderboard and the activity alerts.')],
            [t('Vacation days'), t('Only the Lead Alliance Ambassador or an Alliance Leader can grant them, with the 🌴 button.')],
            [t("Sellers' Cup"), t('Start, refresh, disqualify or cancel a knockout Cup from the Sellers tab.')]
        ]
    },
    {
        admin: true,
        title: t('Moderation'), short: t('Look up, ban, warn, log'),
        lines: [
            t('Paste any Discord user ID in <b>Moderation</b> to see their record, even if they never used the market.'),
            t('<b>Market ban</b> blocks every airline of that Discord account; <b>Send message</b> sends information or a warning.'),
            t('Bans and warnings go out as DMs and are logged in the moderation log channel.')
        ],
        detail: [
            [t('Be fair'), t('Warn before you ban, unless it is a clear theft or abuse. Always write a clear reason: the member sees it.')],
            [t('Ban lengths'), t('A week, a month or permanently. Lift a ban early with <b>Lift ban</b> if the member made it right.')],
            [t('Slash commands'), t('<b>/market</b> in Discord lets admins ban, unban, warn, message and look up a member without opening the desk.')],
            [t('Ordering channels'), t('Choose which Discord channels allow ordering with /order, in Moderation.')]
        ]
    },
    {
        admin: true,
        title: t('Community'), short: t('Announcements, alert list, budgets'),
        lines: [
            t('<b>Announcements</b> show a pop-up and a banner to every buyer until you delete them.'),
            t('The <b>alert list</b> puts a caution badge on a buyer\'s orders, with a private reason for the team.'),
            t('<b>Daily budget rewards</b> raise a member\'s daily limit to Tier 1 or Tier 2, with an optional end date.')
        ],
        detail: [
            [t('Announcements'), t('Keep them short, and delete them once they are no longer true.')],
            [t('Alert list'), t('For buyers the team should be careful with. It is not a punishment: use Moderation for that.')],
            [t('Budgets'), t('Server boosters get Tier 3 automatically. Rewards you grant can end on a date you choose.')]
        ]
    },
    {
        admin: true, key: true,
        kind: t('Prop · Compass'), title: t('What admins are for'), short: t('Your everyday duties'),
        lines: [
            t('Check <b>Theft reports → Needs attention</b> every day, and help sellers who are stuck.'),
            t('Answer the bot\'s DMs: missing-plane reports, and sellers who have gone quiet.'),
            t('Be the example: fair, fast and honest, with a clear reason on every admin action.')
        ],
        detail: [
            [t('Theft reports'), t('Make sure every report gets an answer: confirmed with the culprits, not a theft, or under investigation.')],
            [t('Quiet sellers'), t('The bot DMs Market Admins when a seller has not delivered for 5 days. Check in with them, and mark them Unranked if they have resigned.')],
            [t('Decisions'), t('Stuck orders, disputes and rule breaks come to you. Decide quickly, and explain your decision.')],
            [t('Privacy'), t('Discord IDs, warnings and the alert list are private. Never share them outside the admin team.')]
        ]
    }
].filter((x) => ADMIN || !x.admin).map((x, i) => {
    // An exhibit with a video is a display board on its stand, playing that video (buildBoard).
    const video = VIDEOS.find((v) => v.exhibit === i)?.id || null;
    return { ...x, video, kind: video ? t('Board · Training video') : x.kind };
});
let EXHIBITS = exhibits();
const N = EXHIBITS.length;   // 8, or 12 with the admin wing
const pad = (n) => String(n).padStart(2, '0');
const exhibitColour = (i) => COLOURS[(i % 9) + 1];

// Build the exhibit pages and the index from EXHIBITS.
const cardHtml = (x, i) => `
            ${x.admin ? `<p class="key-badge admin-badge">${t('Admin wing')}</p>` : x.key ? `<p class="key-badge">${t('The key habit')}</p>` : ''}
            <p class="num">${pad(i + 1)} / ${pad(N)}</p>
            <p class="kind">${esc(x.kind)}</p>
            <h2>${esc(x.title)}</h2>
            <ul class="lines">${x.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
            <div class="row"><button type="button" class="ghost" data-open="${i}">${t('Open the close-up')}</button><span class="hint"><span class="hint-mouse">${t('Drag the exhibit to turn it')}</span><span class="hint-touch">${t('Swipe the exhibit sideways to turn it')}</span></span></div>`;
const indexHtml = () => EXHIBITS.map((x, i) => `<li${x.admin ? ' class="admin"' : ''}><a href="#p${i + 1}"><span class="n">${pad(i + 1)}</span>
    <span class="t">${esc(x.title)}${x.video ? ' <span class="has-video" aria-hidden="true">▶</span>' : ''}</span><span class="s">${esc(x.short)}</span></a></li>`).join('');
$('exhibits').outerHTML = EXHIBITS.map((x, i) => `
    <section class="page${x.key ? ' key' : ''}${x.admin ? ' admin' : ''}${x.video ? ' has-tv' : ''}" id="p${i + 1}" data-page="${i + 1}">
        <div class="card"><div class="card-text">${cardHtml(x, i)}</div>${x.video ? '<div class="tv-slot"></div>' : ''}
        </div>
    </section>`).join('');
$('index-list').innerHTML = indexHtml();
document.querySelector('.nav-links').innerHTML = `<a href="#index" data-i18n>Index</a>${EXHIBITS.map((_, i) => `<a href="#p${i + 1}">${pad(i + 1)}</a>`).join('')}<a href="#pledge" data-i18n>Pledge</a>`;
if (ADMIN) {
    document.documentElement.dataset.admin = '1';
    $('pledge-admin-wrap').hidden = false;
}

const PAGES = [...document.querySelectorAll('.page')];   // hero, index, 8 exhibits, pledge
const LAST = PAGES.length - 1;
// Which view and colour each page uses: 0 = opening, 1–8 = exhibit stands, 9 = finale.
const VIEW_OF = PAGES.map((p) => (p.id === 'p0' || p.id === 'index' ? 0 : p.id === 'pledge' ? N + 1 : Number(p.dataset.page)));
const colourOfView = (v) => (v === 0 ? COLOURS[0] : v <= N ? exhibitColour(v - 1) : COLOURS[8]);

// ------------------------------------------------------------------ language
// The menu sits in the top bar. Text in welcome.html is marked data-i18n; the exhibits are rebuilt, and the
// script's own messages go through say(), so they change too when the language does.
const PACKS = ['app', 'welcome-seller'];
const said = new Map();   // element → English text
function say(el, text) {
    said.set(el, text);
    el.textContent = text ? tx(text) : '';
}
function paintLanguage() {
    translatePage();
    document.title = t('A new era begins · Echo Market sellers');
    EXHIBITS = exhibits();
    EXHIBITS.forEach((x, i) => { document.querySelector(`#p${i + 1} .card-text`).innerHTML = cardHtml(x, i); });
    $('index-list').innerHTML = indexHtml();
    players.forEach((pl) => pl.paint());
    paintChecklist();
    if (closeUp >= 0) fillDetail(closeUp);
    said.forEach((text, el) => { el.textContent = text ? tx(text) : ''; });
}
document.querySelector('.nav').insertBefore(languageMenu(PACKS), document.querySelector('.nav-progress'));

// ------------------------------------------------------------------ replay or first time
let gated = true;
function setReplay() {
    gated = false;
    $('replay-note').hidden = false;
    $('nav-exit').hidden = false;
    $('enter').disabled = false;
    say($('enter'), 'Back to the desk');
}

// ------------------------------------------------------------------ textures (canvas, no image files)
function canvasTexture(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
}
const glowTex = () => canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.25, 'rgba(255,255,255,0.7)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.12)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
});
// The seller desk's own fonts: JetBrains Mono for labels and numbers, Plus Jakarta Sans for text.
const DISPLAY = '"JetBrains Mono", ui-monospace, monospace', BODY = '"Plus Jakarta Sans", sans-serif';

function ticketTexture(colour) {
    return canvasTexture(1024, 540, (g, w, h) => {
        g.fillStyle = '#f2efe6'; g.fillRect(0, 0, w, h);
        g.fillStyle = colour; g.fillRect(0, 0, w, 86);
        g.fillStyle = '#0b0d14'; g.font = `700 44px ${DISPLAY}`; g.fillText('ORDER #142', 40, 60);
        g.font = `500 26px ${DISPLAY}`; g.textAlign = 'right'; g.fillText('ECHO MARKET', w - 40, 56); g.textAlign = 'left';
        g.fillStyle = '#1b1e29'; g.font = `600 46px ${BODY}`; g.fillText('6× Airbus A320neo', 40, 170);
        g.font = `400 32px ${BODY}`; g.fillStyle = '#444a5c';
        g.fillText('Price level 70% · buyer airline FORZA (Lior)', 40, 222);
        g.fillText('Selling as: your airline', 40, 266);
        g.fillStyle = '#b26b00'; g.font = `700 34px ${DISPLAY}`; g.fillText('LIST VALUE  $663M', 40, 340);
        g.fillStyle = '#0b0d14';
        for (let x = 40, i = 0; x < w - 40; i++) { const bw = 3 + ((i * 7) % 9); if (i % 2 === 0) g.fillRect(x, 400, bw, 100); x += bw + 4; }
        g.setLineDash([14, 12]); g.strokeStyle = '#9aa0b4'; g.lineWidth = 3; g.beginPath(); g.moveTo(760, 100); g.lineTo(760, 380); g.stroke();
        g.fillStyle = '#1b1e29'; g.font = `700 30px ${DISPLAY}`; g.fillText('TAKE', 800, 200); g.fillText('ORDER', 800, 246);
    });
}
function boardTexture() {
    return canvasTexture(1024, 576, (g, w, h) => {
        g.fillStyle = '#05070d'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#ffb703'; g.font = `700 40px ${DISPLAY}`; g.fillText('PROGRESS', 36, 66);
        g.font = `500 22px ${DISPLAY}`; g.fillStyle = '#7d8197'; g.fillText('AIRCRAFT        LISTED   AIRLINE       STATUS', 36, 120);
        const rows = [['A320NEO', '3/6', 'DAVE AIR', 'LISTED', '#ffb703'], ['A320NEO', '3/6', 'CAROL CARGO', 'LISTED', '#ffb703'],
            ['A350-900', '2/2', 'SKY ECHO', 'DONE', '#5eff94'], ['777-9', '0/4', '—', 'WAITING', '#ff6b6b']];
        rows.forEach((r, i) => {
            const y = 190 + i * 92;
            g.fillStyle = '#0d1120'; g.fillRect(28, y - 52, w - 56, 76);
            g.font = `700 32px ${DISPLAY}`; g.fillStyle = '#f3f5ff';
            g.fillText(r[0], 44, y); g.fillText(r[1], 360, y); g.font = `500 28px ${DISPLAY}`; g.fillText(r[2], 520, y);
            g.fillStyle = r[4]; g.font = `700 28px ${DISPLAY}`; g.fillText(r[3], 800, y);
        });
    });
}
function soldTexture() {
    return canvasTexture(1024, 640, (g, w, h) => {
        g.fillStyle = '#0c0f1c'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#9aa3c7'; g.font = `700 30px ${DISPLAY}`; g.fillText('SOLD LISTINGS', 40, 64);
        const row = (y, title, buyer, ok) => {
            g.fillStyle = ok ? 'rgba(94,255,148,0.10)' : 'rgba(255,107,107,0.12)'; g.fillRect(28, y, w - 56, 250);
            g.strokeStyle = ok ? '#5eff94' : '#ff6b6b'; g.lineWidth = 4; g.strokeRect(28, y, w - 56, 250);
            g.fillStyle = '#f3f5ff'; g.font = `600 44px ${BODY}`; g.fillText(title, 56, y + 70);
            g.fillStyle = '#9aa3c7'; g.font = `500 30px ${DISPLAY}`; g.fillText('BUYER', 56, y + 140);
            g.fillStyle = ok ? '#5eff94' : '#ff6b6b'; g.font = `700 52px ${DISPLAY}`; g.fillText(buyer, 56, y + 205);
            g.font = `700 34px ${DISPLAY}`; g.textAlign = 'right';
            g.fillText(ok ? '✓ ON THE ORDER' : '✗ NOT ON THE ORDER', w - 56, y + 205); g.textAlign = 'left';
        };
        row(96, '2× A320neo · order #142', 'FORZA', true);
        row(370, '1× A320neo · order #142', 'SKYWOLF', false);
    });
}

// ------------------------------------------------------------------ 3D objects
function makeJet(colour, { length = 30, parked = false } = {}) {
    const jet = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: parked ? 0x1a1e2a : 0xd9dde8, metalness: 0.55, roughness: 0.32, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1d27, metalness: 0.4, roughness: 0.5, flatShading: true });
    const livery = new THREE.MeshStandardMaterial({ color: colour, emissive: colour, emissiveIntensity: 0.35, metalness: 0.3, roughness: 0.4 });
    const half = length / 2;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, length, 16), skin); body.rotation.x = Math.PI / 2; jet.add(body);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), skin);
    nose.rotation.x = Math.PI / 2; nose.scale.set(1, 2.2, 1); nose.position.z = half; jet.add(nose);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(2, 9, 16), skin);
    tail.rotation.x = -Math.PI / 2; tail.position.set(0, 0.6, -half - 4.5); tail.scale.set(1, 1, 0.75); jet.add(tail);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(2.03, 2.03, length * 0.9, 16, 1, true, -0.5, 1), livery);
    stripe.rotation.x = Math.PI / 2; stripe.rotation.y = Math.PI / 2; jet.add(stripe);
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 3); wingShape.lineTo(17, -5); wingShape.lineTo(17.6, -7.5); wingShape.lineTo(0, -5); wingShape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.5, bevelEnabled: false });
    for (const side of [1, -1]) {
        const w = new THREE.Mesh(wingGeo, skin); w.rotation.x = -Math.PI / 2; w.scale.x = side; w.position.set(0, -1, 1); jet.add(w);
        const tip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 1.6), livery); tip.position.set(side * 17.4, 0.1, -5.6); jet.add(tip);
        const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1, 5, 14), dark); eng.rotation.x = Math.PI / 2; eng.position.set(side * 6.5, -2.4, 2.5); jet.add(eng);
        const glowRing = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.12, 8, 20), livery); glowRing.position.set(side * 6.5, -2.4, 0); jet.add(glowRing);
        const stab = new THREE.Mesh(wingGeo, skin); stab.rotation.x = -Math.PI / 2; stab.scale.set(side * 0.38, 0.38, 1); stab.position.set(0, 0.6, -half - 2); jet.add(stab);
    }
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0); finShape.lineTo(-7, 0); finShape.lineTo(-9.5, 8); finShape.lineTo(-6.5, 8); finShape.closePath();
    const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: 0.4, bevelEnabled: false }), livery);
    fin.rotation.y = Math.PI / 2; fin.position.set(0.2, 1.4, -half + 1.5); jet.add(fin);
    const win = new THREE.Mesh(new THREE.BoxGeometry(4.1, 0.25, length * 0.72), new THREE.MeshBasicMaterial({ color: 0x0b0d14 }));
    win.position.set(0, 0.7, 1); jet.add(win);
    return jet;
}

// A display board on a stand, playing the exhibit's training video. The <video> lives in the card's player (which has
// the controls); the board shows it as a texture, with the poster frame until it has played, and a play button.
function buildBoard(i, colour) {
    const g = new THREE.Group();
    const pl = players.get(EXHIBITS[i].video);
    const metal = new THREE.MeshStandardMaterial({ color: 0x151925, metalness: 0.6, roughness: 0.4 });
    g.add(new THREE.Mesh(new THREE.BoxGeometry(25.4, 14.9, 1.2), metal));
    const edge = new THREE.Mesh(new THREE.BoxGeometry(25.9, 15.4, 0.5), new THREE.MeshBasicMaterial({ color: colour, toneMapped: false }));
    edge.position.z = -0.1; g.add(edge);
    const poster = new THREE.TextureLoader().load(`media/training/${pl.v.id}.jpg`);
    poster.colorSpace = THREE.SRGBColorSpace;
    const vtex = new THREE.VideoTexture(pl.video);
    vtex.colorSpace = THREE.SRGBColorSpace;
    const screenMat = new THREE.MeshBasicMaterial({ map: poster, toneMapped: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(24, 13.5), screenMat);
    screen.position.z = 0.62; g.add(screen);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(24, 13.5), new THREE.MeshBasicMaterial({ map: poster, color: 0x4a4f5c, toneMapped: false }));
    back.rotation.y = Math.PI; back.position.z = -0.62; g.add(back);
    const play = new THREE.Group();
    play.add(new THREE.Mesh(new THREE.CircleGeometry(2.3, 48), new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.94, toneMapped: false })));
    const tri = new THREE.Shape(); tri.moveTo(-0.7, -1.15); tri.lineTo(1.25, 0); tri.lineTo(-0.7, 1.15); tri.closePath();
    const icon = new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshBasicMaterial({ color: 0x0b0d14, toneMapped: false }));
    icon.position.z = 0.02; play.add(icon);
    play.position.z = 0.75; g.add(play);
    for (const x of [-8, 8]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 9), new THREE.MeshStandardMaterial({ color: 0x2a2f3c, metalness: 0.7, roughness: 0.3 }));
        leg.position.set(x, -11.6, 0); g.add(leg);
    }
    g.position.y = 13.4; g.scale.setScalar(0.94);
    g.userData.board = { pl, screen, screenMat, poster, vtex, play };
    return g;
}

function buildExhibit(i, colour) {
    if (EXHIBITS[i].video) return buildBoard(i, colour);
    const g = new THREE.Group();
    const c = new THREE.Color(colour);
    const metal = (col, m = 0.7, r = 0.3) => new THREE.MeshStandardMaterial({ color: col, metalness: m, roughness: r });
    switch (i) {
        case 0: {   // order ticket
            const tex = ticketTexture(colour);
            const paper = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.8 });
            const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
            const card = new THREE.Mesh(new THREE.BoxGeometry(19, 10, 0.2), [paper, paper, paper, paper, face, face]);
            card.rotation.z = -0.06; g.add(card);
            g.position.y = 9; g.scale.setScalar(1.05);
            break;
        }
        case 1: {   // A320neo
            const jet = makeJet(colour, { length: 28 }); jet.rotation.y = -0.6; g.add(jet);
            g.position.y = 8; g.scale.setScalar(0.62);
            break;
        }
        case 2: {   // departures board
            const frame = new THREE.Mesh(new THREE.BoxGeometry(21, 12.6, 1.2), metal(0x151925, 0.6, 0.4)); g.add(frame);
            const screen = new THREE.Mesh(new THREE.PlaneGeometry(20, 11.3), new THREE.MeshBasicMaterial({ map: boardTexture() }));
            screen.position.z = 0.62; g.add(screen);
            const back = screen.clone(); back.rotation.y = Math.PI; back.position.z = -0.62; g.add(back);
            for (const x of [-7, 7]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 8), metal(0x2a2f3c)); leg.position.set(x, -10, 0); g.add(leg); }
            g.position.y = 13.5;
            break;
        }
        case 3: {   // sold listing + magnifying glass (the key exhibit)
            const listing = new THREE.Mesh(new THREE.PlaneGeometry(17, 10.6), new THREE.MeshBasicMaterial({ map: soldTexture(), side: THREE.DoubleSide }));
            g.add(listing);
            const glass = new THREE.Group();
            const ring = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.42, 16, 48), metal(c, 0.8, 0.25));
            const lens = new THREE.Mesh(new THREE.CircleGeometry(3.3, 48), new THREE.MeshStandardMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.16, metalness: 0.1, roughness: 0.05, side: THREE.DoubleSide }));
            const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 6, 16), metal(0x20232e, 0.5, 0.5));
            handle.position.set(3.6, -4.6, 0); handle.rotation.z = 0.68;
            glass.add(ring, lens, handle); glass.position.z = 2.4;
            g.add(glass); g.userData.glass = glass;
            g.position.y = 10;
            break;
        }
        case 4: {   // two aircraft nose to nose (take-over)
            const a = makeJet(colour, { length: 26 }); a.scale.setScalar(0.42); a.position.set(-8.5, 0, 0); a.rotation.y = Math.PI / 2;
            const b = makeJet('#fdecd8', { length: 22 }); b.scale.setScalar(0.4); b.position.set(8.5, 0, 0); b.rotation.y = -Math.PI / 2;
            g.add(a, b); g.position.y = 7;
            break;
        }
        case 5: {   // shield
            const s = new THREE.Shape();
            s.moveTo(0, 6); s.quadraticCurveTo(3.5, 6.2, 5.5, 4.8); s.lineTo(5.2, 0.5);
            s.quadraticCurveTo(4.6, -4, 0, -6.5); s.quadraticCurveTo(-4.6, -4, -5.2, 0.5); s.lineTo(-5.5, 4.8); s.quadraticCurveTo(-3.5, 6.2, 0, 6);
            const geo = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.45, bevelSegments: 4 });
            geo.center();
            const shield = new THREE.Mesh(geo, metal(c, 0.85, 0.22)); g.add(shield);
            const chev = new THREE.Shape();   // an Echo-like chevron on the shield
            chev.moveTo(2.4, 2.6); chev.lineTo(-2.2, -0.2); chev.lineTo(2.4, -3); chev.lineTo(2.4, -1.6); chev.lineTo(0.2, -0.2); chev.lineTo(2.4, 1.2); chev.closePath();
            const cg = new THREE.ExtrudeGeometry(chev, { depth: 0.6, bevelEnabled: false }); cg.center();
            const emblem = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: 0x0b0d14, metalness: 0.4, roughness: 0.4 }));
            emblem.position.z = 1.05; g.add(emblem);
            const emblemBack = emblem.clone(); emblemBack.position.z = -1.05; g.add(emblemBack);
            g.position.y = 10; g.scale.setScalar(1.1);
            break;
        }
        case 6: {   // warning beacon
            const base = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.8, 2.4, 24), metal(0x1d2130, 0.6, 0.4)); g.add(base);
            const dome = new THREE.Mesh(new THREE.SphereGeometry(3, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
                new THREE.MeshStandardMaterial({ color: 0xff6a2a, emissive: 0xff4a1a, emissiveIntensity: 0.6, transparent: true, opacity: 0.55, roughness: 0.1 }));
            dome.position.y = 1.2; g.add(dome);
            const spin = new THREE.Group(); spin.position.y = 2.6;
            const beamMat = new THREE.MeshBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
            for (const dir of [1, -1]) {
                const beam = new THREE.Mesh(new THREE.ConeGeometry(2.2, 11, 24, 1, true), beamMat);
                beam.geometry.translate(0, -5.5, 0); beam.rotation.z = dir * Math.PI / 2; spin.add(beam);
            }
            g.add(spin); g.userData.spin = spin;
            const bulb = new THREE.PointLight(0xff6a2a, 40, 30, 1.6); bulb.position.y = 2.6; g.add(bulb); g.userData.bulb = bulb;
            g.position.y = 5; g.scale.setScalar(1.25);
            break;
        }
        case 7: {   // A350 under the brightest spotlight
            const jet = makeJet(colour, { length: 36 }); jet.rotation.y = 0.7; g.add(jet);
            g.position.y = 8.5; g.scale.setScalar(0.6);
            break;
        }
        case 11: {   // compass (an admin's duties)
            const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.7, 16, 64), metal(c, 0.85, 0.25)); g.add(ring);
            const face = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 5.6, 0.5, 64), new THREE.MeshStandardMaterial({ color: 0x0d111c, metalness: 0.3, roughness: 0.5 }));
            face.rotation.x = Math.PI / 2; g.add(face);
            const needle = new THREE.Group();
            const north = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.6, 4), new THREE.MeshStandardMaterial({ color: 0xff456a, emissive: 0xff456a, emissiveIntensity: 0.4 }));
            north.position.y = 2.3;
            const south = new THREE.Mesh(new THREE.ConeGeometry(0.9, 4.6, 4), metal(0xe5e7eb, 0.6, 0.3)); south.rotation.z = Math.PI; south.position.y = -2.3;
            needle.add(north, south); needle.position.z = 0.6;
            const back = needle.clone(); back.position.z = -0.6;
            g.add(needle, back); g.userData.needle = [needle, back];
            g.position.y = 10;
            break;
        }
    }
    return g;
}

// ------------------------------------------------------------------ the hangar
const STAND_X = (i) => 40 + i * 44;   // exhibit i (0–7) stands along x
const loaderPct = $('loader-pct');
let loadTarget = 0;
const setLoad = (p) => { loadTarget = Math.max(loadTarget, p); };

function buildWorld() {
    const canvas = document.createElement('canvas');
    canvas.id = 'scene'; canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high', powerPreference: 'high-performance' });
    renderer.setPixelRatio(pixelRatioFor(quality));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04050a);
    scene.fog = new THREE.FogExp2(0x05060c, 0.0042);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 4000);
    const glow = glowTex();

    scene.add(new THREE.HemisphereLight(0x2b3256, 0x05060a, 0.7));
    const moon = new THREE.DirectionalLight(0x8fa4ff, 0.35); moon.position.set(-100, 200, 150); scene.add(moon);

    // polished concrete floor, with soft pools under each stand
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(1400, 400), new THREE.MeshStandardMaterial({ color: 0x0d1018, metalness: 0.55, roughness: 0.34 }));
    floor.rotation.x = -Math.PI / 2; scene.add(floor);
    const seams = new THREE.GridHelper(1400, 70, 0x1a1f2c, 0x141824); seams.position.y = 0.02; scene.add(seams);

    // walls and roof trusses (x from -120 to 420)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x0a0c14, metalness: 0.3, roughness: 0.8 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(540, 90), wallMat); back.position.set(150, 45, -70); scene.add(back);
    const truss = new THREE.MeshStandardMaterial({ color: 0x1b2030, metalness: 0.7, roughness: 0.45 });
    const END = STAND_X(N - 1) + 70;   // the far wall, after the last stand
    const BAYS = Math.max(26, Math.ceil((END + 110) / 21) + 1);
    const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 1.2, 150), truss, BAYS);
    const diag = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 14, 0.6), truss, BAYS * 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    for (let k = 0; k < BAYS; k++) {
        const x = -110 + k * 21;
        beams.setMatrixAt(k, m4.compose(new THREE.Vector3(x, 72, 0), q, one));
        for (const s of [0, 1]) diag.setMatrixAt(k * 2 + s, m4.compose(new THREE.Vector3(x, 65, s ? 30 : -30), q.setFromEuler(new THREE.Euler(s ? 0.5 : -0.5, 0, 0)), one));
        q.identity();
    }
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(Math.max(560, END + 140), 1.4, 1.4), truss); ridge.position.set(Math.max(150, (END - 140) / 2), 74, 0);
    scene.add(beams, diag, ridge);
    // ceiling lamps (dim, the stands' spotlights do the work)
    const lampPts = [];
    for (let k = 0; k < Math.max(13, Math.ceil((END + 100) / 42)); k++) lampPts.push(-100 + k * 42, 70, 0);
    const lampGeo = new THREE.BufferGeometry(); lampGeo.setAttribute('position', new THREE.Float32BufferAttribute(lampPts, 3));
    scene.add(new THREE.Points(lampGeo, new THREE.PointsMaterial({ size: 6, map: glow, color: 0xffe2b8, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    setLoad(25);

    // the hangar doors (behind the opening view): they slide open to a starry apron
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x141826, metalness: 0.6, roughness: 0.5 });
    const doorL = new THREE.Mesh(new THREE.BoxGeometry(40, 60, 2), doorMat), doorR = doorL.clone();
    doorL.position.set(-30, 30, -69); doorR.position.set(10, 30, -69); scene.add(doorL, doorR);
    // the night outside: a sky with a glowing horizon, seen through the doors
    const skyTex = canvasTexture(256, 256, (g, w, h) => {
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#04050f'); grad.addColorStop(0.55, '#0f1236'); grad.addColorStop(0.82, '#3a1d6e'); grad.addColorStop(0.9, '#ff7b3e'); grad.addColorStop(1, '#0a0b14');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
    });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(260, 120), new THREE.MeshBasicMaterial({ map: skyTex, fog: false }));
    sky.position.set(-10, 40, -130); scene.add(sky);
    const apronFloor = new THREE.Mesh(new THREE.PlaneGeometry(260, 70), new THREE.MeshStandardMaterial({ color: 0x0b0e18, roughness: 0.6, metalness: 0.4 }));
    apronFloor.rotation.x = -Math.PI / 2; apronFloor.position.set(-10, 0.01, -105); scene.add(apronFloor);
    const doorGlow = new THREE.PointLight(0x9a7dff, 900, 120, 1.3); doorGlow.position.set(-10, 30, -60); scene.add(doorGlow);
    const outside = new THREE.PointLight(0xffb27a, 700, 90, 1.4); outside.position.set(-14, 20, -84); scene.add(outside);
    back.position.set((30 + Math.max(420, END)) / 2, 45, -70); back.scale.x = (Math.max(420, END) - 30) / 540;   // the wall right of the door opening
    const backL = new THREE.Mesh(new THREE.PlaneGeometry(70, 90), wallMat); backL.position.set(-85, 45, -70); scene.add(backL);
    const lintel = new THREE.Mesh(new THREE.PlaneGeometry(80, 30), wallMat); lintel.position.set(-10, 75, -70); scene.add(lintel);
    const stars = [];
    for (let k = 0; k < (quality === 'high' ? 700 : 260); k++) stars.push(-130 + Math.random() * 240, 40 + Math.random() * 60, -125);
    const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, map: glow, color: 0xdfe4ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    const apron = [];   // runway lights far outside
    for (let k = 0; k < 30; k++) apron.push(-110 + k * 7.5, 1.5, -112), apron.push(-110 + k * 7.5, 1.5, -100);
    const apronGeo = new THREE.BufferGeometry(); apronGeo.setAttribute('position', new THREE.Float32BufferAttribute(apron, 3));
    const apronMat = new THREE.PointsMaterial({ size: 5, map: glow, color: new THREE.Color(COLOURS[0]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    scene.add(new THREE.Points(apronGeo, apronMat));
    const parked = makeJet('#7d34ff', { length: 28 }); parked.scale.setScalar(0.55); parked.position.set(-16, 3, -90); parked.rotation.y = Math.PI / 2; scene.add(parked);
    setLoad(40);

    // the stands (eight, or twelve with the admin wing): plinth, coloured rim, spotlight with a visible cone, the exhibit
    const stands = [];
    const plinthMat = new THREE.MeshStandardMaterial({ color: 0x10131d, metalness: 0.6, roughness: 0.35 });
    for (let i = 0; i < N; i++) {
        const colour = exhibitColour(i);
        const x = STAND_X(i);
        const plinth = new THREE.Mesh(new THREE.CylinderGeometry(11, 12, 2.2, 48), plinthMat); plinth.position.set(x, 1.1, 0);
        const rimMat = new THREE.MeshBasicMaterial({ color: colour });
        const rim = new THREE.Mesh(new THREE.TorusGeometry(11.6, 0.18, 8, 96), rimMat); rim.rotation.x = Math.PI / 2; rim.position.set(x, 2.25, 0);
        const pool = new THREE.Mesh(new THREE.CircleGeometry(20, 48), new THREE.MeshBasicMaterial({ map: glow, color: colour, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }));
        pool.rotation.x = -Math.PI / 2; pool.position.set(x, 0.05, 0);
        const spot = new THREE.SpotLight(0xfff3e2, i === 7 ? 5200 : 3600, 120, 0.42, 0.55, 1.4);
        spot.position.set(x, 64, 10); spot.target.position.set(x, 4, 0);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(17, 62, 40, 1, true),
            new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: i === 7 ? 0.07 : 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
        cone.position.set(x, 33, 5); cone.rotation.x = -0.16;
        const rimLight = new THREE.PointLight(colour, 260, 46, 1.5); rimLight.position.set(x - 9, 10, 14);
        const exhibit = buildExhibit(i, colour);   // its own height is set inside; the pivot turns and floats it
        const pivot = new THREE.Group(); pivot.position.set(x, 0, 0);
        pivot.add(exhibit);
        scene.add(plinth, rim, pool, spot, spot.target, cone, rimLight, pivot);
        // 'high' only: 16 lights on every surface is what slows older tablets down. Lower levels use followSpot.
        spot.visible = rimLight.visible = quality === 'high';
        // Flat exhibits (ticket, board, sold listing) sway and spring back so they stay readable; the rest turn.
        stands.push({ x, pivot, exhibit, spot, cone, rimMat, pool, rimLight, spin: 0, vel: 0, flat: Boolean(EXHIBITS[i].video) || i === 3 });
        setLoad(40 + Math.round(((i + 1) * 48) / N));
    }
    setLoad(92);
    // Lower levels: one spotlight and one coloured rim light that follow the camera from stand to stand.
    const followSpot = new THREE.SpotLight(0xfff3e2, 4200, 120, 0.42, 0.55, 1.4);
    followSpot.position.set(STAND_X(0), 64, 10); followSpot.target.position.set(STAND_X(0), 4, 0);
    const followRim = new THREE.PointLight(exhibitColour(0), 260, 46, 1.5);
    followSpot.visible = followRim.visible = quality !== 'high';
    scene.add(followSpot, followSpot.target, followRim);
    return { renderer, scene, camera, stands, doors: [doorL, doorR], apronMat, parked, followSpot, followRim };
}

let world = null;

// Camera views: 0 = the opening (facing the doors), 1–N = each stand, N + 1 = the finale (all stands, wide).
function viewFor(v, out = {}) {
    if (v === 0) return { pos: new THREE.Vector3(-10, 16, 58), look: new THREE.Vector3(-10, 22, -70) };
    if (v === N + 1) {
        const k = (N - 1) / 7, far = N / 8;
        return { pos: new THREE.Vector3(STAND_X(3.2 * k), 85 * far, 250 * far), look: new THREE.Vector3(STAND_X(4.6 * k), 6, -10) };
    }
    const x = STAND_X(v - 1);
    return { pos: new THREE.Vector3(x - 6, 15, 48), look: new THREE.Vector3(x, 9, 0) };
}

// ------------------------------------------------------------------ scroll
let target = 0, shown = 0;
function readScroll() {
    const mid = window.scrollY + window.innerHeight * 0.5;
    const band = window.innerHeight * 0.5;
    let f = 0;
    for (let i = 1; i <= LAST; i++) {
        const t = (mid - (PAGES[i].offsetTop - band / 2)) / band;
        if (t >= 1) f = i; else { if (t > 0) f = i - 1 + t; break; }
    }
    target = Math.max(0, Math.min(LAST, f));
    const docH = document.documentElement.scrollHeight - window.innerHeight;
    $('nav-progress-bar').style.width = `${docH > 0 ? Math.min(100, (window.scrollY / docH) * 100) : 0}%`;
    const idx = Math.round(target), v = VIEW_OF[idx];
    $('nav-step').textContent = v >= 1 && v <= N ? `${pad(v)} / ${pad(N)}` : v === N + 1 ? t('PLEDGE') : `00 / ${pad(N)}`;
    const id = PAGES[idx].id;
    document.querySelectorAll('.nav-links a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
    exhaustOn(v);
}
window.addEventListener('scroll', readScroll, { passive: true });
window.addEventListener('resize', () => { readScroll(); resize(); });

// Jet-exhaust wipe in the new page's colour when the colour changes.
let lastColour = COLOURS[0];
function exhaustOn(v) {
    const col = colourOfView(v);
    if (col === lastColour || REDUCED) { lastColour = col; return; }
    lastColour = col;
    const ex = $('exhaust');
    ex.style.setProperty('--accent', col);
    ex.classList.remove('go'); void ex.offsetWidth; ex.classList.add('go');
}

const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('seen');
        if (e.target.id === 'pledge' && !e.target.dataset.burst) { e.target.dataset.burst = '1'; burst(); }
    }
}, { threshold: 0.2 });
PAGES.forEach((p) => seen.observe(p));

// ------------------------------------------------------------------ colours
let lastCss = '';
function applyAccent(f) {
    const i = Math.floor(f), t = f - i;
    const hex = mixHex(colourOfView(VIEW_OF[i]), colourOfView(VIEW_OF[Math.min(i + 1, LAST)]), t);
    if (hex === lastCss) return;
    lastCss = hex;
    if (world) world.apronMat.color.set(hex);
    const root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--accent-ink', inkFor(hex));
}

// ------------------------------------------------------------------ "A NEW ERA BEGINS"
function burst() {
    if (REDUCED) return;
    const b = $('burst'), sparks = b.querySelector('.burst-sparks');
    sparks.innerHTML = Array.from({ length: 36 }, (_, k) => {
        const a = (k / 36) * 360 + Math.random() * 8;
        return `<i class="spark" style="--a:${a}deg;--r:${30 + Math.random() * 26}vmax;--c:${COLOURS[k % COLOURS.length]};--d:${(Math.random() * 0.18).toFixed(2)}s"></i>`;
    }).join('');
    b.classList.remove('on'); void b.offsetWidth; b.classList.add('on');
    clearTimeout(burst.t); burst.t = setTimeout(() => b.classList.remove('on'), 2600);
    flare = 1;   // every spotlight flares in the 3D world too
}
let flare = 0;

// ------------------------------------------------------------------ drag to turn + close-ups
let drag = null, closeUp = -1;
function currentStand() {
    const v = VIEW_OF[Math.round(target)];
    return v >= 1 && v <= N ? v - 1 : -1;
}
function onDown(e) {
    const s = closeUp >= 0 ? closeUp : currentStand();
    if (s < 0 || !world) return;
    drag = { s, x: e.clientX, id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now() };
    world.renderer.domElement.classList.add('dragging');
    world.renderer.domElement.setPointerCapture?.(e.pointerId);
}
function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x; drag.x = e.clientX;
    const st = world.stands[drag.s];
    st.spin += dx * 0.012; st.vel = dx * 0.012;
}
function onUp(e) {
    // A click (not a drag) on a video board plays or pauses it.
    if (drag && e && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6 && performance.now() - drag.t0 < 500) {
        const board = world?.stands[drag.s]?.exhibit.userData.board;
        if (board) {
            const r = world.renderer.domElement.getBoundingClientRect();
            const ray = new THREE.Raycaster();
            ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), world.camera);
            if (ray.intersectObjects([board.screen, board.play], true).length) board.pl.toggle();
        }
    }
    drag = null; world?.renderer.domElement.classList.remove('dragging');
}

function fillDetail(i) {
    const x = EXHIBITS[i];
    $('detail-kind').textContent = `${pad(i + 1)} / ${pad(N)} · ${x.kind}`;
    $('detail-title').textContent = x.title;
    $('detail-body').innerHTML = x.detail.map(([h, p]) => `<h3>${esc(h)}</h3><p>${p}</p>`).join('');
}
function openDetail(i) {
    fillDetail(i);
    $('detail').hidden = false;
    closeUp = i;
    $('detail-close').focus();
}
function closeDetail() {
    if ($('detail').hidden) return;
    $('detail').hidden = true;
    const opener = document.querySelector(`[data-open="${closeUp}"]`);
    closeUp = -1;
    opener?.focus({ preventScroll: true });
}
document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openDetail(Number(b.dataset.open));
});
$('detail-close').addEventListener('click', closeDetail);
$('detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

// ------------------------------------------------------------------ frame loop
let camPos, camLook, goalPos, goalLook;   // set once three.js has loaded
let watch = null;   // frame-rate watch (welcome-perf.js)
function startWatch() {
    watch = quality === 'lite' ? null : frameWatch(quality === 'high' ? 45 : 24, () => setQuality(lowerThan(quality), true));
}
// Change the graphics level while the page runs (auto: remembered on this device for next time).
function setQuality(level, auto = false) {
    if (level === quality) return;
    quality = level;
    document.documentElement.dataset.quality = level;
    if (auto) rememberQuality(level);
    if (level === 'lite') {
        if (world) { world.renderer.dispose(); world.renderer.domElement.remove(); world = null; }
        watch = null;
        return;
    }
    if (!world) return;
    world.renderer.setPixelRatio(pixelRatioFor(level)); resize();
    for (const st of world.stands) st.spot.visible = st.rimLight.visible = level === 'high';
    world.followSpot.visible = world.followRim.visible = level !== 'high';
    startWatch();
}
let firstFrame = true, doorsT = REDUCED ? 1 : 0, leaving = false;
function resize() {
    if (!world) return;
    const w = window.innerWidth, h = window.innerHeight;
    world.renderer.setSize(w, h, false);
    world.camera.aspect = w / h;
    world.camera.fov = w / h < 1 ? 64 : 42;
    // Keep the exhibit clear of the text: to the right on wide screens, near the top on phones.
    if (w > 720) world.camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
    else world.camera.setViewOffset(w, h, 0, h * 0.31, w, h);
    world.camera.updateProjectionMatrix();
}
function frame(now) {
    requestAnimationFrame(frame);
    watch?.(now);
    const time = now / 1000;
    if (REDUCED) shown = Math.round(target); else shown += (target - shown) * (firstFrame ? 1 : 0.07);
    applyAccent(shown);
    tiltPlayers(time);
    if (!world) return;
    const { renderer, scene, camera, stands, doors } = world;

    // camera between the two nearest views (closer in for a close-up)
    const i = Math.floor(shown), t = shown - i, e = t * t * (3 - 2 * t);
    const a = viewFor(VIEW_OF[i]), b = viewFor(VIEW_OF[Math.min(i + 1, LAST)]);
    goalPos.copy(a.pos).lerp(b.pos, e); goalLook.copy(a.look).lerp(b.look, e);
    if (closeUp >= 0) {
        const x = STAND_X(closeUp);
        goalPos.set(x - 3, 12, 30); goalLook.set(x, 9, 0);
    }
    if (leaving) goalPos.y += 6;
    if (firstFrame || REDUCED) { camPos.copy(goalPos); camLook.copy(goalLook); }
    else { camPos.lerp(goalPos, 0.07); camLook.lerp(goalLook, 0.07); }
    camera.position.copy(camPos); camera.lookAt(camLook);
    world.parked.rotation.y = Math.PI / 2 + (REDUCED ? 0 : Math.sin(time * 0.2) * 0.15);
    if (world.followSpot.visible) {   // lower levels: the one spotlight follows the camera to the stand in view
        const fx = camLook.x;
        world.followSpot.position.set(fx, 64, 10); world.followSpot.target.position.set(fx, 4, 0);
        const k = Math.max(0, Math.min(N - 1, Math.round((fx - STAND_X(0)) / (STAND_X(1) - STAND_X(0)))));
        world.followRim.position.set(fx - 9, 10, 14); world.followRim.color.set(exhibitColour(k));
    }
    firstFrame = false;

    // the doors slide open once the hangar is lit
    if (doorsT < 1 && loaded) doorsT = Math.min(1, doorsT + 0.006);
    const d = 1 - Math.pow(1 - doorsT, 3);
    doors[0].position.x = -30 - d * 38; doors[1].position.x = 10 + d * 38;

    // exhibits: slow showroom turn, drag with inertia, a gentle float; the finale and bursts light everything up
    flare = Math.max(0, flare - 0.012);
    const finale = VIEW_OF[Math.round(shown)] === N + 1 ? 1 : 0;
    stands.forEach((st, k) => {
        const held = drag && drag.s === k;
        if (!REDUCED && !held) {
            st.vel *= 0.94; st.spin += st.vel;
            if (st.flat) st.spin *= 0.985; else st.spin += 0.0035;
        }
        const board = st.exhibit.userData.board;
        const sway = board?.pl.playing ? 0.1 : 0.32;   // a playing board turns only a little, so it stays easy to watch
        st.pivot.rotation.y = st.spin + (st.flat && !REDUCED ? Math.sin(time * 0.5 + k) * sway : 0);
        if (board) {
            const v = board.pl.video;
            const live = v.readyState >= 2 && (board.pl.playing || v.currentTime > 0.2);
            const map = live ? board.vtex : board.poster;
            if (board.screenMat.map !== map) { board.screenMat.map = map; board.screenMat.needsUpdate = true; }
            board.play.visible = !board.pl.playing;
        }
        st.pivot.position.y = REDUCED ? 0 : Math.sin(time * 0.9 + k) * 0.5;
        const boost = 1 + flare * 1.6 + finale * 0.5;
        st.spot.intensity = (k === 7 ? 5200 : 3600) * boost;
        st.cone.material.opacity = (k === 7 ? 0.07 : 0.045) * (1 + flare * 2.5 + finale);
        st.pool.material.opacity = 0.22 * (1 + flare + finale * 0.6);
        const ex = st.exhibit.userData;
        if (ex.glass && !REDUCED) ex.glass.position.set(Math.sin(time * 0.8) * 3.8, Math.cos(time * 1.1) * 2.2 + 0.4, 2.4);
        if (ex.spin && !REDUCED) ex.spin.rotation.y = time * 3;
        if (ex.bulb) ex.bulb.intensity = REDUCED ? 60 : 50 + Math.sin(time * 6) * 20;
        if (ex.needle && !REDUCED) ex.needle.forEach((nd) => { nd.rotation.z = Math.sin(time * 0.7) * 0.5 + Math.sin(time * 2.3) * 0.08; });
    });
    renderer.render(scene, camera);
}

// ------------------------------------------------------------------ loader
let loaded = false;
(async function load() {
    // Wait for the fonts (the canvas textures use them), at most a few seconds.
    await Promise.race([
        Promise.all([document.fonts?.load?.('800 40px "Plus Jakarta Sans"'), document.fonts?.load?.('500 20px "JetBrains Mono"'), document.fonts?.ready].filter(Boolean)).catch(() => {}),
        new Promise((r) => setTimeout(r, 3500))
    ]);
    setLoad(10);
    if (quality !== 'lite') {
        try {
            THREE = await import('../vendor/three-0.160.1/three.module.min.js');
            camPos = new THREE.Vector3(); camLook = new THREE.Vector3(); goalPos = new THREE.Vector3(); goalLook = new THREE.Vector3();
            world = buildWorld();
            lastCss = '';   // repaint the scene's colour on the next frame
        } catch (err) { console.warn('3D scene unavailable:', err); setQuality('lite'); }
    }
    setLoad(100);
    let pct = 0;
    await new Promise((done) => {
        const step = () => {
            pct += Math.max(1, (loadTarget - pct) * 0.2);
            if (pct > loadTarget) pct = loadTarget;
            loaderPct.textContent = String(Math.round(pct));
            if (pct >= 100) done(); else setTimeout(step, REDUCED ? 0 : 20);
        };
        step();
    });
    readScroll(); resize();
    if (world) {
        const c = world.renderer.domElement;
        c.addEventListener('pointerdown', onDown); c.addEventListener('pointermove', onMove);
        c.addEventListener('pointerup', onUp); c.addEventListener('pointercancel', onUp);
        world.renderer.compile(world.scene, world.camera);
    }
    startWatch();
    qualitySwitch($('quality-switch'), quality);
    requestAnimationFrame(frame);
    setTimeout(() => {
        $('loader').classList.add('done');
        loaded = true;
        if (window.scrollY < window.innerHeight * 0.5) burst();   // the opening "A NEW ERA BEGINS"
    }, REDUCED ? 0 : 250);
})();

// ------------------------------------------------------------------ the pledges
const pledgesTicked = () => $('pledge-check').checked && $('pledge-serve').checked && (!ADMIN || $('pledge-admin').checked);
function updateEnter() { if (gated) $('enter').disabled = !pledgesTicked() || missingVideos().length > 0; }
$('pledge-check').addEventListener('change', updateEnter);
$('pledge-serve').addEventListener('change', updateEnter);
$('pledge-admin').addEventListener('change', updateEnter);
$('nav-exit').addEventListener('click', (e) => { e.preventDefault(); leave(); });
$('enter').addEventListener('click', async () => {
    const button = $('enter'), out = $('enter-msg');
    out.classList.remove('bad');
    if (gated) {
        if (!pledgesTicked() || missingVideos().length) return;
        button.disabled = true;
        say(out, 'Opening your desk…');
        try {
            await api('/api/welcome', { pledges: { check: true, serve: true, admin: ADMIN ? true : undefined } });
        } catch (err) {
            say(out, err.message); out.classList.add('bad'); button.disabled = false;
            return;
        }
        say(out, 'Welcome to the new era.');
    }
    button.disabled = true;
    leave();
});
function leave() {
    if (leaving) return;
    leaving = true;
    burst();
    const wait = REDUCED ? 200 : 2300;
    setTimeout(() => $('fade').classList.add('on'), Math.max(0, wait - 900));
    setTimeout(() => window.location.replace('/'), wait);
}

// ------------------------------------------------------------------ training video players
// No speed changes and no skipping ahead (going back is fine), one video at a time, paused when scrolled away or when
// the tab is hidden. Each start and end goes to the API, which decides what counts as watched (lib/training.js).
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const local = {
    get: (k) => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } },
    set: (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } }
};
const players = new Map();   // video id → player
const tvSeen = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting && !document.fullscreenElement) players.get(e.target.dataset.vid)?.video.pause();
}), { threshold: 0.3 });
document.addEventListener('visibilitychange', () => { if (document.hidden) players.forEach((pl) => pl.video.pause()); });

function makePlayer(v, slot) {
    const fig = document.createElement('figure');
    fig.className = 'tv';
    fig.dataset.vid = v.id;
    fig.innerHTML = `<div class="tv-frame">
            <video preload="none" playsinline disablepictureinpicture disableremoteplayback controlslist="nodownload noplaybackrate noremoteplayback nofullscreen"
                poster="media/training/${v.id}.jpg" src="media/training/${v.id}.mp4"></video>
            <button type="button" class="tv-big"><span aria-hidden="true">▶</span></button>
            <div class="tv-ui">
                <button type="button" class="tv-btn tv-pp"></button>
                <div class="tv-bar"><i class="tv-seen"></i><i class="tv-now"></i></div>
                <span class="tv-time"></span>
                <button type="button" class="tv-btn tv-mute"></button>
                <button type="button" class="tv-btn tv-fs">⛶</button>
            </div>
        </div>
        <figcaption><span class="tv-title"></span><span class="tv-state"></span></figcaption>`;
    slot.appendChild(fig);
    const q = (c) => fig.querySelector(c);
    const video = q('video'), frame = q('.tv-frame');
    const key = 'echo-tv-' + v.id;
    const pl = { v, fig, frame, video, playing: false, max: local.get(key), started: false, stand: v.exhibit, error: '' };
    const done = () => DONE.has(v.id);

    // Nothing that changes speed or jumps ahead: no native controls, no context menu (it offers "show all controls").
    fig.addEventListener('contextmenu', (e) => e.preventDefault());
    video.addEventListener('ratechange', () => {
        if (video.playbackRate !== 1) video.playbackRate = 1;
        if (video.defaultPlaybackRate !== 1) video.defaultPlaybackRate = 1;
    });
    video.addEventListener('seeking', () => { if (!done() && video.currentTime > pl.max + 1) video.currentTime = pl.max; });
    let last = 0;
    video.addEventListener('timeupdate', () => {
        const now = video.currentTime;
        if (!video.seeking && now > pl.max && now - last < 1.5) { pl.max = now; local.set(key, Math.floor(now)); }
        last = now;
        paintTime();
    });
    // Back where they left off (this device), never further.
    video.addEventListener('loadedmetadata', () => {
        if (!done() && pl.max > 2 && pl.max < video.duration - 2 && video.currentTime < 1) video.currentTime = Math.max(0, pl.max - 1);
        paintTime();
    });
    video.addEventListener('play', () => {
        players.forEach((o) => { if (o !== pl) o.video.pause(); });
        pl.playing = true; pl.error = ''; paint();
        if (!pl.started && !done()) { pl.started = true; report('start'); }
    });
    video.addEventListener('pause', () => { pl.playing = false; paint(); });
    video.addEventListener('ended', () => {
        pl.playing = false;
        if (!video.seeking && (video.duration || v.seconds) - last < 1.5) pl.max = video.duration || v.seconds;
        if (!done() && pl.max >= (video.duration || v.seconds) - 2.5) report('done');
        if (document.fullscreenElement === frame) document.exitFullscreen?.().catch(() => {});
        paint();
    });

    async function report(event) {
        if (!sb || !ME) return;
        try {
            const r = await api('/api/welcome', { video: { id: v.id, event } });
            if (r.done) { DONE.add(v.id); local.set(key, 0); }
        } catch (err) {
            pl.error = err.message;
            if (event === 'done') { pl.max = 0; local.set(key, 0); pl.started = false; }
        }
        paint(); paintChecklist(); updateEnter();
    }

    const toggle = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
    pl.toggle = toggle;
    q('.tv-big').addEventListener('click', toggle);
    q('.tv-pp').addEventListener('click', toggle);
    video.addEventListener('click', toggle);
    q('.tv-mute').addEventListener('click', () => { video.muted = !video.muted; paint(); });
    q('.tv-fs').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        else frame.requestFullscreen?.().catch(() => {});
    });
    // The bar: going back is fine; forward only as far as already watched.
    q('.tv-bar').addEventListener('click', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const want = ((e.clientX - r.left) / r.width) * (video.duration || v.seconds);
        video.currentTime = Math.max(0, Math.min(want, done() ? Infinity : pl.max));
    });

    function paintTime() {
        const d = video.duration || v.seconds;
        q('.tv-time').textContent = `${fmt(video.currentTime)} / ${fmt(d)}`;
        q('.tv-now').style.width = `${Math.min(100, (video.currentTime / d) * 100)}%`;
        q('.tv-seen').style.width = `${(done() ? 1 : Math.min(1, pl.max / d)) * 100}%`;
    }
    function paint() {
        fig.classList.toggle('playing', pl.playing);
        fig.classList.toggle('done', done());
        fig.classList.toggle('bad', Boolean(pl.error) && !done());
        q('.tv-big').setAttribute('aria-label', t('Play'));
        q('.tv-pp').textContent = pl.playing ? '❚❚' : '▶';
        q('.tv-pp').setAttribute('aria-label', pl.playing ? t('Pause') : t('Play'));
        q('.tv-mute').textContent = video.muted ? '🔇' : '🔊';
        q('.tv-mute').setAttribute('aria-label', video.muted ? t('Sound on') : t('Mute'));
        q('.tv-fs').setAttribute('aria-label', t('Full screen'));
        q('.tv-title').textContent = `${t('Video')} · ${videoTitle(v.id)} · ${fmt(v.seconds)}`;
        q('.tv-state').textContent = pl.error && !done() ? tx(pl.error)
            : done() ? `✓ ${t('Watched')}` : REQUIRED.includes(v.id) ? t('Watch to the end to continue') : t('No skipping ahead');
        paintTime();
    }
    pl.paint = paint;
    paint();
    tvSeen.observe(fig);
    return pl;
}
EXHIBITS.forEach((x, i) => {
    if (!x.video) return;
    players.set(x.video, makePlayer(VIDEOS.find((v) => v.id === x.video), document.querySelector(`#p${i + 1} .tv-slot`)));
});

// The players turn softly with their exhibit (less while playing, so the video stays easy to watch).
function tiltPlayers(time) {
    players.forEach((pl) => {
        if (REDUCED || world) { pl.frame.style.transform = ''; return; }   // with the 3D scene the board turns instead
        const st = world?.stands[pl.stand];
        const rot = st ? st.pivot.rotation.y : Math.sin(time * 0.35 + pl.stand) * 0.9;
        const bob = st ? st.pivot.position.y : Math.sin(time * 0.9 + pl.stand) * 0.5;
        const amp = pl.playing ? 3 : 9;
        pl.frame.style.transform = `perspective(1100px) rotateY(${(Math.sin(rot) * amp).toFixed(2)}deg) rotateX(${(bob * 2.2).toFixed(2)}deg)`;
    });
}

// Which videos are still to watch, on the pledge page.
function paintChecklist() {
    const box = $('tv-checklist');
    if (!REQUIRED.length) { box.hidden = true; return; }
    box.hidden = false;
    const left = missingVideos();
    box.innerHTML = `<p class="tv-check-head">${esc(t('Training videos watched: {n} of {m}', { n: REQUIRED.length - left.length, m: REQUIRED.length }))}</p>`
        + (left.length
            ? `<p>${esc(t('Watch each one to the end before your pledges:'))}</p><ul>${left.map((id) => {
                const v = VIDEOS.find((x) => x.id === id);
                return `<li><a href="#p${v.exhibit + 1}">▶ ${esc(videoTitle(id))}</a></li>`;
            }).join('')}</ul>`
            : `<p>✓ ${esc(t('All watched. Thank you!'))}</p>`);
}

if (ADMIN) {
    say($('hero-eyebrow'), 'Echo Market · Admin training');
    say($('hero-lead'), "You help run the market. Your training is the sellers' welcome plus the admin wing: twelve exhibits, eight short videos and three pledges.");
    say($('index-title'), 'Twelve things every admin knows');
    say($('finale-lead'), "You're cleared to sell and to run the market. Three promises, then the desk is yours.");
}
if (REPLAY) setReplay();
paintChecklist();
updateEnter();

// Language last: paintLanguage uses the state above.
onLangChange(paintLanguage);
setLang(savedLang(), PACKS, false).catch(() => {});
