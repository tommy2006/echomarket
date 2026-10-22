// Graphics level for the 3D welcomes (welcome.html on both sites), so older phones and tablets run them smoothly.
//   'high'  the full scene
//   'low'   lighter: lower resolution, no edge smoothing, fewer lights and particles, no blur behind the cards
//   'lite'  no 3D at all (three.js isn't even downloaded); the same text, quiz and pledges over a coloured backdrop
// Picked from what the device reports, then lowered automatically while the page runs if it can't keep a smooth
// frame rate. A lowered level is remembered on this device. ?quality=high|low|lite forces one (support / testing).
// Source of truth: shared/js/welcome-perf.js. Run "npm run sync" at the repo root after editing.
import { t, onLangChange } from './i18n.js';
const KEY = 'echo_welcome_quality_v1';
export const LEVELS = ['lite', 'low', 'high'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
const saved = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* private mode */ } }
};

// What the device can probably manage, from its graphics chip, memory and processor count.
function detect() {
    let gpu = '';
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return 'lite';
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { return 'lite'; }
    if (/swiftshader|llvmpipe|software|basic render/i.test(gpu)) return 'lite';   // no real graphics chip
    const memory = navigator.deviceMemory || 8, cores = navigator.hardwareConcurrency || 8;
    if (memory <= 2 || cores <= 2) return 'lite';
    // Phone / tablet chips and older laptop graphics: Mali, PowerVR, Adreno below 600, older Intel HD.
    const modestGpu = /mali|powervr|adreno[^0-9]*[1-5]\d\d\b|intel\(r\) hd graphics( [2-5]\d\d\b)?|intel hd/i.test(gpu);
    const touch = window.matchMedia('(pointer: coarse)').matches;
    // Tablets (and sharp large phones) have many pixels to fill for a modest chip: start them on 'low'.
    const bigScreenPixels = Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) > 2000;
    if (modestGpu || memory <= 4 || cores <= 4 || (touch && bigScreenPixels) || navigator.connection?.saveData) return 'low';
    return 'high';
}

export function pickQuality() {
    const forced = new URLSearchParams(location.search).get('quality');
    if (LEVELS.includes(forced)) return forced;
    const detected = detect(), remembered = saved.get();
    // A level the device chose (or was stepped down to) before wins if it is lower.
    return LEVELS.includes(remembered) && rank(remembered) < rank(detected) ? remembered : detected;
}
export const lowerThan = (level) => LEVELS[Math.max(0, rank(level) - 1)];
export const rememberQuality = (level) => saved.set(level);
export const forgetQuality = () => saved.set(null);

// Pixel ratio for a level: 'low' renders at most ~1.3 million pixels (big tablets at full sharpness are the
// costly case) and at most 1.5× (phones stay sharp).
export function pixelRatioFor(level) {
    const dpr = window.devicePixelRatio || 1;
    if (level === 'high') return Math.min(dpr, 2);
    const fit = Math.sqrt(1.3e6 / Math.max(1, window.innerWidth * window.innerHeight));
    return Math.max(0.6, Math.min(1.5, dpr, fit));
}

// Frame-rate watch: call tick(now) once per frame. After a warm-up, if the average over about 1.5 seconds is below
// minFps, onSlow() is called (once). Pauses (hidden tab, a long hitch) are not counted.
export function frameWatch(minFps, onSlow, warmupMs = 2500) {
    let last = 0, sum = 0, n = 0, startAt = 0, fired = false;
    return function tick(now) {
        if (fired || document.hidden) { last = 0; return; }
        if (!startAt) startAt = now + warmupMs;
        const dt = last ? now - last : 0;
        last = now;
        if (now < startAt || !dt || dt > 400) return;
        sum += dt; n++;
        if (n < 90) return;
        const fps = 1000 / (sum / n);
        sum = 0; n = 0;
        if (fps < minFps) { fired = true; onSlow(fps); }
    };
}

// Colour helpers that work without three.js (the lite level never loads it).
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function mixHex(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
// Dark text on light accents, white on dark ones (relative luminance).
export function inkFor(hex) {
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const [r, g, b] = hexToRgb(hex).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.2 ? '#0b0d14' : '#ffffff';
}

// The footer switch: "Slow? Use the lite version" / "Switch back to full 3D".
export function qualitySwitch(button, level) {
    if (!button) return;
    button.hidden = false;
    const paint = () => { button.textContent = level === 'lite' ? t('Switch back to full 3D') : t('Slow on this device? Use the lite version'); };
    paint();
    onLangChange(paint);
    button.addEventListener('click', () => {
        if (level === 'lite') forgetQuality(); else rememberQuality('lite');
        const url = new URL(location.href); url.searchParams.delete('quality');
        location.replace(url.href);
    });
}
