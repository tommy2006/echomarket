// Training videos in the sellers' welcome (welcome.html): the seller guide cut into short parts, each at most two
// minutes (files in seller/media/training/, made from the full guide video).
//   - New sellers watch the five seller videos to the end before their pledges.
//   - Admins (Market Admins, Lead Ambassadors, admins added by hand) also get the admin wing: three admin videos,
//     four admin exhibits and a third pledge. Every admin goes through it once (sellers.admin_training_at); until then
//     the desk sends them to welcome.html and the admin tools refuse (requireAdminTraining in lib/server.js).
// "Watched" is recorded here, not trusted from the page: the page reports when a video starts and when it ends, and
// an end only counts when at least the video's length has passed since its start (sellers.training).
import { admin, isAdminSeller, HttpError } from './server.js';

// id → length in seconds, and whether it is an admin video. Keep in step with VIDEOS in js/welcome.js.
export const TRAINING_VIDEOS = {
    's1-getting-started': { seconds: 83.4, admin: false },
    's2-finding-orders': { seconds: 67.4, admin: false },
    's3-taking-and-delivering': { seconds: 70.3, admin: false },
    's4-teamwork-and-flags': { seconds: 68.3, admin: false },
    's5-missing-planes': { seconds: 80.3, admin: false },
    'a1-admin-orders-and-sellers': { seconds: 62.6, admin: true },
    'a2-moderation': { seconds: 49.3, admin: true },
    'a3-community': { seconds: 41.0, admin: true }
};
const SLACK = 4;   // seconds: clocks and the last frames
const RESTART_HOURS = 12;   // a start older than this (never finished) starts over

const ids = (admins) => Object.keys(TRAINING_VIDEOS).filter((id) => admins || !TRAINING_VIDEOS[id].admin);
export const watched = (row) => {
    const v = row?.training?.videos || {};
    return new Set(Object.keys(v).filter((id) => v[id]?.done));
};
// What this seller still has to do: { admin: needs the admin training, seller: needs the sellers' welcome, videos: [...] }.
export function trainingDue(row) {
    const needAdmin = isAdminSeller(row) && 'admin_training_at' in row && !row.admin_training_at;
    const needSeller = 'welcome_done_at' in row && !row.welcome_done_at;
    const tracked = 'training' in row;   // older database: no video check
    const seen = watched(row);
    const videos = !tracked ? [] : ids(needAdmin).filter((id) => (needAdmin || needSeller) && !seen.has(id));
    return { admin: needAdmin, seller: needSeller, videos };
}

// { id, event: 'start' | 'done' }
export async function recordVideo(seller, input) {
    const id = String(input.id || '');
    const video = TRAINING_VIDEOS[id];
    if (!video) throw new HttpError(400, 'Unknown training video.');
    if (!('training' in seller)) throw new HttpError(503, 'The seller desk needs a database update: an admin must re-run supabase/schema.sql.');
    const training = seller.training && typeof seller.training === 'object' ? structuredClone(seller.training) : {};
    training.videos ||= {};
    const entry = training.videos[id] || {};
    const now = Date.now();
    if (entry.done) return { ok: true, id, done: true };
    if (input.event === 'start') {
        if (!entry.started || now - Date.parse(entry.started) > RESTART_HOURS * 36e5) entry.started = new Date(now).toISOString();
    } else if (input.event === 'done') {
        const started = entry.started ? Date.parse(entry.started) : NaN;
        if (!(now - started >= (video.seconds - SLACK) * 1000)) throw new HttpError(409, 'That video ended too soon: watch it to the end.');
        entry.done = new Date(now).toISOString();
    } else {
        throw new HttpError(400, 'Unknown video event.');
    }
    training.videos[id] = entry;
    const { error } = await admin().from('sellers').update({ training }).eq('user_id', seller.user_id);
    if (error) throw error;
    return { ok: true, id, done: Boolean(entry.done) };
}
