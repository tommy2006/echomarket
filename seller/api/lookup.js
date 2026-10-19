// POST /api/lookup { discordId } — who is this Discord ID? For the seller desk, so a pasted ID shows the
// person's Discord username before you grant a reward, warn, ban or name a theft culprit.
// Echo Market accounts first (username and name as they signed in), otherwise Discord itself (needs the bot).
// Returns { ok, found, discordId, username, name, avatar, onMarket }.
import { admin, handler, requireUser, requireActiveSeller, rateLimit, body, discordBot, HttpError } from '../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await requireActiveSeller(account);
    await rateLimit('lookup:' + account.id, 120, 600, 'Too many look-ups in a short time. Wait a minute.');
    const id = String(body(req).discordId || '').trim();
    if (!/^\d{5,25}$/.test(id)) throw new HttpError(400, 'A Discord user ID is numbers only.');
    const { data: a } = await admin().from('accounts').select('discord_username, display_name, avatar_url').eq('discord_id', id).maybeSingle();
    if (a) return res.json({ ok: true, found: true, discordId: id, username: a.discord_username, name: a.display_name, avatar: a.avatar_url || null, onMarket: true });
    const u = await discordBot(`/users/${id}`).catch(() => null);
    if (u?.ok && u.json?.id) {
        const avatar = u.json.avatar ? `https://cdn.discordapp.com/avatars/${id}/${u.json.avatar}.png?size=64` : null;
        return res.json({ ok: true, found: true, discordId: id, username: u.json.username, name: u.json.global_name || null, avatar, onMarket: false });
    }
    // 404 from Discord: no such user. Anything else (no bot token, Discord down): unknown.
    res.json({ ok: true, found: u?.status === 404 ? false : null, discordId: id });
});
