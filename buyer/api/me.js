// POST /api/me — may the signed-in person use the market right now?
// Called by the buyer site when it opens. Re-checks Echo server membership with Discord (and the
// Market Banned role, server boosting and the Tier 1 / Tier 2 roles), and looks up market bans and the daily budget. Returns:
//   { ok, inGuild, membershipCheck, ban: { reason, duration, ends_at } | null, bannedRole,
//     budget: { tier, limit, source, expiresAt, key, celebrate }, welcomeDone }
// { action: 'budget-seen', key }: the buyer saw the "thank you" for this reward (shown once per reward).
// { action: 'welcome-done', answers }: the buyer finished the "Cleared for takeoff" welcome (welcome.html).
//   The quiz answers are checked here too, so the welcome can't be skipped by calling the API directly.
import { handler, requireUser, marketStanding, budgetFor, rateLimit, admin, body, MEMBERSHIP_CHECK, HttpError } from '../lib/server.js';

// The welcome quiz (welcome.html): the right answer to each question.
const WELCOME_ANSWERS = { q1: '4', q2: 'ask', q3: 'tell' };

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await rateLimit('me:' + account.id, 60, 600);
    const input = body(req);
    if (input.action === 'budget-seen') {
        const key = String(input.key || '').slice(0, 60);
        await admin().from('accounts').update({ budget_seen_key: key || null }).eq('id', account.id);
        return res.json({ ok: true });
    }
    if (input.action === 'welcome-done') {
        const a = input.answers || {};
        if (Object.entries(WELCOME_ANSWERS).some(([k, v]) => a[k] !== v)) throw new HttpError(400, 'Some quiz answers are not right yet.');
        if (!input.understood) throw new HttpError(400, 'Tick "I understand" first.');
        const now = new Date().toISOString();
        const { error } = await admin().from('accounts')
            .update({ welcome_done_at: now, rules_seen_at: account.rules_seen_at || now }).eq('id', account.id);
        if (error) throw new HttpError(503, 'The market needs a database update (re-run supabase/schema.sql).');
        return res.json({ ok: true });
    }
    const st = await marketStanding(account, { fresh: true });
    const budget = await budgetFor(account, { booster: st.booster, roleTier: st.roleTier });
    res.json({
        ok: true,
        inGuild: st.inGuild,
        membershipCheck: MEMBERSHIP_CHECK,
        bannedRole: st.bannedRole,
        ban: st.ban ? { reason: st.ban.reason, duration: st.ban.duration, ends_at: st.ban.ends_at, starts_at: st.ban.starts_at } : null,
        // celebrate: a new reward (or boosting) the buyer hasn't been thanked for yet. Never the admins' reason.
        budget: { ...budget, celebrate: Boolean(budget.key && 'budget_seen_key' in account && budget.key !== account.budget_seen_key) },
        // false = must do the welcome first; null = older database without the column (no welcome yet).
        welcomeDone: 'welcome_done_at' in account ? Boolean(account.welcome_done_at) : null
    });
});
