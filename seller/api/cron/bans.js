// GET /api/cron/bans — run daily by Vercel (see "crons" in vercel.json): removes the Market Banned role
// from everyone whose market ban ended in the last 3 days (people who come back to the market get it
// removed right away anyway). Vercel sends "Authorization: Bearer <CRON_SECRET>"; without CRON_SECRET
// set in this project, nothing runs.
import { admin, handler, endLapsedBanRole, logModeration, HttpError } from '../../lib/server.js';
import { timingSafeEqual } from 'crypto';

export default handler(['GET'], async (req, res) => {
    const secret = process.env.CRON_SECRET || '';
    const given = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${secret}`);
    if (secret.length < 16 || given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'Not allowed.');

    const now = Date.now();
    const { data: ended, error } = await admin().from('market_bans').select('discord_id')
        .is('revoked_at', null).lt('ends_at', new Date(now).toISOString()).gt('ends_at', new Date(now - 3 * 864e5).toISOString());
    if (error) throw error;
    let removed = 0;
    for (const discordId of [...new Set((ended || []).map((b) => b.discord_id))]) {
        if (await endLapsedBanRole(discordId)) {
            removed++;
            await logModeration({ title: '⌛ Market ban ended', color: 0xFFFFFF, description: `<@${discordId}>: the ban ran out and the Market Banned role was removed.` });
        }
    }
    res.json({ ok: true, checked: (ended || []).length, removed });
});
