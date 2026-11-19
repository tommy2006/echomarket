// The vacation screen's scenery (seller/js/seller.js → VacationScreen): a dark, unlit island under a night sky,
// mirrored in still water; below it a long dive into deep, clear sea that gets darker with every scroll, with
// glowing fish, jellyfish and plankton drifting past; and at the bottom a sandy seabed with pebbles, softly
// swaying glowing corals and a small cave, where the quiet "come back early" button hides.
// Pure scenery: no data, no texts of its own. Animations live in styles/seller.css (vac-*), and stop for people
// who ask for less motion.
import { html } from './ui.js';

const rnd = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const r1 = (n) => Math.round(n * 10) / 10;

// ---------- Silhouettes (viewBox 1440 × 900, horizon at y 560)
const HORIZON = 560;
// A spruce: jagged tiers widening towards the ground.
function spruce(x, base, h, w, seed) {
    const n = Math.max(5, Math.round(h / 20));
    const right = [], left = [];
    for (let i = 1; i <= n; i++) {
        const y = base - h + (h * 0.93 * i) / n;
        const hw = (w / 2) * (0.18 + (0.82 * i) / n) * (0.82 + 0.36 * rnd(seed * 31 + i));
        const inner = hw * (0.38 + 0.15 * rnd(seed * 17 + i));
        const dip = (h / n) * 0.42;
        right.push(`${r1(x + hw)},${r1(y)}`, `${r1(x + inner)},${r1(y + dip * 0.35)}`);
        left.unshift(`${r1(x - inner)},${r1(y + dip * 0.35)}`, `${r1(x - hw * (0.9 + 0.2 * rnd(seed * 7 + i)))},${r1(y)}`);
    }
    const t = Math.max(1.5, w * 0.04);
    return `M${x},${base - h} L${right.join(' L')} L${r1(x + t)},${base + 2} L${r1(x - t)},${base + 2} L${left.join(' L')} Z`;
}
// A low, bumpy tree line along the horizon.
function treeLine(x0, x1, base, hMin, hMax, seed) {
    const pts = [`M${x0},${base + 2}`];
    for (let x = x0, i = 0; x <= x1; x += 9, i++) pts.push(`L${x},${r1(base - hMin - (hMax - hMin) * rnd(seed + i * 3.7))}`);
    pts.push(`L${x1},${base + 2} Z`);
    return pts.join(' ');
}
const SPRUCES = [
    // left forest: tall at the edge, falling towards the water
    [-10, 600, 360, 120], [40, 590, 300, 100], [95, 585, 250, 90], [150, 575, 205, 80], [205, 570, 160, 66], [250, 566, 128, 56],
    [292, 564, 104, 46], [330, 562, 84, 40], [364, 561, 68, 34], [395, 560, 52, 28],
    // the island
    [600, 556, 112, 50], [640, 554, 158, 62], [676, 552, 186, 70], [712, 551, 200, 72], [748, 552, 178, 66], [784, 553, 192, 70],
    [818, 555, 156, 60], [850, 556, 122, 50], [878, 558, 92, 40],
    // right shore, rising towards the edge
    [1010, 560, 58, 30], [1048, 560, 74, 36], [1085, 559, 96, 42], [1124, 558, 118, 50], [1166, 557, 140, 56], [1212, 556, 166, 64],
    [1258, 556, 150, 60], [1400, 590, 250, 96], [1452, 600, 300, 110]
].map(([x, b, h, w], i) => spruce(x, b, h, w, i + 1));
const BLOBS = [   // round-topped trees: [cx, cy, r]
    [0, 300, 70], [-20, 380, 90], [60, 360, 60], [1330, 330, 66], [1300, 380, 58], [1365, 300, 60], [1352, 390, 70], [1290, 440, 46]
];
const STARS = Array.from({ length: 46 }, (_, i) => ({ x: r1(rnd(i + 1) * 1440), y: r1(rnd(i + 101) * 470), s: r1(0.5 + rnd(i + 201) * 1.1), tw: rnd(i + 301) > 0.55, d: (rnd(i + 401) * 5).toFixed(2) }));

function NightIsland() {
    return html`<svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 w-full h-full" aria-hidden="true">
        <defs>
            <linearGradient id="vn-sky" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#020512" /><stop offset="0.35" stopColor="#06103a" /><stop offset="0.75" stopColor="#13296b" /><stop offset="1" stopColor="#24478f" />
            </linearGradient>
            <linearGradient id="vn-water" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#1f3f86" /><stop offset="0.35" stopColor="#13285e" /><stop offset="1" stopColor="#081633" />
            </linearGradient>
            <radialGradient id="vn-glow" cx="0.5" cy="1" r="0.6"><stop offset="0" stopColor="#3d68c2" stopOpacity="0.45" /><stop offset="1" stopColor="#3d68c2" stopOpacity="0" /></radialGradient>
            <linearGradient id="vn-fade" x1="0" y1="${HORIZON}" x2="0" y2="900" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="#fff" stopOpacity="0.75" /><stop offset="1" stopColor="#fff" stopOpacity="0.05" />
            </linearGradient>
            <mask id="vn-mask" maskUnits="userSpaceOnUse" x="0" y="${HORIZON}" width="1440" height="${900 - HORIZON}"><rect x="0" y="${HORIZON}" width="1440" height="${900 - HORIZON}" fill="url(#vn-fade)" /></mask>
            <filter id="vn-soft" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="1.6" /></filter>
            <radialGradient id="vn-lamp"><stop offset="0" stopColor="#fff7d6" /><stop offset="0.25" stopColor="#ffe9a8" stopOpacity="0.55" /><stop offset="1" stopColor="#ffe9a8" stopOpacity="0" /></radialGradient>
            <g id="vn-land" fill="#02040b">
                <path d=${treeLine(380, 1440, HORIZON, 4, 14, 5)} />
                <path d="M560 ${HORIZON + 1} C 600 540, 860 538, 905 ${HORIZON + 1} Z" />
                ${SPRUCES.map((d, i) => html`<path key=${i} d=${d} />`)}
                ${BLOBS.map(([cx, cy, r], i) => html`<circle key=${'b' + i} cx=${cx} cy=${cy} r=${r} />`)}
                <rect x="-40" y="380" width="120" height=${HORIZON - 378} />
                <rect x="1290" y="380" width="190" height=${HORIZON - 378} />
            </g>
        </defs>
        <rect width="1440" height=${HORIZON} fill="url(#vn-sky)" />
        <ellipse cx="760" cy=${HORIZON} rx="720" ry="170" fill="url(#vn-glow)" />
        ${STARS.map((s, i) => html`<circle key=${i} cx=${s.x} cy=${s.y} r=${s.s} fill="#e8eeff" className=${s.tw ? 'vac-twinkle' : ''} style=${{ animationDelay: s.d + 's', opacity: s.tw ? undefined : 0.7 }} />`)}
        <rect y=${HORIZON} width="1440" height=${900 - HORIZON} fill="url(#vn-water)" />
        <g mask="url(#vn-mask)" filter="url(#vn-soft)"><use href="#vn-land" transform=${`matrix(1 0 0 -1 0 ${HORIZON * 2})`} /></g>
        <use href="#vn-land" />
        ${[[600, 0.22, 520], [640, 0.16, 760], [700, 0.12, 380], [770, 0.1, 980], [840, 0.08, 620]].map(([y, o, x], i) =>
            html`<rect key=${i} x=${x} y=${y} width=${180 + i * 40} height="1.2" rx="0.6" fill="#9db8f0" opacity=${o} className="vac-shimmer" style=${{ animationDelay: `${i * 1.3}s` }} />`)}
        <circle cx="452" cy=${HORIZON - 3} r="16" fill="url(#vn-lamp)" />
        <circle cx="452" cy=${HORIZON - 3} r="1.6" fill="#fffbe8" />
        <rect x="451" y=${HORIZON + 2} width="2" height="46" fill="#ffe9a8" opacity="0.28" className="vac-shimmer" />
    </svg>`;
}

// ---------- Sea creatures (each a small SVG; colours are their glow)
function Fish({ glow = '#7dd3fc', size = 70 }) {
    return html`<svg viewBox="0 0 100 40" width=${size} height=${size * 0.4} className="vac-glow" style=${{ '--glow': glow }}>
        <path d="M10 20 L0 8 L3 20 L0 32 Z" fill="#0b1830" />
        <path d="M8 20 C 25 4, 62 2, 88 18 C 92 20, 92 21, 88 23 C 62 38, 25 36, 8 20 Z" fill="#0b1830" stroke=${glow} strokeOpacity="0.35" strokeWidth="0.8" />
        ${[22, 30, 38, 46, 54, 62, 70].map((x) => html`<circle key=${x} cx=${x} cy=${27 - (x - 46) * (x - 46) * 0.002} r="1.3" fill=${glow} />`)}
        <circle cx="78" cy="17" r="2" fill=${glow} />
    </svg>`;
}
function School({ glow, n = 5 }) {
    return html`<div className="relative" style=${{ width: 220, height: 90 }}>
        ${Array.from({ length: n }, (_, i) => html`<div key=${i} className="absolute vac-bob" style=${{ left: (i * 41) % 170, top: (i * 29) % 70, animationDelay: `${-i * 0.7}s` }}><${Fish} glow=${glow} size=${34 + (i % 3) * 6} /></div>`)}
    </div>`;
}
function Jelly({ glow = '#f0abfc', size = 70, id }) {
    return html`<svg viewBox="0 0 60 110" width=${size} height=${size * 1.83} className="vac-glow" style=${{ '--glow': glow }}>
        <defs><radialGradient id=${'vj' + id} cx="0.5" cy="0.35" r="0.65"><stop offset="0" stopColor=${glow} stopOpacity="0.85" /><stop offset="1" stopColor=${glow} stopOpacity="0.12" /></radialGradient></defs>
        ${[10, 20, 30, 40, 50].map((x, i) => html`<path key=${x} d=${`M${x} 32 C ${x + 6} 50, ${x - 6} 66, ${x + 3} 82 S ${x - 2} 100, ${x + 2} 108`} fill="none" stroke=${glow} strokeOpacity=${0.45 - i * 0.03} strokeWidth="1.1" />`)}
        <path d="M4 32 C 4 6, 56 6, 56 32 C 47 37, 13 37, 4 32 Z" fill=${`url(#vj${id})`} />
        <path d="M14 24 C 18 14, 42 14, 46 24" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="1" />
    </svg>`;
}
function Angler({ size = 130 }) {
    return html`<svg viewBox="-5 -14 110 70" width=${size} height=${size * 0.64}>
        <path d="M14 30 L0 18 L4 30 L0 42 Z" fill="#070d1c" />
        <path d="M12 30 C 12 10, 46 2, 68 14 C 82 22, 86 32, 80 40 C 64 54, 26 54, 12 30 Z" fill="#070d1c" stroke="#38bdf8" strokeOpacity="0.18" strokeWidth="0.8" />
        <path d="M66 38 L70 34 L73 38 L76 33 L79 37" fill="none" stroke="#cbd5e1" strokeOpacity="0.35" strokeWidth="0.8" />
        <circle cx="70" cy="22" r="2.2" fill="#a5f3fc" opacity="0.8" />
        <path d="M60 12 C 66 -6, 84 -12, 92 -2" fill="none" stroke="#1e293b" strokeWidth="1.4" />
        <circle cx="92" cy="0" r="10" fill="#fde68a" opacity="0.18" className="vac-lure" />
        <circle cx="92" cy="0" r="3.2" fill="#fef3c7" className="vac-glow" style=${{ '--glow': '#fde68a' }} />
    </svg>`;
}
function Ray({ size = 240 }) {
    return html`<svg viewBox="0 0 200 90" width=${size} height=${size * 0.45}>
        <path d="M100 18 C 120 20, 150 30, 198 58 C 160 58, 130 60, 112 70 C 106 74, 104 80, 100 88 C 96 80, 94 74, 88 70 C 70 60, 40 58, 2 58 C 50 30, 80 20, 100 18 Z" fill="#081227" opacity="0.9" />
        <path d="M100 88 L100 90" stroke="#081227" />
        ${[70, 85, 115, 130].map((x) => html`<circle key=${x} cx=${x} cy=${48 + Math.abs(x - 100) * 0.05} r="1.1" fill="#93c5fd" opacity="0.55" />`)}
    </svg>`;
}

// [what, depth (% of the dive), direction (1 = to the right), seconds per crossing, extra]
const SWIMMERS = [
    ['ray', 5, -1, 120], ['school', 15, 1, 70, '#7dd3fc'], ['fish', 27, -1, 85, '#5eead4'], ['school', 41, -1, 95, '#a5b4fc'],
    ['fish', 50, 1, 75, '#f9a8d4'], ['angler', 66, -1, 140], ['school', 77, 1, 110, '#67e8f9'], ['fish', 90, -1, 100, '#c4b5fd']
];
// [left %, depth %, colour, size, seconds]
const JELLIES = [[10, 20, '#f0abfc', 58, 11], [80, 34, '#67e8f9', 74, 14], [28, 55, '#c4b5fd', 46, 12], [70, 70, '#f9a8d4', 62, 16], [14, 84, '#5eead4', 40, 13]];
const PLANKTON = Array.from({ length: 46 }, (_, i) => ({ x: r1(rnd(i + 501) * 100), y: r1(8 + rnd(i + 601) * 90), d: r1(10 + rnd(i + 701) * 16), delay: r1(-rnd(i + 801) * 20), s: rnd(i + 901) > 0.8 ? 3 : 2 }));

function Dive({ children }) {
    return html`<section className="relative overflow-hidden" style=${{ height: '260vh', background: 'linear-gradient(#081633 0%, #06112a 18%, #040b1d 45%, #020713 72%, #01040b 100%)' }}>
        <div className="absolute inset-x-0 top-0 h-40 vac-caustics" aria-hidden="true"></div>
        <div className="absolute inset-0" aria-hidden="true">
            ${PLANKTON.map((p, i) => html`<span key=${i} className="absolute rounded-full vac-rise" style=${{ left: p.x + '%', top: p.y + '%', width: p.s, height: p.s, animationDuration: p.d + 's', animationDelay: p.delay + 's' }}></span>`)}
            ${JELLIES.map(([x, y, c, s, d], i) => html`<div key=${'j' + i} className="absolute vac-jelly" style=${{ left: x + '%', top: y + '%', animationDuration: d + 's', animationDelay: `${-i * 3}s` }}><${Jelly} glow=${c} size=${s} id=${i} /></div>`)}
            ${SWIMMERS.map(([kind, y, dir, secs, glow], i) => html`<div key=${'s' + i} className=${`absolute left-0 ${dir > 0 ? 'vac-swim-r' : 'vac-swim-l'}`} style=${{ top: y + '%', animationDuration: secs + 's', animationDelay: `${-secs * rnd(i + 1001)}s` }}>
                <div className="vac-bob" style=${{ animationDelay: `${-i}s` }}><div style=${{ transform: dir > 0 ? 'none' : 'scaleX(-1)' }}>
                    ${kind === 'ray' ? html`<${Ray} />` : kind === 'angler' ? html`<${Angler} />` : kind === 'school' ? html`<${School} glow=${glow} />` : html`<${Fish} glow=${glow} size=${80} />`}
                </div></div>
            </div>`)}
        </div>
        <div className="relative z-10">${children}</div>
    </section>`;
}

// ---------- Seabed
const PEBBLES = Array.from({ length: 95 }, (_, i) => ({ x: r1(rnd(i + 1101) * 1440), y: r1(345 + rnd(i + 1201) * 250), rx: r1(3 + rnd(i + 1301) * 11), c: ['#24221c', '#2c2a23', '#1b1a15', '#33302a'][i % 4] }));
function Coral({ kind, color, size }) {
    const glow = { '--glow': color };
    if (kind === 'fan') {
        return html`<svg viewBox="0 0 120 120" width=${size} height=${size} className="vac-glow-soft" style=${glow}>
            <ellipse cx="60" cy="118" rx="38" ry="5" fill=${color} opacity="0.18" />
            ${Array.from({ length: 13 }, (_, i) => { const a = -75 + i * 12.5; const rad = (a * Math.PI) / 180; const L = 70 + (i % 3) * 12;
                return html`<path key=${i} d=${`M60 118 Q ${60 + Math.sin(rad) * L * 0.4} ${118 - L * 0.55}, ${r1(60 + Math.sin(rad) * L)} ${r1(118 - Math.cos(rad) * L)}`} fill="none" stroke=${color} strokeOpacity="0.8" strokeWidth="1.6" strokeLinecap="round" />`; })}
        </svg>`;
    }
    if (kind === 'anemone') {
        return html`<svg viewBox="0 0 100 100" width=${size} height=${size} className="vac-glow-soft" style=${glow}>
            <ellipse cx="50" cy="97" rx="30" ry="4" fill=${color} opacity="0.2" />
            <path d="M38 98 C 38 86, 62 86, 62 98 Z" fill=${color} opacity="0.55" />
            ${[-70, -50, -32, -15, 0, 15, 32, 50, 70].map((a, i) => { const rad = (a * Math.PI) / 180; const L = 40 + ((i * 13) % 18);
                const tx = 50 + Math.sin(rad) * L, ty = 90 - Math.cos(rad) * L; const cx = 50 + Math.sin(rad) * L * 0.5 + (i % 2 ? 6 : -6), cy = 90 - Math.cos(rad) * L * 0.6;
                return html`<g key=${a}><path d=${`M50 90 Q ${r1(cx)} ${r1(cy)}, ${r1(tx)} ${r1(ty)}`} fill="none" stroke=${color} strokeOpacity="0.7" strokeWidth="3.2" strokeLinecap="round" />
                    <circle cx=${r1(tx)} cy=${r1(ty)} r="2.6" fill="#fff" opacity="0.8" /></g>`; })}
        </svg>`;
    }
    // branching coral
    return html`<svg viewBox="0 0 120 130" width=${size} height=${size * 1.08} className="vac-glow-soft" style=${glow}>
        <ellipse cx="60" cy="127" rx="34" ry="4" fill=${color} opacity="0.18" />
        <g fill="none" stroke=${color} strokeOpacity="0.85" strokeWidth="5" strokeLinecap="round">
            <path d="M60 127 C 58 100, 62 80, 58 54 M58 54 C 52 40, 44 30, 46 14 M58 54 C 66 42, 74 36, 76 20" />
            <path d="M59 96 C 46 88, 34 80, 30 60 M30 60 C 26 48, 20 42, 18 30 M30 60 C 36 50, 38 42, 36 32" />
            <path d="M60 86 C 74 80, 88 72, 92 52 M92 52 C 96 42, 102 36, 104 26 M92 52 C 86 44, 84 36, 86 28" />
        </g>
        ${[[46, 14], [76, 20], [18, 30], [36, 32], [104, 26], [86, 28]].map(([x, y]) => html`<circle key=${x} cx=${x} cy=${y} r="3.2" fill="#fff" opacity="0.75" />`)}
    </svg>`;
}
const KELP = [[90, 120], [150, 90], [420, 140], [470, 100], [980, 130], [1040, 95], [1290, 150], [1350, 110]].map(([x, h]) =>
    `M${x} 350 C ${x - 14} ${350 - h * 0.3}, ${x + 14} ${350 - h * 0.6}, ${x - 4} ${350 - h}`);
// [kind, colour, left %, size (px at desktop), sway seconds, shown on phones]
const CORALS = [['fan', '#f472b6', 6, 170, 7, true], ['branch', '#5eead4', 14, 120, 6, false], ['anemone', '#a78bfa', 25, 90, 5, true],
    ['branch', '#fbbf24', 34, 105, 8, false], ['anemone', '#22d3ee', 63, 96, 5.5, false], ['fan', '#a78bfa', 72, 170, 7.5, true],
    ['branch', '#f472b6', 84, 135, 6.5, false], ['anemone', '#2dd4bf', 93, 96, 6, true]];

function Seabed({ cave }) {
    return html`<section className="relative overflow-hidden" style=${{ height: '78vh', minHeight: 520, background: 'linear-gradient(#01040b, #010309)' }}>
        <svg viewBox="0 0 1440 600" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 w-full h-full" aria-hidden="true">
            <defs>
                <linearGradient id="vb-sand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1d1b14" /><stop offset="1" stopColor="#0c0b08" /></linearGradient>
            </defs>
            ${KELP.map((d, i) => html`<path key=${'k' + i} d=${d} fill="none" stroke="#06101a" strokeWidth=${6 + (i % 3) * 2} strokeLinecap="round" className="vac-sway" style=${{ animationDuration: `${9 + i}s`, animationDelay: `${-i * 1.7}s`, transformBox: 'fill-box' }} />`)}
            <path d="M0 330 C 60 300, 120 250, 190 262 C 240 270, 270 310, 330 318 L330 360 L0 360 Z M1440 322 C 1380 286, 1320 246, 1250 258 C 1190 268, 1160 300, 1100 312 L1100 360 L1440 360 Z" fill="#05080e" />
            <path d="M0 345 C 180 318, 360 332, 540 326 C 720 318, 860 336, 1040 328 C 1200 322, 1330 334, 1440 324 L1440 600 L0 600 Z" fill="url(#vb-sand)" />
            ${[390, 440, 495, 550].map((y, i) => html`<path key=${y} d=${`M0 ${y} C 240 ${y - 10}, 480 ${y + 8}, 720 ${y} S 1200 ${y - 8}, 1440 ${y + 4}`} fill="none" stroke="#2a271d" strokeOpacity=${0.6 - i * 0.12} strokeWidth="2" />`)}
            ${PEBBLES.map((p, i) => html`<g key=${i}><ellipse cx=${p.x} cy=${p.y} rx=${p.rx} ry=${r1(p.rx * 0.6)} fill=${p.c} /><ellipse cx=${p.x - p.rx * 0.2} cy=${p.y - p.rx * 0.25} rx=${r1(p.rx * 0.45)} ry=${r1(p.rx * 0.18)} fill="#4b4638" opacity="0.35" /></g>`)}
        </svg>
        ${CORALS.map(([kind, color, x, size, secs, phone], i) => html`<div key=${i} className=${`absolute ${phone ? '' : 'hidden md:block'}`} style=${{ left: x + '%', bottom: `${4 + (i % 3) * 2.5}%`, transform: 'translateX(-50%)' }}>
            <div className="vac-sway" style=${{ animationDuration: secs + 's', animationDelay: `${-i * 1.1}s` }}><${Coral} kind=${kind} color=${color} size=${`clamp(${Math.round(size * 0.55)}px, ${(size / 14.4).toFixed(1)}vw, ${size}px)`} /></div>
        </div>`)}
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[3%]" style=${{ width: 'clamp(230px, 26vw, 340px)' }}>
            ${[0, 1, 2].map((i) => html`<span key=${i} className="absolute rounded-full border border-sky-200/40 vac-bubble" style=${{ left: `${46 + i * 5}%`, bottom: '62%', width: 6 + i * 2, height: 6 + i * 2, animationDelay: `${-i * 2.2}s` }}></span>`)}
            <svg viewBox="0 0 340 220" className="w-full h-auto block" aria-hidden="true">
                <defs><radialGradient id="vb-cave" cx="0.5" cy="0.85" r="0.7"><stop offset="0" stopColor="#0e7490" stopOpacity="0.32" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient></defs>
                <path d="M0 220 C 4 184, 18 156, 36 132 C 50 112, 52 94, 74 78 C 96 60, 116 64, 138 48 C 164 30, 202 34, 226 52 C 246 66, 268 62, 286 86 C 304 110, 318 130, 326 158 C 334 186, 338 204, 340 220 Z" fill="#0a0d15" />
                <path d="M60 96 C 70 88, 84 84, 96 86 M150 52 C 170 44, 196 46, 214 58 M262 78 C 276 84, 288 98, 296 112" fill="none" stroke="#1d2738" strokeWidth="3" strokeLinecap="round" />
                <path d="M22 168 C 30 150, 44 140, 58 138 M300 150 C 312 160, 318 176, 320 192" fill="none" stroke="#151c29" strokeWidth="2.5" strokeLinecap="round" />
                
                <path d="M106 220 C 108 178, 118 146, 140 128 C 158 112, 188 110, 206 124 C 228 140, 240 176, 242 220 Z" fill="#010205" />
                <path d="M106 220 C 108 178, 118 146, 140 128 C 158 112, 188 110, 206 124 C 228 140, 240 176, 242 220 Z" fill="url(#vb-cave)" />
                ${[[80, 214, '#22d3ee'], [268, 216, '#f472b6']].map(([x, y, c]) => html`<g key=${x} className="vac-glow-soft" style=${{ '--glow': c }}>${[-30, -10, 10, 30].map((a) => html`<path key=${a} d=${`M${x} ${y} q ${a * 0.25} -10, ${a * 0.45} -18`} fill="none" stroke=${c} strokeWidth="2.4" strokeLinecap="round" />`)}</g>`)}
                ${[[60, 206, 9], [272, 210, 11], [300, 214, 7]].map(([x, y, r]) => html`<ellipse key=${x} cx=${x} cy=${y} rx=${r} ry=${r * 0.6} fill="#1f1d17" />`)}
            </svg>
            <div className="absolute inset-x-0 bottom-[7%] flex justify-center">${cave}</div>
        </div>
    </section>`;
}

// header: the greeting over the island; dive: the lines met on the way down; cave: the button in the cave.
export function VacationScene({ header, dive, cave }) {
    return html`<div className="vac-scene">
        <section className="relative w-full h-[100svh] min-h-[560px] overflow-hidden">
            <${NightIsland} />
            <div className="relative z-10">${header}</div>
        </section>
        <${Dive}>${dive}<//>
        <${Seabed} cave=${cave} />
    </div>`;
}
