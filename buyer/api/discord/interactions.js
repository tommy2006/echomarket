// POST /api/discord/interactions — the Echo Market bot's slash commands (Discord "Interactions Endpoint URL").
//
// Discord sends every command here, signed with the app's key: requests without a valid signature are refused
// (DISCORD_PUBLIC_KEY, from Developer Portal → General Information). Replies are private to the person who
// ran the command. The rules are the website's own: lib/moderation.js (bans, warnings) and lib/orders.js
// (orders), so a ban or an order from Discord is exactly the same as one from the website.
//
//   /market ban|unban|warn|message|info   Market Admins only (DISCORD_MARKET_ADMIN_ROLE_ID), checked here too
//   /airline create|list                   any member who has signed in on the website once
//   /order                                 same, then "Send order" / "Cancel" buttons
// /airline and /order only work in the ordering channel(s) chosen on the seller desk (market_settings
// order_channel_ids; empty = any channel). /market works everywhere.
import { createPublicKey, verify } from 'crypto';
import { waitUntil } from '@vercel/functions';
import {
    admin, accountName, cleanText, requireMarketAccess, rateLimit, activeBan, banText, orderRef, getSetting, ROLE_IDS, GUILD_IDS,
    DISCORD_API, BUYER_URL, HttpError
} from '../../lib/server.js';
import { resolveTarget, issueBan, liftBan, sendMarketMessage, moderationSummary } from '../../lib/moderation.js';
import { previewOrder, placeOrder } from '../../lib/orders.js';
import { AIRCRAFT, PRICE_LEVELS } from '../../lib/pricing.js';

// Discord reads the raw body for the signature, so it must not be parsed first.
export const config = { api: { bodyParser: false } };

const PUBLIC_KEY = (process.env.DISCORD_PUBLIC_KEY || '').trim();
const PENDING_MINUTES = 15;
const EPHEMERAL = 64;
const MAX_AIRLINES = 20;

// ------------------------------------------------------------------ signature
let keyObject = null;
function signatureValid(req, raw) {
    const sig = String(req.headers['x-signature-ed25519'] || '');
    const ts = String(req.headers['x-signature-timestamp'] || '');
    if (!/^[0-9a-f]{64}$/i.test(PUBLIC_KEY) || !/^[0-9a-f]{128}$/i.test(sig) || !/^\d+$/.test(ts)) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;   // older than 5 minutes: replay
    try {
        keyObject ||= createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBLIC_KEY, 'hex')]), format: 'der', type: 'spki' });
        return verify(null, Buffer.from(ts + raw), keyObject, Buffer.from(sig, 'hex'));
    } catch { return false; }
}
async function readRaw(req) {
    if (typeof req.rawBody === 'string') return req.rawBody;
    const chunks = [];
    for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks).toString('utf8');
}

// ------------------------------------------------------------------ replies
const say = (content, extra = {}) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...extra } });
const thinking = () => ({ type: 5, data: { flags: EPHEMERAL } });
async function editReply(i, data) {
    try {
        const r = await fetch(`${DISCORD_API}/webhooks/${i.application_id}/${i.token}/messages/@original`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowed_mentions: { parse: [] }, ...data })
        });
        if (!r.ok) console.error('editing the reply failed:', r.status, await r.text().catch(() => ''));
    } catch (err) { console.error('editing the reply failed:', err.message); }
}
// Answer "working on it…" now, finish the work after the reply (Discord allows 3 seconds for the first answer).
function later(i, work, { update = false } = {}) {
    const job = (async () => {
        try { await editReply(i, await work()); }
        catch (err) { await editReply(i, { content: `⚠️ ${err instanceof HttpError ? err.message : 'Something went wrong. Try again in a moment.'}`, embeds: [], components: [] }); if (!(err instanceof HttpError)) console.error(err); }
    })();
    waitUntil(job);
    return update ? { type: 6 } : thinking();
}

const opts = (list = []) => Object.fromEntries(list.map((o) => [o.name, o.value]));
const memberName = (m, u) => m?.nick || u?.global_name || u?.username || 'someone';
const signInText = () => `You need a market account first: sign in once on ${BUYER_URL || 'the Echo Market website'} with Discord, then try again.`;

async function accountFor(discordId) {
    const { data } = await admin().from('accounts').select('*').eq('discord_id', discordId).maybeSingle();
    return data || null;
}

// ------------------------------------------------------------------ /market (Market Admins)
const LENGTH_TEXT = { week: '1 week', month: '1 month', permanent: 'permanently' };
const delivered = (d = {}) => [d.dm === 'sent' ? 'DM sent' : d.dm && d.dm !== 'skipped' ? "DM couldn't be delivered" : null,
    d.role === true ? 'Market Banned role updated' : d.role === false ? 'role not changed' : null,
    d.logged ? 'logged' : d.logged === false ? 'not logged' : null].filter(Boolean).join(' · ');

async function market(i) {
    const roles = i.member?.roles || [];
    if (!ROLE_IDS.marketAdmin || !roles.includes(ROLE_IDS.marketAdmin)) return say('⛔ Only Market Admins can use `/market`.');
    const sub = i.data.options?.[0];
    const o = opts(sub?.options);
    const me = i.member.user;
    await rateLimit('moderation-bot:' + me.id, 60, 600);
    const myAccount = await accountFor(me.id);
    const by = { accountId: myAccount?.id || null, name: memberName(i.member, me) };
    const targetId = String(o.user || '');
    const targetUser = i.data.resolved?.users?.[targetId];
    const targetMember = i.data.resolved?.members?.[targetId];
    const targetName = memberName(targetMember, targetUser);
    if (targetUser?.bot) return say("Bots can't be moderated with `/market`.");

    switch (sub?.name) {
        case 'ban':
            if (targetId === me.id) return say("You can't ban yourself.");
            if ((targetMember?.roles || []).includes(ROLE_IDS.marketAdmin)) return say("You can't market-ban another Market Admin.");
            return later(i, async () => {
                const target = await resolveTarget({ discordId: targetId, name: targetName });
                const { ban, delivery } = await issueBan({ target, duration: o.length, reason: o.reason, by, source: 'bot' });
                return { content: `⛔ **${targetName}** is banned from Echo Market ${o.length === 'permanent' ? 'permanently' : banText(ban)}.\n${delivered(delivery)}` };
            });
        case 'unban':
            return later(i, async () => {
                const ban = await activeBan(targetId);
                if (!ban) return { content: `**${targetName}** isn't market-banned.` };
                const { delivery } = await liftBan({ ban, note: o.note, by, source: 'bot' });
                return { content: `✅ **${targetName}**'s market ban was lifted.\n${delivered(delivery)}` };
            });
        case 'warn':
        case 'message':
            return later(i, async () => {
                const target = await resolveTarget({ discordId: targetId, name: targetName });
                const { delivery } = await sendMarketMessage({ target, kind: sub.name === 'warn' ? 'warning' : 'info', body: o.message, by, source: 'bot' });
                return { content: `${sub.name === 'warn' ? '⚠️ Warning' : '📣 Message'} sent to **${targetName}**.\n${delivered(delivery)}` };
            });
        case 'info':
            return later(i, async () => {
                const s = await moderationSummary(targetId);
                const lines = [
                    s.ban ? `⛔ **Market banned** ${s.ban.ends_at ? banText(s.ban) : 'permanently'}: ${s.ban.reason} (by ${s.ban.issued_by_name || 'an admin'})` : '✅ Not market-banned.',
                    `⚠️ ${s.warnings} warning${s.warnings === 1 ? '' : 's'} · 📣 ${s.messages - s.warnings} other message${s.messages - s.warnings === 1 ? '' : 's'}`,
                    s.onMarket ? (s.orders.length ? `📦 Recent orders: ${s.orders.map((x) => `${orderRef(x)} (${x.status.toLowerCase()}, ${x.total_qty} aircraft)`).join(' · ')}` : '📦 No orders yet.') : 'Has never signed in on Echo Market.'
                ];
                return { content: `**${targetName}**\n${lines.join('\n')}` };
            });
        default:
            return say('Unknown command.');
    }
}

// ------------------------------------------------------------------ /airline
async function airline(i) {
    const me = i.member.user;
    const account = await accountFor(me.id);
    if (!account) return say(signInText());
    const sub = i.data.options?.[0];
    const db = admin();
    if (sub?.name === 'list') {
        const { data } = await db.from('airlines').select('name, alliance').eq('owner_id', account.id).order('created_at');
        if (!data?.length) return say('You have no airline profiles yet. Create one with `/airline create`.');
        return say(`**Your airlines (${data.length}/${MAX_AIRLINES})**\n${data.map((a) => `• ${a.name} (${a.alliance})`).join('\n')}`);
    }
    if (sub?.name === 'create') {
        const o = opts(sub.options);
        await requireMarketAccess(account);
        await rateLimit('airline-bot:' + me.id, 20, 600);
        const name = cleanText(o.name, 60);
        const { data: alliance } = await db.from('alliances').select('name').eq('name', String(o.alliance || '')).maybeSingle();
        if (!alliance) return say('Pick an alliance from the list.');
        const { data, error } = await db.from('airlines').insert({ owner_id: account.id, name, alliance: alliance.name }).select().single();
        if (error) {
            if (error.code === '23505') return say(`You already have an airline called **${name}**.`);
            if (error.code === '23514') return say('Airline names must be 2–60 characters, with no web addresses or invite links.');
            if (error.code === 'P0001') return say(`You already have ${MAX_AIRLINES} airline profiles, the maximum.`);
            throw error;
        }
        const { count } = await db.from('airlines').select('id', { count: 'exact', head: true }).eq('owner_id', account.id);
        return say(`✈️ Created **${data.name}** (${data.alliance}). You have ${count}/${MAX_AIRLINES} airline profiles; they also show on the website.`);
    }
    return say('Unknown command.');
}

// ------------------------------------------------------------------ /order
const findModel = (text) => {
    const t = String(text || '').trim().toLowerCase();
    return AIRCRAFT.find((a) => a.model.toLowerCase() === t) || null;
};
const short = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : `$${Math.round(n).toLocaleString('en-US')}`);

async function order(i) {
    const me = i.member.user;
    const account = await accountFor(me.id);
    if (!account) return say(signInText());
    const o = opts(i.data.options);
    const aircraft = findModel(o.aircraft);
    if (!aircraft) return say(`I couldn't find the aircraft **${cleanText(o.aircraft, 80)}**. Start typing its name and pick one of the suggestions.`);
    if (!PRICE_LEVELS.includes(Number(o.price))) return say('Pick a price level from the list.');
    const airlineIds = [o.airline, o.airline2, o.airline3].filter(Boolean);
    const payload = { airlineIds, items: [{ model: aircraft.model, qty: Number(o.quantity), pricePercent: Number(o.price), note: cleanText(o.note, 200) }] };
    return later(i, async () => {
        const p = await previewOrder(account, payload);
        const { data: pending, error } = await admin().from('bot_pending_orders')
            .insert({ discord_id: me.id, account_id: account.id, payload }).select('id').single();
        if (error) throw error;
        const it = p.items[0];
        return {
            content: '',
            embeds: [{
                title: '🛒 Your order — check it, then send',
                color: 0xFFFFFF,
                fields: [
                    { name: 'Aircraft', value: `${it.qty}× ${it.model}`, inline: true },
                    { name: 'Price level', value: `${it.pricePercent}% of list (${100 - it.pricePercent}% off)`, inline: true },
                    { name: 'Total', value: short(p.totalUSD), inline: true },
                    { name: p.airlines.length > 1 ? 'Deliver to any of' : 'Deliver to', value: p.airlines.map((a) => `${a.name} (${a.alliance})`).join('\n') },
                    { name: '24-hour limit (at list price)', value: `${short(p.used + p.listTotalUSD)} of ${short(p.limit)} after this order` },
                    ...(it.note ? [{ name: 'Note for the seller', value: it.note }] : [])
                ],
                footer: { text: `Expires in ${PENDING_MINUTES} minutes · only you can see this` }
            }],
            components: [{ type: 1, components: [
                { type: 2, style: 3, label: 'Send order', custom_id: `order:send:${pending.id}` },
                { type: 2, style: 2, label: 'Cancel', custom_id: `order:cancel:${pending.id}` }
            ] }]
        };
    });
}

async function orderButton(i) {
    const [, action, id] = String(i.data.custom_id || '').split(':');
    const me = (i.member || i).user;
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) return say('This button has expired.');
    const db = admin();
    const { data: pending } = await db.from('bot_pending_orders').select('*').eq('id', id).maybeSingle();
    if (!pending || pending.discord_id !== me.id) return say("This isn't your order.");
    const closed = (content) => ({ type: 7, data: { content, embeds: [], components: [] } });
    if (pending.used_at) return closed('This order was already sent or cancelled.');
    if (Date.now() - new Date(pending.created_at).getTime() > PENDING_MINUTES * 60e3) return closed('⌛ This order expired. Run `/order` again.');
    // Claim it, so a double click can't send it twice.
    const { data: claimed } = await db.from('bot_pending_orders').update({ used_at: new Date().toISOString() }).eq('id', id).is('used_at', null).select('id');
    if (!claimed?.length) return closed('This order was already sent or cancelled.');
    if (action === 'cancel') return closed('Order cancelled. Nothing was sent.');
    return later(i, async () => {
        const account = await accountFor(me.id);
        if (!account) throw new HttpError(403, signInText());
        const placed = await placeOrder(account, pending.payload);
        return {
            content: `✅ **Order ${orderRef(placed)} sent to the sellers.** You'll get a DM when a seller takes it. Follow it on ${BUYER_URL ? `${BUYER_URL}/#orders` : 'the website'}.`,
            embeds: [], components: []
        };
    }, { update: true });
}

// ------------------------------------------------------------------ autocomplete
async function autocomplete(i) {
    const me = i.member?.user || i.user;
    const top = i.data.options?.[0];
    const list = top?.type === 1 ? top.options || [] : i.data.options || [];
    const focused = list.find((o) => o.focused);
    const typed = String(focused?.value || '').toLowerCase();
    let choices = [];
    if (i.data.name === 'order' && /^airline\d?$/.test(focused?.name)) {
        const account = await accountFor(me.id);
        if (account) {
            const { data } = await admin().from('airlines').select('id, name, alliance').eq('owner_id', account.id).order('created_at');
            choices = (data || []).filter((a) => !typed || a.name.toLowerCase().includes(typed))
                .map((a) => ({ name: `${a.name} (${a.alliance})`.slice(0, 100), value: a.id }));
        }
    } else if (i.data.name === 'order' && focused?.name === 'aircraft') {
        const norm = (s) => s.toLowerCase().replace(/[\s\-_.]/g, '');
        const q = norm(typed);
        choices = AIRCRAFT.filter((a) => !q || norm(a.model).includes(q))
            .map((a) => ({ name: `${a.model} · list ${short(a.price)}`.slice(0, 100), value: a.model }));
    } else if (i.data.name === 'airline' && focused?.name === 'alliance') {
        const { data } = await admin().from('alliances').select('name').order('sort_order');
        choices = (data || []).filter((a) => !typed || a.name.toLowerCase().includes(typed)).map((a) => ({ name: a.name, value: a.name }));
    }
    return { type: 8, data: { choices: choices.slice(0, 25) } };
}

// The ordering channel(s), or null when buyers may use the commands anywhere.
async function wrongChannel(i) {
    const ids = await getSetting('order_channel_ids', []);
    if (!Array.isArray(ids) || !ids.length) return null;
    return ids.includes(i.channel_id || i.channel?.id) ? null : ids;
}
const BUYER_COMMANDS = ['order', 'airline'];

// ------------------------------------------------------------------ entry
export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method not allowed'); }
    const raw = await readRaw(req);
    if (!signatureValid(req, raw)) { res.statusCode = 401; return res.end('invalid request signature'); }
    let i;
    try { i = JSON.parse(raw); } catch { res.statusCode = 400; return res.end('bad request'); }
    const send = (body) => { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

    if (i.type === 1) return send({ type: 1 });   // Discord's "ping" when you save the endpoint URL
    try {
        if (!i.guild_id || (GUILD_IDS.length && !GUILD_IDS.includes(i.guild_id))) {
            return send(i.type === 4 ? { type: 8, data: { choices: [] } } : say('Use Echo Market commands in the Echo Alliances server.'));
        }
        if ((i.type === 2 || i.type === 4) && BUYER_COMMANDS.includes(i.data?.name)) {
            const ids = await wrongChannel(i);
            if (ids) {
                if (i.type === 4) return send({ type: 8, data: { choices: [] } });
                return send(say(`🛒 Echo Market ordering happens in ${ids.map((id) => `<#${id}>`).join(' or ')}. Use \`/${i.data.name}\` there.`));
            }
        }
        if (i.type === 4) return send(await autocomplete(i));
        if (i.type === 3 && String(i.data?.custom_id || '').startsWith('order:')) return send(await orderButton(i));
        if (i.type === 2) {
            if (i.data.name === 'market') return send(await market(i));
            if (i.data.name === 'airline') return send(await airline(i));
            if (i.data.name === 'order') return send(await order(i));
        }
        return send(say('Unknown command.'));
    } catch (err) {
        if (!(err instanceof HttpError)) console.error(err);
        return send(say(`⚠️ ${err instanceof HttpError ? err.message : 'Something went wrong. Try again in a moment.'}`));
    }
}
