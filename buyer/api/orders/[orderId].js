// POST /api/orders/:orderId  { action: 'cancel' } — buyer cancels an order nobody has taken yet.
import { admin, handler, requireUser, body, cleanText, loadOrder, addEvent, syncDiscord, HttpError } from '../../lib/server.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const input = body(req);
    const order = await loadOrder(req.query.orderId);
    if (order.buyer_id !== account.id) throw new HttpError(404, `Order ${order.id} not found.`);

    if (input.action !== 'cancel') throw new HttpError(400, 'Unknown action.');

    const reason = cleanText(input.reason, 300) || 'Cancelled by buyer';
    // Conditional update: only succeeds if no seller grabbed it in the meantime.
    const { data: updated, error } = await admin().from('orders')
        .update({ status: 'CANCELLED', closed_reason: reason })
        .eq('id', order.id).eq('status', 'PENDING')
        .select();
    if (error) throw error;
    if (!updated?.length) {
        throw new HttpError(409, 'A seller has already taken this order, so it can no longer be cancelled here. Contact the seller on Discord.');
    }

    await addEvent(updated[0], 'CANCELLED', account, { message: reason });
    await syncDiscord(updated[0], `✖️ Order ${order.id} cancelled by buyer`);
    res.json({ ok: true, order: updated[0] });
});
