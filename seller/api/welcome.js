// POST /api/welcome { pledges: { check: true, serve: true } } — the seller finished the sellers' welcome
// (welcome.html) and ticked both pledges. Until then the seller desk sends them there and they can't take orders.
import { admin, handler, requireUser, requireActiveSeller, rateLimit, body, HttpError } from '../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const seller = await requireActiveSeller(account);
    await rateLimit('welcome:' + account.id, 20, 600);
    const input = body(req);
    if (input.pledges?.check !== true || input.pledges?.serve !== true) throw new HttpError(400, 'Tick both pledges first.');
    if (!('welcome_done_at' in seller)) throw new HttpError(503, 'The seller desk needs a database update: an admin must re-run supabase/schema.sql.');
    const at = seller.welcome_done_at || new Date().toISOString();
    const { error } = await admin().from('sellers').update({ welcome_done_at: at }).eq('user_id', account.id);
    if (error) throw error;
    res.json({ ok: true, welcomeDoneAt: at });
});
