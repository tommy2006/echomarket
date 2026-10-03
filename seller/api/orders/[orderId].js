// POST /api/orders/:orderId — every seller action on an order.
// Body: { action, ... }
//   claim     { airlineId }            take an open order as one of your airlines
//   release   {}                       give it back to the queue (nothing delivered yet)
//   progress  { filled, note }         record how many aircraft were delivered in-game
//   note      { sellerNote }           note visible to the buyer
//   decline   { reason }               refuse the order (buyer sees the reason)
//   flag      { flagStatus, flagReason }  seller-only moderation flag
//   delete    {}                       admins only — removes the order completely
import {
    admin, handler, requireUser, getSeller, accountName, body, cleanText,
    loadOrder, addEvent, syncDiscord, dmBuyer, HttpError
} from '../../lib/server.js';

const ACTIVE = ['CLAIMED', 'PARTIAL'];
const FLAGS = ['NORMAL', 'SUSPICIOUS', 'BLACKLISTED'];

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const seller = await getSeller(account.id);
    if (!seller) throw new HttpError(403, 'You are not on the seller list.');

    const input = body(req);
    const db = admin();
    const order = await loadOrder(req.query.orderId);
    const isOwner = order.seller_id === account.id;
    const mustOwn = () => {
        if (!isOwner && !seller.is_admin) {
            throw new HttpError(403, `This order is handled by ${order.seller_airline_name || 'another seller'}.`);
        }
    };
    // Conditional update: fails (409) if someone changed the order's status meanwhile.
    const update = async (patch, expectedStatuses) => {
        let q = db.from('orders').update(patch).eq('id', order.id);
        if (expectedStatuses) q = q.in('status', expectedStatuses);
        const { data, error } = await q.select();
        if (error) throw error;
        if (!data?.length) throw new HttpError(409, 'This order was just changed by someone else. Refresh and try again.');
        return data[0];
    };

    switch (input.action) {
        case 'claim': {
            if (order.status !== 'PENDING') throw new HttpError(409, 'This order has already been taken or closed.');
            const { data: airline } = await db.from('airlines').select('*')
                .eq('id', input.airlineId || '00000000-0000-0000-0000-000000000000')
                .eq('owner_id', account.id).maybeSingle();
            if (!airline) throw new HttpError(400, 'Pick one of your airline profiles to sell as.');
            const updated = await update({
                status: 'CLAIMED',
                seller_id: account.id,
                seller_name: accountName(account),
                seller_airline_id: airline.id,
                seller_airline_name: airline.name,
                seller_alliance: airline.alliance,
                claimed_at: new Date().toISOString()
            }, ['PENDING']);
            await addEvent(updated, 'CLAIMED', account, { message: `${airline.name} will sell you this order.` });
            await syncDiscord(updated, `🤝 ${order.id} taken by ${airline.name}`);
            await dmBuyer(updated, 'CLAIMED');
            return res.json({ ok: true, order: updated });
        }

        case 'release': {
            mustOwn();
            if (order.status !== 'CLAIMED' || order.filled > 0) {
                throw new HttpError(409, 'Only taken orders with nothing delivered yet can be released.');
            }
            const updated = await update({
                status: 'PENDING', seller_id: null, seller_name: null, seller_airline_id: null,
                seller_airline_name: null, seller_alliance: null, claimed_at: null
            }, ['CLAIMED']);
            await addEvent(updated, 'RELEASED', account, { message: 'The seller released this order. Waiting for another seller.' });
            await syncDiscord(updated, `↩️ ${order.id} is open again`, { pingSellers: true });
            return res.json({ ok: true, order: updated });
        }

        case 'progress': {
            mustOwn();
            if (![...ACTIVE, 'FULFILLED'].includes(order.status)) throw new HttpError(409, 'Take the order before recording deliveries.');
            const filled = Math.max(0, Math.min(order.total_qty, Math.floor(Number(input.filled) || 0)));
            const status = filled === 0 ? 'CLAIMED' : filled >= order.total_qty ? 'FULFILLED' : 'PARTIAL';
            const updated = await update({ filled, status }, [...ACTIVE, 'FULFILLED']);
            const note = cleanText(input.note, 500);
            await addEvent(updated, status === 'FULFILLED' ? 'FULFILLED' : 'PROGRESS', account, {
                filled, message: note || `${filled} of ${order.total_qty} aircraft delivered.`
            });
            const title = status === 'FULFILLED' ? `✅ ${order.id} fulfilled` : `🟡 ${order.id}: ${filled}/${order.total_qty} delivered`;
            await syncDiscord(updated, title);
            // DM only when more aircraft were delivered (not for corrections downwards).
            if (filled > order.filled) await dmBuyer(updated, status === 'FULFILLED' ? 'FULFILLED' : 'PROGRESS', note);
            return res.json({ ok: true, order: updated });
        }

        case 'note': {
            mustOwn();
            const sellerNote = cleanText(input.sellerNote, 1000);
            const updated = await update({ seller_note: sellerNote || null });
            if (sellerNote) await addEvent(updated, 'NOTE', account, { message: sellerNote });
            await syncDiscord(updated, `🔖 ${order.id}: seller note updated`);
            return res.json({ ok: true, order: updated });
        }

        case 'decline': {
            if (order.status !== 'PENDING') mustOwn();
            if (['FULFILLED', 'CANCELLED', 'DECLINED'].includes(order.status)) throw new HttpError(409, 'This order is already closed.');
            const reason = cleanText(input.reason, 500);
            if (!reason) throw new HttpError(400, 'Tell the buyer why the order is declined.');
            const updated = await update({ status: 'DECLINED', closed_reason: reason }, ['PENDING', ...ACTIVE]);
            await addEvent(updated, 'DECLINED', account, { message: reason });
            await syncDiscord(updated, `⛔ ${order.id} declined`);
            await dmBuyer(updated, 'DECLINED', reason);
            return res.json({ ok: true, order: updated });
        }

        case 'flag': {
            const status = FLAGS.includes(input.flagStatus) ? input.flagStatus : null;
            if (!status) throw new HttpError(400, 'Invalid flag.');
            const { error } = await db.from('order_flags').upsert({
                order_id: order.id,
                status,
                reason: cleanText(input.flagReason, 500) || null,
                flagged_by: accountName(account),
                flagged_at: new Date().toISOString()
            });
            if (error) throw error;
            await syncDiscord(order, status === 'NORMAL' ? `🟢 ${order.id}: flag cleared` : `🚩 ${order.id} flagged ${status}`);
            return res.json({ ok: true, order });
        }

        case 'delete': {
            if (!seller.is_admin) throw new HttpError(403, 'Only admins can delete orders. Decline it instead.');
            // Closing it first makes syncDiscord remove the Discord message.
            await syncDiscord({ ...order, status: 'CANCELLED' }, 'deleted');
            const { error } = await db.from('orders').delete().eq('id', order.id);
            if (error) throw error;
            return res.json({ ok: true });
        }

        default:
            throw new HttpError(400, 'Unknown action.');
    }
});
