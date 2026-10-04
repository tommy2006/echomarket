// POST /api/orders/:orderId — every seller action on an order.
// Body: { action, ... }
//   claim     { airlineId }            take an open order as one of your airlines
//   release   {}                       give it back to the open queue. If you already delivered some
//                                      aircraft, the rest is handed to the other sellers ("pass on the rest")
//   progress  { items: [n, n, …], note }  delivered so far, per aircraft type (same order as order.items)
//             { filled, note }            (older form: one total; spread over the lines in order)
//   note      { sellerNote }           note visible to the buyer
//   decline   { reason, force }        pass on an open order. The order is only DECLINED for the buyer
//                                      when every active seller has passed; the last one writes the reason.
//                                      Admins can send force: true to decline it for everyone at once.
//   flag      { flagStatus, flagReason }  seller-only moderation flag
//   delete    {}                       admins only — removes the order completely
import {
    admin, handler, requireUser, getSeller, accountName, body, cleanText,
    loadOrder, addEvent, syncDiscord, dmBuyer, sendPush, orderItems, sumFilled, BUYER_URL, HttpError
} from '../../lib/server.js';

const ACTIVE = ['CLAIMED', 'PARTIAL'];
const CLOSED = ['FULFILLED', 'CANCELLED', 'DECLINED'];
const FLAGS = ['NORMAL', 'SUSPICIOUS', 'BLACKLISTED'];
const statusFor = (filled, total) => (filled >= total ? 'FULFILLED' : filled > 0 ? 'PARTIAL' : 'CLAIMED');

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const seller = await getSeller(account.id);
    if (!seller) throw new HttpError(403, 'You are not on the seller list.');

    const input = body(req);
    const db = admin();
    const order = await loadOrder(req.query.orderId);
    const items = orderItems(order);
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
            // Whatever earlier sellers delivered is locked in: the new seller can't lower it.
            const locked = items.map((it) => ({ ...it, locked: it.filled }));
            const filled = sumFilled(locked);
            const updated = await update({
                status: filled > 0 ? 'PARTIAL' : 'CLAIMED',
                items: locked,
                seller_id: account.id,
                seller_name: accountName(account),
                seller_airline_id: airline.id,
                seller_airline_name: airline.name,
                seller_alliance: airline.alliance,
                claimed_at: new Date().toISOString()
            }, ['PENDING']);
            // Taking it means you no longer pass on it.
            await db.from('order_declines').delete().eq('order_id', order.id).eq('seller_id', account.id);
            await addEvent(updated, 'CLAIMED', account, {
                message: filled > 0
                    ? `${airline.name} takes over the remaining ${order.total_qty - filled} aircraft.`
                    : `${airline.name} will sell you this order.`
            });
            await syncDiscord(updated, `🤝 ${order.id} taken by ${airline.name}`);
            await dmBuyer(updated, 'CLAIMED');
            return res.json({ ok: true, order: updated });
        }

        case 'release': {
            mustOwn();
            if (!ACTIVE.includes(order.status)) throw new HttpError(409, 'Only orders in progress can be passed on.');
            const mine = items.reduce((s, it) => s + (it.filled - it.locked), 0);
            const previous = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];
            const updated = await update({
                status: 'PENDING',
                items: items.map((it) => ({ ...it, locked: it.filled })),
                previous_sellers: mine > 0 ? [...previous, {
                    seller_id: order.seller_id,
                    seller_name: order.seller_name,
                    seller_airline_name: order.seller_airline_name,
                    seller_alliance: order.seller_alliance,
                    delivered: mine,
                    at: new Date().toISOString()
                }] : previous,
                seller_id: null, seller_name: null, seller_airline_id: null,
                seller_airline_name: null, seller_alliance: null, claimed_at: null
            }, ACTIVE);
            const left = order.total_qty - updated.filled;
            if (updated.filled > 0) {
                await addEvent(updated, 'HANDOFF', account, {
                    filled: updated.filled,
                    message: `${order.seller_airline_name} passed on the remaining ${left} aircraft. Waiting for a new seller.`
                });
                await syncDiscord(updated, `🔁 ${order.id} needs a new seller — ${left} of ${order.total_qty} left`, { pingSellers: true });
                await dmBuyer(updated, 'HANDOFF', order.seller_airline_name);
            } else {
                await addEvent(updated, 'RELEASED', account, { message: 'The seller released this order. Waiting for another seller.' });
                await syncDiscord(updated, `↩️ ${order.id} is open again`, { pingSellers: true });
            }
            return res.json({ ok: true, order: updated });
        }

        case 'progress': {
            mustOwn();
            if (![...ACTIVE, 'FULFILLED'].includes(order.status)) throw new HttpError(409, 'Take the order before recording deliveries.');
            let wanted;
            if (Array.isArray(input.items)) {
                if (input.items.length !== items.length) throw new HttpError(400, 'Send one delivered count per aircraft type.');
                wanted = input.items.map((n) => Math.floor(Number(n) || 0));
            } else {
                // Older form: one total, spread over the lines in order.
                let rest = Math.floor(Number(input.filled) || 0);
                wanted = items.map((it) => { const n = Math.min(it.qty, Math.max(0, rest)); rest -= n; return n; });
            }
            const next = items.map((it, i) => ({ ...it, filled: Math.max(it.locked, Math.min(it.qty, wanted[i])) }));
            const filled = sumFilled(next);
            const status = statusFor(filled, order.total_qty);
            const updated = await update({ items: next, filled, status }, [...ACTIVE, 'FULFILLED']);

            const changes = next.filter((it, i) => it.filled !== items[i].filled)
                .map((it, i) => `${it.model}: ${it.filled}/${it.qty}`);
            const note = cleanText(input.note, 500);
            await addEvent(updated, status === 'FULFILLED' ? 'FULFILLED' : 'PROGRESS', account, {
                filled,
                message: [note, changes.length ? changes.join(' · ') : null].filter(Boolean).join(' — ') || `${filled} of ${order.total_qty} aircraft delivered.`
            });
            const title = status === 'FULFILLED' ? `✅ ${order.id} fulfilled` : `🟡 ${order.id}: ${filled}/${order.total_qty} delivered`;
            await syncDiscord(updated, title);
            // Notify only when more aircraft were delivered (not for corrections downwards).
            if (filled > order.filled) {
                await dmBuyer(updated, status === 'FULFILLED' ? 'FULFILLED' : 'PROGRESS', note);
                if (status === 'FULFILLED') {
                    await sendPush(updated.buyer_id, {
                        title: `✅ Order ${order.id} delivered`,
                        body: `All ${order.total_qty} aircraft for ${order.airline_name} have been delivered by ${order.seller_airline_name}.`,
                        tag: order.id,
                        url: BUYER_URL ? `${BUYER_URL}/#orders` : undefined
                    });
                }
            }
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
            if (CLOSED.includes(order.status)) throw new HttpError(409, 'This order is already closed.');
            const reason = cleanText(input.reason, 500);
            const closeForEveryone = async () => {
                if (!reason) throw new HttpError(400, 'Tell the buyer why the order is declined.');
                const updated = await update({ status: 'DECLINED', closed_reason: reason }, ['PENDING', ...ACTIVE]);
                await addEvent(updated, 'DECLINED', account, { message: reason });
                await syncDiscord(updated, `⛔ ${order.id} declined`);
                await dmBuyer(updated, 'DECLINED', reason);
                return res.json({ ok: true, order: updated, declinedForEveryone: true, sellersLeft: 0 });
            };

            if (input.force) {
                if (!seller.is_admin) throw new HttpError(403, 'Only admins can decline an order for the whole team.');
                return closeForEveryone();
            }
            if (order.status !== 'PENDING') {
                throw new HttpError(409, 'This order is being delivered. The seller handling it can pass on the rest instead.');
            }

            // Who would still be able to take it once this seller passes?
            const [{ data: active }, { data: passed }] = await Promise.all([
                db.from('sellers').select('user_id').eq('active', true),
                db.from('order_declines').select('seller_id').eq('order_id', order.id)
            ]);
            const passedIds = new Set((passed || []).map((d) => d.seller_id));
            passedIds.add(account.id);
            const sellersLeft = (active || []).filter((s) => !passedIds.has(s.user_id)).length;
            if (sellersLeft === 0) return closeForEveryone();

            const { error } = await db.from('order_declines').upsert({
                order_id: order.id, seller_id: account.id, seller_name: accountName(account), note: reason || null
            });
            if (error) throw error;
            await syncDiscord(order, `👋 ${accountName(account)} passed on ${order.id} — ${sellersLeft} seller${sellersLeft === 1 ? '' : 's'} left`);
            return res.json({ ok: true, order, declinedForEveryone: false, sellersLeft });
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
