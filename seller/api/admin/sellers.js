// POST /api/admin/sellers — seller performance, for admins only.
// Body: { days }   7, 30, 90 or 0 (= all time)
//
// Worked out from the order timeline (order_events), so it can be limited to a period:
//   ordersTaken   times the seller took an order (CLAIMED)
//   ordersDone    times the seller's delivery update completed an order (FULFILLED)
//   aircraftSold  aircraft delivered by the seller: each delivery update records the order's new
//                 delivered total, so the increase since the previous update is what that seller sold
//                 (a correction downwards counts as negative)
//   saleValue     those aircraft × the order's average price per aircraft (exact for single-type orders)
import { admin, handler, requireUser, requireActiveSeller, accountName, body, rateLimit, HttpError } from '../../lib/server.js';

const PAGE = 1000;
async function all(query) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await query().range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE) return rows;
    }
}

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const me = await requireActiveSeller(account);
    if (!me.is_admin) throw new HttpError(403, 'Only admins can see seller performance.');
    await rateLimit('admin-stats:' + account.id, 60, 600);

    const days = [7, 30, 90].includes(Number(body(req).days)) ? Number(body(req).days) : 0;
    const since = days ? Date.now() - days * 864e5 : 0;
    const db = admin();

    const [events, orders, sellers] = await Promise.all([
        all(() => db.from('order_events').select('order_id, kind, actor_id, filled, created_at')
            .in('kind', ['CLAIMED', 'PROGRESS', 'FULFILLED', 'HANDOFF', 'RELEASED'])
            .order('created_at', { ascending: true }).order('id', { ascending: true })),
        all(() => db.from('orders').select('id, total_qty, total_usd, seller_id, status')),
        db.from('sellers').select('user_id, is_admin, active, source, added_at').then((r) => { if (r.error) throw r.error; return r.data || []; })
    ]);
    const ids = [...new Set([...sellers.map((s) => s.user_id), ...events.map((e) => e.actor_id).filter(Boolean)])];
    const { data: accounts, error: accErr } = ids.length
        ? await db.from('accounts').select('id, display_name, discord_username, avatar_url').in('id', ids)
        : { data: [] };
    if (accErr) throw accErr;

    const orderById = new Map(orders.map((o) => [o.id, o]));
    const stats = new Map();
    const row = (id) => {
        if (!stats.has(id)) stats.set(id, { ordersTaken: 0, ordersDone: 0, aircraftSold: 0, saleValue: 0, lastActive: null });
        return stats.get(id);
    };
    const lastFilled = new Map();   // order id → delivered total after its latest update
    for (const e of events) {
        const prev = lastFilled.get(e.order_id) || 0;
        const filled = typeof e.filled === 'number' ? e.filled : prev;
        lastFilled.set(e.order_id, filled);
        if (!e.actor_id) continue;
        const inPeriod = !since || new Date(e.created_at).getTime() >= since;
        if (!inPeriod) continue;
        const s = row(e.actor_id);
        s.lastActive = e.created_at;
        if (e.kind === 'CLAIMED') s.ordersTaken++;
        if (e.kind === 'FULFILLED') s.ordersDone++;
        if (e.kind === 'PROGRESS' || e.kind === 'FULFILLED') {
            const delta = filled - prev;
            const o = orderById.get(e.order_id);
            s.aircraftSold += delta;
            if (o && o.total_qty > 0) s.saleValue += Math.round(delta * (o.total_usd / o.total_qty));
        }
    }

    const sellerById = new Map(sellers.map((s) => [s.user_id, s]));
    const accById = new Map((accounts || []).map((a) => [a.id, a]));
    const list = ids
        .filter((id) => sellerById.has(id) || stats.has(id))
        .map((id) => {
            const s = sellerById.get(id);
            const a = accById.get(id);
            const st = stats.get(id) || row(id);
            return {
                id,
                name: a ? accountName(a) : 'Unknown account',
                discordUsername: a?.discord_username || null,
                avatarUrl: a?.avatar_url || null,
                isAdmin: Boolean(s?.is_admin),
                active: Boolean(s?.active),
                onList: Boolean(s),
                source: s?.source || null,
                inProgress: orders.filter((o) => o.seller_id === id && ['CLAIMED', 'PARTIAL'].includes(o.status)).length,
                ...st
            };
        })
        // Seller-desk actions only: drop buyers whose only events are their own orders.
        .filter((x) => x.onList || x.ordersTaken || x.aircraftSold)
        .sort((x, y) => y.aircraftSold - x.aircraftSold || y.ordersTaken - x.ordersTaken || x.name.localeCompare(y.name));

    const totals = list.reduce((t, x) => ({
        ordersTaken: t.ordersTaken + x.ordersTaken, ordersDone: t.ordersDone + x.ordersDone,
        aircraftSold: t.aircraftSold + x.aircraftSold, saleValue: t.saleValue + x.saleValue
    }), { ordersTaken: 0, ordersDone: 0, aircraftSold: 0, saleValue: 0 });

    res.json({ ok: true, days, sellers: list, totals, generatedAt: new Date().toISOString() });
});
