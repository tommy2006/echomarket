// POST /api/push — phone / browser alerts for the signed-in buyer.
//   { action: 'subscribe', subscription }   save this device (subscription = PushSubscription.toJSON())
//   { action: 'unsubscribe', endpoint }     forget this device
//   { action: 'test' }                      send a test alert to all of this account's devices
import { admin, handler, requireUser, body, sendPush, pushEndpointAllowed, rateLimit, PUSH_AVAILABLE, BUYER_URL, HttpError } from '../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    if (!PUSH_AVAILABLE) throw new HttpError(503, 'Phone alerts are not set up on this site yet.');
    const input = body(req);
    const db = admin();

    if (input.action === 'subscribe') {
        await rateLimit('push-sub:' + account.id, 20, 3600);
        const sub = input.subscription || {};
        const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
        if (!pushEndpointAllowed(endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpError(400, 'Invalid subscription.');
        // One device = one endpoint. If another account used this browser before, it now belongs to this one.
        const { error } = await db.from('push_subscriptions').upsert({
            endpoint,
            account_id: account.id,
            p256dh: String(sub.keys.p256dh).slice(0, 200),
            auth: String(sub.keys.auth).slice(0, 100),
            user_agent: String(req.headers['user-agent'] || '').slice(0, 200)
        });
        if (error) throw error;
        return res.json({ ok: true });
    }

    if (input.action === 'unsubscribe') {
        await db.from('push_subscriptions').delete().eq('endpoint', String(input.endpoint || '')).eq('account_id', account.id);
        return res.json({ ok: true });
    }

    if (input.action === 'test') {
        await rateLimit('push-test:' + account.id, 3, 600, 'You can send 3 test alerts per 10 minutes. Try again a bit later.');
        const sent = await sendPush(account.id, {
            title: '🛫 Echo Market alerts work!',
            body: "You'll get an alert like this when an order is fully delivered.",
            tag: 'echo-test',
            url: BUYER_URL || undefined
        });
        if (!sent) throw new HttpError(400, 'No device with alerts turned on was found. Turn alerts on first, on the device you want them on.');
        return res.json({ ok: true, message: `Test alert sent to ${sent} device${sent === 1 ? '' : 's'}.` });
    }

    throw new HttpError(400, 'Unknown action.');
});
