// Activity alerts: once a day (api/cron/bans.js), Market Admins get a bot DM listing every seller who hasn't
// delivered anything (no delivery update or completed order) for QUIET_DAYS days in a row, so they can check on them.
//
// Who is watched: active sellers with a seller rank (Verified Seller, Ambassador, Lead Ambassador) who are not
// Unranked. Tech-only admins (rank 'admin') and Community Managers without a seller role are never watched.
// The clock starts at the latest of: their last delivery, joining the seller list, finishing the seller
// welcome, and the leaderboard reset (stats_reset_at). Each quiet stretch is reported once
// (sellers.activity_alert_at); after a new delivery a new stretch can be reported again.
import { admin, isAdminSeller, accountName, md, sendDM, getSetting, SELLER_URL, RANKS } from './server.js';

export const QUIET_DAYS = 5;
export const HONEY = 0xF5B533;   // the activity alert colour: yellow-honey
const ms = (t) => (t ? new Date(t).getTime() || 0 : 0);
const day = (t) => new Date(t).toISOString().slice(0, 10);

export async function activityAlerts({ now = Date.now() } = {}) {
    const db = admin();
    const { data: sellers, error } = await db.from('sellers').select('*').eq('active', true);
    if (error) throw error;
    if (sellers.length && !('unranked' in sellers[0])) return { skipped: 're-run supabase/schema.sql' };
    const resetAt = ms(await getSetting('stats_reset_at', 0));
    const cutoff = now - QUIET_DAYS * 864e5;
    const watched = sellers.filter((s) => !s.unranked && RANKS.includes(s.rank)
        && Math.max(ms(s.added_at), ms(s.welcome_done_at), resetAt) <= cutoff);
    if (!watched.length) return { watched: 0, quiet: [] };

    const ids = watched.map((s) => s.user_id);
    const { data: recent, error: evErr } = await db.from('order_events').select('actor_id')
        .in('actor_id', ids).in('kind', ['PROGRESS', 'FULFILLED']).gte('created_at', new Date(cutoff).toISOString());
    if (evErr) throw evErr;
    const busy = new Set((recent || []).map((e) => e.actor_id));

    const quiet = [];
    for (const s of watched.filter((x) => !busy.has(x.user_id))) {
        const { data: last } = await db.from('order_events').select('created_at').eq('actor_id', s.user_id)
            .in('kind', ['PROGRESS', 'FULFILLED']).order('created_at', { ascending: false }).limit(1);
        const lastDelivery = last?.[0]?.created_at || null;
        const stretchStart = Math.max(ms(lastDelivery), ms(s.added_at), ms(s.welcome_done_at), resetAt);
        if (ms(s.activity_alert_at) > stretchStart) continue;   // this stretch was already reported
        quiet.push({ seller: s, lastDelivery, stretchStart });
    }
    if (!quiet.length) return { watched: watched.length, quiet: [] };

    const [{ data: accounts }, { data: open }] = await Promise.all([
        db.from('accounts').select('*').in('id', [...new Set([...quiet.map((q) => q.seller.user_id), ...sellers.filter(isAdminSeller).map((s) => s.user_id)])]),
        db.from('orders').select('seller_id').in('seller_id', quiet.map((q) => q.seller.user_id)).in('status', ['CLAIMED', 'PARTIAL'])
    ]);
    const acc = new Map((accounts || []).map((a) => [a.id, a]));
    const inProgress = (id) => (open || []).filter((o) => o.seller_id === id).length;
    const RANK = { lead: 'Lead Ambassador', ambassador: 'Ambassador', verified: 'Verified Seller' };

    const fields = quiet.slice(0, 24).map(({ seller: s, lastDelivery, stretchStart }) => {
        const a = acc.get(s.user_id);
        const days = Math.floor((now - stretchStart) / 864e5);
        const n = inProgress(s.user_id);
        return {
            name: `${a ? accountName(a) : 'Unknown seller'} · ${RANK[s.rank] || s.rank}`.slice(0, 250),
            value: [
                a?.discord_id ? `<@${a.discord_id}>` : null,
                lastDelivery ? `Last delivery **${day(lastDelivery)}** (${days} days ago)` : `**No deliveries** in ${days} days on the desk`,
                n ? `⚠️ **${n} order${n === 1 ? '' : 's'} still in their hands**: buyers may be waiting` : 'No orders in their hands'
            ].filter(Boolean).join('\n')
        };
    });
    if (quiet.length > 24) fields.push({ name: `…and ${quiet.length - 24} more`, value: 'See the Sellers tab on the seller desk.' });
    const embed = {
        title: `🍯 Seller activity alert: ${quiet.length} quiet seller${quiet.length === 1 ? '' : 's'}`,
        color: HONEY,
        description: `${quiet.length === 1 ? 'This seller hasn\'t' : 'These sellers haven\'t'} delivered any order for **${QUIET_DAYS} days or more**. `
            + 'Please check on them: a friendly DM to see if they\'re okay, still have time to sell, or need help. '
            + 'If someone has orders in their hands, those buyers may be waiting, so consider asking them to pass the orders on.\n\n'
            + '-# Tech-only admins or sellers who resigned? Mark them **Unranked** in the Sellers tab and they\'ll leave the leaderboard and these alerts.',
        url: SELLER_URL || undefined,
        fields
    };

    const admins = sellers.filter(isAdminSeller).map((s) => acc.get(s.user_id)).filter((a) => a?.discord_id);
    const results = await Promise.all(admins.map((a) => sendDM(a, embed)));
    const sent = results.filter((r) => r === 'sent').length;
    if (sent) {
        await db.from('sellers').update({ activity_alert_at: new Date(now).toISOString() })
            .in('user_id', quiet.map((q) => q.seller.user_id));
    }
    return { watched: watched.length, quiet: quiet.map((q) => q.seller.user_id), admins: admins.length, sent };
}
