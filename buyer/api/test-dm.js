// POST /api/test-dm — sends the signed-in user a test DM so they can check DMs reach them.
import { handler, requireUser, sendDM, rateLimit, BUYER_URL, HttpError } from '../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    await rateLimit('test-dm:' + account.id, 3, 600, 'You can send 3 test DMs per 10 minutes. Try again a bit later.');
    const result = await sendDM({ ...account, dm_enabled: true }, {
        title: '👋 Echo Market notifications work!',
        description: "You'll get a DM here when a seller takes your order, delivers aircraft, or declines it.",
        url: BUYER_URL || undefined
    });
    const messages = {
        sent: 'Test DM sent. Check your Discord DMs.',
        blocked: "Discord wouldn't let the bot DM you. Make sure you're in the Echo Discord server and that Privacy Settings → \"Direct Messages\" from server members is ON.",
        unavailable: 'DMs are not set up on this site yet (no bot token).',
        error: 'Something went wrong sending the DM. Try again later.'
    };
    if (result !== 'sent') throw new HttpError(result === 'unavailable' ? 503 : 400, messages[result]);
    res.json({ ok: true, message: messages.sent });
});
