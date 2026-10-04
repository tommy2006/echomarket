// Server helpers shared by every /api function of BOTH apps.
// Source of truth: shared/lib/server.js. Run "npm run sync" at the repo root after editing;
// it copies this file to buyer/lib and seller/lib (each Vercel project only sees its own folder).
import { createClient } from '@supabase/supabase-js';
import { APP } from './site.js';

const env = (...names) => names.map((n) => process.env[n]).find(Boolean) || '';

// Supabase. New projects issue "publishable" + "secret" keys; older ones "anon" + "service_role".
// Either pair works. The NEXT_PUBLIC_* names are what Vercel's Supabase integration creates.
export const SUPABASE_URL = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
export const SUPABASE_PUBLIC_KEY = env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SUPABASE_SECRET_KEY = env('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

// Public addresses of the two apps. This app's own address is detected on Vercel;
// the other app's address comes from BUYER_URL / SELLER_URL (set both in both Vercel projects).
const OWN_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
const clean = (u) => (u || '').replace(/\/$/, '');
export { APP };
export const BUYER_URL = clean(env('BUYER_URL') || (APP === 'buyer' ? OWN_URL : ''));
export const SELLER_URL = clean(env('SELLER_URL') || (APP === 'seller' ? OWN_URL : ''));

let adminClient = null;
// Secret-key client: bypasses Row Level Security. Server-side only, never sent to browsers.
export function admin() {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
        throw new HttpError(500, 'Server is not configured: SUPABASE_URL / SUPABASE_SECRET_KEY are missing in this Vercel project. Open /api/health for details.');
    }
    if (!adminClient) {
        adminClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
    }
    return adminClient;
}

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Wraps a handler: JSON errors, no caching, method check.
export function handler(methods, fn) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!methods.includes(req.method)) {
            res.setHeader('Allow', methods.join(', '));
            return res.status(405).json({ ok: false, error: 'Method not allowed' });
        }
        try {
            await fn(req, res);
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            if (status >= 500) console.error(err);
            res.status(status).json({ ok: false, error: err.message || 'Server error' });
        }
    };
}

// Reads "Authorization: Bearer <supabase access token>" and returns the account row.
export async function requireUser(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'Please sign in.');

    const db = admin();
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');

    const { data: account } = await db.from('accounts').select('*').eq('id', data.user.id).maybeSingle();
    if (!account) throw new HttpError(403, 'Market account not found. Sign out and sign in with Discord again.');
    return account;
}

export async function getSeller(accountId) {
    const { data } = await admin().from('sellers').select('*').eq('user_id', accountId).maybeSingle();
    return data && data.active ? data : null;
}

export function accountName(account) {
    return account.display_name || account.discord_username || 'Unknown';
}

export function body(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export function cleanText(value, max = 500) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function loadOrder(orderId) {
    const { data, error } = await admin().from('orders').select('*').eq('id', orderId).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, `Order ${orderId} not found.`);
    return data;
}

export async function addEvent(order, kind, actor, extra = {}) {
    const { error } = await admin().from('order_events').insert({
        order_id: order.id,
        buyer_id: order.buyer_id,
        kind,
        actor_id: actor?.id || null,
        actor_name: actor ? accountName(actor) : 'System',
        filled: extra.filled ?? null,
        message: extra.message || null
    });
    if (error) console.error('addEvent failed:', error.message);
}

// Order lines with per-type delivery. Each line carries:
//   filled  aircraft of that type delivered so far
//   locked  delivered before the current seller took over (they cannot lower it)
// Orders from before per-type delivery only have a total, so it is spread over the lines in order.
export function orderItems(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const hasPerLine = items.some((it) => typeof it.filled === 'number');
    let rest = hasPerLine ? 0 : Number(order.filled) || 0;
    return items.map((it) => {
        let filled = Number(it.filled);
        if (!hasPerLine) { filled = Math.min(it.qty, rest); rest -= filled; }
        filled = Math.max(0, Math.min(it.qty, Math.floor(filled) || 0));
        const locked = Math.max(0, Math.min(filled, Math.floor(Number(it.locked)) || 0));
        return { ...it, filled, locked };
    });
}
export const sumFilled = (items) => items.reduce((s, it) => s + it.filled, 0);

const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US');

// =====================================================================
//  Discord channel messages (webhooks) — one message per order, moved
//  between channels as its status changes.
// =====================================================================
const FALLBACK_WEBHOOK = env('DISCORD_WEBHOOK_URL');
export const WEBHOOKS = {
    request: env('DISCORD_WEBHOOK_REQUEST') || FALLBACK_WEBHOOK,
    progress: env('DISCORD_WEBHOOK_PROGRESS', 'DISCORD_WEBHOOK_PARTIAL') || FALLBACK_WEBHOOK,
    fulfilled: env('DISCORD_WEBHOOK_FULFILLED') || FALLBACK_WEBHOOK
};
const SELLER_ROLE_ID = env('DISCORD_ROLE_ID');

const STATUS_META = {
    PENDING:   { label: '⏳ Waiting for a seller', color: 0x94A3B8, channel: 'request' },
    CLAIMED:   { label: '🤝 Taken by a seller',    color: 0x38BDF8, channel: 'progress' },
    PARTIAL:   { label: '🟡 Partially delivered',  color: 0xF1C40F, channel: 'progress' },
    FULFILLED: { label: '✅ Fulfilled',            color: 0x2ECC71, channel: 'fulfilled' },
    CANCELLED: { label: '✖️ Cancelled by buyer',   color: 0x64748B, channel: null },
    DECLINED:  { label: '⛔ Declined',             color: 0xE11D48, channel: null }
};

function buildEmbed(order, title, flag, declines = []) {
    const handoff = order.status === 'PENDING' && order.filled > 0;
    const meta = handoff ? { ...STATUS_META.PENDING, label: '🔁 Partly delivered — needs a new seller' } : (STATUS_META[order.status] || STATUS_META.PENDING);
    const items = orderItems(order);
    const fields = [
        { name: 'Order', value: order.id, inline: true },
        { name: 'Buyer airline', value: `${order.airline_name}${order.alliance ? ` (${order.alliance})` : ''}`, inline: true },
        { name: 'Buyer', value: order.buyer_discord_id ? `<@${order.buyer_discord_id}>` : (order.buyer_name || '-'), inline: true },
        {
            name: `Aircraft (${items.length} type${items.length === 1 ? '' : 's'})`,
            value: items.map((it) => `• **${it.qty}×** ${it.model} @ ${it.pricePercent}% — ${usd(it.totalUSD)} · ${it.filled}/${it.qty} delivered${it.note ? `\n  _${it.note}_` : ''}`)
                .join('\n').slice(0, 1000) || '-',
            inline: false
        },
        { name: 'Total', value: usd(order.total_usd), inline: true },
        { name: 'Delivered', value: `${order.filled} / ${order.total_qty}`, inline: true },
        { name: 'Status', value: meta.label, inline: true }
    ];
    if (order.seller_airline_name) {
        fields.push({ name: 'Seller', value: `${order.seller_airline_name}${order.seller_alliance ? ` (${order.seller_alliance})` : ''} — ${order.seller_name || ''}`, inline: false });
    }
    const prev = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];
    if (prev.length) {
        fields.push({ name: 'Earlier sellers', value: prev.map((p) => `${p.seller_airline_name} — ${p.delivered} delivered`).join('\n').slice(0, 1000), inline: false });
    }
    if (declines.length && order.status === 'PENDING') {
        fields.push({ name: `Passed by ${declines.length} seller${declines.length === 1 ? '' : 's'}`, value: declines.map((d) => d.seller_name).join(', ').slice(0, 1000), inline: false });
    }
    if (order.buyer_note) fields.push({ name: '📝 Buyer note', value: order.buyer_note.slice(0, 1000), inline: false });
    if (order.seller_note) fields.push({ name: '🔖 Seller note', value: order.seller_note.slice(0, 1000), inline: false });
    if (order.closed_reason) fields.push({ name: 'Reason', value: order.closed_reason.slice(0, 1000), inline: false });
    if (flag && flag.status !== 'NORMAL') {
        fields.push({ name: flag.status === 'BLACKLISTED' ? '🚫 BLACKLISTED' : '🚩 SUSPICIOUS', value: (flag.reason || '-').slice(0, 900) + `\n— ${flag.flagged_by}`, inline: false });
    }
    return {
        title,
        url: SELLER_URL ? `${SELLER_URL}/#${order.id}` : undefined,
        color: meta.color,
        fields,
        footer: { text: `Echo Market • ${order.id}` },
        timestamp: new Date().toISOString()
    };
}

async function webhookCall(url, method, payload) {
    try {
        const res = await fetch(url, {
            method,
            headers: payload ? { 'Content-Type': 'application/json' } : undefined,
            body: payload ? JSON.stringify(payload) : undefined
        });
        if (!res.ok) return null;
        return method === 'DELETE' ? {} : await res.json().catch(() => ({}));
    } catch (err) {
        console.error(`Discord webhook ${method} failed:`, err.message);
        return null;
    }
}

// Posts / edits / moves the order's Discord message to match its current status.
// Never throws: Discord being down must not break the order itself.
export async function syncDiscord(order, title, { pingSellers = false } = {}) {
    try {
        const meta = STATUS_META[order.status] || STATUS_META.PENDING;
        const target = meta.channel;
        const current = order.discord_channel;
        const msgId = order.discord_message_id;

        const { data: flag } = await admin().from('order_flags').select('*').eq('order_id', order.id).maybeSingle();
        const { data: declines } = await admin().from('order_declines').select('seller_name').eq('order_id', order.id);
        const ping = pingSellers && SELLER_ROLE_ID;
        const payload = {
            content: ping ? `<@&${SELLER_ROLE_ID}> ${title}` : undefined,
            embeds: [buildEmbed(order, title, flag, declines || [])],
            allowed_mentions: { roles: ping ? [SELLER_ROLE_ID] : [], users: [] }
        };

        // Same channel → edit in place (a ping needs a fresh message, so repost then).
        if (msgId && current && current === target && WEBHOOKS[target] && !ping) {
            const edited = await webhookCall(`${WEBHOOKS[target]}/messages/${msgId}`, 'PATCH', payload);
            if (edited) return;
        }
        // Remove the old message (different channel, closed order, or failed edit).
        if (msgId && current && WEBHOOKS[current]) {
            await webhookCall(`${WEBHOOKS[current]}/messages/${msgId}`, 'DELETE');
        }
        let newId = null;
        if (target && WEBHOOKS[target]) {
            const posted = await webhookCall(`${WEBHOOKS[target]}?wait=true`, 'POST', {
                username: 'Echo Market',
                avatar_url: (BUYER_URL || SELLER_URL) ? `${BUYER_URL || SELLER_URL}/echo_logo.png` : undefined,
                ...payload
            });
            newId = posted?.id || null;
        }
        await admin().from('orders')
            .update({ discord_channel: newId ? target : null, discord_message_id: newId })
            .eq('id', order.id);
    } catch (err) {
        console.error('syncDiscord failed:', err.message);
    }
}

// =====================================================================
//  Discord DMs to buyers (via a bot). Needs DISCORD_BOT_TOKEN, and the
//  bot must be in the same Discord server as the buyer.
// =====================================================================
const BOT_TOKEN = env('DISCORD_BOT_TOKEN');
const DISCORD_API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
export const DM_AVAILABLE = Boolean(BOT_TOKEN);

export async function discordBot(path, method = 'GET', payload) {
    const res = await fetch(DISCORD_API + path, {
        method,
        headers: { Authorization: `Bot ${BOT_TOKEN}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
}

// Returns 'sent' | 'blocked' | 'off' | 'unavailable' | 'error'. Never throws.
export async function sendDM(account, { title, description, color = 0x38BDF8, url, fields = [] }) {
    if (!BOT_TOKEN) return 'unavailable';
    if (!account?.discord_id) return 'error';
    if (account.dm_enabled === false) return 'off';
    try {
        const ch = await discordBot('/users/@me/channels', 'POST', { recipient_id: account.discord_id });
        let result = 'error';
        if (ch.ok && ch.json.id) {
            const msg = await discordBot(`/channels/${ch.json.id}/messages`, 'POST', {
                embeds: [{ title, description, color, url, fields, footer: { text: 'Echo Market · turn these off in the 🔔 menu' }, timestamp: new Date().toISOString() }]
            });
            if (msg.ok) result = 'sent';
            // 50007 = user has DMs closed, or shares no server with the bot.
            else if (msg.json?.code === 50007) result = 'blocked';
            else console.error('DM send failed:', msg.status, JSON.stringify(msg.json));
        } else if (ch.json?.code === 50007) {
            result = 'blocked';
        } else {
            console.error('DM channel failed:', ch.status, JSON.stringify(ch.json));
        }
        if (result === 'sent' || result === 'blocked') {
            const dm_status = result === 'sent' ? 'ok' : 'blocked';
            if (account.dm_status !== dm_status) await admin().from('accounts').update({ dm_status }).eq('id', account.id);
        }
        return result;
    } catch (err) {
        console.error('sendDM failed:', err.message);
        return 'error';
    }
}

// DMs the buyer of an order about a status change. Never throws.
export async function dmBuyer(order, kind, extra = '') {
    if (!BOT_TOKEN || !order.buyer_id) return;
    const { data: buyer } = await admin().from('accounts').select('*').eq('id', order.buyer_id).maybeSingle();
    if (!buyer) return;
    const url = BUYER_URL ? `${BUYER_URL}/#orders` : undefined;
    const seller = order.seller_airline_name ? `**${order.seller_airline_name}**${order.seller_alliance ? ` (${order.seller_alliance})` : ''}` : 'a seller';
    const lines = {
        CREATED: { title: `📦 Order ${order.id} received`, color: 0x94A3B8,
            description: `Your order for ${order.total_qty} aircraft for **${order.airline_name}** (${usd(order.total_usd)}) was sent to the seller team. You'll get a DM when a seller takes it and when it's delivered.` },
        CLAIMED: { title: `🤝 Your order ${order.id} was taken`, color: 0x38BDF8,
            description: `${seller} will sell you ${order.total_qty} aircraft for **${order.airline_name}**. Watch for the sale in-game.` },
        PROGRESS: { title: `🟡 ${order.id}: ${order.filled} of ${order.total_qty} delivered`, color: 0xF1C40F,
            description: `${seller} delivered more aircraft to **${order.airline_name}**.${extra ? `\n> ${extra}` : ''}` },
        HANDOFF: { title: `🔁 ${order.id}: looking for a new seller`, color: 0xF59E0B,
            description: `${extra || 'Your seller'} could not finish your order and passed the remaining ${order.total_qty - order.filled} aircraft to the other sellers. Nothing already delivered is lost.` },
        FULFILLED: { title: `✅ Your order ${order.id} is complete`, color: 0x2ECC71,
            description: `All ${order.total_qty} aircraft were delivered to **${order.airline_name}** by ${seller}. Enjoy the new fleet!` },
        DECLINED: { title: `⛔ Your order ${order.id} was declined`, color: 0xE11D48,
            description: `Reason: ${extra || 'not given'}\nYou can place a new order any time.` }
    }[kind];
    if (lines) await sendDM(buyer, { ...lines, url });
}

// =====================================================================
//  Web push ("order delivered" alerts on phones and browsers, even with
//  the site closed). Needs VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY.
// =====================================================================
export const VAPID_PUBLIC_KEY = env('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = env('VAPID_PRIVATE_KEY');
export const PUSH_AVAILABLE = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
let webpushLib = null;
async function webpush() {
    if (!webpushLib) {
        webpushLib = (await import('web-push')).default;
        webpushLib.setVapidDetails(env('VAPID_SUBJECT') || BUYER_URL || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    }
    return webpushLib;
}

// Sends a notification to every device the account enabled alerts on.
// Returns how many devices accepted it. Never throws.
export async function sendPush(accountId, { title, body, tag, url }) {
    if (!PUSH_AVAILABLE || !accountId) return 0;
    try {
        const { data: subs } = await admin().from('push_subscriptions').select('*').eq('account_id', accountId);
        if (!subs?.length) return 0;
        const wp = await webpush();
        const payload = JSON.stringify({ title, body, tag, url: url || (BUYER_URL ? `${BUYER_URL}/#orders` : '/#orders') });
        let sent = 0;
        await Promise.all(subs.map(async (sub) => {
            try {
                await wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 60 * 60 * 24 });
                sent++;
            } catch (err) {
                // 404/410: the browser dropped this subscription (app uninstalled, permission revoked…)
                if (err.statusCode === 404 || err.statusCode === 410) {
                    await admin().from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
                } else {
                    console.error('push failed:', err.statusCode, err.body || err.message);
                }
            }
        }));
        return sent;
    } catch (err) {
        console.error('sendPush failed:', err.message);
        return 0;
    }
}
