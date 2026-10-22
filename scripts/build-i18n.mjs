// Builds the translation files the sites load (shared/js/i18n/<pack>.<code>.js) from i18n/<code>.json.
//
// How translations work (see shared/js/i18n.js): the English text is the key. This script
//   1. collects every English text from the code: t('…') and tj('…') calls, the texts handed to toast / Modal /
//      ask / EmptyState / the guided tours (translated where they are shown), the data-i18n elements of the
//      welcome pages, and the server's error and order-update messages (${…} parts become {placeholders});
//   2. writes them to i18n/keys.json (one list per pack), so a translator sees what is new;
//   3. writes one small JS file per pack and language with the translations that exist.
// A text without a translation shows in English. i18n/<code>.json holds { "English": "translation" }.
//   npm run sync     (runs this first)
//   npm run check    fails if a built file is out of date; lists missing translations without failing
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['id', 'zh', 'ko', 'bn', 'hi'];
const OUT = join(ROOT, 'shared', 'js', 'i18n');
const check = process.argv.includes('--check');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : d.name.endsWith('.js') ? [`${dir}/${d.name}`] : []));

// Which sources feed which pack. Admin-only screens and Discord messages stay in English, so the Discord
// interaction handlers and the cron jobs are left out.
const PACKS = {
    app: { code: ['shared/js/ui.js', 'shared/js/welcome-perf.js', 'buyer/js/app.js', 'seller/js/seller.js'],
        server: [...walk('buyer/api'), ...walk('seller/api'), 'shared/lib/server.js', 'shared/lib/moderation.js']
            .filter((f) => !/\/(discord|cron)\//.test(f)) },
    'welcome-buyer': { code: ['buyer/js/welcome.js'], html: ['buyer/welcome.html'] },
    'welcome-seller': { code: ['seller/js/welcome.js'], html: ['seller/welcome.html'] }
};

// Texts the code builds from variables, so no pattern below can find them.
const EXTRA = {
    app: [
        // seller.js CAUTION_TEXT, passed to t()
        'This buyer is on the alert list. Be cautious and check with the admins if necessary when taking this order.',
        // ui.js EchoLoader's default label
        'Loading',
        // order updates written by the server (shared/lib + api), shown in the buyer's timeline
        '{a} takes over the remaining {b} aircraft.', '{a} will sell you this order.',
        '{a} ({b}) will also be delivering. Each seller lists their own aircraft: buy exactly what each one listed.',
        '{a} stopped delivering.', '{a} stopped delivering (the {b} they listed stay counted).',
        '{a} stopped delivering; {b} now handles the rest of the order.',
        '{a} passed on the remaining {b} aircraft. Waiting for a new seller.',
        '{a} has listed {b} ({c} of {d} delivered in total)', '{note} — {a} has listed {b} ({c} of {d} delivered in total)',
        'Missing planes checked: theft confirmed.', 'Missing planes checked: theft confirmed. {note}',
        'Missing planes checked: not a theft.', 'Missing planes checked: not a theft. {note}',
        'Missing planes reported: {a}', 'The missing planes were re-listed for you: {note}', 'Cancelled by buyer',
        'You can take over {a} hours after the order was taken: in about {b} hour.',
        'You can take over {a} hours after the order was taken: in about {b} hours.',
        'Test alert sent to {a} device.', 'Test alert sent to {a} devices.',
        // seller.js PageSizeBar: tj(noun === 'reports' ? … : …)
        'Showing {shown} of {total} orders', 'Showing {shown} of {total} reports'
    ],
    'welcome-buyer': [
        'Cleared for takeoff · Echo Market',
        'Question 1: buy exactly what you ordered (4). The extra listings belong to someone else. Reread this, then retry the quiz.',
        "Question 2: a listing that isn't yours and isn't in #ffa-listings is someone else's order. When unsure, ask on #market-chat first.",
        "Question 3: own up. Tell #market-chat or an admin, then follow the seller team's instruction (it could be a re-list)."
    ],
    'welcome-seller': ['A new era begins · Echo Market sellers']
};

const LIT = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\$]|\\.|\$(?!\{))*\x60`;
const unquote = (lit) => {
    const q = lit[0], body = lit.slice(1, -1);
    if (q === '"') return JSON.parse(lit);
    return JSON.parse('"' + body.replace(/\\(.)/g, (m, c) => (c === q || c === "'" ? c : m)).replace(/"/g, '\\"') + '"');
};

function fromCode(src) {
    const keys = [];
    const add = (lit) => { const s = unquote(lit); if (/[A-Za-z]{2}/.test(s) && s === s.trim()) keys.push(s); };
    const res = [
        // t('…'), tj('…'), and both branches of t(x ? '…' : '…')
        new RegExp(String.raw`\b(?:t|tj|tx|say)\(\s*(?:[\w$.()[\]]+,\s*)?(${LIT})`, 'g'),
        new RegExp(String.raw`\b(?:t|tj)\([^()'"\x60]*?\?\s*(${LIT})\s*:\s*(${LIT})`, 'g'),
        // texts the shared components translate where they show them
        new RegExp(String.raw`\btoast\(\s*(${LIT})`, 'g'),
        new RegExp(String.raw`\b(?:title|subtitle|text|label|finishLabel|message|confirmLabel|placeholder|what)(?:=|:\s*)(${LIT})`, 'g')
    ];
    for (const re of res) for (const m of src.matchAll(re)) { add(m[1]); if (m[2]) add(m[2]); }
    // Label helpers whose getters call t(): status('Long', 'Short', …), sort('…'), flagMeta('…'), reportLabel('…'),
    // navItem('id', '…'), sort labels and THEFT_TOOL entries
    for (const m of src.matchAll(new RegExp(String.raw`\b(?:sort|flagMeta|reportLabel)\(\s*(${LIT})`, 'g'))) add(m[1]);
    for (const m of src.matchAll(new RegExp(String.raw`\bstatus\(\s*(${LIT})\s*,\s*(${LIT})`, 'g'))) { add(m[1]); add(m[2]); }
    for (const m of src.matchAll(new RegExp(String.raw`\bnavItem\(\s*(?:${LIT})\s*,\s*(${LIT})`, 'g'))) add(m[1]);
    // EmptyState / Modal texts chosen with conditions: title=${a ? '…' : '…'} (translated where they are shown)
    for (const m of src.matchAll(/\b(?:title|text|subtitle)=\$\{/g)) {
        let depth = 1, i = m.index + m[0].length;
        for (; i < src.length && depth; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
        const expr = src.slice(m.index + m[0].length, i - 1);
        for (const x of expr.matchAll(new RegExp(String.raw`[?:]\s*(${LIT})`, 'g'))) add(x[1]);
    }
    // plural(n, 'order') reads the '{n} order' entry
    for (const m of src.matchAll(/\bplural\([^;]*?,\s*'([a-z][a-z ]*)'\)/g)) keys.push(`{n} ${m[1]}`);
    return keys;
}

// The server's messages: HttpError(…, '…') and order-update messages. ${…} becomes {a}, {b}, …
function fromServer(src) {
    const keys = [];
    const re = new RegExp(String.raw`HttpError\(\s*\d+\s*,\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60)`, 'g');
    for (const m of src.matchAll(re)) {
        const lit = m[1];
        if (lit[0] !== '`') { keys.push(unquote(lit)); continue; }
        if (/\$\{[^}]*\?/.test(lit)) continue;   // built with conditions: listed in EXTRA instead
        let n = 0;
        const body = lit.slice(1, -1).replace(/\$\{[^}]*\}/g, () => `{${'abcdefgh'[n++]}}`);
        keys.push(body.replace(/\\(.)/g, '$1'));
    }
    for (const m of src.matchAll(/message:\s*('(?:[^'\\\n]|\\.)*')/g)) keys.push(unquote(m[1]));
    return keys;
}

// Welcome pages: the inner HTML of each data-i18n element, spaces collapsed (as translatePage reads it).
function fromHtml(src) {
    const keys = [];
    const open = /<(\w+)\b[^>]*\bdata-i18n\b[^>]*>/g;
    for (const m of src.matchAll(open)) {
        const tag = m[1], start = m.index + m[0].length;
        const tagRe = new RegExp(String.raw`<(/?)${tag}\b[^>]*>`, 'g');
        tagRe.lastIndex = start;
        let depth = 1, end = -1, x;
        while ((x = tagRe.exec(src))) {
            depth += x[1] ? -1 : 1;
            if (!depth) { end = x.index; break; }
        }
        if (end < 0) throw new Error(`Unclosed <${tag} data-i18n> near: ${src.slice(m.index, m.index + 80)}`);
        keys.push(src.slice(start, end).replace(/\s+/g, ' ').trim());
    }
    return keys;
}

const packKeys = {};
for (const [pack, src] of Object.entries(PACKS)) {
    const keys = [
        ...(src.code || []).flatMap((f) => fromCode(read(f))),
        ...(src.server || []).flatMap((f) => fromServer(read(f))),
        ...(src.html || []).flatMap((f) => fromHtml(read(f))),
        ...(EXTRA[pack] || [])
    ];
    packKeys[pack] = [...new Set(keys)].filter((k) => k.trim()).sort();
}
// A text in the app pack is loaded on the welcome pages too (they load both): don't repeat it.
for (const pack of ['welcome-buyer', 'welcome-seller']) packKeys[pack] = packKeys[pack].filter((k) => !packKeys.app.includes(k));

const files = { 'i18n/keys.json': JSON.stringify(packKeys, null, 2) + '\n' };
const missing = {};
for (const code of LANGS) {
    const path = join(ROOT, 'i18n', `${code}.json`);
    const tr = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    for (const [pack, keys] of Object.entries(packKeys)) {
        const dict = {};
        for (const k of keys) {
            if (tr[k] != null && tr[k] !== '') dict[k] = tr[k];
            else (missing[code] ||= []).push(k);
        }
        files[`shared/js/i18n/${pack}.${code}.js`] = `// Built by scripts/build-i18n.mjs from i18n/${code}.json: edit that file, then run "npm run sync".\n`
            + `export default ${JSON.stringify(dict, null, 1)};\n`;
    }
}

let stale = 0;
for (const [file, text] of Object.entries(files)) {
    const target = join(ROOT, file);
    if (existsSync(target) && readFileSync(target, 'utf8') === text) continue;
    if (check) { console.error(`✗ ${file} is out of date`); stale++; continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log(`✓ wrote ${file}`);
}
// Built files for packs or languages that no longer exist.
for (const f of readdirSync(OUT)) {
    if (files[`shared/js/i18n/${f}`]) continue;
    if (check) { console.error(`✗ shared/js/i18n/${f} is no longer built`); stale++; } else { unlinkSync(join(OUT, f)); console.log(`✓ removed shared/js/i18n/${f}`); }
}
const total = Object.values(packKeys).reduce((n, k) => n + k.length, 0);
for (const code of LANGS) if (missing[code]?.length) console.warn(`${code}: ${missing[code].length} of ${total} texts not translated yet (shown in English).`);
if (check && stale) { console.error('\nRun "npm run sync" to rebuild the translations.'); process.exit(1); }
console.log(check ? 'Translations are up to date.' : `Translations built (${total} texts).`);
