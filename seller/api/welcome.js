// POST /api/welcome — the sellers' welcome (welcome.html), with its admin wing for admins (lib/training.js).
//   { video: { id, event: 'start' | 'done' } }       a training video started / played to the end
//   { pledges: { check: true, serve: true, admin? } } finished: records sellers.welcome_done_at and, for admins,
//                                                     sellers.admin_training_at (needs every due video watched).
// Until then the seller desk sends them there: sellers can't take orders, admins can't use the admin tools.
import { admin, handler, requireUser, requireActiveSeller, rateLimit, body, HttpError } from '../lib/server.js';
import { recordVideo, trainingDue } from '../lib/training.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const seller = await requireActiveSeller(account);
    const input = body(req);
    if (input.video) {
        await rateLimit('welcome-video:' + account.id, 80, 600);
        return res.json(await recordVideo({ ...seller, user_id: account.id }, input.video));
    }
    await rateLimit('welcome:' + account.id, 20, 600);
    if (input.pledges?.check !== true || input.pledges?.serve !== true) throw new HttpError(400, 'Tick both pledges first.');
    if (!('welcome_done_at' in seller)) throw new HttpError(503, 'The seller desk needs a database update: an admin must re-run supabase/schema.sql.');
    const due = trainingDue(seller);
    if (due.admin && input.pledges?.admin !== true) throw new HttpError(400, 'Tick all three pledges first.');
    if (due.videos.length) throw new HttpError(403, 'Watch every training video to the end first.');
    const now = new Date().toISOString();
    const patch = { welcome_done_at: seller.welcome_done_at || now, ...(due.admin ? { admin_training_at: now } : {}) };
    const { error } = await admin().from('sellers').update(patch).eq('user_id', account.id);
    if (error) throw error;
    res.json({ ok: true, welcomeDoneAt: patch.welcome_done_at, adminTrainingAt: patch.admin_training_at || seller.admin_training_at || null });
});
