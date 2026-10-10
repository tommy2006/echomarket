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
    return { message: msg, delivery: { dm, logged } };
}

// Summary for /market info and the seller desk: active ban, warnings, recent orders.
export async function moderationSummary(discordId) {
    const db = admin();
    const [ban, msgs, account] = await Promise.all([
        activeBan(discordId),
        db.from('market_messages').select('kind, created_at').eq('discord_id', discordId),
        db.from('accounts').select('id').eq('discord_id', discordId).maybeSingle()
    ]);
    let orders = [];
    if (account.data) {
        const { data } = await db.from('orders').select('id, serial, status, total_qty, created_at')
            .eq('buyer_id', account.data.id).order('created_at', { ascending: false }).limit(5);
        orders = data || [];
    }
    const list = msgs.data || [];
    return { ban, warnings: list.filter((m) => m.kind === 'warning').length, messages: list.length, onMarket: Boolean(account.data), orders };
}
