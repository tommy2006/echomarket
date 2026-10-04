// Read-only check that supabase/schema.sql was installed correctly.
// Uses only the PUBLIC project URL + publishable key; it never writes anything.
//
//   node scripts/check-supabase.mjs <project-url> <publishable-key>
//   (or set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY instead of passing arguments)
//
// Also previews the Discord-login settings from SETUP.md Part 3.
const url = (process.argv[2] || process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.argv[3] || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
if (!url || !key) {
    console.error('Usage: node scripts/check-supabase.mjs <project-url> <publishable-key>');
    process.exit(2);
}
if (/sb_secret_|service_role/.test(key)) {
    console.error('That is a SECRET key. Use the publishable key here; the secret key belongs only in Vercel.');
    process.exit(2);
}

const TABLES = ['accounts', 'alliances', 'airlines', 'sellers', 'orders', 'order_events', 'order_flags', 'order_declines', 'push_subscriptions'];
const ALLIANCES = ['Kyra', 'Proxima', 'Aegis', 'Elysium', 'Rhea', 'Vilis', 'Elion', 'Aura', 'Eos'];
const headers = { apikey: key, Accept: 'application/json' };
let failures = 0;
const line = (ok, label, detail = '') => {
    if (ok === false) failures++;
    const mark = ok === true ? '✅' : ok === false ? '❌' : '➖';
    console.log(`${mark} ${label}${detail ? `  ${detail}` : ''}`);
};

async function get(path, init = {}) {
    const res = await fetch(url + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    return { status: res.status, body };
}

console.log(`Checking ${url}\n`);

// 0. Reachable + key accepted
const ping = await get('/rest/v1/alliances?select=name&limit=1');
if (ping.status === 401 || ping.status === 403) {
    line(false, 'publishable key accepted', `HTTP ${ping.status}: ${ping.body?.message || ''}`);
    process.exit(1);
}

// 1. Tables. RLS hides rows from anonymous visitors, so an existing table answers 200
//    (usually with []), while a missing one answers 404 / PGRST205.
console.log('Tables (Table Editor)');
for (const t of TABLES) {
    const r = await get(`/rest/v1/${t}?select=*&limit=1`);
    const exists = r.status === 200;
    line(exists, t.padEnd(13), exists ? '' : `missing (HTTP ${r.status} ${r.body?.code || ''})`);
}

// 1b. Columns added by later versions of schema.sql
const col = await get('/rest/v1/orders?select=previous_sellers&limit=1');
line(col.status === 200, 'orders.previous_sellers', col.status === 200 ? '' : 'missing: re-run supabase/schema.sql (safe to run again)');

// 2. Seed data
console.log('\nSeed data');
const al = await get('/rest/v1/alliances?select=name&order=sort_order');
const names = Array.isArray(al.body) ? al.body.map((a) => a.name) : [];
const missing = ALLIANCES.filter((n) => !names.includes(n));
line(names.length >= 9 && !missing.length, 'alliances', names.length ? names.join(', ') : 'none found');
if (missing.length) console.log(`   missing: ${missing.join(', ')}`);

// 3. Security: anonymous visitors must not see private rows
console.log('\nSecurity (Row Level Security)');
for (const t of ['accounts', 'airlines', 'orders', 'order_flags', 'sellers', 'order_declines', 'push_subscriptions']) {
    const r = await get(`/rest/v1/${t}?select=*&limit=1`);
    if (r.status !== 200) continue;
    line(Array.isArray(r.body) && r.body.length === 0, `${t} hidden from anonymous visitors`);
}

// 4. Database functions installed by schema.sql
console.log('\nFunctions');
const fn = await get('/rest/v1/rpc/is_seller', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
line(fn.status === 200 && fn.body === false, 'is_seller()', fn.status === 200 ? `returns ${fn.body} for anonymous` : `HTTP ${fn.status} ${fn.body?.code || ''}`);

// 5. Preview of Part 3 (Discord login)
console.log('\nLogin settings (SETUP.md Part 3, not required yet)');
const s = await get('/auth/v1/settings');
if (s.status === 200) {
    line(s.body?.external?.discord ? true : null, 'Discord sign-in enabled', s.body?.external?.discord ? '' : 'not yet (step 3.3)');
    line(s.body?.external?.email ? null : true, 'Email sign-up disabled', s.body?.external?.email ? 'still on (step 3.3)' : '');
} else {
    line(null, 'auth settings', `HTTP ${s.status}`);
}

const tablesMissing = TABLES.length - (await Promise.all(TABLES.map((t) => get(`/rest/v1/${t}?select=*&limit=1`))))
    .filter((r) => r.status === 200).length;
if (tablesMissing === TABLES.length) {
    console.log('\n❌ No Echo Market tables exist in this project: supabase/schema.sql has not been run here yet');
    console.log('   (or it hit an error and was rolled back). Supabase → SQL Editor → New query →');
    console.log('   paste the whole supabase/schema.sql → Run. Then run this check again.');
} else {
    console.log(failures ? `\n❌ ${failures} problem(s). Re-run supabase/schema.sql in the SQL Editor (it is safe to run again).`
        : '\n✅ Database is set up correctly. Part 2 is done.');
}
process.exit(failures ? 1 : 0);
