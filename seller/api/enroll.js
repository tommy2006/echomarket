// POST /api/enroll — seller desk access from the Discord seller role.
// Called by the seller desk on sign-in. Anyone with the seller role (DISCORD_ROLE_ID) in a server
// the bot is in gets a sellers row (source 'discord_role'); losing the role switches it off again.
// Rows added by hand (source 'manual', e.g. admins or blocked people) are never changed here.
import { admin, handler, requireUser, hasSellerRole, SELLER_ROLE_SYNC } from '../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const db = admin();
    const { data: row, error } = await db.from('sellers').select('*').eq('user_id', account.id).maybeSingle();
    if (error) throw error;

    const reply = (seller, changed, extra = {}) => res.json({ ok: true, seller, changed, ...extra });
    if (row && row.source !== 'discord_role') return reply(row.active, false, { source: row.source });
    if (!SELLER_ROLE_SYNC) return reply(Boolean(row?.active), false, { sync: false });

    // account.discord_id is checked against the Discord login in requireUser(), so it can't be borrowed.
    // No Discord login at all = no role.
    const has = account.discord_id ? await hasSellerRole(account.discord_id) : false;
    // Discord didn't answer: keep whatever they had.
    if (has === null) return reply(Boolean(row?.active), false, { unknown: true });

    if (!row && has) {
        const { error: insErr } = await db.from('sellers').insert({
            user_id: account.id, source: 'discord_role', active: true, note: 'Added automatically (Discord seller role)'
        });
        if (insErr && insErr.code !== '23505') throw insErr;   // 23505: added by a parallel request
        return reply(true, true, { source: 'discord_role' });
    }
    if (row && row.active !== has) {
        const { error: updErr } = await db.from('sellers').update({ active: has }).eq('user_id', account.id);
        if (updErr) throw updErr;
        return reply(has, true, { source: 'discord_role' });
    }
    return reply(has, false, { source: 'discord_role' });
});
