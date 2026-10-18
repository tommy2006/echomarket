// Sellers' welcome (welcome.html): "A new era begins". Every seller walks through it once before taking orders.
// A night hangar showroom drawn with Three.js (no image files): eight exhibits on spotlit stands that you can drag
// to turn and open for a close-up, one alliance division colour per page, jet-exhaust transitions.
// The layout borrows the feel of ThreeUI's free Kibori page; all code here is our own.
// Finishing it: POST /api/welcome { pledges: { check, serve } } (records sellers.welcome_done_at).
import * as THREE from '../vendor/three-0.160.1/three.module.min.js';

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

// The nine alliance division colours: the opening, then one per exhibit.
const COLOURS = ['#7d34ff', '#d3ff4a', '#e76fff', '#82fdff', '#ff7b3e', '#5eff94', '#7f9ff2', '#eba09d', '#fdecd8'];

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

// ------------------------------------------------------------------ the eight exhibits (cards + close-ups)
const EXHIBITS = [
    {
        kind: 'Prop · Order ticket', title: 'Taking an order', short: 'Selling as, alliance, list value',
        lines: [
            'Pick the airline you sell as (<b>Selling as</b>, top right). Buyers see it on their order.',
            'Prefer orders from your own alliance: your matching airline is offered first.',
            'The amber <b>list value</b> is your estimated cost of buying those aircraft new.'
        ],
        detail: [
            ['Where', 'The <b>Open queue</b> lists orders waiting for a seller, the longest-waiting first. Press <b>Take order</b> and choose the airline you deliver from.'],
            ['Your airline', 'You need an airline profile on the market site (same Discord login). The buyer sees it on their order and searches for it in-game.'],
            ['The cost', 'List value = the in-game price of each aircraft new × the quantity: roughly what you pay before reselling at the buyer\'s level.'],
            ["Can't do it?", 'Pass on it with a reason. It stays open for the other sellers; the buyer is only told once every seller has passed.']
        ]
    },
    {
        kind: 'Aircraft · A320neo', title: 'Buy new, list in public', short: 'Exact model, exact quantity, your airline',
        lines: [
            'Buy the aircraft <b>new</b> in-game.',
            'List them on the <b>public</b> in-game market under <b>your airline</b>, at the buyer\'s price level.',
            'Exact model, exact quantity: nothing more, nothing less.'
        ],
        detail: [
            ['Why it matters', 'The in-game market is public: anyone browsing can see your listings. That is why buyers buy straight away, and why you check who bought (exhibit 04).'],
            ['Price level', 'Each order line shows its level, e.g. 70% of the list price. List every aircraft at that level.'],
            ['Several types', 'List each aircraft type for its own count, so the buyer can match it to their order.'],
            ['Spare planes', 'Never mix spares into someone\'s order. Free-for-all sales are announced in #ffa-listings.']
        ]
    },
    {
        kind: 'Prop · Departures board', title: 'Update progress straight away', short: 'Per type, the moment you list',
        lines: [
            'As soon as you list, record what you listed, per aircraft type.',
            'The buyer gets a DM and sees which airline listed what.',
            'The order completes when everything is listed.'
        ],
        detail: [
            ['How', 'My orders → <b>Update progress</b> → the number you listed for each type. Add a note the buyer can see if it helps (e.g. where it is listed).'],
            ['Why fast', 'Buyers search after your update. The sooner they buy, the less time anyone else has to take the planes.'],
            ['Several sellers', 'Each seller records only what they listed themselves; the buyer sees the split per airline.']
        ]
    },
    {
        key: true,
        kind: 'Prop · Sold listing + magnifier', title: 'Check who bought, before you claim the money', short: 'The key habit',
        lines: [
            'Every sold listing in-game shows the <b>buyer\'s airline</b>.',
            'Before claiming the money, check it is an airline on the order.',
            'Wrong buyer? Note their airline and keep it. <b>Don\'t act yet.</b>',
            'When the buyer reports missing planes, you already know the culprit.'
        ],
        detail: [
            ['Every sale', 'Open your sold listings. Compare each buyer\'s airline with the order\'s airline(s), shown on the order on the desk. Only then claim the sale money.'],
            ['Wrong buyer', 'Write down their airline (and Discord name if you know it) and which order it was. Don\'t chase them yet: you serve many orders and run FFA events, so the buyer\'s missing-plane report is what confirms a theft.'],
            ['When the report comes', 'You get a DM. Open the order and confirm the theft with the culprit\'s Discord ID (exhibit 06): they are warned automatically.'],
            ['Why it matters', 'This one check is how thieves get caught. Without it, a theft can\'t be traced back to anyone.']
        ]
    },
    {
        kind: 'Aircraft · 737 MAX + E-Jet', title: 'Take-over and passing on', short: '12 hours, shares, releasing',
        lines: [
            'Taken but not finished after <b>12 hours</b>? Another seller can take it over.',
            'The buyer sees how many each airline listed, and buys that many from each.',
            'Can\'t finish? Pass on the rest, or release it to the queue.'
        ],
        detail: [
            ['Taking over', '<b>Take over</b> appears on orders taken more than 12 hours ago and not complete. Up to three sellers can join; the original seller stays on it.'],
            ['Your share', 'Update progress records what you listed. The buyer is shown each airline\'s share so they buy the right amount from each.'],
            ['Passing on', 'Release an order you can\'t finish: what you listed stays counted, the rest goes back to the queue (or to the seller who joined).'],
            ['Declining', 'Pass on an open order with a reason. Admins can decline it for everyone.']
        ]
    },
    {
        kind: 'Prop · Shield', title: 'Theft reports', short: 'Confirm, warn every culprit, clear',
        lines: [
            'A buyer reports missing planes: the sellers on the order and the admins get a DM.',
            'Check in-game, then confirm the theft with every culprit\'s Discord ID, or <b>Under investigation</b>.',
            'Any seller can warn culprits later from <b>Theft reports</b> on the front page.'
        ],
        detail: [
            ['Confirm', '<b>Theft confirmed</b> → I know who: add one or more Discord IDs (right-click the user → Copy User ID). Each gets an automatic warning: DM, moderation log, disciplinary record. The buyer never learns who.'],
            ['Not sure yet', 'Choose <b>Under investigation</b>. Found them later? <b>Identify & warn culprits</b>. Never found? Close the investigation.'],
            ['Not a theft', 'Tell the buyer what you found, e.g. the planes are still listed.'],
            ['Clear theft', 'Once the culprits re-listed the planes for the buyer (checked in-game), clear it: the buyer is told to buy them.']
        ]
    },
    {
        kind: 'Prop · Warning beacon', title: 'Caution and the alert list', short: 'Badges, records, flags',
        lines: [
            'A <b>caution</b> badge marks orders from buyers on the alert list: deliver with extra care.',
            'Every order shows the buyer\'s disciplinary record in one line.',
            'Flag suspicious or blacklisted orders for the other sellers.'
        ],
        detail: [
            ['Alert list', 'Admins add buyers to it. Their orders carry a caution badge and banner; admins also see why.'],
            ['Record', '"Buyer has N warnings on record", with <b>Show details</b> for the warnings and bans.'],
            ['Flags', 'Seller-only: buyers never see them. Use them to warn the team about an order.']
        ]
    },
    {
        kind: 'Aircraft · A350', title: 'Your desk', short: 'Queues, filters, messages',
        lines: [
            'Open queue, My orders, All orders, and Theft reports on the front page.',
            'Sort and filter by price, alliance, types, aircraft count, list value, or orders you delivered on.',
            'Tap <b>💬 new buyer messages</b> in the greeting to see those orders.'
        ],
        detail: [
            ['Messages', 'Buyers can write once an order has waited 24 hours. Answer from the order; keep it short (no full conversations in tickets).'],
            ['Paging', 'Every list shows the latest 5 first, then 10 / 25 / 50 / All.'],
            ['Next', 'A short tour of the desk follows this welcome. You can replay both from the account menu.']
        ]
    }
];

// Build the exhibit pages and the index from EXHIBITS.
$('exhibits').outerHTML = EXHIBITS.map((x, i) => `
    <section class="page${x.key ? ' key' : ''}" id="p${i + 1}" data-page="${i + 1}">
        <div class="card">
            ${x.key ? '<p class="key-badge">The key habit</p>' : ''}
            <p class="num">${String(i + 1).padStart(2, '0')} / 08</p>
            <p class="kind">${esc(x.kind)}</p>
            <h2>${esc(x.title)}</h2>
            <ul class="lines">${x.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
            <div class="row"><button type="button" class="ghost" data-open="${i}">Open the close-up</button><span class="hint"><span class="hint-mouse">Drag the exhibit to turn it</span><span class="hint-touch">Swipe the exhibit sideways to turn it</span></span></div>
        </div>
    </section>`).join('');
$('index-list').innerHTML = EXHIBITS.map((x, i) => `<li><a href="#p${i + 1}"><span class="n">${String(i + 1).padStart(2, '0')}</span>
    <span class="t">${esc(x.title)}</span><span class="s">${esc(x.short)}</span></a></li>`).join('');

const PAGES = [...document.querySelectorAll('.page')];   // hero, index, 8 exhibits, pledge
const LAST = PAGES.length - 1;
// Which view and colour each page uses: 0 = opening, 1–8 = exhibit stands, 9 = finale.
const VIEW_OF = PAGES.map((p) => (p.id === 'p0' || p.id === 'index' ? 0 : p.id === 'pledge' ? 9 : Number(p.dataset.page)));
const colourOfView = (v) => COLOURS[Math.min(v, 8)];

// ------------------------------------------------------------------ who is this?
let gated = true;
(async () => {
    if (!sb) return;
    const { data } = await sb.auth.getSession();
    if (!data?.session) { window.location.replace('/'); return; }   // sign in on the seller desk first
    const { data: row } = await sb.from('sellers').select('*').eq('user_id', data.session.user.id).maybeSingle();
    if (!row || row.active === false) { window.location.replace('/'); return; }
    if (!('welcome_done_at' in row) || row.welcome_done_at) setReplay();
})();
function setReplay() {
    gated = false;
    $('replay-note').hidden = false;
    $('nav-exit').hidden = false;
    $('enter').disabled = false;
    $('enter').textContent = 'Back to the desk';
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
const DISPLAY = '"Orbitron", "Exo 2", sans-serif', BODY = '"Exo 2", sans-serif';

function ticketTexture(colour) {
    return canvasTexture(1024, 540, (g, w, h) => {
        g.fillStyle = '#f2efe6'; g.fillRect(0, 0, w, h);
        g.fillStyle = colour; g.fillRect(0, 0, w, 86);
        g.fillStyle = '#0b0d14'; g.font = `700 44px ${DISPLAY}`; g.fillText('ORDER #142', 40, 60);
        g.font = `500 26px ${DISPLAY}`; g.textAlign = 'right'; g.fillText('ECHO MARKET', w - 40, 56); g.textAlign = 'left';
        g.fillStyle = '#1b1e29'; g.font = `600 46px ${BODY}`; g.fillText('6× Airbus A320neo', 40, 170);
        g.font = `400 32px ${BODY}`; g.fillStyle = '#444a5c';
        g.fillText('Price level 70% · buyer airline FORZA (Proxima)', 40, 222);
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

function buildExhibit(i, colour) {
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
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
    const beams = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 1.2, 150), truss, 26);
    const diag = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 14, 0.6), truss, 52);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    for (let k = 0; k < 26; k++) {
        const x = -110 + k * 21;
        beams.setMatrixAt(k, m4.compose(new THREE.Vector3(x, 72, 0), q, one));
        for (const s of [0, 1]) diag.setMatrixAt(k * 2 + s, m4.compose(new THREE.Vector3(x, 65, s ? 30 : -30), q.setFromEuler(new THREE.Euler(s ? 0.5 : -0.5, 0, 0)), one));
        q.identity();
    }
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(560, 1.4, 1.4), truss); ridge.position.set(150, 74, 0);
    scene.add(beams, diag, ridge);
    // ceiling lamps (dim, the stands' spotlights do the work)
    const lampPts = [];
    for (let k = 0; k < 13; k++) lampPts.push(-100 + k * 42, 70, 0);
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
    back.position.set(225, 45, -70); back.scale.x = 390 / 540;   // the wall right of the door opening
    const backL = new THREE.Mesh(new THREE.PlaneGeometry(70, 90), wallMat); backL.position.set(-85, 45, -70); scene.add(backL);
    const lintel = new THREE.Mesh(new THREE.PlaneGeometry(80, 30), wallMat); lintel.position.set(-10, 75, -70); scene.add(lintel);
    const stars = [];
    for (let k = 0; k < 700; k++) stars.push(-130 + Math.random() * 240, 40 + Math.random() * 60, -125);
    const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, map: glow, color: 0xdfe4ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
    const apron = [];   // runway lights far outside
    for (let k = 0; k < 30; k++) apron.push(-110 + k * 7.5, 1.5, -112), apron.push(-110 + k * 7.5, 1.5, -100);
    const apronGeo = new THREE.BufferGeometry(); apronGeo.setAttribute('position', new THREE.Float32BufferAttribute(apron, 3));
    const apronMat = new THREE.PointsMaterial({ size: 5, map: glow, color: new THREE.Color(COLOURS[0]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    scene.add(new THREE.Points(apronGeo, apronMat));
    const parked = makeJet('#7d34ff', { length: 28 }); parked.scale.setScalar(0.55); parked.position.set(-16, 3, -90); parked.rotation.y = Math.PI / 2; scene.add(parked);
    setLoad(40);

    // the eight stands: plinth, coloured rim, spotlight with a visible cone, the exhibit
    const stands = [];
    const plinthMat = new THREE.MeshStandardMaterial({ color: 0x10131d, metalness: 0.6, roughness: 0.35 });
    for (let i = 0; i < 8; i++) {
        const colour = COLOURS[i + 1];
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
        // Flat exhibits (ticket, board, sold listing) sway and spring back so they stay readable; the rest turn.
        stands.push({ x, pivot, exhibit, spot, cone, rimMat, pool, rimLight, spin: 0, vel: 0, flat: [0, 2, 3].includes(i) });
        setLoad(40 + (i + 1) * 6);
    }
    setLoad(92);
    return { renderer, scene, camera, stands, doors: [doorL, doorR], apronMat, parked };
}

let world = null;

// Camera views: 0 = the opening (facing the doors), 1–8 = each stand, 9 = the finale (all stands, wide).
function viewFor(v, out = {}) {
    if (v === 0) return { pos: new THREE.Vector3(-10, 16, 58), look: new THREE.Vector3(-10, 22, -70) };
    if (v === 9) return { pos: new THREE.Vector3(STAND_X(3.2), 85, 250), look: new THREE.Vector3(STAND_X(4.6), 6, -10) };
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
    $('nav-step').textContent = v >= 1 && v <= 8 ? `${String(v).padStart(2, '0')} / 08` : v === 9 ? 'PLEDGE' : '00 / 08';
    const id = PAGES[idx].id;
    document.querySelectorAll('.nav-links a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${id}`));
    exhaustOn(v);
}
window.addEventListener('scroll', readScroll, { passive: true });
window.addEventListener('resize', () => { readScroll(); resize(); });

// Jet-exhaust wipe in the new page's colour when the colour changes.
let lastColourView = 0;
function exhaustOn(v) {
    const cv = Math.min(v, 8);
    if (cv === lastColourView || REDUCED) { lastColourView = cv; return; }
    lastColourView = cv;
    const ex = $('exhaust');
    ex.style.setProperty('--accent', COLOURS[cv]);
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
const tmpA = new THREE.Color(), tmpB = new THREE.Color();
let lastCss = '';
function applyAccent(f) {
    const i = Math.floor(f), t = f - i;
    tmpA.set(colourOfView(VIEW_OF[i])); tmpB.set(colourOfView(VIEW_OF[Math.min(i + 1, LAST)]));
    const c = tmpA.lerp(tmpB, t);
    if (world) world.apronMat.color.copy(c);
    const hex = '#' + c.getHexString(THREE.SRGBColorSpace);
    if (hex === lastCss) return;
    lastCss = hex;
    const root = document.documentElement.style;
    root.setProperty('--accent', hex);
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;   // linear colours: relative luminance
    root.setProperty('--accent-ink', lum > 0.2 ? '#070910' : '#ffffff');
}

// ------------------------------------------------------------------ "A NEW ERA BEGINS"
function burst() {
    if (REDUCED) return;
    const b = $('burst'), sparks = b.querySelector('.burst-sparks');
    sparks.innerHTML = Array.from({ length: 36 }, (_, k) => {
        const a = (k / 36) * 360 + Math.random() * 8;
        return `<i class="spark" style="--a:${a}deg;--r:${30 + Math.random() * 26}vmax;--c:${COLOURS[k % 9]};--d:${(Math.random() * 0.18).toFixed(2)}s"></i>`;
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
    return v >= 1 && v <= 8 ? v - 1 : -1;
}
function onDown(e) {
    const s = closeUp >= 0 ? closeUp : currentStand();
    if (s < 0 || !world) return;
    drag = { s, x: e.clientX, id: e.pointerId };
    world.renderer.domElement.classList.add('dragging');
    world.renderer.domElement.setPointerCapture?.(e.pointerId);
}
function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x; drag.x = e.clientX;
    const st = world.stands[drag.s];
    st.spin += dx * 0.012; st.vel = dx * 0.012;
}
function onUp() { drag = null; world?.renderer.domElement.classList.remove('dragging'); }

function openDetail(i) {
    const x = EXHIBITS[i];
    $('detail-kind').textContent = `${String(i + 1).padStart(2, '0')} / 08 · ${x.kind}`;
    $('detail-title').textContent = x.title;
    $('detail-body').innerHTML = x.detail.map(([h, p]) => `<h3>${esc(h)}</h3><p>${p}</p>`).join('');
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
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), goalPos = new THREE.Vector3(), goalLook = new THREE.Vector3();
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
    const time = now / 1000;
    if (REDUCED) shown = Math.round(target); else shown += (target - shown) * (firstFrame ? 1 : 0.07);
    applyAccent(shown);
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
    firstFrame = false;

    // the doors slide open once the hangar is lit
    if (doorsT < 1 && loaded) doorsT = Math.min(1, doorsT + 0.006);
    const d = 1 - Math.pow(1 - doorsT, 3);
    doors[0].position.x = -30 - d * 38; doors[1].position.x = 10 + d * 38;

    // exhibits: slow showroom turn, drag with inertia, a gentle float; the finale and bursts light everything up
    flare = Math.max(0, flare - 0.012);
    const finale = VIEW_OF[Math.round(shown)] === 9 ? 1 : 0;
    stands.forEach((st, k) => {
        const held = drag && drag.s === k;
        if (!REDUCED && !held) {
            st.vel *= 0.94; st.spin += st.vel;
            if (st.flat) st.spin *= 0.985; else st.spin += 0.0035;
        }
        st.pivot.rotation.y = st.spin + (st.flat && !REDUCED ? Math.sin(time * 0.5 + k) * 0.32 : 0);
        st.pivot.position.y = REDUCED ? 0 : Math.sin(time * 0.9 + k) * 0.5;
        const boost = 1 + flare * 1.6 + finale * 0.5;
        st.spot.intensity = (k === 7 ? 5200 : 3600) * boost;
        st.cone.material.opacity = (k === 7 ? 0.07 : 0.045) * (1 + flare * 2.5 + finale);
        st.pool.material.opacity = 0.22 * (1 + flare + finale * 0.6);
        const ex = st.exhibit.userData;
        if (ex.glass && !REDUCED) ex.glass.position.set(Math.sin(time * 0.8) * 3.8, Math.cos(time * 1.1) * 2.2 + 0.4, 2.4);
        if (ex.spin && !REDUCED) ex.spin.rotation.y = time * 3;
        if (ex.bulb) ex.bulb.intensity = REDUCED ? 60 : 50 + Math.sin(time * 6) * 20;
    });
    renderer.render(scene, camera);
}

// ------------------------------------------------------------------ loader
let loaded = false;
(async function load() {
    // Wait for the fonts (the canvas textures use them), at most a few seconds.
    await Promise.race([
        Promise.all([document.fonts?.load?.(`700 40px Orbitron`), document.fonts?.load?.(`500 40px "Exo 2"`), document.fonts?.ready].filter(Boolean)).catch(() => {}),
        new Promise((r) => setTimeout(r, 3500))
    ]);
    setLoad(10);
    try { world = buildWorld(); } catch (err) { console.warn('3D scene unavailable:', err); }
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
    requestAnimationFrame(frame);
    setTimeout(() => {
        $('loader').classList.add('done');
        loaded = true;
        if (window.scrollY < window.innerHeight * 0.5) burst();   // the opening "A NEW ERA BEGINS"
    }, REDUCED ? 0 : 250);
})();

// ------------------------------------------------------------------ the pledges
const pledgesTicked = () => $('pledge-check').checked && $('pledge-serve').checked;
const updateEnter = () => { if (gated) $('enter').disabled = !pledgesTicked(); };
$('pledge-check').addEventListener('change', updateEnter);
$('pledge-serve').addEventListener('change', updateEnter);
$('nav-exit').addEventListener('click', (e) => { e.preventDefault(); leave(); });
$('enter').addEventListener('click', async () => {
    const button = $('enter'), out = $('enter-msg');
    out.classList.remove('bad');
    if (gated) {
        if (!pledgesTicked()) return;
        button.disabled = true;
        out.textContent = 'Opening your desk…';
        try {
            await api('/api/welcome', { pledges: { check: true, serve: true } });
        } catch (err) {
            out.textContent = err.message; out.classList.add('bad'); button.disabled = false;
            return;
        }
        out.textContent = 'Welcome to the new era.';
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
