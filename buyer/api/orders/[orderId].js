// POST /api/orders/:orderId — the buyer's own actions on an order.
//   { action: 'cancel', reason }   cancel an order nobody has taken yet (and nothing has been delivered:
//                                  a partly delivered order waiting for a new seller can't be cancelled)
//   { action: 'message', body }    write to the seller team. Allowed once the order has waited
//                                  CONTACT_AFTER_DAYS without being fully delivered, or to answer a seller.
import {
    admin, handler, requireUser, body, cleanText, loadOrder, addEvent, syncDiscord, orderRef, accountName,
    requireMarketAccess, rateLimit, sendDM, md, SELLER_URL, HttpError
} from '../../lib/server.js';

export const CONTACT_AFTER_DAYS = 5;
const OPEN = ['PENDING', 'CLAIMED', 'PARTIAL'];

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const input = body(req);
    const order = await loadOrder(req.query.orderId);
    if (order.buyer_id !== account.id) throw new HttpError(404, `Order ${order.id} not found.`);
    const db = admin();

    if (input.action === 'message') {
        await requireMarketAccess(account);
        await rateLimit('buyer-msg:' + account.id, 10, 3600, 'You can send 10 messages per hour. Wait a bit and try again.');
        const text = cleanText(input.body, 1000);
        if (!text) throw new HttpError(400, 'Write a message first.');
        const ageDays = (Date.now() - new Date(order.created_at).getTime()) / 864e5;
        const { count: sellerMessages } = await db.from('order_messages').select('id', { count: 'exact', head: true })
            .eq('order_id', order.id).eq('from_role', 'seller');
        const waitedLongEnough = ageDays >= CONTACT_AFTER_DAYS && OPEN.includes(order.status);
        if (!waitedLongEnough && !sellerMessages) {
            throw new HttpError(409, OPEN.includes(order.status)
                ? `You can contact the seller team once an order has waited ${CONTACT_AFTER_DAYS} days without being fully delivered.`
                : 'This order is finished, so it can no longer be discussed here. Ask on the Echo Discord server.');
        }
        const { data: msg, error } = await db.from('order_messages').insert({
            order_id: order.id, buyer_id: order.buyer_id, author_id: account.id, author_name: accountName(account),
            from_role: 'buyer', body: text
        }).select().single();
        if (error) throw error;
        // Sellers see it live on the seller desk; the seller handling the order also gets a DM.
        if (order.seller_id) {
            const { data: seller } = await db.from('accounts').select('*').eq('id', order.seller_id).maybeSingle();
            if (seller) {
                await sendDM({ ...seller, dm_enabled: true }, {
                    title: `💬 Message from the buyer of ${orderRef(order)}`,
                    description: `**${md(accountName(account))}** (${md(order.airline_name)}) wrote:\n> ${md(text).slice(0, 1500)}\n\nAnswer on the seller desk.`,
                    url: SELLER_URL ? `${SELLER_URL}/#${order.id}` : undefined
                });
            }
        }
        return res.json({ ok: true, message: msg });
    }

    if (input.action !== 'cancel') throw new HttpError(400, 'Unknown action.');

    if (order.filled > 0) {
        throw new HttpError(409, 'Part of this order was already delivered, so it can no longer be cancelled here. Contact the sellers on Discord.');
    }
    const reason = cleanText(input.reason, 300) || 'Cancelled by buyer';
    // Conditional update: only succeeds if no seller grabbed it in the meantime.
    const { data: updated, error } = await db.from('orders')
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
