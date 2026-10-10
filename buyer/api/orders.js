// POST /api/orders — a signed-in buyer places an order.
// Body: { airlineIds: [id, …], buyerNote, items: [{ model, qty, pricePercent, note }] }
//   airlineIds  every one of the buyer's airlines the aircraft may be delivered to (the first one is the
//               main airline). The older form { airlineId } is still accepted.
// The checks and side effects are in lib/orders.js, shared with the Discord bot's /order.
import { handler, requireUser, body } from '../lib/server.js';
import { placeOrder } from '../lib/orders.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const input = body(req);
    const order = await placeOrder(account, {
        airlineIds: Array.isArray(input.airlineIds) ? input.airlineIds : [input.airlineId],
        items: input.items,
        buyerNote: input.buyerNote
    });
    res.status(201).json({ ok: true, order });
});
