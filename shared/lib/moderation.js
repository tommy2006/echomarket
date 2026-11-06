// Market moderation: bans, lifting bans, and messages/warnings to buyers. Used by the seller desk
// (seller/api/admin/moderation.js) and the Discord bot (buyer/api/discord/interactions.js), so both follow
// exactly the same rules. Source of truth: shared/lib/moderation.js ("npm run sync" copies it).
//
// "by" is the admin doing it: { accountId (or null when they never used the market), name }.
// "target" is { discordId, account (or null), name }: see resolveTarget().
import {
    admin, accountName, cleanText, md, activeBan, banText, dmDiscordUser, setMarketBannedRole, logModeration,
    discordBot, EMBED_COLORS, BUYER_URL, HttpError
} from './server.js';

export const BAN_DAYS = { week: 7, month: 30, permanent: null };

// Finds who a moderation action is about, from a market account ID or a Discord user ID.
export async function resolveTarget({ accountId, discordId, name } = {}) {
    const db = admin();
    if (typeof accountId === 'string' && /^[0-9a-f-]{36}$/i.test(accountId)) {
        const { data } = await db.from('accounts').select('*').eq('id', accountId).maybeSingle();
        if (!data?.discord_id) throw new HttpError(404, 'That market account has no Discord login.');
        return { account: data, discordId: data.discord_id, name: accountName(data) };
    }
    const id = String(discordId || '').trim();
    if (!/^\d{5,25}$/.test(id)) throw new HttpError(400, 'Give a Discord user ID (numbers only, right-click the user → Copy User ID).');
    const { data } = await db.from('accounts').select('*').eq('discord_id', id).maybeSingle();
    if (data) return { account: data, discordId: id, name: accountName(data) };
    if (name) return { account: null, discordId: id, name };
    // Not on the market yet: ask Discord for a name to show in the log.
    const u = await discordBot(`/users/${id}`).catch(() => null);
    return { account: null, discordId: id, name: u?.ok ? (u.json.global_name || u.json.username) : `Discord user ${id}` };
}

const via = (source) => (source === 'bot' ? ' (via Discord)' : '');

export async function issueBan({ target, duration, reason, by, source = 'web' }) {
    if (!(duration in BAN_DAYS)) throw new HttpError(400, 'Choose a ban length: a week, a month or permanent.');
    const why = cleanText(reason, 500);
    if (!why) throw new HttpError(400, 'Write the reason for the ban (the person will see it).');
    const db = admin();
    const days = BAN_DAYS[duration];
    const endsAt = days ? new Date(Date.now() + days * 864e5).toISOString() : null;
    // A new ban replaces any active one.
    await db.from('market_bans').update({ revoked_at: new Date().toISOString(), revoked_by_name: `${by.name} (replaced by a new ban)` })
        .eq('discord_id', target.discordId).is('revoked_at', null);
    const { data: ban, error } = await db.from('market_bans').insert({
        discord_id: target.discordId, account_id: target.account?.id || null, reason: why, duration,
        ends_at: endsAt, issued_by: by.accountId || null, issued_by_name: by.name, source
    }).select().single();
    if (error) throw error;
    const length = days ? `for ${days === 7 ? 'one week' : 'one month'} (${banText(ban)})` : 'permanently';
    const [dm, role, logged] = await Promise.all([
        dmDiscordUser(target.discordId, {
            title: '⛔ You have been banned from Echo Market', color: EMBED_COLORS.declined,
            description: `You can't order on Echo Market ${length}.\n**Reason:** ${md(why)}\n\nIf you think this is a mistake, contact a Market Admin on the Echo Discord server.`
        }),
        setMarketBannedRole(target.discordId, true, `Market ban by ${by.name}: ${why}`),
        logModeration({
            title: '⛔ Market ban', color: EMBED_COLORS.declined,
            fields: [
                { name: 'User', value: `<@${target.discordId}> (${md(target.name)})`, inline: true },
                { name: 'Length', value: days ? `${days} days, ${banText(ban)}` : 'permanent', inline: true },
                { name: 'By', value: md(by.name) + via(source), inline: true },
                { name: 'Reason', value: md(why).slice(0, 1000) }
            ]
        })
    ]);
    return { ban, delivery: { dm, role, logged } };
}

export async function liftBan({ ban, note, by, source = 'web' }) {
    if (!ban) throw new HttpError(404, 'Ban not found.');
    if (ban.revoked_at) throw new HttpError(409, 'This ban was already lifted.');
    const db = admin();
    const text = cleanText(note, 300);
    const { error } = await db.from('market_bans').update({ revoked_at: new Date().toISOString(), revoked_by_name: by.name }).eq('id', ban.id);
    if (error) throw error;
    const stillBanned = await activeBan(ban.discord_id);
    const [dm, role, logged] = await Promise.all([
        stillBanned ? 'skipped' : dmDiscordUser(ban.discord_id, {
            title: '✅ Your Echo Market ban was lifted', color: EMBED_COLORS.progress,
            description: `You can use Echo Market again.${text ? `\n> ${md(text)}` : ''}`, url: BUYER_URL || undefined
        }),
        stillBanned ? false : setMarketBannedRole(ban.discord_id, false, `Market ban lifted by ${by.name}`),
        logModeration({
            title: '✅ Market ban lifted', color: EMBED_COLORS.progress,
            fields: [
                { name: 'User', value: `<@${ban.discord_id}>`, inline: true },
                { name: 'By', value: md(by.name) + via(source), inline: true },
                { name: 'Original reason', value: md(ban.reason).slice(0, 1000) },
                ...(text ? [{ name: 'Note', value: md(text).slice(0, 1000) }] : [])
            ]
        })
    ]);
    return { delivery: { dm, role, logged } };
}

export async function sendMarketMessage({ target, kind, body, by, source = 'web' }) {
    const k = kind === 'warning' ? 'warning' : 'info';
    const text = cleanText(body, 1500);
    if (!text) throw new HttpError(400, 'Write the message first.');
    const { data: msg, error } = await admin().from('market_messages').insert({
        account_id: target.account?.id || null, discord_id: target.discordId, kind: k, body: text,
        sent_by: by.accountId || null, sent_by_name: by.name, source
    }).select().single();
    if (error) throw error;
    const [dm, logged] = await Promise.all([
        dmDiscordUser(target.discordId, k === 'warning'
            ? { title: '⚠️ Warning from the Echo Market admins', color: EMBED_COLORS.declined, description: md(text), url: BUYER_URL || undefined }
            : { title: '📣 Message from the Echo Market admins', color: EMBED_COLORS.request, description: md(text), url: BUYER_URL || undefined }),
        logModeration({
            title: k === 'warning' ? '⚠️ Market warning' : '📣 Market message', color: k === 'warning' ? 0xF59E0B : EMBED_COLORS.request,
            fields: [
                { name: 'User', value: `<@${target.discordId}> (${md(target.name)})`, inline: true },
                { name: 'By', value: md(by.name) + via(source), inline: true },
                { name: 'Message', value: md(text).slice(0, 1000) }
            ]
        })
    ]);
    // The warning policy: this warning may be the one that triggers an automatic ban. The warning itself
    // is already saved and sent, so a problem here never undoes it.
    let autoBan = null;
    if (k === 'warning') {
        try { autoBan = await applyStrikes(target); }
        catch (err) { console.error('warning policy check failed:', err.message); }
    }
    return { message: msg, delivery: { dm, logged }, autoBan };
}

// ---------------------------------------------------------------- the warning policy
// Leaders' policy (November 2026):
//   STRIKES market warnings (counting every warning, also ones given before this rule)   → one-week ban
//   STRIKES more warnings given after that automatic one-week ban                         → permanent ban
// The automatic bans are normal market bans (DM, Market Banned role, moderation log) marked with auto_step,
// so each step happens only once per person. Buyers never see the number: their Account Standing page shows
// a level (standingLevel) instead.
export const STRIKES = 3;
export const AUTO_BY = 'Echo Market (automatic)';

// Every warning and ban of one person (oldest first), the policy step reached (0, 1 = had the one-week
// ban, 2 = permanent), and the warnings that count towards the next step.
export async function strikeRecord(discordId) {
    const db = admin();
    const [w, b] = await Promise.all([
        db.from('market_messages').select('id, body, created_at, sent_by_name, source').eq('discord_id', discordId).eq('kind', 'warning').order('created_at'),
        db.from('market_bans').select('*').eq('discord_id', discordId).order('created_at')
    ]);
    if (w.error) throw w.error;
    if (b.error) throw b.error;
    const warnings = w.data || [];
    const bans = b.data || [];
    const autos = bans.filter((x) => x.auto_step);
    const last = autos[autos.length - 1] || null;
    const step = last ? Math.max(...autos.map((x) => x.auto_step)) : 0;
    const counted = last ? warnings.filter((x) => x.created_at > last.created_at) : warnings;
    return { warnings, bans, step, counted };
}

// 0 All good · 1 Caution · 2 Under watch · 3 At risk · 4 Banned. Deliberately not "n of 3".
export function standingLevel({ step, counted }, banned) {
    if (banned) return 4;
    const n = counted.length;
    if (n >= STRIKES - 1) return 3;
    if (step > 0) return 2;          // back after an automatic ban: watched more closely
    return n > 0 ? 1 : 0;
}

// Issues the next automatic ban if the person has reached it. Returns { ban, step, delivery } or null.
export async function applyStrikes(target) {
    const rec = await strikeRecord(target.discordId);
    if (rec.step >= 2 || rec.counted.length < STRIKES) return null;
    const step = rec.step + 1;
    const db = admin();
    const current = await activeBan(target.discordId);
    if (current && !current.ends_at) return null;   // already banned for good by an admin
    // The one-week ban never shortens a longer ban that is already running.
    let endsAt = step === 1 ? Date.now() + 7 * 864e5 : null;
    if (endsAt && current?.ends_at) endsAt = Math.max(endsAt, new Date(current.ends_at).getTime());
    const reason = step === 1
        ? 'Automatic one-week ban after repeated market warnings.'
        : 'Automatic permanent ban: more market warnings after an earlier ban.';
    const { data: ban, error } = await db.from('market_bans').insert({
        discord_id: target.discordId, account_id: target.account?.id || null, reason, duration: step === 1 ? 'week' : 'permanent',
        ends_at: endsAt ? new Date(endsAt).toISOString() : null, issued_by: null, issued_by_name: AUTO_BY, source: 'auto', auto_step: step
    }).select().single();
    if (error) {
        if (error.code === '23505') return null;   // a warning sent at the same moment already did it
        throw error;
    }
    await db.from('market_bans').update({ revoked_at: new Date().toISOString(), revoked_by_name: `${AUTO_BY} (replaced by an automatic ban)` })
        .eq('discord_id', target.discordId).is('revoked_at', null).neq('id', ban.id);

    const length = step === 1 ? `for one week (${banText(ban)})` : 'permanently';
    const [dm, role] = await Promise.all([
        dmDiscordUser(target.discordId, {
            title: '⛔ You have been banned from Echo Market', color: EMBED_COLORS.declined,
            description: `Because of repeated market warnings, you can't order on Echo Market ${length}.`
                + (step === 1 ? '\n\nFurther warnings after this ban lead to a **permanent** market ban.' : '')
                + '\n\nYou can see your record under **Account standing** in the market menu. If you think this is a mistake, contact a Market Admin on the Echo Discord server.',
            url: BUYER_URL || undefined
        }),
        setMarketBannedRole(target.discordId, true, `Automatic market ban (${step === 1 ? 'one week' : 'permanent'}): warning policy`)
    ]);
    const short = (s) => md(String(s || '')).replace(/\s+/g, ' ').slice(0, 140);
    const list = rec.counted.slice(-6).map((w, i, all) => `**${rec.counted.length - all.length + i + 1}.** ${new Date(w.created_at).toISOString().slice(0, 10)} · ${md(w.sent_by_name || 'admin')}${w.source === 'theft' ? ' (plane theft)' : ''}: ${short(w.body)}`).join('\n');
    const logged = await logModeration({
        title: step === 1 ? '⛔ Automatic market ban: 1 week' : '⛔ Automatic market ban: PERMANENT',
        color: step === 1 ? EMBED_COLORS.declined : 0x7F1D1D,
        description: step === 1
            ? `<@${target.discordId}> reached **${rec.counted.length} market warnings**, so the warning policy banned them for one week.`
            : `<@${target.discordId}> got **${rec.counted.length} more market warnings** after their automatic one-week ban, so the warning policy banned them permanently.`,
        fields: [
            { name: 'User', value: `<@${target.discordId}> (${md(target.name)})`, inline: true },
            { name: 'Length', value: step === 1 ? `7 days, ${banText(ban)}` : 'permanent', inline: true },
            { name: 'Market Banned role', value: role ? 'given ✅' : '⚠️ not given (check the bot role / health page)', inline: true },
            { name: step === 1 ? 'Warnings counted' : 'Warnings since the one-week ban', value: list.slice(0, 1024) || '–' },
            { name: 'Policy', value: `${STRIKES} warnings → 1-week ban · ${STRIKES} more after it → permanent ban. Lift it in the seller desk (Moderation) or with /market unban if it was a mistake.` }
        ]
    });
    return { ban, step, delivery: { dm, role, logged } };
}

// Everyone who already has enough warnings for an automatic ban they haven't had yet (for warnings given
// before the policy existed). apply = true bans them; otherwise it's only a preview list.
export async function strikeBacklog({ apply = false } = {}) {
    const db = admin();
    const { data, error } = await db.from('market_messages').select('discord_id').eq('kind', 'warning').limit(10000);
    if (error) throw error;
    const counts = {};
    for (const r of data || []) counts[r.discord_id] = (counts[r.discord_id] || 0) + 1;
    const due = [];
    for (const id of Object.keys(counts).filter((x) => counts[x] >= STRIKES)) {
        const rec = await strikeRecord(id);
        if (rec.step >= 2 || rec.counted.length < STRIKES) continue;
        const current = await activeBan(id);
        if (current && !current.ends_at) continue;
        const target = await resolveTarget({ discordId: id });
        const item = { discordId: id, name: target.name, warnings: rec.counted.length, step: rec.step + 1 };
        if (apply) {
            try { item.done = Boolean(await applyStrikes(target)); } catch (err) { item.error = err.message; }
        }
        due.push(item);
    }
    return due;
}

// What a buyer sees on Account Standing: a level and their record (no names of the admins involved).
export async function accountStanding(discordId, { bannedRole = false } = {}) {
    const rec = await strikeRecord(discordId);
    const now = Date.now();
    const active = (b) => !b.revoked_at && (!b.ends_at || new Date(b.ends_at).getTime() > now);
    const ban = [...rec.bans].reverse().find(active) || null;
    return {
        level: standingLevel(rec, Boolean(ban) || bannedRole),
        ban: ban ? { reason: ban.reason, ends_at: ban.ends_at } : null,
        bannedRole: !ban && bannedRole,
        history: [
            ...rec.warnings.map((w) => ({ type: 'warning', at: w.created_at, text: w.body, theft: w.source === 'theft' })),
            ...rec.bans.map((b) => ({
                type: 'ban', at: b.starts_at || b.created_at, text: b.reason, duration: b.duration, ends_at: b.ends_at,
                state: active(b) ? 'active' : b.revoked_at && !/replaced/.test(b.revoked_by_name || '') ? 'lifted' : 'ended', auto: Boolean(b.auto_step)
            }))
        ].sort((a, b) => b.at.localeCompare(a.at))
    };
}

// Summary for /market info and the seller desk: active ban, warnings, recent orders.
export async function moderationSummary(discordId) {
    const db = admin();
    const [ban, msgs, account, rec] = await Promise.all([
        activeBan(discordId),
        db.from('market_messages').select('kind, created_at').eq('discord_id', discordId),
        db.from('accounts').select('id').eq('discord_id', discordId).maybeSingle(),
        strikeRecord(discordId).catch(() => null)
    ]);
    let orders = [];
    if (account.data) {
        const { data } = await db.from('orders').select('id, serial, status, total_qty, created_at')
            .eq('buyer_id', account.data.id).order('created_at', { ascending: false }).limit(5);
        orders = data || [];
    }
    const list = msgs.data || [];
    return { ban, warnings: list.filter((m) => m.kind === 'warning').length, messages: list.length, onMarket: Boolean(account.data), orders,
        policy: rec ? policyText(rec) : null };
}

// For staff (seller desk, /market info): where the person is on the warning policy.
export function policyText({ step, counted }) {
    if (step >= 2) return 'Warning policy: permanently banned (final step reached).';
    return `Warning policy: ${counted.length} of ${STRIKES} warnings towards ${step ? 'a permanent ban' : 'a one-week ban'}${step ? ' (after their automatic one-week ban)' : ''}.`;
}
