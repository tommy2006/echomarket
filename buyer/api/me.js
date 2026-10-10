// POST /api/me — may the signed-in person use the market right now?
// Called by the buyer site when it opens. Re-checks Echo server membership with Discord (and the
// Market Banned role), and looks up market bans. Returns:
//   { ok, inGuild, membershipCheck, ban: { reason, duration, ends_at } | null, bannedRole }
import { handler, requireUser, marketStanding, rateLimit, MEMBERSHIP_CHECK } from '../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await rateLimit('me:' + account.id, 60, 600);
    const st = await marketStanding(account, { fresh: true });
    res.json({
        ok: true,
        inGuild: st.inGuild,
        membershipCheck: MEMBERSHIP_CHECK,
        bannedRole: st.bannedRole,
        ban: st.ban ? { reason: st.ban.reason, duration: st.ban.duration, ends_at: st.ban.ends_at, starts_at: st.ban.starts_at } : null
    });
});
