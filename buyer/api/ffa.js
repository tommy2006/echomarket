// POST /api/ffa — the FFA page: aircraft players listed in the Discord channel #ffa-listings (see lib/ffa.js).
// Reads the channel first when the last check is older than a few minutes. Returns
//   { ok, available, listings: [{ id, author_name, author_avatar, content, posted_at, items, divisions, url, expiresAt }],
//     channelUrl, checkedAt, days }
import { handler, requireUser, rateLimit, getSetting } from '../lib/server.js';
import { syncFfa, activeListings, channelUrl, FFA_AVAILABLE, LISTING_DAYS } from '../lib/ffa.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await rateLimit('ffa:' + account.id, 60, 600);
    if (!FFA_AVAILABLE) return res.json({ ok: true, available: false, listings: [] });
    try {
        await syncFfa();
    } catch (err) {
        console.error('FFA check failed:', err);   // still show what was read last time
    }
    const state = await getSetting('ffa_sync', {}) || {};
    res.json({
        ok: true, available: true, listings: await activeListings(), channelUrl: channelUrl(), days: LISTING_DAYS,
        checkedAt: state.ok || null
    });
});
