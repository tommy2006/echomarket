// POST /api/orders — a signed-in buyer places an order.
// Body: { airlineIds: [id, …], buyerNote, items: [{ model, qty, pricePercent, note }] }
//   airlineIds  every one of the buyer's airlines the aircraft may be delivered to (the first one is the
//               main airline). The older form { airlineId } is still accepted.
import { admin, handler, requireUser, accountName, body, cleanText, addEvent, syncDiscord, dmBuyer, orderRef, rateLimit, HttpError } from '../lib/server.js';
import { priceItems, orderListValue, DAILY_LIMIT_USD } from '../lib/pricing.js';

// Every new order pings the seller role on Discord, so placing orders is rate limited per account.
const MAX_ORDERS_PER_10_MIN = 5;

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    if (!account.discord_id) throw new HttpError(403, 'Your market account is not linked to a Discord login. Sign out and sign in with Discord again.');
    const input = body(req);
    const db = admin();

    const wanted = [...new Set((Array.isArray(input.airlineIds) ? input.airlineIds : [input.airlineId])
        .filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 20);
    if (!wanted.length) throw new HttpError(400, 'Choose at least one of your airlines for this order.');
    const { data: owned, error: airErr } = await db.from('airlines').select('*').in('id', wanted).eq('owner_id', account.id);
    if (airErr) throw airErr;
    if ((owned || []).length !== wanted.length) throw new HttpError(400, 'Choose your own airline profiles for this order.');
    const airlines = wanted.map((id) => owned.find((a) => a.id === id));
    const airline = airlines[0];

    const { items, totalQty, totalUSD, listTotalUSD } = priceItems(input.items);

    // Cheap first check on the orders already placed (also covers a database without the rate-limit function).
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count: recentCount, error: countErr } = await db.from('orders').select('id', { count: 'exact', head: true })
        .eq('buyer_id', account.id).gte('created_at', tenMinAgo);
    if (countErr) throw countErr;
    if ((recentCount || 0) >= MAX_ORDERS_PER_10_MIN) {
        throw new HttpError(429, `You can send at most ${MAX_ORDERS_PER_10_MIN} orders per 10 minutes. Put more aircraft in one order instead.`);
    }

    // Rolling 24h limit, counted across ALL of this account's airlines, at 100% LIST price:
    // a 50% order uses up the same quota as the same aircraft at 90%.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const usedNow = async () => {
        const { data: recent, error: recentErr } = await db.from('orders').select('items, total_usd')
            .eq('buyer_id', account.id)
            .gte('created_at', since)
            .not('status', 'in', '(CANCELLED,DECLINED)');
        if (recentErr) throw recentErr;
        return (recent || []).reduce((s, o) => s + orderListValue(o), 0);
    };
    const overLimit = (used) => {
        const left = Math.max(0, DAILY_LIMIT_USD - used);
        return new HttpError(400, `This order goes over the 24-hour limit, which counts aircraft at full list price. This order is $${listTotalUSD.toLocaleString('en-US')} at list price; you have $${left.toLocaleString('en-US')} of list-price quota left today.`);
    };
    const used = await usedNow();
    if (used + listTotalUSD > DAILY_LIMIT_USD) throw overLimit(used);

    // Atomic counter in the database, so orders sent at the same moment can't all slip under the cap.
    // Counted here, after every other check, so refused orders don't use up the allowance.
    await rateLimit('orders:' + account.id, MAX_ORDERS_PER_10_MIN, 600,
        `You can send at most ${MAX_ORDERS_PER_10_MIN} orders per 10 minutes. Put more aircraft in one order instead.`);

    const row = {
        buyer_id: account.id,
        buyer_discord_id: account.discord_id,
        buyer_name: accountName(account),
        airline_id: airline.id,
        airline_name: airline.name,
        alliance: airline.alliance,
        airlines: airlines.map((a) => ({ id: a.id, name: a.name, alliance: a.alliance })),
        items,
        total_qty: totalQty,
        total_usd: totalUSD,
        buyer_note: cleanText(input.buyerNote, 1000) || null
    };
    let { data: order, error } = await db.from('orders').insert(row).select().single();
    // Database not updated yet (no "airlines" column): save the main airline only.
    if (error?.code === 'PGRST204' && airlines.length === 1) {
        delete row.airlines;
        ({ data: order, error } = await db.from('orders').insert(row).select().single());
    }
    if (error?.code === 'PGRST204') throw new HttpError(503, 'Ordering for several airlines needs a database update (re-run supabase/schema.sql). Pick one airline for now.');
    if (error) throw error;

    // Two orders sent at the same moment could both pass the check above. Re-check with this order
    // included; if the total is now over the limit, take this one back.
    const total = await usedNow();
    if (total > DAILY_LIMIT_USD) {
        await db.from('orders').delete().eq('id', order.id);
        throw overLimit(total - listTotalUSD);
    }

    await addEvent(order, 'CREATED', account, { message: `Order sent for ${airlines.map((a) => a.name).join(', ')}.` });
    await syncDiscord(order, `📦 New order ${orderRef(order)}`, { pingSellers: true });
    await dmBuyer(order, 'CREATED');

    res.status(201).json({ ok: true, order });
});
