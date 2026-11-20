// Alliance statistics for the seller desk's Alliances tab (admins only), served by
// POST /api/admin/sellers { view: 'alliances', days } (one function, to stay inside Vercel Hobby's limit).
//
// An order belongs to the alliance of the buyer's first delivery airline (orders.alliance). The period
// filters on when the order was placed. Per alliance:
//   orders, completed, active, declined, cancelled   order counts by outcome
//   aircraft / delivered                             aircraft ordered / delivered so far
//   value                                            what the buyers pay (orders.total_usd)
//   buyers                                           different buyers
//   priceLevel                                       average price level, weighted by aircraft
//   waitHours                                        median time until a seller first took the order
//   wait                                             wait-time details (waitStats below): mean, median, 90th
//                                                    percentile, how many waited < 6 h, 6–12 h, 12–24 h, 24–48 h,
//                                                    48 h+; orders still waiting (never taken) by how long so far;
//                                                    orders closed before any seller took them
//   series                                           orders per day (≤ 30 days) or per week
//   topAircraft                                      most-ordered aircraft types
// waits: the same wait-time details for every alliance together (the whole Echo organisation).
// trade: aircraft delivered from each seller alliance to each buyer alliance (who supplies whom).
// aircraft: the most popular aircraft types across all alliances (aircraft ordered, orders, delivered, value,
//           average price level, alliances that ordered them).
import { admin, orderItems, deliveryShares, getSetting } from './server.js';

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

export const NO_ALLIANCE = 'No alliance';
// Wait-time groups, in hours: [from, to). The last one has no end.
export const WAIT_BUCKETS = [[0, 6], [6, 12], [12, 24], [24, 48], [48, Infinity]];
const round1 = (h) => (h == null ? null : Math.round(h * 10) / 10);
const percentile = (sorted, p) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
// taken: hours until the first seller took each order. open: hours waited so far by orders nobody has taken yet.
// within[h]: share of orders taken within h hours, out of the orders whose answer is known (taken, or still
// waiting for longer than h).
function waitStats(taken, open, noSeller) {
    const sorted = [...taken].sort((a, b) => a - b);
    const bucketOf = (h) => WAIT_BUCKETS.findIndex(([from, to]) => h >= from && h < to);
    const buckets = WAIT_BUCKETS.map(() => 0), openBuckets = WAIT_BUCKETS.map(() => 0);
    for (const h of taken) buckets[bucketOf(h)]++;
    for (const h of open) openBuckets[bucketOf(h)]++;
    const within = Object.fromEntries([6, 12, 24].map((h) => {
        const known = taken.length + open.filter((x) => x >= h).length;
        return [h, known ? Math.round(taken.filter((x) => x <= h).length / known * 100) : null];
    }));
    return {
        taken: taken.length, open: open.length, noSeller,
        mean: sorted.length ? round1(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
        median: round1(percentile(sorted, 0.5)), p90: round1(percentile(sorted, 0.9)),
        longest: round1(sorted[sorted.length - 1] ?? null), longestOpen: round1(open.length ? Math.max(...open) : null),
        buckets, openBuckets, within
    };
}
const DAY = 864e5;
const median = (list) => {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export async function allianceStats(days) {
    const db = admin();
    // Launch reset (supabase/launch-reset.sql, market_settings 'stats_reset_at'): only orders placed since then
    // count, also for "all time" (the same date as the Sellers leaderboard).
    const resetAt = new Date(await getSetting('stats_reset_at', 0) || 0).getTime() || 0;
    const since = Math.max(days ? Date.now() - days * DAY : 0, resetAt);
    const [orders, claims] = await Promise.all([
        all(() => {
            const q = db.from('orders').select('id, buyer_id, alliance, items, total_qty, total_usd, filled, status, seller_id, seller_name, seller_alliance, helpers, previous_sellers, created_at')
                .order('created_at', { ascending: true });
            return since ? q.gte('created_at', new Date(since).toISOString()) : q;
        }),
        all(() => db.from('order_events').select('order_id, created_at').eq('kind', 'CLAIMED').order('created_at', { ascending: true }))
    ]);
    const firstClaim = new Map();
    for (const c of claims) if (!firstClaim.has(c.order_id)) firstClaim.set(c.order_id, c.created_at);

    // Time buckets: days for short periods, weeks (from the first order) otherwise.
    const start = since || (orders.length ? new Date(orders[0].created_at).getTime() : Date.now());
    const bucketDays = days && days <= 30 ? 1 : 7;
    const buckets = Math.max(1, Math.ceil((Date.now() - start) / (bucketDays * DAY)));
    const bucketStarts = Array.from({ length: buckets }, (_, i) => new Date(start + i * bucketDays * DAY).toISOString());
    const bucketOf = (iso) => Math.min(buckets - 1, Math.max(0, Math.floor((new Date(iso).getTime() - start) / (bucketDays * DAY))));

    const stats = new Map();
    const row = (name) => {
        if (!stats.has(name)) stats.set(name, {
            name, orders: 0, completed: 0, active: 0, declined: 0, cancelled: 0, aircraft: 0, delivered: 0, value: 0,
            buyerSet: new Set(), levelSum: 0, levelQty: 0, waits: [], openWaits: [], noSeller: 0, series: new Array(buckets).fill(0), models: new Map()
        });
        return stats.get(name);
    };
    const trade = new Map();   // "buyer alliance|seller alliance" → aircraft delivered
    const types = new Map();   // model → totals over every alliance

    for (const o of orders) {
        const a = row(o.alliance || NO_ALLIANCE);
        a.orders++;
        if (o.status === 'FULFILLED') a.completed++;
        else if (o.status === 'DECLINED') a.declined++;
        else if (o.status === 'CANCELLED') a.cancelled++;
        else a.active++;
        a.aircraft += o.total_qty;
        a.delivered += o.filled;
        a.value += Number(o.total_usd) || 0;
        if (o.buyer_id) a.buyerSet.add(o.buyer_id);
        a.series[bucketOf(o.created_at)]++;
        for (const it of orderItems(o)) {
            a.models.set(it.model, (a.models.get(it.model) || 0) + it.qty);
            const level = Number(it.pricePercent);
            if (level > 0) { a.levelSum += level * it.qty; a.levelQty += it.qty; }
            if (!types.has(it.model)) types.set(it.model, { model: it.model, aircraft: 0, orders: 0, delivered: 0, value: 0, levelSum: 0, levelQty: 0, allianceSet: new Set() });
            const ty = types.get(it.model);
            ty.aircraft += it.qty;
            ty.orders++;
            ty.delivered += it.filled;
            // Older lines have no totalUSD: their share of the order's total, by aircraft.
            ty.value += Number(it.totalUSD) || Math.round((Number(o.total_usd) || 0) * it.qty / (o.total_qty || 1));
            if (level > 0) { ty.levelSum += level * it.qty; ty.levelQty += it.qty; }
            ty.allianceSet.add(a.name);
        }
        const claimed = firstClaim.get(o.id);
        if (claimed) a.waits.push(Math.max(0, (new Date(claimed) - new Date(o.created_at)) / 36e5));
        else if (o.status === 'PENDING') a.openWaits.push(Math.max(0, (Date.now() - new Date(o.created_at)) / 36e5));
        else if (['DECLINED', 'CANCELLED'].includes(o.status)) a.noSeller++;
        for (const sh of deliveryShares(o)) {
            if (!(sh.total > 0)) continue;
            const key = `${a.name}|${sh.alliance || NO_ALLIANCE}`;
            trade.set(key, (trade.get(key) || 0) + sh.total);
        }
    }

    const alliances = [...stats.values()].map(({ buyerSet, levelSum, levelQty, waits, openWaits, noSeller, models, ...a }) => ({
        ...a,
        wait: waitStats(waits, openWaits, noSeller),
        buyers: buyerSet.size,
        priceLevel: levelQty ? Math.round(levelSum / levelQty * 10) / 10 : null,
        waitHours: waits.length ? Math.round(median(waits) * 10) / 10 : null,
        topAircraft: [...models].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([model, qty]) => ({ model, qty }))
    })).sort((x, y) => y.orders - x.orders || y.aircraft - x.aircraft || x.name.localeCompare(y.name));

    const totals = alliances.reduce((t, a) => ({
        orders: t.orders + a.orders, completed: t.completed + a.completed, aircraft: t.aircraft + a.aircraft,
        delivered: t.delivered + a.delivered, value: t.value + a.value
    }), { orders: 0, completed: 0, aircraft: 0, delivered: 0, value: 0 });
    totals.buyers = new Set(orders.map((o) => o.buyer_id).filter(Boolean)).size;

    const aircraft = [...types.values()].map(({ levelSum, levelQty, allianceSet, ...ty }) => ({
        ...ty, alliances: allianceSet.size, priceLevel: levelQty ? Math.round(levelSum / levelQty * 10) / 10 : null
    })).sort((x, y) => y.aircraft - x.aircraft || y.orders - x.orders || x.model.localeCompare(y.model)).slice(0, 25);

    const everyAlliance = [...stats.values()];
    const waits = waitStats(everyAlliance.flatMap((a) => a.waits), everyAlliance.flatMap((a) => a.openWaits),
        everyAlliance.reduce((n, a) => n + a.noSeller, 0));

    return {
        ok: true, days, bucketDays, bucketStarts, alliances, totals, waits, waitBuckets: WAIT_BUCKETS.map(([from, to]) => [from, to === Infinity ? null : to]), aircraft, statsSince: resetAt ? new Date(resetAt).toISOString() : null,
        trade: [...trade].map(([key, aircraft]) => { const [buyer, seller] = key.split('|'); return { buyer, seller, aircraft }; }),
        generatedAt: new Date().toISOString()
    };
}
