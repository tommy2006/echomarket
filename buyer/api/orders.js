// POST /api/orders — a signed-in buyer places an order.
// Body: { airlineId, buyerNote, items: [{ model, qty, pricePercent, note }] }
import { admin, handler, requireUser, accountName, body, cleanText, addEvent, syncDiscord, dmBuyer, HttpError } from '../lib/server.js';
import { priceItems, DAILY_LIMIT_USD } from '../lib/pricing.js';

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const input = body(req);
    const db = admin();

    const { data: airline } = await db.from('airlines').select('*')
        .eq('id', input.airlineId || '00000000-0000-0000-0000-000000000000')
        .eq('owner_id', account.id)
        .maybeSingle();
    if (!airline) throw new HttpError(400, 'Choose one of your airline profiles for this order.');

    const { items, totalQty, totalUSD } = priceItems(input.items);

    // Rolling 24h spending limit, counted across ALL of this account's airlines.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent, error: recentErr } = await db.from('orders').select('total_usd')
        .eq('buyer_id', account.id)
        .gte('created_at', since)
        .not('status', 'in', '(CANCELLED,DECLINED)');
    if (recentErr) throw recentErr;
    const spent = (recent || []).reduce((s, o) => s + Number(o.total_usd), 0);
    if (spent + totalUSD > DAILY_LIMIT_USD) {
        const left = Math.max(0, DAILY_LIMIT_USD - spent);
        throw new HttpError(400, `This order goes over the 24-hour limit. You can still order $${left.toLocaleString('en-US')} worth today.`);
    }

    const { data: order, error } = await db.from('orders').insert({
        buyer_id: account.id,
        buyer_discord_id: account.discord_id,
        buyer_name: accountName(account),
        airline_id: airline.id,
        airline_name: airline.name,
        alliance: airline.alliance,
        items,
        total_qty: totalQty,
        total_usd: totalUSD,
        buyer_note: cleanText(input.buyerNote, 1000) || null
    }).select().single();
    if (error) throw error;

    await addEvent(order, 'CREATED', account, { message: `Order sent for ${airline.name}.` });
    await syncDiscord(order, `📦 New order ${order.id}`, { pingSellers: true });
    await dmBuyer(order, 'CREATED');

    res.status(201).json({ ok: true, order });
});
