// POST /api/orders/:orderId — the buyer's own actions on an order.
//   { action: 'cancel', reason }   cancel an order nobody has taken yet (and nothing has been delivered:
//                                  a partly delivered order waiting for a new seller can't be cancelled)
//   { action: 'message', body }    write to the seller team. Allowed once the order has waited
//                                  CONTACT_AFTER_HOURS without being fully delivered, or to answer a seller.
//   { action: 'report-missing', details }  planes listed in-game were bought by someone else (free text). When a
//                                  seller on the order is on vacation, the answer says so (vacation: their names).
//   { action: 'relist-help', reportId }  that seller is on vacation: ask the other sellers (new-orders channel,
//                                  pinging the seller role) whether one of them can re-list the planes early. Once per report.
import {
    admin, handler, requireUser, body, cleanText, loadOrder, addEvent, syncDiscord, orderRef, accountName,
    requireMarketAccess, rateLimit, sendDM, md, SELLER_URL, EMBED_COLORS, deliveryShares, shareText, missingReportRecipients,
    vacationingIds, postToSellers, HttpError
} from '../../lib/server.js';

export const CONTACT_AFTER_HOURS = 24;
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
        const ageHours = (Date.now() - new Date(order.created_at).getTime()) / 36e5;
        const { count: sellerMessages } = await db.from('order_messages').select('id', { count: 'exact', head: true })
            .eq('order_id', order.id).eq('from_role', 'seller');
        const waitedLongEnough = ageHours >= CONTACT_AFTER_HOURS && OPEN.includes(order.status);
        if (!waitedLongEnough && !sellerMessages) {
            throw new HttpError(409, OPEN.includes(order.status)
                ? `You can contact the seller team once an order has waited ${CONTACT_AFTER_HOURS} hours without being fully delivered.`
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

    if (input.action === 'report-missing') {
        // Planes listed for this buyer in-game were bought by someone else first. Every seller on the order
        // and every admin is DMed; one of them checks in-game who bought them and closes the report.
        await requireMarketAccess(account);
        if (!(order.filled > 0) || ['CANCELLED', 'DECLINED'].includes(order.status)) {
            throw new HttpError(409, 'You can report missing planes once at least part of the order has been delivered.');
        }
        const details = cleanText(input.details, 1000);
        if (!details || details.length < 3) throw new HttpError(400, 'Say how many planes are missing and of which type.');
        const { data: open } = await db.from('missing_reports').select('id').eq('order_id', order.id).eq('status', 'OPEN').limit(1);
        if (open?.length) throw new HttpError(409, 'You already reported missing planes on this order. The sellers are checking it.');
        await rateLimit('missing-report:' + account.id, 5, 86400, 'You can send 5 missing-plane reports per day.');
        // Sellers on the order who are on vacation right now (they get no DM; the buyer is told).
        const onOrder = deliveryShares(order).filter((sh) => sh.sellerId && (sh.role !== 'earlier' || sh.total > 0));
        const away = await vacationingIds(onOrder.map((sh) => sh.sellerId));
        const awayNames = [...new Set(onOrder.filter((sh) => away.has(sh.sellerId)).map((sh) => sh.name || sh.airline).filter(Boolean))];
        const { data: report, error } = await db.from('missing_reports').insert({
            order_id: order.id, buyer_id: order.buyer_id, buyer_name: accountName(account), details,
            ...(awayNames.length ? { vacation_sellers: awayNames.join(', ').slice(0, 300) } : {})
        }).select().single();
        if (error) throw error;
        const ref = orderRef(order);
        await addEvent(order, 'MISSING', account, { message: `Missing planes reported: ${details}` });
        // Every seller on the order with their Discord username (and a mention to open their profile), and what they listed.
        const shares = deliveryShares(order).filter((sh) => sh.role !== 'earlier' || sh.total > 0);
        const sellerIds = shares.map((sh) => sh.sellerId).filter(Boolean);
        const { data: people } = sellerIds.length
            ? await db.from('accounts').select('id, discord_id, discord_username, display_name').in('id', sellerIds) : { data: [] };
        const byId = Object.fromEntries((people || []).map((p) => [p.id, p]));
        const listed = shares.map((sh) => {
            const p = byId[sh.sellerId];
            const who = p?.discord_username ? `@${md(p.discord_username)}` : md(sh.name || 'seller');
            const mention = /^\d+$/.test(p?.discord_id || '') ? ` <@${p.discord_id}>` : '';
            const role = sh.role === 'earlier' ? ' _(earlier)_' : sh.role === 'helper' ? ' _(also delivering)_' : '';
            return `**${md(sh.airline || sh.name)}** · ${who}${mention}${role}: ${shareText(order, sh)}`;
        }).join('\n').slice(0, 1000);
        const recipients = await missingReportRecipients(order);
        const sent = await Promise.all(recipients.map((r) => sendDM({ ...r, dm_enabled: true }, {
            title: `🚨 Missing planes reported · ${ref}`,
            color: EMBED_COLORS.declined,
            description: `**${md(accountName(account))}** (${md(order.airline_name)}) says aircraft listed for them in-game were bought by someone else before they could take them:\n> ${md(details).slice(0, 1200)}\n\nCheck in-game who bought them, then mark the report on the seller desk: **Theft confirmed** (logged, and the culprit can get an automatic warning) or **Not a theft**.`,
            url: SELLER_URL ? `${SELLER_URL}/#${order.id}` : undefined,
            fields: listed ? [{ name: 'Sellers on this order (Discord) · what they listed', value: listed }] : []
        })));
        return res.json({ ok: true, report, alerted: sent.filter((x) => x === 'sent').length, vacation: awayNames });
    }

    if (input.action === 'relist-help') {
        await requireMarketAccess(account);
        const { data: report } = await db.from('missing_reports').select('*').eq('id', Number(input.reportId)).eq('order_id', order.id).maybeSingle();
        if (!report) throw new HttpError(404, 'Report not found.');
        if (report.status !== 'OPEN') throw new HttpError(409, 'The sellers have already answered this report.');
        if (!report.vacation_sellers) throw new HttpError(409, 'Your sellers are not on vacation, so they will look at this report themselves.');
        if (report.relist_asked_at) throw new HttpError(409, 'You already asked the other sellers. One of them will get back to you.');
        // Claim the request first, so two quick taps can't post twice.
        const { data: claimed } = await db.from('missing_reports').update({ relist_asked_at: new Date().toISOString() })
            .eq('id', report.id).is('relist_asked_at', null).select().maybeSingle();
        if (!claimed) throw new HttpError(409, 'You already asked the other sellers. One of them will get back to you.');
        const ref = orderRef(order);
        const posted = await postToSellers({
            title: `🏝️ Re-listing help wanted · ${ref}`,
            color: 0x38BDF8,
            description: `**${md(report.vacation_sellers)}** ${report.vacation_sellers.includes(',') ? 'are' : 'is'} on vacation, and **${md(accountName(account))}** (${md(order.airline_name)}) reported missing planes on ${ref}:
> ${md(report.details).slice(0, 800)}

Can anyone check in-game and re-list them early? Open the order on the seller desk.`,
            url: SELLER_URL ? `${SELLER_URL}/#${order.id}` : undefined
        }, { pingRole: true });
        if (!posted) {
            await db.from('missing_reports').update({ relist_asked_at: null }).eq('id', report.id);
            throw new HttpError(503, "Couldn't reach the sellers' Discord channel right now. Try again in a minute.");
        }
        return res.json({ ok: true, report: claimed });
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
