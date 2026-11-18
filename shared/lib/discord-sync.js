// Keeps three things on Discord in step with the seller desk (all optional, each needs the bot):
//
//   Vacation role     (DISCORD_VACATION_ROLE_ID)     given while a seller is on vacation, taken back when they return.
//   Hidden channels   (the order channels behind DISCORD_WEBHOOK_REQUEST / _PROGRESS / _FULFILLED)
//                     hidden from a seller during their vacation with a per-member "View Channel: deny" overwrite,
//                     so order posts and pings in them can't reach them. Removed again when they return.
//   Order Pings role  (DISCORD_ORDER_PINGS_ROLE_ID)  the role new orders ping. Every active seller with a seller
//                     rank (Lead Ambassador, Ambassador, Verified Seller) who isn't Unranked has it, except while on
//                     vacation. Community Managers without a seller role, tech-only admins and resigned sellers don't.
//
// When: at once when a vacation starts or ends early (lib/vacation.js), when a seller opens the desk (api/enroll.js;
// this also ends a vacation that ran out), and for everyone in the daily /api/cron/bans run.
// Discord setup: the bot's role must have "Manage Roles" and sit ABOVE Vacation and Order Pings; in each order
// channel the bot needs "View Channel" and "Manage Permissions". Nothing here ever throws: Discord being down or a
// missing permission must not break the desk. Problems are returned (and shown on /api/health).
import { admin, discordBot, onVacation, ROLE_IDS, RANKS, GUILD_IDS, WEBHOOKS, DM_AVAILABLE } from './server.js';

const VIEW_CHANNEL = 1n << 10n;
const DAY = 864e5;
const RECENT_DAYS = 7;   // a vacation that ended this recently may still have hidden channels to undo

// Roles the bot must never take away by mistake (a wrong ID in DISCORD_VACATION_ROLE_ID / DISCORD_ORDER_PINGS_ROLE_ID).
function protectedRoles() {
    return new Set([ROLE_IDS.lead, ROLE_IDS.ambassador, ROLE_IDS.verified, ROLE_IDS.marketAdmin, ROLE_IDS.communityManager,
        ROLE_IDS.marketBanned, ROLE_IDS.resonant, ROLE_IDS.allianceLeader, process.env.DISCORD_ROLE_ID].filter(Boolean));
}

// { guild, vacationRole, pingsRole, problems[] }: what the bot may manage. A role that is also a desk or
// moderation role is switched off here (and reported), so the bot can't strip Verified Seller from someone.
export function syncConfig() {
    const prot = protectedRoles();
    const problems = [];
    const pick = (id, env) => {
        if (!id) return null;
        if (prot.has(id)) { problems.push(`${env} is the same role as a seller, admin or moderation role: it must be its own new role.`); return null; }
        return id;
    };
    const vacationRole = pick(ROLE_IDS.vacation, 'DISCORD_VACATION_ROLE_ID');
    const pingsRole = pick(ROLE_IDS.orderPings, 'DISCORD_ORDER_PINGS_ROLE_ID');
    if (vacationRole && vacationRole === pingsRole) problems.push('DISCORD_VACATION_ROLE_ID and DISCORD_ORDER_PINGS_ROLE_ID must be two different roles.');
    return { guild: DM_AVAILABLE ? GUILD_IDS[0] || null : null, vacationRole, pingsRole: pingsRole === vacationRole ? null : pingsRole, problems };
}

// The channels behind the order webhooks (asked from Discord once per server instance). Webhook URLs answer
// a plain GET with their channel_id, no token needed.
let channelCache = null;
export async function orderChannelIds() {
    if (channelCache && Date.now() - channelCache.at < 60 * 60e3) return channelCache.ids;
    const ids = new Set();
    let complete = true;
    for (const url of new Set(Object.values(WEBHOOKS).filter(Boolean))) {
        try {
            const r = await fetch(url);
            const j = await r.json().catch(() => ({}));
            if (r.ok && j.channel_id) ids.add(String(j.channel_id)); else complete = false;
        } catch { complete = false; }
    }
    const list = [...ids];
    if (complete) channelCache = { at: Date.now(), ids: list };
    return list;
}

// Should this seller have Order Pings? rank: their seller rank from Discord, or the hand-set one for sellers
// added by hand.
export function wantsOrderPings(row, roles, now = Date.now()) {
    if (!row || !row.active || row.unranked || onVacation(row, now)) return false;
    const fromRoles = roles ? RANKS.find((r) => ROLE_IDS[r] && roles.includes(ROLE_IDS[r])) : null;
    const rank = fromRoles || (row.source !== 'discord_role' ? row.rank : null);
    return RANKS.includes(rank);
}

// One Discord call, retried once after a short rate-limit wait.
async function call(path, method, payload, reason) {
    let r = await discordBot(path, method, payload, { reason });
    if (r.status === 429) {
        const wait = Math.min(3, Number(r.json?.retry_after) || 1);
        await new Promise((ok) => setTimeout(ok, wait * 1000));
        r = await discordBot(path, method, payload, { reason });
    }
    return r;
}

async function setRole(guild, discordId, roleId, on, reason) {
    const r = await call(`/guilds/${guild}/members/${discordId}/roles/${roleId}`, on ? 'PUT' : 'DELETE', undefined, reason);
    return r.ok || (!on && r.status === 404) ? null : `role ${on ? 'add' : 'removal'} refused (HTTP ${r.status})`;
}

// Hides (or shows again) one channel for one member, keeping any other overwrite bits someone set by hand.
// channels: a Map shared by one run, so each channel is read from Discord once.
async function setHidden(channelId, discordId, hide, channels, reason) {
    let ch = channels.get(channelId);
    if (!ch) {
        const r = await call(`/channels/${channelId}`, 'GET');
        if (!r.ok) return `can't read channel ${channelId} (HTTP ${r.status})`;
        ch = r.json; channels.set(channelId, ch);
    }
    const ow = (ch.permission_overwrites || []).find((o) => String(o.id) === String(discordId) && Number(o.type) === 1);
    const allow = BigInt(ow?.allow || 0), deny = BigInt(ow?.deny || 0);
    const hidden = (deny & VIEW_CHANNEL) !== 0n && (allow & VIEW_CHANNEL) === 0n;
    if (hide === hidden) return null;
    let r;
    if (hide) {
        r = await call(`/channels/${channelId}/permissions/${discordId}`, 'PUT',
            { type: 1, allow: String(allow & ~VIEW_CHANNEL), deny: String(deny | VIEW_CHANNEL) }, reason);
    } else {
        const rest = deny & ~VIEW_CHANNEL;
        r = !rest && !allow
            ? await call(`/channels/${channelId}/permissions/${discordId}`, 'DELETE', undefined, reason)
            : await call(`/channels/${channelId}/permissions/${discordId}`, 'PUT', { type: 1, allow: String(allow), deny: String(rest) }, reason);
    }
    if (!r.ok && !(r.status === 404 && !hide)) return `can't ${hide ? 'hide' : 'show'} channel ${channelId} (HTTP ${r.status}: the bot needs Manage Permissions there)`;
    // Keep the cached copy in step for the rest of this run.
    const others = (ch.permission_overwrites || []).filter((o) => o !== ow);
    const next = hide ? { id: String(discordId), type: 1, allow: String(allow & ~VIEW_CHANNEL), deny: String(deny | VIEW_CHANNEL) }
        : (deny & ~VIEW_CHANNEL) || allow ? { id: String(discordId), type: 1, allow: String(allow), deny: String(deny & ~VIEW_CHANNEL) } : null;
    ch.permission_overwrites = next ? [...others, next] : others;
    return null;
}

// Brings one seller's Discord in step. row: their sellers row; roles: their role ids if already known (saves a call).
// channels: true = always check the order channels; 'auto' = only when it may be needed (see below).
// Returns { changes: [...], problems: [...] }.
export async function syncSeller(row, discordId, { roles = null, channels = 'auto', channelMap = new Map(), now = Date.now() } = {}) {
    const out = { changes: [], problems: [] };
    const cfg = syncConfig();
    if (!cfg.guild || !discordId || !row) return out;
    try {
        if (!roles) {
            const m = await call(`/guilds/${cfg.guild}/members/${discordId}`, 'GET');
            if (m.status === 404) return out;   // not in the server: nothing to keep in step
            if (!m.ok) { out.problems.push(`member lookup failed (HTTP ${m.status})`); return out; }
            roles = m.json.roles || [];
        }
        const away = onVacation(row, now);
        let vacationRoleChanged = false;
        if (cfg.vacationRole && roles.includes(cfg.vacationRole) !== away) {
            const err = await setRole(cfg.guild, discordId, cfg.vacationRole, away, away ? 'Echo Market: vacation started' : 'Echo Market: back from vacation');
            if (err) out.problems.push(`Vacation ${err}`); else { out.changes.push(away ? '+vacation' : '-vacation'); vacationRoleChanged = true; }
        }
        if (cfg.pingsRole) {
            const want = wantsOrderPings(row, roles, now);
            if (roles.includes(cfg.pingsRole) !== want) {
                const err = await setRole(cfg.guild, discordId, cfg.pingsRole, want, want ? 'Echo Market: active seller' : away ? 'Echo Market: on vacation' : 'Echo Market: not an active seller');
                if (err) out.problems.push(`Order Pings ${err}`); else out.changes.push(want ? '+pings' : '-pings');
            }
        }
        // Channels. 'auto': with a Vacation role, only when that role just changed (it marks the hidden state);
        // without one, while away or for a week after a vacation ended.
        const until = row.vacation_until ? new Date(row.vacation_until).getTime() : 0;
        const recent = until && now - until < RECENT_DAYS * DAY;
        const check = channels === true || (channels === 'auto' && (cfg.vacationRole ? vacationRoleChanged : away || recent));
        if (check) {
            for (const id of await orderChannelIds()) {
                const err = await setHidden(id, discordId, away, channelMap, away ? 'Echo Market: vacation started' : 'Echo Market: back from vacation');
                if (err) out.problems.push(err);
            }
            out.changes.push(away ? 'channels hidden' : 'channels checked');
        }
    } catch (err) {
        out.problems.push(err.message);
    }
    if (out.problems.length) console.warn('discord sync for', row.user_id, out.problems.join('; '));
    return out;
}

// Same, from a market account id (loads their sellers row and Discord id).
export async function syncSellerById(accountId, opts = {}) {
    const db = admin();
    const [{ data: row }, { data: acc }] = await Promise.all([
        db.from('sellers').select('*').eq('user_id', accountId).maybeSingle(),
        db.from('accounts').select('discord_id').eq('id', accountId).maybeSingle()
    ]);
    return syncSeller(row, acc?.discord_id, opts);
}

// Everyone on the seller list (the daily cron). Stops after budgetMs and says how far it got.
export async function syncAllSellers({ budgetMs = 8000 } = {}) {
    const cfg = syncConfig();
    if (!cfg.guild) return { skipped: 'no bot or DISCORD_GUILD_ID' };
    const db = admin();
    const { data: sellers, error } = await db.from('sellers').select('*');
    if (error) return { skipped: error.message };
    const ids = (sellers || []).map((s) => s.user_id);
    const { data: accounts } = ids.length ? await db.from('accounts').select('id, discord_id').in('id', ids) : { data: [] };
    const discordOf = new Map((accounts || []).map((a) => [a.id, a.discord_id]));
    const start = Date.now();
    const now = Date.now();
    const channelMap = new Map();
    const result = { checked: 0, changed: 0, problems: [], unfinished: 0, ...(cfg.problems.length ? { config: cfg.problems } : {}) };
    // Only sellers it can matter for: everyone when Order Pings is on, else those away or just back.
    const todo = (sellers || []).filter((s) => discordOf.get(s.user_id) && (cfg.pingsRole || cfg.vacationRole || onVacation(s, now)
        || (s.vacation_until && now - new Date(s.vacation_until).getTime() < RECENT_DAYS * DAY)));
    let i = 0;
    const worker = async () => {
        while (i < todo.length) {
            if (Date.now() - start > budgetMs) { result.unfinished = todo.length - i; i = todo.length; return; }
            const s = todo[i++];
            const until = s.vacation_until ? new Date(s.vacation_until).getTime() : 0;
            const r = await syncSeller(s, discordOf.get(s.user_id), { channels: Boolean(until && now - until < RECENT_DAYS * DAY) || onVacation(s, now), channelMap, now });
            result.checked++;
            if (r.changes.some((c) => c !== 'channels checked')) result.changed++;
            result.problems.push(...r.problems.map((p) => `${s.user_id.slice(0, 8)}: ${p}`));
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    result.problems = result.problems.slice(0, 20);
    return result;
}

// For /api/health (seller site): can the bot manage the Vacation / Order Pings roles and the order channels?
// Returns a list of [name, ok, detail, fix].
export async function syncHealth() {
    const cfg = syncConfig();
    const out = [];
    for (const p of cfg.problems) out.push(['Vacation & Order Pings roles', false, p, 'Create separate "Vacation" and "Order Pings" roles and use their IDs.']);
    if (!cfg.guild || (!cfg.vacationRole && !cfg.pingsRole)) return out;
    const me = await discordBot('/users/@me');
    if (!me.ok) return out;
    const [roles, botMember] = await Promise.all([discordBot(`/guilds/${cfg.guild}/roles`), discordBot(`/guilds/${cfg.guild}/members/${me.json.id}`)]);
    const all = (roles.ok && roles.json) || [];
    const mine = all.filter((r) => (botMember.json?.roles || []).includes(r.id));
    const everyone = all.find((r) => r.id === cfg.guild);
    const base = [everyone, ...mine].filter(Boolean).reduce((p, r) => p | BigInt(r.permissions || 0), 0n);
    const isAdmin = (base & 0x8n) !== 0n;
    const top = Math.max(0, ...mine.map((r) => r.position));
    for (const [id, label] of [[cfg.vacationRole, 'Vacation'], [cfg.pingsRole, 'Order Pings']]) {
        if (!id) continue;
        const target = all.find((r) => r.id === id);
        const ok = target && (isAdmin || (base & 0x10000000n) !== 0n) && top > target.position;
        out.push([`bot can give the ${label} role`, Boolean(ok),
            !target ? 'role not found in the server' : ok ? `yes (@${target.name})` : !(isAdmin || (base & 0x10000000n)) ? 'the bot has no "Manage Roles" permission' : `the bot's role is below ${label}`,
            `Server Settings → Roles: give the bot's role "Manage Roles" and drag it ABOVE ${label}.`]);
    }
    // Order channels: View Channel + Manage Permissions (role "Manage Roles" bit 0x10000000 in a channel) for the bot.
    let n = 0;
    for (const id of await orderChannelIds()) {
        n++;
        const ch = await discordBot(`/channels/${id}`);
        if (!ch.ok) { out.push([`bot can hide order channel ${n} during vacations`, false, `the bot can't see it (HTTP ${ch.status})`, 'Edit Channel → Permissions → add the bot with View Channel and Manage Permissions.']); continue; }
        let p = base;
        if (!isAdmin) {
            const ows = ch.json.permission_overwrites || [];
            const ev = ows.find((o) => o.id === cfg.guild);
            if (ev) p = (p & ~BigInt(ev.deny)) | BigInt(ev.allow);
            let a = 0n, d = 0n;
            for (const o of ows) if (Number(o.type) === 0 && o.id !== cfg.guild && mine.some((r) => r.id === o.id)) { a |= BigInt(o.allow); d |= BigInt(o.deny); }
            p = (p & ~d) | a;
            const own = ows.find((o) => Number(o.type) === 1 && o.id === me.json.id);
            if (own) p = (p & ~BigInt(own.deny)) | BigInt(own.allow);
        }
        const ok = isAdmin || ((p & VIEW_CHANNEL) !== 0n && (p & 0x10000000n) !== 0n);
        out.push([`bot can hide order channel ${n} during vacations`, ok, `#${ch.json.name}: ${ok ? 'yes' : 'missing View Channel or Manage Permissions'}`,
            `Edit Channel #${ch.json.name} → Permissions → add the bot (Echo Market) with View Channel and Manage Permissions.`]);
    }
    return out;
}
