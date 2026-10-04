// POST /api/orders/:orderId  { action: 'cancel' } — buyer cancels an order nobody has taken yet
// (and nothing has been delivered: a partly delivered order waiting for a new seller can't be cancelled).
import { admin, handler, requireUser, body, cleanText, loadOrder, addEvent, syncDiscord, orderRef, HttpError } from '../../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const input = body(req);
    const order = await loadOrder(req.query.orderId);
    if (order.buyer_id !== account.id) throw new HttpError(404, `Order ${order.id} not found.`);

    if (input.action !== 'cancel') throw new HttpError(400, 'Unknown action.');

    if (order.filled > 0) {
        throw new HttpError(409, 'Part of this order was already delivered, so it can no longer be cancelled here. Contact the sellers on Discord.');
    }
    const reason = cleanText(input.reason, 300) || 'Cancelled by buyer';
    // Conditional update: only succeeds if no seller grabbed it in the meantime.
    const { data: updated, error } = await admin().from('orders')
        .update({ status: 'CANCELLED', closed_reason: reason })
        .eq('id', order.id).eq('status', 'PENDING').eq('filled', 0)
        .select();
    if (error) throw error;
    if (!updated?.length) {
        throw new HttpError(409, 'A seller has already taken this order, so it can no longer be cancelled here. Contact the seller on Discord.');
    }

    await addEvent(updated[0], 'CANCELLED', account, { message: reason });
    await syncDiscord(updated[0], `✖️ Order ${orderRef(order)} cancelled by buyer`);
    res.json({ ok: true, order: updated[0] });
});
