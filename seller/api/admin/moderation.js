// POST /api/admin/moderation — market bans and messages to buyers. Admins only (Market Admins, the Lead
// Ambassador, and admins added by hand).
// Body: { action, ... }
//   ban      { accountId | discordId, duration: 'week'|'month'|'permanent', reason }
//            Bans the Discord account from the buyer market (all its airlines). Replaces an earlier active
//            ban. Gives the Market Banned role, DMs the person, logs it in DISCORD_LOG_CHANNEL_ID.
//   unban    { banId, note }   lifts a ban early (removes the role if no other ban is active)
//   message  { accountId | discordId, kind: 'info'|'warning', body }
//            Shown in the buyer's notifications, DMed, and logged.
// The rules themselves live in lib/moderation.js (shared with the Discord bot).
// Reading bans and messages: the seller desk reads market_bans / market_messages directly (RLS).
import { admin, handler, requireUser, requireActiveSeller, accountName, body, rateLimit, HttpError } from '../../lib/server.js';
import { resolveTarget, issueBan, liftBan, sendMarketMessage } from '../../lib/moderation.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const me = await requireActiveSeller(account);
    if (!me.is_admin) throw new HttpError(403, 'Only Market Admins can ban or message buyers.');
    await rateLimit('moderation:' + account.id, 60, 600);
    const input = body(req);
    const by = { accountId: account.id, name: accountName(account) };

    switch (input.action) {
        case 'ban': {
            const target = await resolveTarget(input);
            if (target.discordId === account.discord_id) throw new HttpError(400, "You can't ban yourself.");
            return res.json({ ok: true, ...(await issueBan({ target, duration: input.duration, reason: input.reason, by })) });
        }
        case 'unban': {
            const { data: ban } = await admin().from('market_bans').select('*').eq('id', Number(input.banId)).maybeSingle();
            return res.json({ ok: true, ...(await liftBan({ ban, note: input.note, by })) });
        }
        case 'message': {
            const target = await resolveTarget(input);
            return res.json({ ok: true, ...(await sendMarketMessage({ target, kind: input.kind, body: input.body, by })) });
        }
        default:
            throw new HttpError(400, 'Unknown action.');
    }
});
