// Languages for the buyer site, the seller desk and both welcome pages (same menu as the Echo Alliances site).
//   English is built in; the other languages load only when chosen (js/i18n/<pack>.<code>.js, built by
//   scripts/build-i18n.mjs from i18n/<code>.json). The choice is remembered on this device (localStorage
//   "eua-lang", the key the Echo Alliances site uses too); English when it can't be read.
// Writing text in the code:
//   t('Open queue')                          a plain sentence (the English text is the key)
//   t('{n} orders waiting', { n })           with values; translations may move {n} anywhere
//   tj('Showing {a} of {b}', { a: html`<b>${x}</b>`, b })   the same, but values may be elements (returns an array)
//   tx(text)                                 a finished English text made elsewhere (server messages, titles passed
//                                            to Modal/toast/ask): exact match first, then the {placeholder} patterns
//   plural(n, 'order')                       "1 order" / "3 orders" (each language has a '{n} order' entry)
// Names (airlines, alliances, divisions, aircraft models, codes, Discord handles) are never translated:
// keep them out of keys, pass them as values.
// Source of truth: shared/js/i18n.js. Run "npm run sync" at the repo root after editing.
const KEY = 'eua-lang';
export const LANGS = [
    { code: 'en', label: 'EN', name: 'English' },
    { code: 'id', label: 'ID', name: 'Bahasa Indonesia' },
    { code: 'zh', label: '中文', name: '简体中文' },
    { code: 'ko', label: '한국어', name: '한국어' },
    { code: 'bn', label: 'বাংলা', name: 'বাংলা' },
    { code: 'hi', label: 'हिन्दी', name: 'हिन्दी' },
    { code: 'vi', label: 'VI', name: 'Tiếng Việt' },
    { code: 'fil', label: 'FIL', name: 'Filipino' }
];
// Noto fonts for scripts the Latin fonts don't have (ours cover Vietnamese and Filipino), loaded only with their language (fallbacks after ours).
const FONTS = {
    zh: 'Noto+Sans+SC:wght@400;500;700;900',
    ko: 'Noto+Sans+KR:wght@400;500;700;900',
    bn: 'Noto+Sans+Bengali:wght@400;500;700;900',
    hi: 'Noto+Sans+Devanagari:wght@400;500;700;900'
};

let lang = 'en';
let dict = Object.create(null);
let patterns = null;   // compiled lazily from the keys with {placeholders}
const listeners = new Set();

export const currentLang = () => lang;
export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function savedLang() {
    try { const v = localStorage.getItem(KEY); return LANGS.some((l) => l.code === v) ? v : 'en'; } catch { return 'en'; }
}

function loadFont(code) {
    const family = FONTS[code];
    if (!family || document.querySelector(`link[data-lang-font="${code}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
    link.dataset.langFont = code;
    document.head.appendChild(link);
}

// Switch language. packs: which dictionaries this page needs ('app', 'welcome-buyer', 'welcome-seller').
export async function setLang(code, packs = ['app'], remember = true) {
    if (!LANGS.some((l) => l.code === code)) code = 'en';
    const next = Object.create(null);
    if (code !== 'en') {
        const mods = await Promise.all(packs.map((p) => import(`./i18n/${p}.${code}.js`).catch(() => ({ default: {} }))));
        for (const m of mods) Object.assign(next, m.default);
        loadFont(code);
    }
    lang = code;
    dict = next;
    patterns = null;
    document.documentElement.lang = code;
    if (remember) { try { localStorage.setItem(KEY, code); } catch { /* private mode */ } }
    listeners.forEach((fn) => fn(code));
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

export function t(key, vars) {
    return fill(dict[key] ?? key, vars);
}

export function tj(key, vars = {}) {
    const s = dict[key] ?? key;
    const out = [];
    let last = 0;
    s.replace(/\{(\w+)\}/g, (m, k, i) => {
        out.push(s.slice(last, i));
        out.push(k in vars ? vars[k] : m);
        last = i + m.length;
        return m;
    });
    out.push(s.slice(last));
    return out.filter((x) => x !== '' && x != null && x !== false);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile() {
    patterns = Object.keys(dict).filter((k) => /\{\w+\}/.test(k)).map((key) => {
        const names = [];
        const body = key.split(/(\{\w+\})/).map((part) => {
            const m = /^\{(\w+)\}$/.exec(part);
            if (!m) return escapeRe(part);
            names.push(m[1]);
            return '([\\s\\S]+?)';
        }).join('');
        return { key, names, re: new RegExp('^' + body + '$') };
    }).sort((a, b) => b.key.length - a.key.length);   // the most specific first
}
// A finished English text: exact match, else the first {placeholder} pattern that fits. A placeholder named
// {msg} is itself translated (e.g. "Order not sent: {msg}" with a server message inside).
export function tx(text) {
    if (lang === 'en' || text == null || typeof text !== 'string') return text;
    if (dict[text] != null) return dict[text];
    const trimmed = text.trim();
    if (dict[trimmed] != null) return dict[trimmed];
    if (!patterns) compile();
    for (const p of patterns) {
        const m = p.re.exec(trimmed);
        if (!m) continue;
        const vars = {};
        p.names.forEach((n, i) => { vars[n] = n === 'msg' ? tx(m[i + 1]) : m[i + 1]; });
        return fill(dict[p.key], vars);
    }
    return text;
}

// Static pages (the welcome walkthroughs): each element marked data-i18n shows its translation. The key is the
// element's English HTML as written in the page (spaces collapsed), so translations keep its tags (<b>, <i>, <br>).
// Don't mark elements whose text the script changes, or that hold inputs: mark the text span inside instead.
const originals = new WeakMap();
export const htmlKey = (s) => s.replace(/\s+/g, ' ').trim();
export function translatePage(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        if (!originals.has(el)) originals.set(el, htmlKey(el.innerHTML));
        const en = originals.get(el);
        const next = dict[en] ?? en;
        if (htmlKey(el.innerHTML) !== next) el.innerHTML = next;
    });
}

export function plural(n, word) {
    const en = `${n} ${word}${n === 1 || word === 'aircraft' ? '' : 's'}`;
    if (lang === 'en') return en;
    const k = `{n} ${word}`;
    return dict[k] != null ? fill(dict[k], { n }) : en;
}

// The menu itself: a small button with the current language's code, opening the list of languages, each in its
// own name. Plain DOM, so the welcome pages (no React) use it too. Styles: css/lang-menu.css.
// up: open the list above the button (at the bottom of a dialog). wrap.dispose() removes its listeners.
export function languageMenu(packs = ['app'], onChanged, { up = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = up ? 'lang-menu up' : 'lang-menu';
    wrap.setAttribute('translate', 'no');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const list = document.createElement('ul');
    list.className = 'lang-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const paint = () => {
        const cur = LANGS.find((l) => l.code === lang) || LANGS[0];
        btn.innerHTML = '';
        const code = document.createElement('span'); code.textContent = cur.label;
        const caret = document.createElement('span'); caret.className = 'lang-caret'; caret.textContent = '▾'; caret.setAttribute('aria-hidden', 'true');
        btn.append(code, caret);
        btn.setAttribute('aria-label', `Language: ${cur.name}`);
        list.querySelectorAll('li').forEach((li) => li.setAttribute('aria-selected', String(li.dataset.code === lang)));
    };
    const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    LANGS.forEach((l) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.code = l.code;
        li.lang = l.code;
        li.tabIndex = 0;
        li.textContent = l.name;
        const pick = async () => { close(); if (l.code !== lang) { await setLang(l.code, packs); onChanged?.(l.code); } };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        list.appendChild(li);
    });
    btn.addEventListener('click', () => {
        const open = list.hidden;
        list.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        if (open) list.querySelector('[aria-selected="true"]')?.focus();
    });
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    const escape = (e) => { if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(); btn.focus(); } };
    document.addEventListener('pointerdown', outside);
    wrap.addEventListener('keydown', escape);
    const unlisten = onLangChange(paint);
    wrap.dispose = () => { document.removeEventListener('pointerdown', outside); unlisten(); };
    paint();
    wrap.append(btn, list);
    return wrap;
}
