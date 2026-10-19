// Builds each site's stylesheet ahead of time (buyer/css/app.css, seller/css/app.css) with the Tailwind CLI,
// instead of every visitor's browser compiling it on page load. Run by "npm run sync"; "npm run check" fails
// if a stylesheet is out of date (e.g. a new Tailwind class was used in the code without re-running sync).
// Sources: styles/<app>.css (page-wide styles) + the Tailwind classes found in <app>'s HTML and js/ files.
// Write class names in full in the code (never pieces like `text-${colour}-300`), or they won't be built.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
const check = process.argv.includes('--check');
if (!existsSync(CLI)) {
    console.error('✗ Tailwind is not installed: run "npm install" at the repo root.');
    process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), 'echo-css-'));
let stale = 0;
try {
    for (const app of ['buyer', 'seller']) {
        const config = join(tmp, `tailwind.${app}.cjs`);
        writeFileSync(config, `module.exports = require(${JSON.stringify(join(ROOT, 'scripts', 'tailwind-config.cjs'))})(${JSON.stringify(app)});\n`);
        const out = join(tmp, `${app}.css`);
        execFileSync(process.execPath, [CLI, '-c', config, '-i', join(ROOT, 'styles', `${app}.css`), '-o', out, '--minify'],
            { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
        const css = readFileSync(out, 'utf8');
        const target = join(ROOT, app, 'css', 'app.css');
        const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
        if (current === css) { if (!check) console.log(`  ${app}/css/app.css up to date`); continue; }
        if (check) { console.error(`✗ ${app}/css/app.css is out of date: run "npm run sync".`); stale++; continue; }
        writeFileSync(target, css);
        console.log(`✓ ${app}/css/app.css (${(css.length / 1024).toFixed(1)} KB)`);
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
if (stale) process.exit(1);
if (check) console.log('Stylesheets up to date.');
