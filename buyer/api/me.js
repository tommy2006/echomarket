// POST /api/me — may the signed-in person use the market right now?
// Called by the buyer site when it opens. Re-checks Echo server membership with Discord (and the
// Market Banned role and server boosting), and looks up market bans and the daily budget. Returns:
//   { ok, inGuild, membershipCheck, ban: { reason, duration, ends_at } | null, bannedRole,
//     budget: { tier, limit, source, expiresAt, key, celebrate } }
// { action: 'budget-seen', key }: the buyer saw the "thank you" for this reward (shown once per reward).
import { handler, requireUser, marketStanding, budgetFor, rateLimit, admin, body, MEMBERSHIP_CHECK } from '../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await rateLimit('me:' + account.id, 60, 600);
    const input = body(req);
    if (input.action === 'budget-seen') {
        const key = String(input.key || '').slice(0, 60);
        await admin().from('accounts').update({ budget_seen_key: key || null }).eq('id', account.id);
        return res.json({ ok: true });
    }
    const st = await marketStanding(account, { fresh: true });
    const budget = await budgetFor(account, { booster: st.booster });
    res.json({
        ok: true,
        inGuild: st.inGuild,
        membershipCheck: MEMBERSHIP_CHECK,
        bannedRole: st.bannedRole,
        ban: st.ban ? { reason: st.ban.reason, duration: st.ban.duration, ends_at: st.ban.ends_at, starts_at: st.ban.starts_at } : null,
        // celebrate: a new reward (or boosting) the buyer hasn't been thanked for yet. Never the admins' reason.
        budget: { ...budget, celebrate: Boolean(budget.key && 'budget_seen_key' in account && budget.key !== account.budget_seen_key) }
    });
});
