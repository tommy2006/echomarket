// GET /api/health — setup checklist. Shows WHAT is configured, never the secret values.
// Open https://<your-site>/api/health in a browser after every setup step.
//
// Public view: every check with ✅ / ❌ / ➖ and how to fix it, but no names, counts or addresses
// (no Discord server names, bot name, account numbers…), so it's no use for reconnaissance.
// Full view: set HEALTH_TOKEN in this Vercel project to any long random text, then open
// /api/health?token=<that text>. The full view is never cached.
import { timingSafeEqual } from 'crypto';
import { APP, admin, SUPABASE_URL, SUPABASE_PUBLIC_KEY, BUYER_URL, SELLER_URL, WEBHOOKS, DM_AVAILABLE, PUSH_AVAILABLE, discordBot, ROLE_IDS } from '../lib/server.js';

const has = (n) => Boolean(process.env[n]);

function tokenMatches(given) {
    const want = process.env.HEALTH_TOKEN || '';
    if (want.length < 16 || typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
    const full = tokenMatches(req.query?.token);
    // Public view: cached for a minute on Vercel's edge, so reloading can't run the bot into Discord's
    // rate limit. Full view: never stored anywhere.
    res.setHeader('Cache-Control', full ? 'private, no-store' : 'public, max-age=0, s-maxage=60');
    const checks = [];
    // private: the detail is only shown in the full view (names, counts, error texts)
    const add = (step, name, ok, detail, fix, { private: priv = false } = {}) =>
        checks.push({ step, check: name, ok, detail, priv, ...(ok ? {} : { fix }) });

    // --- Supabase settings
    const secretSet = has('SUPABASE_SECRET_KEY') || has('SUPABASE_SERVICE_ROLE_KEY');
    add('Vercel env', 'SUPABASE_URL', Boolean(SUPABASE_URL), SUPABASE_URL ? SUPABASE_URL.replace(/^https:\/\/([a-z0-9]{4}).*/, 'https://$1…supabase.co') : 'missing',
        'Add SUPABASE_URL in Vercel → Settings → Environment Variables, then redeploy.', { private: Boolean(SUPABASE_URL) });
    add('Vercel env', 'SUPABASE_PUBLISHABLE_KEY', Boolean(SUPABASE_PUBLIC_KEY), SUPABASE_PUBLIC_KEY ? 'set' : 'missing',
        'Add SUPABASE_PUBLISHABLE_KEY (Supabase → Project Settings → API Keys → publishable key), then redeploy.');
    add('Vercel env', 'SUPABASE_SECRET_KEY', secretSet, secretSet ? 'set' : 'missing',
        'Add SUPABASE_SECRET_KEY (Supabase → Project Settings → API Keys → secret key), then redeploy.');

    // --- Links between the two apps (public addresses anyway)
    add('Vercel env', 'BUYER_URL', Boolean(BUYER_URL), BUYER_URL || 'missing',
        'Add BUYER_URL (the buyer site address, e.g. https://echomarket-buyer.vercel.app) in this Vercel project, then redeploy.');
    add('Vercel env', 'SELLER_URL', Boolean(SELLER_URL), SELLER_URL || 'missing',
        'Add SELLER_URL (the seller site address, e.g. https://echomarket-seller.vercel.app) in this Vercel project, then redeploy.');

    // --- Database schema
    if (SUPABASE_URL && secretSet) {
        try {
            const db = admin();
            const { count: alliances, error } = await db.from('alliances').select('name', { count: 'exact', head: true });
            if (error) throw error;
            const { count: accounts } = await db.from('accounts').select('id', { count: 'exact', head: true });
            const { count: sellers } = await db.from('sellers').select('user_id', { count: 'exact', head: true }).eq('active', true);
            const { count: airlines } = await db.from('airlines').select('id', { count: 'exact', head: true });
            add('Database', 'schema.sql installed', true, `${alliances} alliances, ${accounts} accounts, ${airlines} airlines`, null, { private: true });
            add('Database', 'at least one seller', sellers > 0, `${sellers} active seller(s)`,
                'Sign in on the seller site once, then add yourself to public.sellers (see the guide, step 5.3).', { private: true });
        } catch (err) {
            add('Database', 'schema.sql installed', false, err.message,
                'Run supabase/schema.sql in Supabase → SQL Editor (or ask Claude to run it through the Supabase connector).', { private: true });
        }
    }

    // --- Discord login (public auth settings endpoint)
    if (SUPABASE_URL && SUPABASE_PUBLIC_KEY) {
        try {
            const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_PUBLIC_KEY } });
            const s = await r.json();
            const others = Object.entries(s.external || {}).filter(([k, v]) => v && k !== 'discord' && k !== 'email').map(([k]) => k);
            add('Discord login', 'Discord provider enabled', Boolean(s.external?.discord), s.external?.discord ? 'enabled' : 'disabled',
                'Supabase → Authentication → Sign In / Providers → Discord: enable and paste the Discord Client ID + Secret.');
            add('Discord login', 'Email sign-up disabled', !s.external?.email, s.external?.email ? 'email sign-up is ON' : 'off',
                'Supabase → Authentication → Sign In / Providers → Email: turn it off so Discord is the only way in (one account per Discord user).');
            // One market account = one Discord user: no other way in.
            add('Discord login', 'No other sign-in methods', others.length === 0, others.length ? `also on: ${others.join(', ')}` : 'Discord only',
                'Supabase → Authentication → Sign In / Providers (and "Allow anonymous sign-ins"): turn off everything except Discord.');
        } catch (err) {
            add('Discord login', 'Supabase auth reachable', false, err.message, 'Check SUPABASE_URL.', { private: true });
        }
    }

    // --- Discord channel webhooks
    for (const [channel, url] of Object.entries(WEBHOOKS)) {
        if (!url) {
            add('Discord channels', `webhook: ${channel}`, false, 'not set (optional)',
                `Create a webhook in the "${channel}" channel and add DISCORD_WEBHOOK_${channel.toUpperCase()} in Vercel.`);
            continue;
        }
        try {
            const r = await fetch(url);
            const j = await r.json().catch(() => ({}));
            add('Discord channels', `webhook: ${channel}`, r.ok, r.ok ? `posts as "${j.name}"` : `Discord says HTTP ${r.status}`,
                'The webhook URL is wrong or the webhook was deleted. Create a new one and update the Vercel env var.', { private: r.ok });
        } catch (err) {
            add('Discord channels', `webhook: ${channel}`, false, err.message, 'Check the webhook URL.', { private: true });
        }
    }
    add('Discord channels', 'DISCORD_ROLE_ID (seller ping)', has('DISCORD_ROLE_ID'), has('DISCORD_ROLE_ID') ? 'set' : 'not set (optional)',
        'Discord → Server Settings → Roles → right-click the seller role → Copy Role ID (needs Developer Mode). Add as DISCORD_ROLE_ID.');

    // --- DM bot
    if (!DM_AVAILABLE) {
        add('Discord DMs', 'DISCORD_BOT_TOKEN', false, 'not set (optional)', 'Create a bot (guide step "DM bot") and add DISCORD_BOT_TOKEN in Vercel.');
    } else {
        try {
            const me = await discordBot('/users/@me');
            add('Discord DMs', 'bot token valid', me.ok, me.ok ? `bot is "${me.json.username}"` : `Discord says HTTP ${me.status}`,
                'The token is wrong or was reset. Discord Developer Portal → Bot → Reset Token, then update DISCORD_BOT_TOKEN.', { private: me.ok });
            if (me.ok) {
                const guilds = await discordBot('/users/@me/guilds');
                const list = guilds.ok ? guilds.json || [] : [];
                add('Discord DMs', 'bot is in your server', list.length > 0, list.length ? `in: ${list.map((g) => g.name).join(', ')}` : 'in no servers',
                    'Ask a server admin to open the bot invite link (guide step "Invite the bot").', { private: list.length > 0 });
                // The seller role is only looked up in this one server (recommended; see SETUP.md 8.2).
                const pinned = (process.env.DISCORD_GUILD_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
                const pinnedOk = pinned.length > 0 && pinned.every((id) => list.some((g) => g.id === id));
                add('Discord DMs', 'DISCORD_GUILD_ID (seller role server)', pinnedOk,
                    pinned.length ? (pinnedOk ? 'set, bot is in it' : 'set, but the bot is not in that server') : 'not set (optional, recommended)',
                    'Discord → right-click the Echo Alliances server icon → Copy Server ID (Developer Mode on). Add it as DISCORD_GUILD_ID in the SELLER Vercel project, then redeploy.');
                // Discord roles: the one new orders ping, and the three that give seller desk access.
                const roleNames = new Map();   // role id → "@name in server"
                for (const g of pinned.length ? list.filter((x) => pinned.includes(x.id)) : list) {
                    const roles = await discordBot(`/guilds/${g.id}/roles`);
                    for (const r of (roles.ok && roles.json) || []) roleNames.set(r.id, `@${r.name} in ${g.name}`);
                }
                const pingRole = process.env.DISCORD_ROLE_ID;
                if (pingRole) {
                    add('Discord roles', 'DISCORD_ROLE_ID (pinged for new orders)', roleNames.has(pingRole), roleNames.get(pingRole) || 'role not found in the server',
                        'Set DISCORD_ROLE_ID to the Verified Seller role ID (Server Settings → Roles → right-click → Copy Role ID) in BOTH Vercel projects.', { private: roleNames.has(pingRole) });
                }
                if (APP === 'seller') {
                    const explicit = has('DISCORD_LEAD_ROLE_ID') || has('DISCORD_AMBASSADOR_ROLE_ID') || has('DISCORD_VERIFIED_SELLER_ROLE_ID');
                    for (const [rank, key, label] of [['lead', 'DISCORD_LEAD_ROLE_ID', 'Lead Ambassador'],
                        ['ambassador', 'DISCORD_AMBASSADOR_ROLE_ID', 'Ambassador'], ['verified', 'DISCORD_VERIFIED_SELLER_ROLE_ID', 'Verified Seller']]) {
                        const id = ROLE_IDS[rank];
                        if (!has(key)) {
                            add('Discord roles', `${key} (${label} → seller desk)`, false,
                                explicit ? 'not set (optional)' : rank === 'verified' && id ? 'not set (optional, recommended): DISCORD_ROLE_ID is used instead' : 'not set (optional, recommended)',
                                `Discord → Server Settings → Roles → right-click "${label}" → Copy Role ID. Add it as ${key} in the SELLER Vercel project, then redeploy.`);
                            continue;
                        }
                        add('Discord roles', `${key} (${label} → seller desk)`, roleNames.has(id),
                            roleNames.get(id) ? `${roleNames.get(id)}: gets the seller desk${rank === 'lead' ? ' as admin' : ''}` : 'role not found in the server',
                            `Check ${key}: it must be the ID of the ${label} role in the Echo Alliances server.`, { private: roleNames.has(id) });
                    }
                }
            }
        } catch (err) {
            add('Discord DMs', 'bot reachable', false, err.message, 'Check DISCORD_BOT_TOKEN.', { private: true });
        }
    }

    // 'at least one seller' is done in Part 5 (after the sites exist), so it doesn't block 'ready'.
    // --- Phone / browser alerts
    add('Phone alerts', 'VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY', PUSH_AVAILABLE, PUSH_AVAILABLE ? 'set' : 'not set (optional)',
        'Run "npx web-push generate-vapid-keys" and add both keys to BOTH Vercel projects (SETUP.md: "Phone alerts"), then redeploy.');
    // Testing-only switch that lets alerts go to extra addresses; must never be on a live site.
    add('Phone alerts', 'PUSH_EXTRA_HOSTS not set', !has('PUSH_EXTRA_HOSTS'), has('PUSH_EXTRA_HOSTS') ? 'set' : 'not set',
        'Delete PUSH_EXTRA_HOSTS from this Vercel project (it is for local testing only), then redeploy.');

    const required = checks.filter((c) => ['Vercel env', 'Database', 'Discord login'].includes(c.step) && c.check !== 'at least one seller');
    const ready = required.every((c) => c.ok);
    const next = checks.find((c) => !c.ok && !String(c.detail).includes('optional'));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({
        app: APP,
        ready,
        summary: ready ? '✅ Core setup complete. Optional items below add Discord channel posts and DMs.' : `❌ Not ready yet. Next: ${next?.fix || 'see checks'}`,
        ...(full ? {} : { note: 'Public view: names and numbers are hidden. Add ?token=<HEALTH_TOKEN> for full details.' }),
        checks: checks.map(({ priv, ...c }) => ({
            ...c,
            detail: priv && !full ? (c.ok ? 'ok' : 'problem (details in the full view)') : c.detail,
            ok: c.ok ? '✅' : (String(c.detail).includes('optional') ? '➖' : '❌')
        }))
    }, null, 2));
}
