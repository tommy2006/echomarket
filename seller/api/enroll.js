// POST /api/enroll — seller desk access from the Discord roles.
// Called by the seller desk on sign-in. Anyone with a seller role in the Discord server (Verified Seller,
// Ambassador or Lead Ambassador; see ROLE_IDS in lib/server.js) gets a sellers row (source 'discord_role')
// with the matching rank; losing all of them switches it off again.
// Rows added by hand (source 'manual', e.g. admins or blocked people) keep their access and admin
// status; only their rank follows their highest Discord seller role, if they have one (it sets the
// colour and title on the seller desk). Without any seller role, admins get the plain 'admin' look and
// everyone else keeps the rank set by hand.
import { admin, handler, requireUser, sellerRankFromDiscord, markRoleChecked, rateLimit, SELLER_ROLE_SYNC } from '../lib/server.js';

const RANK_NOTE = { lead: 'Lead Ambassador', ambassador: 'Ambassador', verified: 'Verified Seller' };

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await rateLimit('enroll:' + account.id, 30, 600);   // each check calls Discord
    const db = admin();
    const { data: row, error } = await db.from('sellers').select('*').eq('user_id', account.id).maybeSingle();
    if (error) throw error;

    const reply = (seller, changed, extra = {}) => res.json({ ok: true, seller, changed, ...extra });
    if (row && row.source !== 'discord_role') {
        let rank = row.rank;
        if (SELLER_ROLE_SYNC && account.discord_id) {
            const fromDiscord = await sellerRankFromDiscord(account.discord_id);
            if (fromDiscord) rank = fromDiscord;
            else if (fromDiscord === false && row.is_admin) rank = 'admin';
            if (rank !== row.rank) {
                const { error: rankErr } = await db.from('sellers').update({ rank }).eq('user_id', account.id);
                // 23514: database not updated for the 'admin' look yet; the desk still gets it below.
                if (rankErr && rankErr.code !== '23514') throw rankErr;
            }
        }
        return reply(row.active, rank !== row.rank, { source: row.source, rank });
    }
    if (!SELLER_ROLE_SYNC) return reply(Boolean(row?.active), false, { sync: false });

    // account.discord_id is checked against the Discord login in requireUser(), so it can't be borrowed.
    // No Discord login at all = no role.
    const rank = account.discord_id ? await sellerRankFromDiscord(account.discord_id) : false;
    // Discord didn't answer: keep whatever they had.
    if (rank === null) return reply(Boolean(row?.active), false, { unknown: true });
    const has = Boolean(rank);
    // Seller access through a role needs a recent check (see is_seller() and requireActiveSeller()).
    const confirm = async () => { if (has) await markRoleChecked(account.id, rank); };

    if (!row && has) {
        const { error: insErr } = await db.from('sellers').insert({
            user_id: account.id, source: 'discord_role', active: true, rank,
            note: `Added automatically (Discord role: ${RANK_NOTE[rank]})`
        });
        if (insErr && insErr.code !== '23505') throw insErr;   // 23505: added by a parallel request
        await confirm();
        return reply(true, true, { source: 'discord_role', rank });
    }
    if (row && row.active !== has) {
        const { error: updErr } = await db.from('sellers').update({ active: has }).eq('user_id', account.id);
        if (updErr) throw updErr;
        await confirm();
        return reply(has, true, { source: 'discord_role', rank: rank || row.rank });
    }
    await confirm();
    return reply(has, false, { source: 'discord_role', rank: rank || row?.rank });
});
