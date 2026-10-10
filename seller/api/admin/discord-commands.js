// POST /api/admin/discord-commands — install or check the bot's slash commands in the Echo server.
// Admins only. Body: { action: 'install' | 'status' }
// Uses the bot token on the server, so nobody has to handle it. Needs DISCORD_GUILD_ID and the bot invited
// with the "applications.commands" scope (otherwise Discord answers "Missing Access").
import { handler, requireUser, requireActiveSeller, body, rateLimit, discordBot, DM_AVAILABLE, GUILD_IDS, HttpError } from '../../lib/server.js';
import { COMMANDS } from '../../lib/discord-commands.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const me = await requireActiveSeller(account);
    if (!me.is_admin) throw new HttpError(403, 'Only admins can install the Discord commands.');
    await rateLimit('discord-commands:' + account.id, 10, 600);
    if (!DM_AVAILABLE) throw new HttpError(503, 'The bot token (DISCORD_BOT_TOKEN) is not set in this Vercel project.');
    if (!GUILD_IDS.length) throw new HttpError(503, 'DISCORD_GUILD_ID is not set in this Vercel project.');

    const app = await discordBot('/oauth2/applications/@me');
    if (!app.ok) throw new HttpError(502, `Discord didn't return the bot's application (HTTP ${app.status}).`);
    const path = `/applications/${app.json.id}/guilds/${GUILD_IDS[0]}/commands`;
    const action = body(req).action === 'install' ? 'install' : 'status';
    const r = action === 'install' ? await discordBot(path, 'PUT', COMMANDS) : await discordBot(path);
    if (!r.ok) {
        const missing = r.status === 403 || r.json?.code === 50001;
        throw new HttpError(502, missing
            ? 'Discord refused: the bot was invited without the "applications.commands" scope. Open the invite link again with scope=bot%20applications.commands, then try again.'
            : `Discord refused the commands (HTTP ${r.status}): ${r.json?.message || 'unknown error'}`);
    }
    const names = (r.json || []).map((c) => `/${c.name}`);
    res.json({ ok: true, action, commands: names, applicationId: app.json.id });
});
