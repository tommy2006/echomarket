// A seller's own profile statistics (seller desk → profile), served by POST /api/admin/sellers { view: 'me', days }.
// Worked out the same way as the leaderboard (api/admin/sellers.js), from the order timeline:
//   ordersTaken   times they took an order (CLAIMED) or part of one (JOINED)
//   ordersDone    times their delivery update completed an order (FULFILLED)
//   aircraft      aircraft they delivered: the increase in the order's delivered total at each of their updates
//   value         those aircraft × the order's average price per aircraft (≈ sales volume)
// Plus a timeline (per day, or per week for longer periods), deliveries by weekday (UTC), the aircraft types and
// buyer alliances they delivered to (from their share of each order they delivered on in the period), and "mosts".
import { admin, orderItems, deliveryShares, getSetting } from './server.js';
import { vacationView, vacationHistory } from './vacation.js';

const DAY = 864e5;
const CHUNK = 150;
const KINDS = ['CLAIMED', 'JOINED', 'PROGRESS', 'FULFILLED', 'HANDOFF', 'RELEASED'];
async function inChunks(ids, fetch) {
    const out = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await fetch(ids.slice(i, i + CHUNK));
        if (error) throw error;
        out.push(...(data || []));
    }
    return out;
}
const top = (map) => [...map].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));

export async function sellerProfile(sellerRow, days) {
    const db = admin();
    const me = sellerRow.user_id;
    const resetAt = new Date(await getSetting('stats_reset_at', 0) || 0).getTime() || 0;
    const now = Date.now();
    const since = Math.max(days ? now - days * DAY : 0, resetAt);

    const { data: mine, error } = await db.from('order_events').select('order_id').eq('actor_id', me).in('kind', KINDS).limit(5000);
    if (error) throw error;
    const orderIds = [...new Set((mine || []).map((e) => e.order_id))];
    const [events, orders] = await Promise.all([
        inChunks(orderIds, (ids) => db.from('order_events').select('order_id, kind, actor_id, filled, created_at').in('order_id', ids).in('kind', KINDS)
            .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(10000)),
        inChunks(orderIds, (ids) => db.from('orders').select('*').in('id', ids))
    ]);
    events.sort((a, b) => a.created_at.localeCompare(b.created_at));
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // Timeline buckets: days for up to 30 days, weeks otherwise (all time: since their first activity, at most a year).
    const firstAt = events.find((e) => e.actor_id === me)?.created_at;
    const start = days ? since : Math.max(since, firstAt ? new Date(firstAt).getTime() : now - 7 * DAY, now - 52 * 7 * DAY);
    const bucketDays = days && days <= 30 ? 1 : 7;
    const buckets = Math.max(1, Math.ceil((now - start) / (bucketDays * DAY)));
    const firstBucket = now - buckets * bucketDays * DAY;
    const series = new Array(buckets).fill(0);
    const weekdays = new Array(7).fill(0);   // Monday first

    const t = { ordersTaken: 0, ordersDone: 0, aircraft: 0, value: 0 };
    const lastFilled = new Map();
    const deliveredOn = new Map();           // order id → aircraft they delivered on it in the period
    const perDay = new Map();                // 'YYYY-MM-DD' → aircraft
    const takenAt = new Map();               // order id → their latest take
    const completions = [];                  // hours from their take to their completing update
    for (const e of events) {
        const prev = lastFilled.get(e.order_id) || 0;
        const filled = typeof e.filled === 'number' ? e.filled : prev;
        lastFilled.set(e.order_id, filled);
        if (e.actor_id !== me) continue;
        const at = new Date(e.created_at).getTime();
        if (e.kind === 'CLAIMED' || e.kind === 'JOINED') takenAt.set(e.order_id, at);
        if (at < since) continue;
        if (e.kind === 'CLAIMED' || e.kind === 'JOINED') t.ordersTaken++;
        if (e.kind === 'FULFILLED') {
            t.ordersDone++;
            if (takenAt.has(e.order_id)) completions.push((at - takenAt.get(e.order_id)) / 36e5);
        }
        if (e.kind === 'PROGRESS' || e.kind === 'FULFILLED') {
            const delta = filled - prev;
            const o = orderById.get(e.order_id);
            t.aircraft += delta;
            if (o && o.total_qty > 0) t.value += Math.round(delta * (o.total_usd / o.total_qty));
            deliveredOn.set(e.order_id, (deliveredOn.get(e.order_id) || 0) + delta);
            if (delta > 0) {
                const b = Math.floor((at - firstBucket) / (bucketDays * DAY));
                if (b >= 0 && b < buckets) series[b] += delta;
                weekdays[(new Date(at).getUTCDay() + 6) % 7] += delta;
                const d = e.created_at.slice(0, 10);
                perDay.set(d, (perDay.get(d) || 0) + delta);
            }
        }
    }

    // Aircraft types and buyer alliances: their share of each order they delivered on in the period.
    const types = new Map();
    const alliances = new Map();
    let biggest = null;
    for (const [orderId, n] of deliveredOn) {
        const o = orderById.get(orderId);
        if (!o || n <= 0) continue;
        if (!biggest || n > biggest.aircraft) biggest = { id: o.id, serial: o.serial, airline: o.airline_name, aircraft: n };
        const items = orderItems(o);
        const shares = deliveryShares(o).filter((sh) => sh.sellerId === me && sh.items);
        let counted = 0;
        for (const sh of shares) sh.items.forEach((k, i) => { if (k > 0 && items[i]) { types.set(items[i].model, (types.get(items[i].model) || 0) + k); counted += k; } });
        if (!counted && items.length === 1) types.set(items[0].model, (types.get(items[0].model) || 0) + n);   // single-type order
        const alliance = o.alliance || 'No alliance';
        alliances.set(alliance, (alliances.get(alliance) || 0) + n);
    }
    const bestDay = [...perDay].sort((a, b) => b[1] - a[1])[0] || null;
    const sorted = [...completions].sort((a, b) => a - b);
    const inProgress = orders.filter((o) => (o.seller_id === me || (Array.isArray(o.helpers) && o.helpers.some((h) => h?.seller_id === me)))
        && ['CLAIMED', 'PARTIAL'].includes(o.status)).length;

    return {
        ok: true, days,
        totals: { ...t, inProgress },
        series, bucketDays, firstBucket: new Date(firstBucket).toISOString(),
        weekdays,
        types: top(types).slice(0, 8),
        alliances: top(alliances).slice(0, 6),
        mosts: {
            type: top(types)[0] || null,
            alliance: top(alliances)[0] || null,
            biggest,
            bestDay: bestDay && { day: bestDay[0], aircraft: bestDay[1] },
            fastestHours: sorted.length ? sorted[0] : null,
            medianHours: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
        },
        statsSince: resetAt ? new Date(resetAt).toISOString() : null,
        vacation: { ...vacationView(sellerRow), history: await vacationHistory(me) }
    };
}
