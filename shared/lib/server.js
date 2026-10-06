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
            // Our own errors (HttpError) are written for players. Anything else (database, Discord, bugs) can
            // reveal internals, so the browser only gets a generic message; the details are in the Vercel logs.
            const message = err instanceof HttpError ? err.message : 'Something went wrong on the server. Try again in a moment.';
            res.status(status).json({ ok: false, error: message });
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

    // SECURITY: who someone is on Discord comes only from their Discord login (auth identities, written by
    // Supabase during OAuth). user_metadata is editable by the user, so it is never used. If the stored row
    // disagrees (an account tampered with before the schema fix), trust the login and repair the row.
    const identity = discordIdentity(data.user);
    if (account.discord_id !== identity.id) {
        console.warn(`Account ${account.id}: stored Discord ID ${account.discord_id} != login ${identity.id}. Using the login.`);
        if (identity.id) await db.from('accounts').update({ discord_id: null }).eq('discord_id', identity.id).neq('id', account.id);
        await db.from('accounts').update({ discord_id: identity.id }).eq('id', account.id);
        account.discord_id = identity.id;
        // Seller access that came from the borrowed ID's Discord role is gone until the real one has the role.
        await db.from('sellers').update({ active: false }).eq('user_id', account.id).eq('source', 'discord_role');
    }
    if (identity.name) account.display_name = identity.name;
    if (identity.username) account.discord_username = identity.username;
    return account;
}

// The Discord account a Supabase user signed in with. Only fields Supabase sets during the OAuth login.
export function discordIdentity(user) {
    const ident = (user?.identities || []).find((i) => i.provider === 'discord');
    const d = ident?.identity_data || {};
    const id = String(d.provider_id || d.sub || ident?.id || '').trim();
    return {
        id: /^\d{5,25}$/.test(id) ? id : null,
        name: d.custom_claims?.global_name || d.full_name || d.name || null,
        username: d.user_name || d.name || d.full_name || null
    };
}

// Per-account rate limit, counted in the database (public.hit_rate_limit). Throws 429 when over.
// If the database function isn't installed yet (schema not re-run), it lets the request through.
export async function rateLimit(key, max, seconds, message = 'Too many tries. Wait a few minutes and try again.') {
    const { data, error } = await admin().rpc('hit_rate_limit', { p_key: key, p_max: max, p_seconds: seconds });
    if (error) { console.warn('rate limit unavailable:', error.message); return; }
    if (data === false) throw new HttpError(429, message);
}

export async function getSeller(accountId) {
    const { data } = await admin().from('sellers').select('*').eq('user_id', accountId).maybeSingle();
    return data && data.active ? data : null;
}

// For seller ACTIONS: like getSeller(), but people who are sellers because of their Discord role must
// still have that role. Re-checked with Discord at most every ROLE_RECHECK_MINUTES; losing the role
// switches the seller off immediately. If Discord can't be reached, a check from the last hour still counts.
const ROLE_RECHECK_MINUTES = 10;
export async function requireActiveSeller(account) {
    const seller = await getSeller(account.id);
    if (!seller) throw new HttpError(403, 'You are not on the seller list.');
    if (seller.source !== 'discord_role') return seller;
    const age = seller.role_checked_at ? Date.now() - new Date(seller.role_checked_at).getTime() : Infinity;
    if (age < ROLE_RECHECK_MINUTES * 60e3) return seller;
    const has = account.discord_id ? await hasSellerRole(account.discord_id) : false;
    if (has === false) {
        await admin().from('sellers').update({ active: false }).eq('user_id', account.id).eq('source', 'discord_role');
        throw new HttpError(403, 'You no longer have the seller role on Discord, so your seller access was switched off.');
    }
    if (has === null) {
        if (age < 60 * 60e3) return seller;
        throw new HttpError(503, "Couldn't confirm your seller role with Discord right now. Try again in a minute.");
    }
    await markRoleChecked(account.id);
    return seller;
}
export async function markRoleChecked(accountId) {
    const { error } = await admin().from('sellers').update({ role_checked_at: new Date().toISOString() }).eq('user_id', accountId);
    if (error) console.warn('role_checked_at not saved (re-run schema.sql?):', error.message);
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
// Player-typed text shown on Discord: escape markdown so nobody can post masked links ([text](url)),
// fake formatting or mentions inside an official Echo Market message.
// Discord turns "https://…", "www.…" and "discord.gg/…" into clickable links even inside embeds.
// An invisible zero-width space after "://" and after dots between letters stops that, so player text
// (airline names, notes, reasons) always shows as plain text. Use plain() where markdown isn't parsed
// (embed titles), md() everywhere else.
export const plain = (value) => String(value ?? '')
    .replace(/:\/\//g, ':\u200b//')
    .replace(/([A-Za-z0-9])\.(?=[A-Za-z0-9])/g, '$1.\u200b')
    .replace(/@/g, '@\u200b');
export const md = (value) => plain(value).replace(/([\\*_~`|>\[\]()#<-])/g, '\\$1');
// All buyer airlines an order may be delivered to (older orders: just the one).
export function orderAirlines(order) {
    const list = Array.isArray(order.airlines) ? order.airlines.filter((a) => a && a.name) : [];
    return list.length ? list : [{ id: order.airline_id, name: order.airline_name, alliance: order.alliance }];
}
const airlineList = (order) => orderAirlines(order).map((a) => `**${md(a.name)}**${a.alliance ? ` (${md(a.alliance)})` : ''}`);
// "#42 · ECH-1A2B3C4D": the order's serial number (counts up from 1) plus its code.
export const orderRef = (order) => (order.serial ? `#${order.serial} · ${order.id}` : order.id);

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

// Embed side-bar colours, used for channel posts and DMs alike.
// Black is 0x010101: Discord treats 0x000000 as "no colour" and would show its default grey.
export const EMBED_COLORS = {
    request: 0xFFFFFF,     // new / back in the queue: white
    progress: 0x808080,    // taken / partly delivered: grey, halfway between black and white
    fulfilled: 0x010101,   // fully delivered: black
    declined: 0xED4245,    // declined for everyone: Discord red
    cancelled: 0x64748B
};
const STATUS_META = {
    PENDING:   { label: '⏳ Waiting for a seller', color: EMBED_COLORS.request,   channel: 'request' },
    CLAIMED:   { label: '🤝 Taken by a seller',    color: EMBED_COLORS.progress,  channel: 'progress' },
    PARTIAL:   { label: '🟡 Partially delivered',  color: EMBED_COLORS.progress,  channel: 'progress' },
    FULFILLED: { label: '✅ Fulfilled',            color: EMBED_COLORS.fulfilled, channel: 'fulfilled' },
    CANCELLED: { label: '✖️ Cancelled by buyer',   color: EMBED_COLORS.cancelled, channel: null },
    DECLINED:  { label: '⛔ Declined',             color: EMBED_COLORS.declined,  channel: null }
};

function buildEmbed(order, title, flag, declines = []) {
    const handoff = order.status === 'PENDING' && order.filled > 0;
    const meta = handoff ? { ...STATUS_META.PENDING, label: '🔁 Partly delivered — needs a new seller' } : (STATUS_META[order.status] || STATUS_META.PENDING);
    const items = orderItems(order);
    const fields = [
        { name: 'Order', value: orderRef(order), inline: true },
        { name: orderAirlines(order).length > 1 ? 'Deliver to any of' : 'Buyer airline', value: airlineList(order).join('\n').slice(0, 1000), inline: true },
        { name: 'Buyer', value: /^\d+$/.test(order.buyer_discord_id || '') ? `<@${order.buyer_discord_id}>` : md(order.buyer_name || '-'), inline: true },
        {
            name: `Aircraft (${items.length} type${items.length === 1 ? '' : 's'})`,
            value: items.map((it) => `• **${it.qty}×** ${it.model} @ ${it.pricePercent}% — ${usd(it.totalUSD)}${it.note ? `\n  _${md(it.note)}_` : ''}`)
                .join('\n').slice(0, 1000) || '-',
            inline: false
        },
        { name: 'Total', value: usd(order.total_usd), inline: true },
        { name: 'Delivered', value: `${order.filled} / ${order.total_qty}`, inline: true },
        { name: 'Status', value: meta.label, inline: true }
    ];
    if (order.seller_airline_name) {
        fields.push({ name: 'Seller', value: `${md(order.seller_airline_name)}${order.seller_alliance ? ` (${md(order.seller_alliance)})` : ''} — ${md(order.seller_name || '')}`, inline: false });
    }
    const prev = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];
    if (prev.length) {
        fields.push({ name: 'Earlier sellers', value: prev.map((p) => `${md(p.seller_airline_name)} — ${p.delivered} delivered`).join('\n').slice(0, 1000), inline: false });
    }
    if (declines.length && order.status === 'PENDING') {
        fields.push({ name: `Passed by ${declines.length} seller${declines.length === 1 ? '' : 's'}`, value: declines.map((d) => md(d.seller_name)).join(', ').slice(0, 1000), inline: false });
    }
    if (order.buyer_note) fields.push({ name: '📝 Buyer note', value: md(order.buyer_note).slice(0, 1000), inline: false });
    if (order.seller_note) fields.push({ name: '🔖 Seller note', value: md(order.seller_note).slice(0, 1000), inline: false });
    if (order.closed_reason) fields.push({ name: 'Reason', value: md(order.closed_reason).slice(0, 1000), inline: false });
    if (flag && flag.status !== 'NORMAL') {
        fields.push({ name: flag.status === 'BLACKLISTED' ? '🚫 BLACKLISTED' : '🚩 SUSPICIOUS', value: md(flag.reason || '-').slice(0, 900) + `\n— ${md(flag.flagged_by)}`, inline: false });
    }
    return {
        title,
        url: SELLER_URL ? `${SELLER_URL}/#${order.id}` : undefined,
        color: meta.color,
        fields,
        footer: { text: `Echo Market • ${orderRef(order)}` },
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
            allowed_mentions: { parse: [], roles: ping ? [SELLER_ROLE_ID] : [], users: [] }
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
export async function sendDM(account, { title, description, color = EMBED_COLORS.progress, url, fields = [] }) {
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
    const seller = order.seller_airline_name ? `**${md(order.seller_airline_name)}**${order.seller_alliance ? ` (${md(order.seller_alliance)})` : ''}` : 'a seller';
    const buyerAirlines = airlineList(order).join(', ');
    const note = md(extra);
    const ref = orderRef(order);
    const lines = {
        CREATED: { title: `📦 Order ${ref} received`, color: EMBED_COLORS.request,
            description: `Your order for ${order.total_qty} aircraft for ${buyerAirlines} (${usd(order.total_usd)}) was sent to the seller team. You'll get a DM when a seller takes it and when it's delivered.` },
        CLAIMED: { title: `🤝 Your order ${ref} was taken`, color: EMBED_COLORS.progress,
            description: `${seller} will sell you ${order.total_qty} aircraft for ${buyerAirlines}. Watch for the sale in-game.` },
        PROGRESS: { title: `🟡 ${ref}: ${order.filled} of ${order.total_qty} delivered`, color: EMBED_COLORS.progress,
            description: `${seller} delivered more aircraft to ${buyerAirlines}.${extra ? `\n> ${note}` : ''}` },
        HANDOFF: { title: `🔁 ${ref}: looking for a new seller`, color: EMBED_COLORS.request,
            description: `${extra ? note : 'Your seller'} could not finish your order and passed the remaining ${order.total_qty - order.filled} aircraft to the other sellers. Nothing already delivered is lost.` },
        FULFILLED: { title: `✅ Your order ${ref} is complete`, color: EMBED_COLORS.fulfilled,
            description: `All ${order.total_qty} aircraft were delivered to ${buyerAirlines} by ${seller}. Enjoy the new fleet!` },
        DECLINED: { title: `⛔ Your order ${ref} was declined`, color: EMBED_COLORS.declined,
            description: `Reason: ${extra ? note : 'not given'}\nYou can place a new order any time.` }
    }[kind];
    if (lines) await sendDM(buyer, { ...lines, url });
}

// =====================================================================
//  Seller role → seller desk access. Anyone with the seller role (DISCORD_ROLE_ID, the same role new
//  orders ping) in a Discord server the bot is in can use the seller desk. DISCORD_GUILD_ID can pin
//  it to one server; otherwise every server the bot is in is checked.
// =====================================================================
export const SELLER_ROLE_SYNC = Boolean(BOT_TOKEN && SELLER_ROLE_ID);

// true / false = has the role or not; null = couldn't tell (Discord down, bad token…). Never throws.
export async function hasSellerRole(discordId) {
    if (!SELLER_ROLE_SYNC || !discordId) return null;
    try {
        let guildIds = env('DISCORD_GUILD_ID').split(',').map((s) => s.trim()).filter(Boolean);
        if (!guildIds.length) {
            const guilds = await discordBot('/users/@me/guilds');
            if (!guilds.ok) return null;
            guildIds = (guilds.json || []).map((g) => g.id);
        }
        let known = false;
        for (const id of guildIds) {
            const m = await discordBot(`/guilds/${id}/members/${discordId}`);
            if (m.ok) {
                known = true;
                if ((m.json.roles || []).includes(SELLER_ROLE_ID)) return true;
            } else if (m.status === 404) {
                known = true;   // not in this server
            }
        }
        return known ? false : null;
    } catch (err) {
        console.error('hasSellerRole failed:', err.message);
        return null;
    }
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
// Browser push services. Subscriptions pointing anywhere else are refused, so the server can't be made
// to send requests to arbitrary addresses. PUSH_EXTRA_HOSTS (comma-separated) is for local testing only.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
    /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];
export function pushEndpointAllowed(endpoint) {
    try {
        const u = new URL(endpoint);
        if (u.protocol !== 'https:') return false;
        const extra = env('PUSH_EXTRA_HOSTS').split(',').map((h) => h.trim()).filter(Boolean);
        return PUSH_HOSTS.some((re) => re.test(u.hostname)) || extra.includes(u.host);
    } catch { return false; }
}

export async function sendPush(accountId, { title, body, tag, url }) {
    if (!PUSH_AVAILABLE || !accountId) return 0;
    try {
        const { data: subs } = await admin().from('push_subscriptions').select('*').eq('account_id', accountId);
        if (!subs?.length) return 0;
        const wp = await webpush();
        const payload = JSON.stringify({ title, body, tag, url: url || (BUYER_URL ? `${BUYER_URL}/#orders` : '/#orders') });
        let sent = 0;
        await Promise.all(subs.filter((sub) => pushEndpointAllowed(sub.endpoint)).map(async (sub) => {
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
