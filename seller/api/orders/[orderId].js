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
//   missing   { reportId, outcome, note, culprits: [discordId, …] }  close a buyer's missing-plane report:
//                                      'confirmed' (theft: posted to the moderation log; every culprit gets an
//                                      automatic warning; no culprits = "under investigation") or 'not_theft'.
//                                      Sellers on the order and admins only.
//   missing-culprits { reportId, culprits: [discordId, …], done }  any seller: name (more) culprits of a
//                                      confirmed theft later; each is warned and logged. done: true closes the
//                                      investigation (also with no names: "culprit could not be identified").
//   missing-clear { reportId, note, verified }  clear a confirmed theft: the warned culprit(s) re-listed the
//                                      planes for the buyer (checked in-game). Logged; buyer and culprits are DMed.
//   flag      { flagStatus, flagReason }  seller-only moderation flag
//   message   { body }                 message to the buyer about this order (any seller); the buyer is DMed
//   delete    {}                       admins only — removes the order completely
import {
    admin, handler, requireUser, requireActiveSeller, accountName, plain, body, cleanText,
    loadOrder, addEvent, syncDiscord, dmBuyer, sendPush, orderItems, sumFilled, orderRef, rateLimit, sendDM, md, BUYER_URL, SELLER_URL,
    orderHelpers, deliveryShares, shareText, TAKEOVER_HOURS, MAX_HELPERS, logModeration, dmDiscordUser, EMBED_COLORS, HttpError
} from '../../lib/server.js';
import { resolveTarget, sendMarketMessage } from '../../lib/moderation.js';

const ACTIVE = ['CLAIMED', 'PARTIAL'];
const MAX_CULPRITS = 10;   // per report (one theft had 4)
const THEFT_WARNING = (ref) => `You bought aircraft on the in-game market that were listed for another Echo Market buyer (order ${ref}). Only buy planes you ordered: that is a market rule. Follow the seller team's instructions (for example, re-list the planes for the buyer). Another case can lead to a market ban.`;

// The culprit Discord IDs a seller typed: cleaned, checked, without duplicates.
function culpritIds(input, order, account) {
    const raw = Array.isArray(input.culprits) ? input.culprits : [input.culpritDiscordId];   // older form: one ID
    const ids = [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (ids.length > MAX_CULPRITS) throw new HttpError(400, `At most ${MAX_CULPRITS} culprits at once.`);
    for (const id of ids) {
        if (!/^\d{17,20}$/.test(id)) throw new HttpError(400, `"${id.slice(0, 30)}" isn't a Discord user ID (17–20 digits: right-click the user → Copy User ID).`);
        if (id === order.buyer_discord_id) throw new HttpError(400, "One of those is the buyer's own Discord ID.");
        if (id === account.discord_id) throw new HttpError(400, 'One of those is your own Discord ID.');
    }
    return ids;
}

// Warn each culprit of a confirmed theft (automatic market warning: DM + moderation log) and attach them to
// the report. Skips anyone already attached to it. Returns [{ discordId, name, warningId }].
async function warnCulprits({ db, order, report, ids, account, ref }) {
    const { data: existing } = await db.from('missing_report_culprits').select('discord_id').eq('report_id', report.id);
    const known = new Set((existing || []).map((c) => c.discord_id));
    const out = [];
    for (const id of ids) {
        if (known.has(id)) continue;
        // Attach first (unique per report), so two sellers pressing at once can't warn the same person twice.
        const { data: row, error } = await db.from('missing_report_culprits').insert({
            report_id: report.id, order_id: order.id, discord_id: id,
            added_by: account.id, added_by_name: accountName(account)
        }).select().single();
        if (error) { if (error.code === '23505') continue; throw error; }
        const target = await resolveTarget({ discordId: id });
        const sent = await sendMarketMessage({
            target, kind: 'warning', source: 'theft',
            by: { accountId: account.id, name: accountName(account) }, body: THEFT_WARNING(ref)
        });
        await db.from('missing_report_culprits').update({ name: target.name, warning_id: sent.message.id }).eq('id', row.id);
        out.push({ discordId: id, name: target.name, warningId: sent.message.id });
    }
    return out;
}
const culpritLines = (list) => list.map((c) => `<@${c.discordId}> (${md(c.name)})`).join('\n').slice(0, 1000);
async function culpritTableReady(db) {
    const { error } = await db.from('missing_report_culprits').select('id').limit(1);
    if (error) throw new HttpError(503, 'Theft reports need a database update: an admin must re-run supabase/schema.sql.');
}
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
    // Clears the sellers who joined (only once schema.sql has the column, so claiming keeps working before that).
    const noHelpers = 'helpers' in order ? { helpers: [] } : {};
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
                ...noHelpers
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
            if (!('helpers' in order)) throw new HttpError(503, 'Taking over needs a database update: an admin must re-run supabase/schema.sql.');
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
                ...noHelpers,
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

        case 'missing': {
            // Close a buyer's missing-plane report after checking in-game who bought the planes.
            // { reportId, outcome: 'confirmed' | 'not_theft', note, culprits: [discordId, …] (confirmed only) }
            const onOrder = deliveryShares(order).some((sh) => sh.sellerId === account.id);
            if (!onOrder && !seller.is_admin) throw new HttpError(403, 'Only the sellers on this order and admins can close missing-plane reports.');
            const { data: report } = await db.from('missing_reports').select('*')
                .eq('id', Math.floor(Number(input.reportId)) || 0).eq('order_id', order.id).maybeSingle();
            if (!report) throw new HttpError(404, 'Report not found.');
            if (report.status !== 'OPEN') throw new HttpError(409, `This report was already closed by ${report.resolved_by_name || 'another seller'}.`);
            const outcome = { confirmed: 'CONFIRMED', not_theft: 'NOT_THEFT' }[input.outcome];
            if (!outcome) throw new HttpError(400, 'Choose: theft confirmed, or not a theft.');
            const note = cleanText(input.note, 1000);
            if (!note) throw new HttpError(400, 'Write what you found. The buyer sees it.');
            const ids = outcome === 'CONFIRMED' ? culpritIds(input, order, account) : [];
            const newDb = 'investigating' in report;   // false until schema.sql has been re-run
            if (outcome === 'CONFIRMED' && newDb) await culpritTableReady(db);
            if (ids.length > 1 && !newDb) throw new HttpError(503, 'Several culprits need a database update: an admin must re-run supabase/schema.sql.');
            // No names yet: the theft is confirmed, the culprit(s) are "under investigation".
            const investigating = outcome === 'CONFIRMED' && !ids.length;
            // Close it first (only once, even if two sellers press at the same moment), then warn and log.
            const { data: closed } = await db.from('missing_reports').update({
                status: outcome, resolved_by: account.id, resolved_by_name: accountName(account),
                resolved_at: new Date().toISOString(), resolution_note: note,
                ...(newDb ? { investigating } : {})
            }).eq('id', report.id).eq('status', 'OPEN').select();
            if (!closed?.length) throw new HttpError(409, 'Another seller closed this report just now.');
            let result = closed[0];
            let warned = [];
            if (ids.length && newDb) {
                warned = await warnCulprits({ db, order, report, ids, account, ref });
            } else if (ids.length) {
                // Older database (no culprits table yet): one culprit, kept on the report itself.
                const target = await resolveTarget({ discordId: ids[0] });
                const sent = await sendMarketMessage({
                    target, kind: 'warning', source: 'theft',
                    by: { accountId: account.id, name: accountName(account) }, body: THEFT_WARNING(ref)
                });
                warned = [{ discordId: ids[0], name: target.name, warningId: sent.message.id }];
            }
            if (warned.length) {
                const { data: linked } = await db.from('missing_reports').update({ warning_id: warned[0].warningId }).eq('id', report.id).select();
                if (linked?.length) result = linked[0];
            }
            const logged = outcome === 'CONFIRMED' ? await logModeration({
                title: `🚨 Plane theft confirmed · ${plain(ref)}`, color: EMBED_COLORS.declined,
                fields: [
                    { name: 'Buyer', value: `${/^\d+$/.test(order.buyer_discord_id || '') ? `<@${order.buyer_discord_id}> ` : ''}(${md(order.buyer_name || '-')})`, inline: true },
                    { name: 'Confirmed by', value: md(accountName(account)), inline: true },
                    {
                        name: warned.length > 1 ? `Culprits (${warned.length}) · automatic warnings sent` : warned.length ? 'Culprit · automatic warning sent' : 'Culprit',
                        value: warned.length ? culpritLines(warned)
                            : '🔍 Under investigation: not identified yet. Any seller can add them later (seller desk → Theft reports).',
                        inline: false
                    },
                    { name: "Buyer's report", value: md(report.details).slice(0, 1000) },
                    { name: 'Findings', value: md(note).slice(0, 1000) }
                ]
            }) : null;
            await addEvent(order, 'MISSING', account, {
                message: outcome === 'CONFIRMED' ? `Missing planes checked: theft confirmed. ${note}` : `Missing planes checked: not a theft. ${note}`
            });
            if (order.buyer_id) {
                const { data: buyer } = await db.from('accounts').select('*').eq('id', order.buyer_id).maybeSingle();
                if (buyer) await sendDM(buyer, {
                    title: `🔎 Your missing-plane report on ${ref}`,
                    color: outcome === 'CONFIRMED' ? EMBED_COLORS.declined : EMBED_COLORS.progress,
                    description: `${outcome === 'CONFIRMED' ? 'The sellers confirmed that someone else bought planes listed for you.' : 'The sellers checked your report: it was not a theft.'}\n> ${md(note).slice(0, 1200)}`,
                    url: BUYER_URL ? `${BUYER_URL}/#orders` : undefined
                });
            }
            return res.json({ ok: true, order, report: result, warned: warned.length, investigating,
                culprits: warned.map(({ discordId, name }) => ({ discordId, name })), logged });
        }

        case 'missing-culprits': {
            // Name the culprit(s) of a confirmed theft later ("under investigation" → identified), or add more.
            // Any active seller: { reportId, culprits: [discordId, …], done: true = the investigation is closed }.
            const { data: report } = await db.from('missing_reports').select('*')
                .eq('id', Math.floor(Number(input.reportId)) || 0).eq('order_id', order.id).maybeSingle();
            if (!report) throw new HttpError(404, 'Report not found.');
            if (!('investigating' in report)) throw new HttpError(503, 'Theft reports need a database update: an admin must re-run supabase/schema.sql.');
            await culpritTableReady(db);
            if (!['CONFIRMED', 'CLEARED'].includes(report.status)) throw new HttpError(409, 'Only a confirmed theft can have culprits.');
            const ids = culpritIds(input, order, account);
            const done = input.done === true;
            if (!ids.length && !done) throw new HttpError(400, "Add the culprit's Discord user ID.");
            const warned = await warnCulprits({ db, order, report, ids, account, ref });
            if (ids.length && !warned.length && !done) throw new HttpError(409, 'Everyone you listed is already on this report.');
            const patch = {};
            if (done && report.investigating) patch.investigating = false;
            if (!report.warning_id && warned.length) patch.warning_id = warned[0].warningId;
            let result = report;
            if (Object.keys(patch).length) {
                const { data: upd } = await db.from('missing_reports').update(patch).eq('id', report.id).select();
                if (upd?.length) result = upd[0];
            }
            const logged = (warned.length || patch.investigating === false) ? await logModeration({
                title: warned.length ? `🕵️ Theft culprit${warned.length > 1 ? 's' : ''} identified · ${plain(ref)}` : `🔍 Theft investigation closed · ${plain(ref)}`,
                color: warned.length ? EMBED_COLORS.declined : EMBED_COLORS.progress,
                fields: [
                    ...(warned.length ? [{ name: warned.length > 1 ? `Culprits (${warned.length}) · automatic warnings sent` : 'Culprit · automatic warning sent', value: culpritLines(warned) }] : []),
                    { name: 'By', value: md(accountName(account)), inline: true },
                    { name: 'Investigation', value: result.investigating ? 'still open: more culprits may follow' : warned.length ? 'closed' : 'closed: the culprit could not be identified', inline: true },
                    { name: "Buyer's report", value: md(report.details).slice(0, 1000) }
                ]
            }) : null;
            if (warned.length) await addEvent(order, 'MISSING', account, { message: 'Theft follow-up: the sellers identified who took the planes, and they were warned.' });
            return res.json({ ok: true, order, report: result, warned: warned.length,
                culprits: warned.map(({ discordId, name }) => ({ discordId, name })), logged });
        }

        case 'missing-clear': {
            // Clear a confirmed theft: the warned culprit re-listed the planes for the buyer, checked in-game.
            // { reportId, note, verified: true }. The warning stays on the culprit's record.
            const onOrder = deliveryShares(order).some((sh) => sh.sellerId === account.id);
            if (!onOrder && !seller.is_admin) throw new HttpError(403, 'Only the sellers on this order and admins can clear a theft.');
            const { data: report } = await db.from('missing_reports').select('*')
                .eq('id', Math.floor(Number(input.reportId)) || 0).eq('order_id', order.id).maybeSingle();
            if (!report) throw new HttpError(404, 'Report not found.');
            if (!('cleared_at' in report)) throw new HttpError(503, 'Clearing a theft needs a database update: an admin must re-run supabase/schema.sql.');
            if (report.status === 'CLEARED') throw new HttpError(409, `${report.cleared_by_name || 'Another seller'} already cleared this theft.`);
            // Everyone named on the report (older reports: the one warning kept on the report).
            const { data: rows } = 'investigating' in report
                ? await db.from('missing_report_culprits').select('discord_id').eq('report_id', report.id) : { data: [] };
            let named = (rows || []).map((c) => c.discord_id);
            if (!named.length && report.warning_id) {
                const { data: warning } = await db.from('market_messages').select('discord_id').eq('id', report.warning_id).maybeSingle();
                if (warning?.discord_id) named = [warning.discord_id];
            }
            if (report.status !== 'CONFIRMED' || !named.length) {
                throw new HttpError(409, 'Only a confirmed theft whose culprit was identified and warned can be cleared.');
            }
            if (input.verified !== true) throw new HttpError(400, 'Check in-game first that the planes are listed for the buyer again.');
            const note = cleanText(input.note, 1000);
            if (!note) throw new HttpError(400, 'Say what was re-listed and where. The buyer sees it.');
            const { data: cleared } = await db.from('missing_reports').update({
                status: 'CLEARED', cleared_at: new Date().toISOString(), cleared_by: account.id,
                cleared_by_name: accountName(account), cleared_note: note
            }).eq('id', report.id).eq('status', 'CONFIRMED').select();
            if (!cleared?.length) throw new HttpError(409, 'Another seller changed this report just now.');
            const logged = await logModeration({
                title: `✅ Theft cleared · ${plain(ref)}`, color: EMBED_COLORS.fulfilled,
                fields: [
                    { name: named.length > 1 ? 'Culprits' : 'Culprit', value: named.map((id) => `<@${id}>`).join(' ').slice(0, 1000), inline: true },
                    { name: 'Cleared by', value: md(accountName(account)), inline: true },
                    { name: 'Re-listed', value: md(note).slice(0, 1000) },
                    { name: 'Note', value: 'Planes re-listed for the buyer, checked in-game. The warning stays on record.' }
                ]
            });
            await addEvent(order, 'MISSING', account, { message: `The missing planes were re-listed for you: ${note}` });
            const dmed = [];
            for (const id of named) {
                dmed.push(await dmDiscordUser(id, {
                    title: `✅ Echo Market: case cleared (${ref})`, color: EMBED_COLORS.progress,
                    description: 'Thanks for re-listing the planes for their buyer. The case is closed; the warning stays on your record. Only buy planes you ordered.'
                }));
            }
            if (order.buyer_id) {
                const { data: buyer } = await db.from('accounts').select('*').eq('id', order.buyer_id).maybeSingle();
                if (buyer) await sendDM(buyer, {
                    title: `✈️ Your missing planes are back on the market (${ref})`,
                    color: EMBED_COLORS.progress,
                    description: `The planes taken from your order were listed for you again. Buy them on the in-game market now:\n> ${md(note).slice(0, 1200)}`,
                    url: BUYER_URL ? `${BUYER_URL}/#orders` : undefined
                });
            }
            return res.json({ ok: true, order, report: cleared[0], logged, culpritTold: dmed.some((d) => d === 'sent') });
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
