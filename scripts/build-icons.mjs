// Builds a small icon file with only the Lucide icons the two sites use (instead of all ~1,700).
// The full library stays in scripts/lucide-0.469.0.min.js as the source. Run by "npm run sync" (and
// checked by "npm run check"); the output name carries a content hash, so browsers can cache it forever.
//
// How icons are found: every quoted 'kebab-case' word in buyer/js, seller/js and shared/js that is a Lucide
// icon name (Icon name="..." and icon: '...' alike). Icons built from pieces of text at runtime wouldn't be
// found, so always write icon names in full.
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import vm from 'vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'scripts', 'lucide-0.469.0.min.js');
const OUT_DIR = join(ROOT, 'shared', 'vendor');
const PAGES = ['buyer/index.html', 'seller/seller.html'];
const check = process.argv.includes('--check');

const ctx = { window: {}, self: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(SOURCE, 'utf8'), ctx);
const all = (ctx.lucide || ctx.window.lucide || ctx.self.lucide).icons;
const pascal = (s) => s.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

const used = new Set();
for (const dir of ['buyer/js', 'seller/js', 'shared/js']) {
    for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.js'))) {
        const text = readFileSync(join(ROOT, dir, f), 'utf8');
        for (const m of text.matchAll(/['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)['"`]/g)) {
            if (all[pascal(m[1])]) used.add(pascal(m[1]));
        }
    }
}
// Every icon has the same outer <svg> settings: keep only its inner shapes; createElement adds the rest.
const ROOT_ATTRS = all.Check[1];
const icons = Object.fromEntries([...used].sort().map((k) => [k, all[k][2]]));
const body = `/* Lucide 0.469.0 (ISC licence, lucide.dev): only the icons Echo Market uses. Built by scripts/build-icons.mjs. */
(function () {
var icons = ${JSON.stringify(icons)};
var ROOT = ${JSON.stringify(ROOT_ATTRS)};
for (var k in icons) icons[k] = ['svg', ROOT, icons[k]];
function createElement(node) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', node[0]);
    var attrs = node[1] || {};
    for (var k in attrs) el.setAttribute(k, String(attrs[k]));
    (node[2] || []).forEach(function (child) { el.appendChild(createElement(child)); });
    return el;
}
window.lucide = { icons: icons, createElement: createElement };
})();
`;
const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
const name = `lucide-icons-${hash}.js`;

if (check) {
    const ok = existsSync(join(OUT_DIR, name)) && PAGES.every((p) => readFileSync(join(ROOT, p), 'utf8').includes(`vendor/${name}`));
    if (!ok) { console.error('✗ Icon file is out of date: run "npm run sync".'); process.exit(1); }
    console.log(`Icons up to date (${used.size} icons).`);
    process.exit(0);
}
// Remove older builds (here and in the apps), write the new one, point the pages at it.
for (const dir of [OUT_DIR, join(ROOT, 'buyer', 'vendor'), join(ROOT, 'seller', 'vendor')]) {
    for (const f of readdirSync(dir)) if (/^lucide-(icons-[0-9a-f]+|0\.469\.0\.min)\.js$/.test(f) && f !== name) unlinkSync(join(dir, f));
}
writeFileSync(join(OUT_DIR, name), body);
for (const p of PAGES) {
    const file = join(ROOT, p);
    const html = readFileSync(file, 'utf8').replace(/vendor\/lucide-[^"]+\.js/, `vendor/${name}`);
    writeFileSync(file, html);
}
console.log(`✓ ${name}: ${used.size} of ${Object.keys(all).length} icons, ${(body.length / 1024).toFixed(1)} KB`);
