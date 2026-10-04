// GET /api/health — setup checklist. Shows WHAT is configured, never the secret values.
// Open https://<your-site>/api/health in a browser after every setup step.
import { APP, admin, SUPABASE_URL, SUPABASE_PUBLIC_KEY, BUYER_URL, SELLER_URL, WEBHOOKS, DM_AVAILABLE, PUSH_AVAILABLE, discordBot } from '../lib/server.js';

const has = (n) => Boolean(process.env[n]);

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const checks = [];
    const add = (step, name, ok, detail, fix) => checks.push({ step, check: name, ok, detail, ...(ok ? {} : { fix }) });

    // --- Supabase settings
    const secretSet = has('SUPABASE_SECRET_KEY') || has('SUPABASE_SERVICE_ROLE_KEY');
    add('Vercel env', 'SUPABASE_URL', Boolean(SUPABASE_URL), SUPABASE_URL ? SUPABASE_URL.replace(/^https:\/\/([a-z0-9]{4}).*/, 'https://$1…supabase.co') : 'missing',
        'Add SUPABASE_URL in Vercel → Settings → Environment Variables, then redeploy.');
    add('Vercel env', 'SUPABASE_PUBLISHABLE_KEY', Boolean(SUPABASE_PUBLIC_KEY), SUPABASE_PUBLIC_KEY ? 'set' : 'missing',
        'Add SUPABASE_PUBLISHABLE_KEY (Supabase → Project Settings → API Keys → publishable key), then redeploy.');
    add('Vercel env', 'SUPABASE_SECRET_KEY', secretSet, secretSet ? 'set' : 'missing',
        'Add SUPABASE_SECRET_KEY (Supabase → Project Settings → API Keys → secret key), then redeploy.');

    // --- Links between the two apps
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
            add('Database', 'schema.sql installed', true, `${alliances} alliances, ${accounts} accounts, ${airlines} airlines`);
            add('Database', 'at least one seller', sellers > 0, `${sellers} active seller(s)`,
                'Sign in on the seller site once, then add yourself to public.sellers (see the guide, step 5.3).');
        } catch (err) {
            add('Database', 'schema.sql installed', false, err.message,
                'Run supabase/schema.sql in Supabase → SQL Editor (or ask Claude to run it through the Supabase connector).');
        }
    }

    // --- Discord login (public auth settings endpoint)
    if (SUPABASE_URL && SUPABASE_PUBLIC_KEY) {
        try {
            const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_PUBLIC_KEY } });
            const s = await r.json();
            add('Discord login', 'Discord provider enabled', Boolean(s.external?.discord), s.external?.discord ? 'enabled' : 'disabled',
                'Supabase → Authentication → Sign In / Providers → Discord: enable and paste the Discord Client ID + Secret.');
            add('Discord login', 'Email sign-up disabled', !s.external?.email, s.external?.email ? 'email sign-up is ON' : 'off',
                'Supabase → Authentication → Sign In / Providers → Email: turn it off so Discord is the only way in (one account per Discord user).');
        } catch (err) {
            add('Discord login', 'Supabase auth reachable', false, err.message, 'Check SUPABASE_URL.');
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
                'The webhook URL is wrong or the webhook was deleted. Create a new one and update the Vercel env var.');
        } catch (err) {
            add('Discord channels', `webhook: ${channel}`, false, err.message, 'Check the webhook URL.');
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
                'The token is wrong or was reset. Discord Developer Portal → Bot → Reset Token, then update DISCORD_BOT_TOKEN.');
            if (me.ok) {
                const guilds = await discordBot('/users/@me/guilds');
                const names = (guilds.json || []).map((g) => g.name);
                add('Discord DMs', 'bot is in your server', guilds.ok && names.length > 0, names.length ? `in: ${names.join(', ')}` : 'in no servers',
                    'Ask a server admin to open the bot invite link (guide step "Invite the bot").');
            }
        } catch (err) {
            add('Discord DMs', 'bot reachable', false, err.message, 'Check DISCORD_BOT_TOKEN.');
        }
    }

    // 'at least one seller' is done in Part 5 (after the sites exist), so it doesn't block 'ready'.
    // --- Phone / browser alerts
    add('Phone alerts', 'VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY', PUSH_AVAILABLE, PUSH_AVAILABLE ? 'set' : 'not set (optional)',
        'Run "npx web-push generate-vapid-keys" and add both keys to BOTH Vercel projects (SETUP.md: "Phone alerts"), then redeploy.');

    const required = checks.filter((c) => ['Vercel env', 'Database', 'Discord login'].includes(c.step) && c.check !== 'at least one seller');
    const ready = required.every((c) => c.ok);
    const next = checks.find((c) => !c.ok && !String(c.detail).includes('optional'));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({
        app: APP,
        ready,
        summary: ready ? '✅ Core setup complete. Optional items below add Discord channel posts and DMs.' : `❌ Not ready yet. Next: ${next?.fix || 'see checks'}`,
        checks: checks.map((c) => ({ ...c, ok: c.ok ? '✅' : (String(c.detail).includes('optional') ? '➖' : '❌') }))
    }, null, 2));
}
