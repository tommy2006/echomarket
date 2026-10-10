// POST /api/admin/discord-commands — the bot's slash commands and where buyers may use them. Admins only.
// Body: { action: 'status' | 'install' | 'channel', channelIds }
//   status   which commands are installed, and the ordering channel(s)
//   install  (re)install /market, /airline, /order in the Echo server
//   channel  set the channel(s) where buyers may use /order and /airline ("" = anywhere). /market works
//            everywhere for Market Admins. Saved in market_settings, so no redeploy is needed.
// Uses the bot token on the server, so nobody has to handle it. Installing needs DISCORD_GUILD_ID and the bot
// invited with the "applications.commands" scope (otherwise Discord answers "Missing Access").
import {
    handler, requireUser, requireActiveSeller, accountName, body, rateLimit, discordBot, getSetting, setSetting,
    DM_AVAILABLE, GUILD_IDS, HttpError
} from '../../lib/server.js';
import { COMMANDS } from '../../lib/discord-commands.js';

// Channel id → { id, name } (or an error text), as the bot sees it.
async function describeChannel(id) {
    const ch = await discordBot(`/channels/${id}`);
    if (!ch.ok) return { id, error: `the bot can't see channel ${id} (HTTP ${ch.status})` };
    if (GUILD_IDS.length && ch.json.guild_id !== GUILD_IDS[0]) return { id, error: `channel ${id} is not in the Echo Alliances server` };
    return { id, name: ch.json.name };
}

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const me = await requireActiveSeller(account);
    if (!me.is_admin) throw new HttpError(403, 'Only admins can manage the Discord commands.');
    await rateLimit('discord-commands:' + account.id, 20, 600);
    if (!DM_AVAILABLE) throw new HttpError(503, 'The bot token (DISCORD_BOT_TOKEN) is not set in this Vercel project.');
    if (!GUILD_IDS.length) throw new HttpError(503, 'DISCORD_GUILD_ID is not set in this Vercel project.');
    const input = body(req);
    const action = ['install', 'channel'].includes(input.action) ? input.action : 'status';

    if (action === 'channel') {
        const ids = [...new Set(String(input.channelIds || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
        if (ids.some((id) => !/^\d{5,25}$/.test(id))) throw new HttpError(400, 'Channel IDs are numbers only: right-click the channel → Copy Channel ID.');
        if (ids.length > 5) throw new HttpError(400, 'At most 5 ordering channels.');
        const channels = await Promise.all(ids.map(describeChannel));
        const bad = channels.find((c) => c.error);
        if (bad) throw new HttpError(400, `${bad.error}. Give the bot View Channel there, or check the ID.`);
        await setSetting('order_channel_ids', ids, accountName(account));
    }

    const app = await discordBot('/oauth2/applications/@me');
    if (!app.ok) throw new HttpError(502, `Discord didn't return the bot's application (HTTP ${app.status}).`);
    const path = `/applications/${app.json.id}/guilds/${GUILD_IDS[0]}/commands`;
    const r = action === 'install' ? await discordBot(path, 'PUT', COMMANDS) : await discordBot(path);
    if (!r.ok) {
        const missing = r.status === 403 || r.json?.code === 50001;
        throw new HttpError(502, missing
            ? 'Discord refused: the bot was invited without the "applications.commands" scope. Open the invite link again with scope=bot%20applications.commands, then try again.'
            : `Discord refused the commands (HTTP ${r.status}): ${r.json?.message || 'unknown error'}`);
    }
    const ids = await getSetting('order_channel_ids', []);
    const orderChannels = await Promise.all((Array.isArray(ids) ? ids : []).map(describeChannel));
    res.json({ ok: true, action, commands: (r.json || []).map((c) => `/${c.name}`), orderChannels });
});
