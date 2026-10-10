// POST /api/admin/moderation — market bans and messages to buyers. Admins only (Market Admins, the Lead
// Ambassador, and admins added by hand).
// Body: { action, ... }
//   ban      { accountId | discordId, duration: 'week'|'month'|'permanent', reason }
//            Bans the Discord account from the buyer market (all its airlines). Replaces an earlier active
//            ban. Gives the Market Banned role, DMs the person, logs it in DISCORD_LOG_CHANNEL_ID.
//   unban    { banId, note }   lifts a ban early (removes the role if no other ban is active)
//   message  { accountId | discordId, kind: 'info'|'warning', body }
//            Shown in the buyer's notifications, DMed, and (warnings) logged.
// Reading bans and messages: the seller desk reads market_bans / market_messages directly (RLS).
import {
    admin, handler, requireUser, requireActiveSeller, accountName, body, cleanText, rateLimit, md,
    activeBan, banText, dmDiscordUser, setMarketBannedRole, logModeration, discordBot, EMBED_COLORS, BUYER_URL, HttpError
} from '../../lib/server.js';

const DURATIONS = { week: 7, month: 30, permanent: null };

async function resolveTarget(db, input) {
    if (typeof input.accountId === 'string' && /^[0-9a-f-]{36}$/i.test(input.accountId)) {
        const { data } = await db.from('accounts').select('*').eq('id', input.accountId).maybeSingle();
        if (!data?.discord_id) throw new HttpError(404, 'That market account has no Discord login.');
        return { account: data, discordId: data.discord_id, name: accountName(data) };
    }
    const discordId = String(input.discordId || '').trim();
    if (!/^\d{5,25}$/.test(discordId)) throw new HttpError(400, 'Give a Discord user ID (numbers only, right-click the user → Copy User ID).');
    const { data } = await db.from('accounts').select('*').eq('discord_id', discordId).maybeSingle();
    if (data) return { account: data, discordId, name: accountName(data) };
    // Not on the market yet: ask Discord for a name to show in the log.
    const u = await discordBot(`/users/${discordId}`).catch(() => null);
    return { account: null, discordId, name: u?.ok ? (u.json.global_name || u.json.username) : `Discord user ${discordId}` };
}

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const me = await requireActiveSeller(account);
    if (!me.is_admin) throw new HttpError(403, 'Only Market Admins can ban or message buyers.');
    await rateLimit('moderation:' + account.id, 60, 600);
    const input = body(req);
    const db = admin();
    const by = accountName(account);

    switch (input.action) {
        case 'ban': {
            const target = await resolveTarget(db, input);
            if (target.discordId === account.discord_id) throw new HttpError(400, "You can't ban yourself.");
            if (!(input.duration in DURATIONS)) throw new HttpError(400, 'Choose a ban length: a week, a month or permanent.');
            const reason = cleanText(input.reason, 500);
            if (!reason) throw new HttpError(400, 'Write the reason for the ban (the person will see it).');
            const days = DURATIONS[input.duration];
            const endsAt = days ? new Date(Date.now() + days * 864e5).toISOString() : null;
            // A new ban replaces any active one.
            await db.from('market_bans').update({ revoked_at: new Date().toISOString(), revoked_by_name: `${by} (replaced by a new ban)` })
                .eq('discord_id', target.discordId).is('revoked_at', null);
            const { data: ban, error } = await db.from('market_bans').insert({
                discord_id: target.discordId, account_id: target.account?.id || null, reason, duration: input.duration,
                ends_at: endsAt, issued_by: account.id, issued_by_name: by, source: 'web'
            }).select().single();
            if (error) throw error;
            const length = days ? `for ${days === 7 ? 'one week' : 'one month'} (${banText(ban)})` : 'permanently';
            const [dm, role, logged] = await Promise.all([
                dmDiscordUser(target.discordId, {
                    title: '⛔ You have been banned from Echo Market', color: EMBED_COLORS.declined,
                    description: `You can't order on Echo Market ${length}.\n**Reason:** ${md(reason)}\n\nIf you think this is a mistake, contact a Market Admin on the Echo Discord server.`
                }),
                setMarketBannedRole(target.discordId, true, `Market ban by ${by}: ${reason}`),
                logModeration({
                    title: '⛔ Market ban', color: EMBED_COLORS.declined,
                    fields: [
                        { name: 'User', value: `<@${target.discordId}> (${md(target.name)})`, inline: true },
                        { name: 'Length', value: days ? `${days} days, ${banText(ban)}` : 'permanent', inline: true },
                        { name: 'By', value: md(by), inline: true },
                        { name: 'Reason', value: md(reason).slice(0, 1000) }
                    ]
                })
            ]);
            return res.json({ ok: true, ban, delivery: { dm, role, logged } });
        }

        case 'unban': {
            const banId = Number(input.banId);
            const { data: ban } = await db.from('market_bans').select('*').eq('id', banId).maybeSingle();
            if (!ban) throw new HttpError(404, 'Ban not found.');
            if (ban.revoked_at) throw new HttpError(409, 'This ban was already lifted.');
            const note = cleanText(input.note, 300);
            const { error } = await db.from('market_bans').update({ revoked_at: new Date().toISOString(), revoked_by_name: by }).eq('id', banId);
            if (error) throw error;
            const stillBanned = await activeBan(ban.discord_id);
            const [dm, role, logged] = await Promise.all([
                stillBanned ? 'skipped' : dmDiscordUser(ban.discord_id, {
                    title: '✅ Your Echo Market ban was lifted', color: EMBED_COLORS.progress,
                    description: `You can use Echo Market again.${note ? `\n> ${md(note)}` : ''}`, url: BUYER_URL || undefined
                }),
                stillBanned ? false : setMarketBannedRole(ban.discord_id, false, `Market ban lifted by ${by}`),
                logModeration({
                    title: '✅ Market ban lifted', color: EMBED_COLORS.progress,
                    fields: [
                        { name: 'User', value: `<@${ban.discord_id}>`, inline: true },
                        { name: 'By', value: md(by), inline: true },
                        { name: 'Original reason', value: md(ban.reason).slice(0, 1000) },
                        ...(note ? [{ name: 'Note', value: md(note).slice(0, 1000) }] : [])
                    ]
                })
            ]);
            return res.json({ ok: true, delivery: { dm, role, logged } });
        }

        case 'message': {
            const target = await resolveTarget(db, input);
            const kind = input.kind === 'warning' ? 'warning' : 'info';
            const text = cleanText(input.body, 1500);
            if (!text) throw new HttpError(400, 'Write the message first.');
            const { data: msg, error } = await db.from('market_messages').insert({
                account_id: target.account?.id || null, discord_id: target.discordId, kind, body: text,
                sent_by: account.id, sent_by_name: by, source: 'web'
            }).select().single();
            if (error) throw error;
            const [dm, logged] = await Promise.all([
                dmDiscordUser(target.discordId, kind === 'warning'
                    ? { title: '⚠️ Warning from the Echo Market admins', color: EMBED_COLORS.declined, description: md(text), url: BUYER_URL || undefined }
                    : { title: '📣 Message from the Echo Market admins', color: EMBED_COLORS.request, description: md(text), url: BUYER_URL || undefined }),
                logModeration({
                    title: kind === 'warning' ? '⚠️ Market warning' : '📣 Market message', color: kind === 'warning' ? 0xF59E0B : EMBED_COLORS.request,
                    fields: [
                        { name: 'User', value: `<@${target.discordId}> (${md(target.name)})`, inline: true },
                        { name: 'By', value: md(by), inline: true },
                        { name: 'Message', value: md(text).slice(0, 1000) }
                    ]
                })
            ]);
            return res.json({ ok: true, message: msg, delivery: { dm, logged } });
        }

        default:
            throw new HttpError(400, 'Unknown action.');
    }
});
