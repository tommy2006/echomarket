// POST /api/enroll — seller desk access from the Discord roles.
// Called by the seller desk on sign-in. Anyone with a seller role in the Discord server (Verified Seller,
// Ambassador or Lead Ambassador; see ROLE_IDS in lib/server.js) gets a sellers row (source 'discord_role')
// with the matching rank; losing all of them switches it off again.
// Rows added by hand (source 'manual', e.g. admins or blocked people) keep their access and admin
// status; only their rank follows their highest Discord seller role, if they have one (it sets the
// colour and title on the seller desk). Without any seller role, admins get the plain 'admin' look and
// everyone else keeps the rank set by hand.
import { admin, handler, requireUser, discordStanding, deskRank, isAdminSeller, markRoleChecked, rateLimit, SELLER_ROLE_SYNC } from '../lib/server.js';

const RANK_NOTE = { lead: 'Lead Ambassador', ambassador: 'Ambassador', verified: 'Verified Seller', admin: 'Market Admin' };

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await rateLimit('enroll:' + account.id, 30, 600);   // each check calls Discord
    const db = admin();
    const { data: row, error } = await db.from('sellers').select('*').eq('user_id', account.id).maybeSingle();
    if (error) throw error;

    const reply = (seller, changed, extra = {}) => res.json({ ok: true, seller, changed, ...extra });
    // One Discord lookup: seller rank, Market Admin role (admin rights), membership.
    const st = SELLER_ROLE_SYNC && account.discord_id ? await discordStanding(account.discord_id) : null;
    const adminNow = (r, rank) => isAdminSeller({ ...r, rank, market_admin: st ? st.marketAdmin : r?.market_admin });
    if (row && row.source !== 'discord_role') {
        // Added by hand: access and is_admin never change here, but the look follows the roles: the highest
        // seller role, else the Market Admin look, else what was set by hand (never the Market Admin look
        // without the Market Admin role).
        let rank = row.rank === 'admin' ? 'verified' : row.rank;
        let marketAdmin = Boolean(row.market_admin);
        if (st) {
            rank = deskRank(st) || rank;
            marketAdmin = st.marketAdmin;
        }
        if (rank !== row.rank || marketAdmin !== Boolean(row.market_admin)) {
            const { error: rankErr } = await db.from('sellers').update({ rank, market_admin: marketAdmin }).eq('user_id', account.id);
            if (rankErr) console.warn('rank not saved (re-run schema.sql?):', rankErr.message);
        }
        return reply(row.active, rank !== row.rank, { source: row.source, rank, admin: adminNow({ ...row, market_admin: marketAdmin }, rank) });
    }
    if (!SELLER_ROLE_SYNC) return reply(Boolean(row?.active), false, { sync: false });

    // account.discord_id is checked against the Discord login in requireUser(), so it can't be borrowed.
    // No Discord login at all = no role.
    const rank = account.discord_id ? deskRank(st) : false;
    // Discord didn't answer: keep whatever they had.
    if (rank === null) return reply(Boolean(row?.active), false, { unknown: true });
    const has = Boolean(rank);
    // Seller access through a role needs a recent check (see is_seller() and requireActiveSeller()).
    const confirm = async () => { if (has) await markRoleChecked(account.id, rank, st.marketAdmin); };

    if (!row && has) {
        const { error: insErr } = await db.from('sellers').insert({
            user_id: account.id, source: 'discord_role', active: true, rank, market_admin: st.marketAdmin,
            note: `Added automatically (Discord role: ${RANK_NOTE[rank]})`
        });
        if (insErr && insErr.code !== '23505') throw insErr;   // 23505: added by a parallel request
        await confirm();
        return reply(true, true, { source: 'discord_role', rank, admin: adminNow({}, rank) });
    }
    if (row && row.active !== has) {
        const { error: updErr } = await db.from('sellers').update({ active: has }).eq('user_id', account.id);
        if (updErr) throw updErr;
        await confirm();
        return reply(has, true, { source: 'discord_role', rank: rank || row.rank, admin: adminNow(row, rank || row.rank) });
    }
    await confirm();
    return reply(has, false, { source: 'discord_role', rank: rank || row?.rank, admin: adminNow(row || {}, rank || row?.rank) });
});
