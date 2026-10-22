// "Cleared for takeoff" welcome (welcome.html): every buyer walks through it once before ordering.
// A night airport drawn with Three.js (no image files) taxis along as you scroll, one stop per chapter.
// The layout borrows the feel of ThreeUI's free Kage page; all code here is our own.
// Finishing it: POST /api/me { action: 'welcome-done', answers, understood } (the server checks the answers too).
import { pickQuality, lowerThan, rememberQuality, pixelRatioFor, frameWatch, mixHex, inkFor, qualitySwitch } from './welcome-perf.js';
import { t, tx, setLang, savedLang, currentLang, languageMenu, translatePage, onLangChange } from './i18n.js';
// three.js is loaded only when the device shows the 3D airport (not at the 'lite' graphics level).
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

// One alliance division colour per chapter (00 to 07); the 9th is for the takeoff itself.
const COLOURS = ['#7d34ff', '#d3ff4a', '#e76fff', '#82fdff', '#ff7b3e', '#5eff94', '#7f9ff2', '#eba09d', '#fdecd8'];
const CHAPTERS = [...document.querySelectorAll('.chapter')];
const LAST = CHAPTERS.length - 1;

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

// ------------------------------------------------------------------ language
// The menu sits in the top bar. Text in welcome.html is marked data-i18n; the script's own messages go
// through say(), so they are rewritten too when the language changes. The market rules stay in English.
const PACKS = ['app', 'welcome-buyer'];
const said = new Map();   // element → [English text, values]
function say(el, text, vars) {
    said.set(el, [text, vars]);
    el.textContent = text ? (vars ? t(text, vars) : tx(text)) : '';
}
function paintLanguage() {
    translatePage();
    document.title = t('Cleared for takeoff · Echo Market');
    $('rules-note').hidden = currentLang() === 'en';
    said.forEach(([text, vars], el) => { el.textContent = text ? (vars ? t(text, vars) : tx(text)) : ''; });
}
document.querySelector('.nav').insertBefore(languageMenu(PACKS), document.querySelector('.nav-progress'));
onLangChange(paintLanguage);
setLang(savedLang(), PACKS, false).catch(() => {});

// ------------------------------------------------------------------ who is this?
// gated: true = first time, the quiz + "I understand" must be done. false = replay (or an older database).
let gated = true;
(async () => {
    if (!sb) return;
    const { data } = await sb.auth.getSession();
    if (!data?.session) { window.location.replace('/'); return; }   // sign in on the market first
    try {
        const me = await api('/api/me');
        if (me.welcomeDone !== false) setReplay();
    } catch { /* keep the gate; "Enter the market" will report any problem */ }
})();

function setReplay() {
    gated = false;
    $('replay-note').hidden = false;
    $('nav-exit').hidden = false;
    $('final').hidden = false;
    $('understand').closest('label').hidden = true;
    $('enter').disabled = false;
    say($('enter'), 'Back to the market');
}

// ------------------------------------------------------------------ helpers for the 3D world
function glowTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
}
function cloudTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
        const x = 60 + Math.random() * 136, y = 90 + Math.random() * 76, r = 30 + Math.random() * 50;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, 'rgba(255,255,255,0.5)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    return new THREE.CanvasTexture(c);
}
function textTexture(text) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(210,214,230,0.55)';
    g.font = '800 96px "Plus Jakarta Sans", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
function lightPoints(positions, material) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions.flat(), 3));
    return new THREE.Points(geo, material);
}

// A low-poly airliner, nose towards +z (Object3D.lookAt points +z at the target).
function makeJet({ parked = false } = {}) {
    const jet = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: parked ? 0x1b1f2b : 0x3a4054, metalness: 0.35, roughness: 0.55, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x10131c, metalness: 0.2, roughness: 0.8, flatShading: true });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 30, 12), skin);
    body.rotation.x = Math.PI / 2; jet.add(body);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), skin);
    nose.rotation.x = Math.PI / 2; nose.scale.set(1, 2.2, 1); nose.position.z = 15; jet.add(nose);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(2, 9, 12), skin);
    tail.rotation.x = -Math.PI / 2; tail.position.set(0, 0.6, -19.5); tail.scale.set(1, 1, 0.75); jet.add(tail);
    // swept wings
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 3); wingShape.lineTo(17, -5); wingShape.lineTo(17, -7.5); wingShape.lineTo(0, -5); wingShape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.5, bevelEnabled: false });
    for (const side of [1, -1]) {
        const w = new THREE.Mesh(wingGeo, skin);
        w.rotation.x = -Math.PI / 2; w.scale.x = side; w.position.set(0, -1, 1); jet.add(w);
        const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1, 5, 10), dark);
        eng.rotation.x = Math.PI / 2; eng.position.set(side * 6.5, -2.4, 2.5); jet.add(eng);
        const stab = new THREE.Mesh(wingGeo, skin);
        stab.rotation.x = -Math.PI / 2; stab.scale.set(side * 0.38, 0.38, 1); stab.position.set(0, 0.6, -17); jet.add(stab);
    }
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0); finShape.lineTo(-7, 0); finShape.lineTo(-9.5, 8); finShape.lineTo(-6.5, 8); finShape.closePath();
    const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: 0.4, bevelEnabled: false }), skin);
    fin.rotation.y = Math.PI / 2; fin.position.set(0.2, 1.4, -13.5); jet.add(fin);
    // window line
    const win = new THREE.Mesh(new THREE.BoxGeometry(4.1, 0.25, 22), new THREE.MeshBasicMaterial({ color: parked ? 0x2a2f3c : 0xffe7b8 }));
    win.position.set(0, 0.6, 1); jet.add(win);
    return jet;
}

// ------------------------------------------------------------------ the world
// Where the jet is on the taxi route at each chapter (fraction of the route), and the camera around it:
// [side (+ = jet's right), height, behind (+ = behind the tail)], camera units in metres.
const HOLD_AT = 0.9;   // the jet waits at the hold-short bar in chapter 06, then lines up for 07
const STOPS = [0.0, 0.16, 0.32, 0.48, 0.62, 0.76, HOLD_AT, 1.0];
const CAMS = [
    [-55, 24, -70],   // 00 at the gate, looking at the jet's nose
    [42, 16, 48],     // 01 pushing off, from behind right
    [-58, 14, 62],    // 02 on the taxiway, low left
    [60, 30, 10],     // 03 hold short: side view
    [36, 10, 68],     // 04
    [-50, 18, -40],   // 05 front left
    [34, 40, 70],     // 06 high behind
    [22, 6, 58]       // 07 lined up on runway 09, low behind
];

const loaderPct = $('loader-pct');
let loadTarget = 0;
const setLoad = (p) => { loadTarget = Math.max(loadTarget, p); };

let world = null;   // built in load() once three.js is in

function buildWorld() {
    const canvas = document.createElement('canvas');
    canvas.id = 'scene'; canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high', powerPreference: 'high-performance' });
    renderer.setPixelRatio(pixelRatioFor(quality));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060c);
    scene.fog = new THREE.FogExp2(0x070914, 0.0016);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 6000);
    setLoad(10);

    const glow = glowTexture();
    const accent = new THREE.Color(COLOURS[0]);
    const lightMat = (size, opacity = 1) => new THREE.PointsMaterial({
        size, map: glow, color: accent.clone(), transparent: true, opacity, depthWrite: false,
        blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false
    });
    const accentMats = [];

    // sky
    scene.add(new THREE.HemisphereLight(0x2a3566, 0x05060c, 1.1));
    const moon = new THREE.DirectionalLight(0x9fb2ff, 0.6); moon.position.set(-300, 400, -200); scene.add(moon);
    const stars = [];
    for (let i = 0; i < (quality === 'high' ? 1800 : 600); i++) {
        const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.46;
        const r = 2600;
        stars.push([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) + 20, r * Math.sin(ph) * Math.sin(th)]);
    }
    const starMat = new THREE.PointsMaterial({ size: 2, color: 0xc9d2ff, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 });
    scene.add(lightPoints(stars, starMat));
    setLoad(25);

    // ground, runway (09, threshold at z = 0, rolling towards -z), apron
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshStandardMaterial({ color: 0x070a12, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    const tarmac = new THREE.MeshStandardMaterial({ color: 0x12151e, roughness: 0.92 });
    const runway = new THREE.Mesh(new THREE.PlaneGeometry(46, 1600), tarmac);
    runway.rotation.x = -Math.PI / 2; runway.position.set(0, 0.05, -790); scene.add(runway);
    const paint = new THREE.MeshBasicMaterial({ color: 0x3b3f4c });
    const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.9, 14), paint, 40);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    for (let i = 0; i < 40; i++) dashes.setMatrixAt(i, m4.compose(new THREE.Vector3(0, 0.08, -60 - i * 38), q, new THREE.Vector3(1, 1, 1)));
    scene.add(dashes);
    const keys = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 26), paint, 12);
    for (let i = 0; i < 12; i++) {
        const x = (i < 6 ? -1 : 1) * (4 + (i % 6) * 3);
        keys.setMatrixAt(i, m4.compose(new THREE.Vector3(x, 0.08, -18), q, new THREE.Vector3(1, 1, 1)));
    }
    scene.add(keys);
    const number = new THREE.Mesh(new THREE.PlaneGeometry(20, 10), new THREE.MeshBasicMaterial({ map: textTexture('09'), transparent: true, depthWrite: false }));
    number.rotation.x = -Math.PI / 2; number.position.set(0, 0.09, -44); scene.add(number);

    const edge = [], threshold = [], approach = [];
    for (let z = 0; z >= -1580; z -= 30) edge.push([-24, 0.6, z], [24, 0.6, z]);
    for (let x = -22; x <= 22; x += 4) threshold.push([x, 0.6, 1.5]);
    for (let i = 1; i <= 11; i++) for (const x of [-6, -3, 0, 3, 6]) approach.push([i === 11 ? x * 2 : x, 0.8, 1 + i * 30]);
    const edgeMat = lightMat(5); accentMats.push(edgeMat);
    const threshMat = lightMat(6); accentMats.push(threshMat);
    const approachMat = lightMat(5, 0.8); accentMats.push(approachMat);
    scene.add(lightPoints(edge, edgeMat), lightPoints(threshold, threshMat), lightPoints(approach, approachMat));
    // the sequenced strobe ("rabbit") running in towards the threshold
    const rabbitMat = new THREE.SpriteMaterial({ map: glow, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const rabbit = new THREE.Sprite(rabbitMat); rabbit.scale.set(14, 14, 1); scene.add(rabbit);
    setLoad(45);

    // taxi route: gate → taxiway → hold short → line up on runway 09
    const route = new THREE.CatmullRomCurve3([
        [-262, -560], [-200, -560], [-150, -545], [-110, -505], [-100, -440], [-100, -250], [-100, -40],
        [-100, 30], [-86, 56], [-58, 64], [-28, 54], [-8, 30], [0, 10], [0, 0]
    ].map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal', 0.5);
    // the taxiway surface: short tarmac strips laid along the route
    const pts = route.getSpacedPoints(400);
    const strips = new THREE.InstancedMesh(new THREE.PlaneGeometry(22, 4).rotateX(-Math.PI / 2), tarmac, pts.length);
    const qs = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    pts.forEach((p, i) => {
        const t = route.getTangentAt(i / (pts.length - 1));
        qs.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(t.x, t.z));
        strips.setMatrixAt(i, m4.compose(new THREE.Vector3(p.x, 0.03, p.z), qs, one));
    });
    scene.add(strips);
    const centre = route.getSpacedPoints(110).filter((p) => p.z > 2 || p.x < -2).map((p) => [p.x, 0.4, p.z]);
    const taxiMat = lightMat(3.2, 0.9); accentMats.push(taxiMat);
    scene.add(lightPoints(centre, taxiMat));
    // hold-short bar lights across the taxiway, just before the runway
    const hold = [];
    const hp = route.getPointAt(HOLD_AT + 0.03), ht = route.getTangentAt(HOLD_AT + 0.03);
    for (let k = -3; k <= 3; k++) hold.push([hp.x - ht.z * k * 3, 0.5, hp.z + ht.x * k * 3]);
    const holdMat = new THREE.PointsMaterial({ size: 4, map: glow, color: 0xffb35a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const holdBar = lightPoints(hold, holdMat); scene.add(holdBar);
    setLoad(60);

    // terminal, gate floodlights and parked aircraft
    const building = new THREE.MeshStandardMaterial({ color: 0x0d1019, roughness: 0.9 });
    const terminal = new THREE.Mesh(new THREE.BoxGeometry(40, 18, 380), building);
    terminal.position.set(-340, 9, -600); scene.add(terminal);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(370, 5), new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.35 }));
    glass.rotation.y = Math.PI / 2; glass.position.set(-319.8, 11, -600); scene.add(glass);
    const flood = new THREE.PointLight(0xffc98a, 2600, 260, 1.6); flood.position.set(-290, 40, -560); scene.add(flood);
    const flood2 = new THREE.PointLight(0xffc98a, 1800, 240, 1.6); flood2.position.set(-290, 40, -720); scene.add(flood2);
    for (const z of [-470, -660, -730, -800]) {
        const p = makeJet({ parked: true });
        p.position.set(-282, 3.2, z); p.rotation.y = -Math.PI / 2; scene.add(p);
    }
    // control tower with a rotating beacon
    const tower = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.5, 52, 10), building); shaft.position.y = 26; tower.add(shaft);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 6, 7, 10), building); cab.position.y = 56; tower.add(cab);
    const cabGlass = new THREE.Mesh(new THREE.CylinderGeometry(8.1, 8.1, 3, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0x6fe3c2, transparent: true, opacity: 0.45 }));
    cabGlass.position.y = 57; tower.add(cabGlass);
    const beam = new THREE.Mesh(new THREE.ConeGeometry(16, 220, 18, 1, true), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    beam.geometry.translate(0, -110, 0); beam.rotation.z = Math.PI / 2 - 0.08;
    const beacon = new THREE.Group(); beacon.position.y = 63; beacon.add(beam); tower.add(beacon);
    const beaconGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    beaconGlow.scale.set(10, 10, 1); beaconGlow.position.y = 63; tower.add(beaconGlow);
    tower.position.set(-210, 0, -170); scene.add(tower);
    setLoad(75);

    // our jet, with nav lights, strobes and a landing light
    const jet = makeJet();
    jet.position.y = 3.2;
    jet.rotation.order = 'YXZ';   // yaw, then pitch (for the takeoff rotation)
    const navLight = (color, x, y, z, s = 4) => {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        sp.scale.set(s, s, 1); sp.position.set(x, y, z); jet.add(sp); return sp;
    };
    navLight(0xff3344, -17, -0.6, -6); navLight(0x33ff88, 17, -0.6, -6);
    const strobes = [navLight(0xffffff, -17, -0.4, -6.6, 7), navLight(0xffffff, 17, -0.4, -6.6, 7), navLight(0xffffff, 0, 1, -24, 6)];
    const beaconRed = navLight(0xff2a2a, 0, 2.3, 2, 5);
    const land = new THREE.SpotLight(0xfff1d6, 9000, 260, 0.42, 0.6, 1.5);
    land.position.set(0, -1, 14); jet.add(land);
    land.target.position.set(0, -6, 70); jet.add(land.target);
    const belly = new THREE.PointLight(accent.clone(), 300, 40, 1.4); belly.position.set(0, -3, 0); jet.add(belly);
    scene.add(jet);
    setLoad(88);

    // low clouds and ground fog
    const cloudTex = cloudTexture();
    const clouds = [];
    // Big see-through cloud sprites cost a lot on weak graphics chips: lower levels show only the first few.
    for (let i = 0; i < 34; i++) {
        const low = i < 10;
        const m = new THREE.SpriteMaterial({ map: cloudTex, color: low ? 0x7782a8 : 0x5d678f, transparent: true, depthWrite: false, opacity: low ? 0.07 : 0.12 + Math.random() * 0.08 });
        const s = new THREE.Sprite(m);
        const scale = low ? 180 + Math.random() * 120 : 220 + Math.random() * 260;
        s.scale.set(scale, scale * 0.45, 1);
        s.position.set(-900 + Math.random() * 1800, low ? 6 + Math.random() * 6 : 90 + Math.random() * 120, -1400 + Math.random() * 1700);
        s.userData.speed = 1.5 + Math.random() * 3;
        s.visible = quality === 'high' || i % 3 === 0;
        clouds.push(s); scene.add(s);
    }
    setLoad(100);

    return { renderer, scene, camera, accent, accentMats, rabbit, approach, beacon, beaconGlow, jet, strobes, beaconRed, belly, clouds, route, holdMat, number };
}

// ------------------------------------------------------------------ scroll state
let target = 0;      // chapter float from the scroll position, 0 … LAST
let shown = 0;       // smoothed
function readScroll() {
    const mid = window.scrollY + window.innerHeight * 0.5;
    // Each chapter is a steady stop; the move to the next one happens while its top crosses mid-screen.
    const band = window.innerHeight * 0.5;
    let f = 0;
    for (let i = 1; i <= LAST; i++) {
        const t = (mid - (CHAPTERS[i].offsetTop - band / 2)) / band;
        if (t >= 1) f = i;
        else { if (t > 0) f = i - 1 + t; break; }
    }
    target = Math.max(0, Math.min(LAST, f));
    const docH = document.documentElement.scrollHeight - window.innerHeight;
    $('nav-progress-bar').style.width = `${docH > 0 ? Math.min(100, (window.scrollY / docH) * 100) : 0}%`;
    const idx = Math.round(target);
    $('nav-step').textContent = `${String(idx).padStart(2, '0')} / ${String(LAST).padStart(2, '0')}`;
    document.querySelectorAll('.nav-links a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#c${idx}`));
    if (idx === LAST && !$('reread').hidden && rereadFrom === null) $('reread').hidden = true;
}
window.addEventListener('scroll', readScroll, { passive: true });
window.addEventListener('resize', () => { readScroll(); resize(); });

// Panels fade in as they arrive.
const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) e.target.classList.add('seen');
}, { threshold: 0.2 });
CHAPTERS.forEach((c) => seen.observe(c));

// The checklist ticks itself as you scroll past each item (or tap to tick / untick).
const checks = [...document.querySelectorAll('#checklist button')];
checks.forEach((b) => b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))));
const ticker = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.setAttribute('aria-pressed', 'true'); ticker.unobserve(e.target); }
}, { rootMargin: '0px 0px -40% 0px', threshold: 1 });
checks.forEach((b) => ticker.observe(b));

// ------------------------------------------------------------------ colours
let lastCss = '';
function applyAccent(f) {
    const i = Math.floor(f), t = f - i, n = COLOURS.length - 1;
    const hex = mixHex(COLOURS[Math.min(i, n)], COLOURS[Math.min(i + 1, n)], t);
    if (hex === lastCss) return;
    lastCss = hex;
    if (world) {
        world.accent.set(hex);
        for (const m of world.accentMats) m.color.set(hex);
        world.belly.color.set(hex);
    }
    const root = document.documentElement.style;
    root.setProperty('--accent', hex);
    root.setProperty('--accent-ink', inkFor(hex));   // dark text on the lighter colours, white on dark ones
}

// ------------------------------------------------------------------ camera + animation
let camOff, v, look, camPos, camGoal, fwd, right, UP;   // set once three.js has loaded
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
    world.clouds.forEach((c, i) => { c.visible = level === 'high' || i % 3 === 0; });
    startWatch();
}
let camScale = 1;
let takeoff = null;   // { start } once "Enter the market" is pressed
let firstFrame = true;

function resize() {
    if (!world) return;
    const w = window.innerWidth, h = window.innerHeight;
    world.renderer.setSize(w, h, false);
    world.camera.aspect = w / h;
    world.camera.fov = w / h < 1 ? 62 : 50;   // phones: a wider lens so the jet fits the narrow screen
    camScale = w / h < 1 ? 1.5 : 1;
    // Keep the jet clear of the text: to the right on wide screens, near the top on phones.
    if (w > 720) world.camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
    else world.camera.setViewOffset(w, h, 0, h * 0.2, w, h);
    world.camera.updateProjectionMatrix();
}

function lerpCam(f, out) {
    const i = Math.floor(f), t = f - i, a = CAMS[i], b = CAMS[Math.min(i + 1, LAST)];
    const e = t * t * (3 - 2 * t);
    return out.set(a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e);
}
function routeAt(f) {
    const i = Math.floor(f), t = f - i;
    const u = STOPS[i] + (STOPS[Math.min(i + 1, LAST)] - STOPS[i]) * t;
    return Math.min(1, Math.max(0, u));
}

function frame(now) {
    requestAnimationFrame(frame);
    watch?.(now);
    const time = now / 1000;
    // smooth the scroll (or snap, for reduced motion)
    if (REDUCED) shown = Math.round(target);
    else shown += (target - shown) * (firstFrame ? 1 : 0.06);
    let f = takeoff ? LAST + 1 : shown;
    applyAccent(takeoff ? Math.min(LAST + 1, LAST + (time - takeoff.start) / 1.2) : shown);
    if (!world) return;
    const { renderer, scene, camera, jet, route } = world;

    // jet on the taxi route
    if (!takeoff) {
        const u = routeAt(f);
        route.getPointAt(u, v);
        route.getTangentAt(Math.min(0.999, u), fwd);
        if (u >= 0.999) fwd.set(0, 0, -1);
        jet.position.set(v.x, 3.2, v.z);
        jet.rotation.set(0, Math.atan2(fwd.x, fwd.z), 0);
        fwd.set(Math.sin(jet.rotation.y), 0, Math.cos(jet.rotation.y));
        right.crossVectors(fwd, UP);
        const c = lerpCam(f, camOff);
        camGoal.copy(jet.position).addScaledVector(right, c.x * camScale).addScaledVector(fwd, -c.z * camScale);
        camGoal.y = c.y * camScale;
        look.copy(jet.position).addScaledVector(fwd, 14);
    } else {
        // roll, rotate, climb out along runway 09 (-z)
        const t = REDUCED ? 0 : time - takeoff.start;
        const s = 0.5 * 34 * t * t;                       // metres rolled
        const rot = Math.max(0, Math.min(1, (t - 2.3) / 0.9));
        const air = Math.max(0, s - 0.5 * 34 * 2.3 * 2.3);
        jet.position.set(0, 3.2 + air * Math.tan(0.16) * rot, -s);
        jet.rotation.set(-0.2 * rot, Math.PI, 0);
        camGoal.set(22, 7 + jet.position.y * 0.4, 55 + jet.position.z * 0.6);   // a chase that slowly falls behind
        look.copy(jet.position);
    }
    if (firstFrame || REDUCED) camPos.copy(camGoal); else camPos.lerp(camGoal, takeoff ? 0.04 : 0.08);
    camera.position.copy(camPos);
    camera.lookAt(look);
    firstFrame = false;

    // lights: strobes, beacon, the rabbit, clouds (all still for reduced motion)
    if (!REDUCED) {
        const st = time % 1.2;
        const flash = st < 0.06 || (st > 0.16 && st < 0.22);
        for (const s of world.strobes) s.material.opacity = flash ? 1 : 0;
        world.beaconRed.material.opacity = (time % 1) < 0.15 ? 1 : 0.15;
        world.beacon.rotation.y = time * 1.6;
        world.beaconGlow.material.color.set(Math.floor(time * 1.6 / Math.PI) % 2 ? 0x55ff99 : 0xffffff);
        const seq = Math.floor((time * 22) % 16);
        if (seq < 11) {
            world.rabbit.visible = true;
            world.rabbit.position.set(0, 1.2, 1 + (11 - seq) * 30);
        } else world.rabbit.visible = false;
        for (const c of world.clouds) {
            c.position.x += c.userData.speed * 0.016;
            if (c.position.x > 1000) c.position.x = -1000;
        }
        world.holdMat.opacity = f > 6.5 ? 0.15 : 0.6 + 0.4 * Math.sin(time * 4);   // hold-short bar goes dark once cleared
    } else {
        world.rabbit.visible = false;
        for (const s of world.strobes) s.material.opacity = 0.6;
    }
    renderer.render(scene, camera);
}

// ------------------------------------------------------------------ loader
(async function load() {
    // The market's own fonts (at most a few seconds; the page works with fallback fonts too).
    const fontsReady = Promise.race([
        Promise.all([document.fonts?.load?.('800 40px "Plus Jakarta Sans"'), document.fonts?.load?.('500 16px "JetBrains Mono"'), document.fonts?.ready].filter(Boolean)).catch(() => {}),
        new Promise((r) => setTimeout(r, 3500))
    ]);
    setLoad(5);
    if (quality !== 'lite') {
        try {
            THREE = await import('../vendor/three-0.160.1/three.module.min.js');
            camOff = new THREE.Vector3(); v = new THREE.Vector3(); look = new THREE.Vector3(); camPos = new THREE.Vector3();
            camGoal = new THREE.Vector3(); fwd = new THREE.Vector3(); right = new THREE.Vector3(); UP = new THREE.Vector3(0, 1, 0);
            world = buildWorld();
            lastCss = '';   // repaint the scene's colour on the next frame
        } catch (err) { console.warn('3D scene unavailable:', err); setQuality('lite'); }
    }
    setLoad(100);
    let shownPct = 0;
    await new Promise((done) => {
        const step = () => {
            shownPct += Math.max(1, (loadTarget - shownPct) * 0.18);
            if (shownPct > loadTarget) shownPct = loadTarget;
            loaderPct.textContent = String(Math.round(shownPct));
            if (shownPct >= 100) done(); else setTimeout(step, REDUCED ? 0 : 24);
        };
        step();
    });
    await fontsReady;
    // The runway number is drawn on a canvas: redraw it now that the font has loaded.
    if (world?.number) { world.number.material.map.dispose(); world.number.material.map = textTexture('09'); world.number.material.needsUpdate = true; }
    readScroll(); resize();
    if (world) world.renderer.compile(world.scene, world.camera);
    startWatch();
    qualitySwitch($('quality-switch'), quality);
    requestAnimationFrame(frame);
    setTimeout(() => $('loader').classList.add('done'), REDUCED ? 0 : 250);
})();

// ------------------------------------------------------------------ quiz
const ANSWERS = { q1: '4', q2: 'ask', q3: 'tell' };
const REREAD = {
    q1: 'Question 1: buy exactly what you ordered (4). The extra listings belong to someone else. Reread this, then retry the quiz.',
    q2: 'Question 2: a listing that isn\'t yours and isn\'t in #ffa-listings is someone else\'s order. When unsure, ask on #market-chat first.',
    q3: 'Question 3: own up. Tell #market-chat or an admin, then follow the seller team\'s instruction (it could be a re-list).'
};
let passed = false;
let rereadFrom = null;
const quiz = $('quiz'), msg = $('quiz-msg');
const scrollTo = (el) => el.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });

quiz.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = new FormData(quiz);
    const given = Object.fromEntries(Object.keys(ANSWERS).map((k) => [k, form.get(k)]));
    msg.classList.remove('bad');
    if (Object.values(given).some((x) => !x)) { say(msg, 'Answer all 3 questions first.'); msg.classList.add('bad'); return; }
    const wrong = Object.keys(ANSWERS).filter((k) => given[k] !== ANSWERS[k]);
    quiz.querySelectorAll('fieldset').forEach((fs) => {
        fs.classList.toggle('wrong', wrong.includes(fs.dataset.q));
        fs.classList.toggle('right', !wrong.includes(fs.dataset.q));
    });
    if (wrong.length) {
        passed = false;
        updateEnter();
        // All-or-nothing: clear the answers and send them to the chapter that explains the first mistake.
        quiz.reset();
        const fs = quiz.querySelector(`fieldset[data-q="${wrong[0]}"]`);
        const chapter = Number(fs.dataset.chapter);
        say(msg, '{n} of 3 not right yet. Reread, then try all three again.', { n: wrong.length });
        msg.classList.add('bad');
        say($('reread-text'), REREAD[wrong[0]]);
        rereadFrom = chapter;
        $('reread').hidden = false;
        if (gated) $('final').hidden = true;
        scrollTo($(`c${chapter}`));
        setTimeout(() => { rereadFrom = null; }, 1500);
        return;
    }
    passed = true;
    say(msg, 'All three right. Nice flying.');
    $('reread').hidden = true;
    $('final').hidden = false;
    updateEnter();
    if (gated) $('understand').focus({ preventScroll: true });
});
quiz.addEventListener('change', () => quiz.querySelectorAll('fieldset').forEach((fs) => fs.classList.remove('wrong', 'right')));
$('reread-back').addEventListener('click', () => { $('reread').hidden = true; scrollTo($('c7')); });

function updateEnter() {
    if (!gated) return;
    $('enter').disabled = !(passed && $('understand').checked);
}
$('understand').addEventListener('change', updateEnter);

$('enter').addEventListener('click', async () => {
    const button = $('enter'), out = $('enter-msg');
    out.classList.remove('bad');
    if (gated) {
        if (!passed || !$('understand').checked) return;
        button.disabled = true;
        say(out, 'Requesting takeoff clearance…');
        try {
            await api('/api/me', { action: 'welcome-done', answers: ANSWERS, understood: true });
        } catch (err) {
            say(out, err.message);
            out.classList.add('bad');
            button.disabled = false;
            return;
        }
        say(out, 'Cleared for takeoff. Welcome aboard!');
    }
    button.disabled = true;
    takeOff();
});
$('nav-exit').addEventListener('click', (e) => { e.preventDefault(); takeOff(); });

function takeOff() {
    if (takeoff) return;
    takeoff = { start: performance.now() / 1000 };
    say($('nav-step'), 'TAKEOFF');
    const wait = REDUCED || !world ? 300 : 3600;
    setTimeout(() => $('fade').classList.add('on'), Math.max(0, wait - 900));
    setTimeout(() => window.location.replace('/'), wait);
}
