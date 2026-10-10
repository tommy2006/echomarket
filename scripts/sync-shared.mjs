// Copies the shared code into both apps.
//
// Each Vercel project only sees its own folder (buyer/ or seller/), so code used by both
// lives once in shared/ and is copied into each app. Edit files in shared/, then run:
//   npm run sync      copy shared/ → buyer/ and seller/
//   npm run check     fail if any copy differs from shared/ (run before committing)
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Shared code, plus the browser libraries in vendor/ (each site serves its own copy; see SECURITY in HANDOVER.md).
const VENDOR = readdirSync(join(ROOT, 'shared', 'vendor')).map((f) => 'vendor/' + f);
const FILES = ['lib/server.js', 'lib/moderation.js', 'js/ui.js', 'js/tailwind-config.js', 'api/config.js', 'api/health.js', ...VENDOR];
const APPS = ['buyer', 'seller'];
const check = process.argv.includes('--check');

let stale = 0;
for (const file of FILES) {
    const source = readFileSync(join(ROOT, 'shared', file), 'utf8');
    for (const app of APPS) {
        const target = join(ROOT, app, file);
        const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
        if (current === source) continue;
        if (check) {
            console.error(`✗ ${app}/${file} differs from shared/${file}`);
            stale++;
        } else {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, source);
            console.log(`✓ updated ${app}/${file}`);
        }
    }
}
if (check && stale) {
    console.error('\nRun "npm run sync" to update the copies.');
    process.exit(1);
}
console.log(check ? 'All shared copies are up to date.' : 'Sync complete.');
