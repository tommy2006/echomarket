// POST /api/orders/:orderId — every seller action on an order.
// Body: { action, ... }
//   claim     { airlineId }            take an open order as one of your airlines
//   join      { airlineId }            "take over": join an order another seller took TAKEOVER_HOURS ago and
//                                      hasn't finished. Their seller stays on it; the buyer is told you will
//                                      also be delivering (orders.helpers)
//   release   {}                       give it back to the open queue. If you already delivered some
//                                      aircraft, the rest is handed to the other sellers ("pass on the rest").
//                                      With sellers who joined, the first of them takes over the order instead.
//                                      A seller who joined stops delivering (what they listed stays counted).
//   progress  { mine: [n, n, …], note }   aircraft YOU listed so far, per aircraft type (same order as order.items)
//             { items: [n, n, …], note }  (older form: delivered in total per type, by the order's seller)
//             { filled, note }            (oldest form: one total; spread over the lines in order)
//   note      { sellerNote }           note visible to the buyer
//   decline   { reason, force }        pass on an open order. The order is only DECLINED for the buyer
//                                      when every active seller has passed; the last one writes the reason.
//                                      Admins can send force: true to decline it for everyone at once.
//   flag      { flagStatus, flagReason }  seller-only moderation flag
//   message   { body }                 message to the buyer about this order (any seller); the buyer is DMed
//   delete    {}                       admins only — removes the order completely
import {
    admin, handler, requireUser, requireActiveSeller, accountName, plain, body, cleanText,
    loadOrder, addEvent, syncDiscord, dmBuyer, sendPush, orderItems, sumFilled, orderRef, rateLimit, sendDM, md, BUYER_URL, SELLER_URL,
    orderHelpers, deliveryShares, shareText, TAKEOVER_HOURS, MAX_HELPERS, HttpError
} from '../../lib/server.js';

const ACTIVE = ['CLAIMED', 'PARTIAL'];
const CLOSED = ['FULFILLED', 'CANCELLED', 'DECLINED'];
const FLAGS = ['NORMAL', 'SUSPICIOUS', 'BLACKLISTED'];
const statusFor = (filled, total) => (filled >= total ? 'FULFILLED' : filled > 0 ? 'PARTIAL' : 'CLAIMED');

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    // Sellers who are in through the Discord role must still have it (re-checked every few minutes).
    const seller = await requireActiveSeller(account);
    await rateLimit('seller:' + account.id, 120, 600, 'Too many changes in a short time. Wait a minute and try again.');

    const input = body(req);
    const db = admin();
    const order = await loadOrder(req.query.orderId);
    const items = orderItems(order);
    const ref = orderRef(order);   // "#42 · ECH-…" for Discord and alerts
    const isOwner = order.seller_id === account.id;
    const helpers = orderHelpers(order);
    const myHelp = helpers.find((h) => h.seller_id === account.id) || null;   // I joined this order
    const mustOwn = () => {
        if (!isOwner && !seller.is_admin) {
            throw new HttpError(403, `This order is handled by ${order.seller_airline_name || 'another seller'}.`);
        }
    };
    // Conditional update: fails (409) if someone changed the order's status meanwhile. For actions only the
    // order's seller (or an admin) may do, the database also checks the seller hasn't changed in between.
    // version: also require the order to be exactly as loaded (several sellers can update the same order).
    const update = async (patch, expectedStatuses, { owned = false, version = false } = {}) => {
        let q = db.from('orders').update(patch).eq('id', order.id);
        if (expectedStatuses) q = q.in('status', expectedStatuses);
        if (version) q = q.eq('updated_at', order.updated_at);
        if (owned) {
            const sellerId = seller.is_admin ? order.seller_id : account.id;
            q = sellerId ? q.eq('seller_id', sellerId) : q.is('seller_id', null);
        }
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
                claimed_at: new Date().toISOString(),
                helpers: []
            }, ['PENDING']);
            // Taking it means you no longer pass on it.
            await db.from('order_declines').delete().eq('order_id', order.id).eq('seller_id', account.id);
            await addEvent(updated, 'CLAIMED', account, {
                message: filled > 0
                    ? `${airline.name} takes over the remaining ${order.total_qty - filled} aircraft.`
                    : `${airline.name} will sell you this order.`
            });
            await syncDiscord(updated, `🤝 ${ref} taken by ${plain(airline.name)}`);
            await dmBuyer(updated, 'CLAIMED');
            return res.json({ ok: true, order: updated });
        }

        case 'join': {
            if (!ACTIVE.includes(order.status)) throw new HttpError(409, 'Only orders that are being delivered can be taken over.');
            if (isOwner || myHelp) throw new HttpError(409, 'You are already delivering this order.');
            const hoursTaken = (Date.now() - new Date(order.claimed_at || order.created_at).getTime()) / 36e5;
            if (hoursTaken < TAKEOVER_HOURS) {
                const left = Math.ceil(TAKEOVER_HOURS - hoursTaken);
                throw new HttpError(409, `You can take over ${TAKEOVER_HOURS} hours after the order was taken: in about ${left} hour${left === 1 ? '' : 's'}.`);
            }
            if (helpers.length >= MAX_HELPERS) throw new HttpError(409, `${MAX_HELPERS} other sellers are already helping with this order.`);
            const { data: airline } = await db.from('airlines').select('*')
                .eq('id', input.airlineId || '00000000-0000-0000-0000-000000000000')
                .eq('owner_id', account.id).maybeSingle();
            if (!airline) throw new HttpError(400, 'Pick one of your airline profiles to sell as.');
            const updated = await update({
                helpers: [...helpers, {
                    seller_id: account.id, seller_name: accountName(account),
                    seller_airline_id: airline.id, seller_airline_name: airline.name, seller_alliance: airline.alliance,
                    joined_at: new Date().toISOString(), items: items.map(() => 0)
                }]
            }, ACTIVE, { version: true });
            await db.from('order_declines').delete().eq('order_id', order.id).eq('seller_id', account.id);
            await addEvent(updated, 'JOINED', account, {
                filled: updated.filled,
                message: `${airline.name} (${airline.alliance}) will also be delivering. Each seller lists their own aircraft: buy exactly what each one listed.`
            });
            await syncDiscord(updated, `🤝 ${ref}: ${plain(airline.name)} will also be delivering`);
            await dmBuyer(updated, 'JOINED', '', airline.name);
            // Let the order's seller know someone joined.
            if (order.seller_id) {
                const { data: first } = await db.from('accounts').select('*').eq('id', order.seller_id).maybeSingle();
                if (first) await sendDM(first, {
                    title: `🤝 ${md(airline.name)} joined your order ${ref}`,
                    description: `The order was taken ${Math.floor(hoursTaken)} hours ago and isn't fully delivered, so **${md(airline.name)}** (${md(accountName(account))}) took over part of it. You both stay on the order: record only the aircraft **you** list.`,
                    url: SELLER_URL ? `${SELLER_URL}/#${order.id}` : undefined
                });
            }
            return res.json({ ok: true, order: updated });
        }

        case 'release': {
            // A seller who joined stops delivering: what they listed stays counted (locked) and is shown as theirs.
            if (myHelp && !isOwner) {
                if (!ACTIVE.includes(order.status)) throw new HttpError(409, 'This order is no longer being delivered.');
                const listed = items.map((it, i) => Math.floor(Number(myHelp.items?.[i])) || 0);
                const total = listed.reduce((a, b) => a + b, 0);
                const previous = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];
                const updated = await update({
                    items: items.map((it, i) => ({ ...it, locked: Math.min(it.filled, it.locked + listed[i]) })),
                    helpers: helpers.filter((h) => h.seller_id !== account.id),
                    previous_sellers: total > 0 ? [...previous, {
                        seller_id: account.id, seller_name: myHelp.seller_name, seller_airline_name: myHelp.seller_airline_name,
                        seller_alliance: myHelp.seller_alliance, delivered: total, items: listed, at: new Date().toISOString()
                    }] : previous
                }, ACTIVE, { version: true });
                await addEvent(updated, 'RELEASED', account, {
                    message: `${myHelp.seller_airline_name} stopped delivering${total ? ` (the ${total} they listed stay counted)` : ''}.`
                });
                await syncDiscord(updated, `↩️ ${ref}: ${plain(myHelp.seller_airline_name)} stopped delivering`);
                return res.json({ ok: true, order: updated });
            }
            mustOwn();
            if (!ACTIVE.includes(order.status)) throw new HttpError(409, 'Only orders in progress can be passed on.');
            const shareNow = deliveryShares(order).find((sh) => sh.role === 'seller');
            const myLines = shareNow ? shareNow.items : items.map(() => 0);
            const mine = myLines.reduce((a, b) => a + b, 0);
            const previous = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];
            const leaving = mine > 0 ? [...previous, {
                seller_id: order.seller_id,
                seller_name: order.seller_name,
                seller_airline_name: order.seller_airline_name,
                seller_alliance: order.seller_alliance,
                delivered: mine,
                items: myLines,
                at: new Date().toISOString()
            }] : previous;
            // Sellers joined it: the first of them now handles the order, nothing goes back to the queue.
            if (helpers.length) {
                const [next, ...rest] = helpers;
                const updated = await update({
                    items: items.map((it, i) => ({ ...it, locked: it.locked + myLines[i] })),
                    previous_sellers: leaving,
                    seller_id: next.seller_id, seller_name: next.seller_name, seller_airline_id: next.seller_airline_id,
                    seller_airline_name: next.seller_airline_name, seller_alliance: next.seller_alliance,
                    claimed_at: next.joined_at || new Date().toISOString(),
                    helpers: rest
                }, ACTIVE, { owned: true, version: true });
                await addEvent(updated, 'HANDOFF', account, {
                    message: `${order.seller_airline_name} stopped delivering; ${next.seller_airline_name} now handles the rest of the order.`
                });
                await syncDiscord(updated, `🔁 ${ref}: ${plain(next.seller_airline_name)} now handles the order`);
                return res.json({ ok: true, order: updated });
            }
            const updated = await update({
                status: 'PENDING',
                items: items.map((it) => ({ ...it, locked: it.filled })),
                previous_sellers: leaving,
                helpers: [],
                seller_id: null, seller_name: null, seller_airline_id: null,
                seller_airline_name: null, seller_alliance: null, claimed_at: null
            }, ACTIVE, { owned: true });
            const left = order.total_qty - updated.filled;
            if (updated.filled > 0) {
                await addEvent(updated, 'HANDOFF', account, {
                    filled: updated.filled,
                    message: `${order.seller_airline_name} passed on the remaining ${left} aircraft. Waiting for a new seller.`
                });
                await syncDiscord(updated, `🔁 ${ref} needs a new seller — ${left} of ${order.total_qty} left`, { pingSellers: true });
                await dmBuyer(updated, 'HANDOFF', order.seller_airline_name);
            } else {
                await addEvent(updated, 'RELEASED', account, { message: 'The seller released this order. Waiting for another seller.' });
                await syncDiscord(updated, `↩️ ${ref} is open again`, { pingSellers: true });
            }
            return res.json({ ok: true, order: updated });
        }

        case 'progress': {
            // The order's seller, a seller who joined it (take over), or an admin (acting as the order's seller).
            const asHelper = Boolean(myHelp) && !isOwner;
            if (!asHelper) mustOwn();
            if (![...ACTIVE, 'FULFILLED'].includes(order.status)) throw new HttpError(409, 'Take the order before recording deliveries.');
            // Everyone records only what THEY listed; everybody else's aircraft stay as they are.
            const shares = deliveryShares(order);
            const myNow = (asHelper ? shares.find((sh) => sh.role === 'helper' && sh.sellerId === account.id)
                : shares.find((sh) => sh.role === 'seller'))?.items || items.map(() => 0);
            const others = items.map((it, i) => it.filled - myNow[i]);
            let mineWanted;
            if (Array.isArray(input.mine)) {
                if (input.mine.length !== items.length) throw new HttpError(400, 'Send one count per aircraft type.');
                mineWanted = input.mine.map((n) => Math.floor(Number(n) || 0));
            } else {
                // Older forms (delivered in total), only for the order's seller.
                if (asHelper) throw new HttpError(400, 'Send the aircraft you listed yourself.');
                let totals;
                if (Array.isArray(input.items)) {
                    if (input.items.length !== items.length) throw new HttpError(400, 'Send one delivered count per aircraft type.');
                    totals = input.items.map((n) => Math.floor(Number(n) || 0));
                } else {
                    let rest = Math.floor(Number(input.filled) || 0);
                    totals = items.map((it) => { const n = Math.min(it.qty, Math.max(0, rest)); rest -= n; return n; });
                }
                mineWanted = totals.map((n, i) => n - others[i]);
            }
            const mineNext = items.map((it, i) => Math.max(0, Math.min(it.qty - others[i], mineWanted[i])));
            const next = items.map((it, i) => ({ ...it, filled: others[i] + mineNext[i] }));
            const filled = sumFilled(next);
            const status = statusFor(filled, order.total_qty);
            const patch = { items: next, filled, status };
            if (asHelper) patch.helpers = helpers.map((h) => (h.seller_id === account.id ? { ...h, items: mineNext } : h));
            const updated = await update(patch, [...ACTIVE, 'FULFILLED'], { owned: !asHelper, version: true });

            const myAirline = asHelper ? myHelp.seller_airline_name : order.seller_airline_name;
            const listedText = shareText(updated, { items: mineNext });
            const note = cleanText(input.note, 500);
            await addEvent(updated, status === 'FULFILLED' ? 'FULFILLED' : 'PROGRESS', account, {
                filled,
                message: [note, `${myAirline} has listed ${listedText} (${filled} of ${order.total_qty} delivered in total)`].filter(Boolean).join(' — ')
            });
            const title = status === 'FULFILLED' ? `✅ ${ref} fulfilled` : `🟡 ${ref}: ${filled}/${order.total_qty} delivered`;
            await syncDiscord(updated, title);
            // Notify only when more aircraft were delivered (not for corrections downwards).
            if (filled > order.filled) {
                await dmBuyer(updated, status === 'FULFILLED' ? 'FULFILLED' : 'PROGRESS', note, myAirline);
                if (status === 'FULFILLED') {
                    await sendPush(updated.buyer_id, {
                        title: `✅ Order ${ref} delivered`,
                        body: `All ${order.total_qty} aircraft for ${order.airline_name} have been delivered by ${orderHelpers(updated).length ? 'your sellers' : order.seller_airline_name}.`,
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
            const updated = await update({ seller_note: sellerNote || null }, null, { owned: true });
            if (sellerNote) await addEvent(updated, 'NOTE', account, { message: sellerNote });
            await syncDiscord(updated, `🔖 ${ref}: seller note updated`);
            return res.json({ ok: true, order: updated });
        }

        case 'decline': {
            if (CLOSED.includes(order.status)) throw new HttpError(409, 'This order is already closed.');
            const reason = cleanText(input.reason, 500);
            const closeForEveryone = async () => {
                if (!reason) throw new HttpError(400, 'Tell the buyer why the order is declined.');
                const updated = await update({ status: 'DECLINED', closed_reason: reason }, ['PENDING', ...ACTIVE]);
                await addEvent(updated, 'DECLINED', account, { message: reason });
                await syncDiscord(updated, `⛔ ${ref} declined`);
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
            await syncDiscord(order, `👋 ${plain(accountName(account))} passed on ${ref} — ${sellersLeft} seller${sellersLeft === 1 ? '' : 's'} left`);
            return res.json({ ok: true, order, declinedForEveryone: false, sellersLeft });
        }

        case 'message': {
            const text = cleanText(input.body, 1000);
            if (!text) throw new HttpError(400, 'Write a message first.');
            const { data: msg, error } = await db.from('order_messages').insert({
                order_id: order.id, buyer_id: order.buyer_id, author_id: account.id, author_name: accountName(account),
                from_role: 'seller', body: text
            }).select().single();
            if (error) throw error;
            if (order.buyer_id) {
                const { data: buyer } = await db.from('accounts').select('*').eq('id', order.buyer_id).maybeSingle();
                if (buyer) await sendDM(buyer, {
                    title: `💬 The seller team wrote about your order ${ref}`,
                    description: `**${md(accountName(account))}** wrote:
> ${md(text).slice(0, 1500)}

Answer on Echo Market (Orders).`,
                    url: BUYER_URL ? `${BUYER_URL}/#orders` : undefined
                });
            }
            return res.json({ ok: true, order, message: msg });
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
            await syncDiscord(order, status === 'NORMAL' ? `🟢 ${ref}: flag cleared` : `🚩 ${ref} flagged ${status}`);
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
