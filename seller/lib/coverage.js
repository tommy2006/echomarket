// Division coverage for admins (Sellers → Divisions), served by POST /api/admin/sellers { view: 'coverage', days }.
// Answers two questions: which sellers have airlines in which division, and which sellers have been selling to
// which division the most, so admins can see where the market is short of sellers.
//
//   divisions  the alliances table, in its order, plus any other alliance found on airlines or orders
//   sellers    every seller on the list who can sell (not Community Managers), with:
//                airlines  division → their airline names there
//                sold      division → aircraft they delivered to buyers in that division (orders placed in the period)
//                orders    division → orders they delivered on there
//              away (on vacation), unranked, active
//   demand     per division: orders placed and aircraft ordered in the period, orders waiting now, aircraft still
//              to deliver on active orders, median hours until a seller took an order (period)
//
// "Sold to a division": each seller's delivered aircraft on an order (deliveryShares) go to the buyer's airline in
// the seller's own division when the buyer has one there, otherwise to the order's division (orders.alliance).
import { admin, deliveryShares, orderAirlines, accountName, canSell, onVacation, getSetting } from './server.js';

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
const DAY = 864e5;
const median = (list) => {
    if (!list.length) return null;
    const s = [...list].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ACTIVE = ['PENDING', 'CLAIMED', 'PARTIAL'];

export async function divisionCoverage(days) {
    const db = admin();
    const resetAt = new Date(await getSetting('stats_reset_at', 0) || 0).getTime() || 0;
    const since = Math.max(days ? Date.now() - days * DAY : 0, resetAt);
    const [alliances, sellers, orders, claims] = await Promise.all([
        db.from('alliances').select('name, sort_order').order('sort_order').then((r) => { if (r.error) throw r.error; return r.data || []; }),
        db.from('sellers').select('*').then((r) => { if (r.error) throw r.error; return r.data || []; }),
        all(() => db.from('orders').select('id, alliance, airline_name, airline_id, airlines, items, total_qty, filled, status, seller_id, seller_name, seller_airline_name, seller_alliance, helpers, previous_sellers, created_at')
            .order('created_at', { ascending: true })),
        all(() => db.from('order_events').select('order_id, created_at').eq('kind', 'CLAIMED').order('created_at', { ascending: true }))
    ]);
    const sellerRows = sellers.filter((s) => canSell(s));
    const ids = sellerRows.map((s) => s.user_id);
    const [{ data: accounts, error: accErr }, { data: airlines, error: airErr }] = ids.length
        ? await Promise.all([
            db.from('accounts').select('id, display_name, discord_username, avatar_url').in('id', ids),
            db.from('airlines').select('owner_id, name, alliance').in('owner_id', ids).order('name')
        ])
        : [{ data: [] }, { data: [] }];
    if (accErr) throw accErr;
    if (airErr) throw airErr;

    const names = alliances.map((a) => a.name);
    const known = new Set(names);
    const addDivision = (d) => { if (d && !known.has(d)) { known.add(d); names.push(d); } };
    const accountOf = new Map((accounts || []).map((a) => [a.id, a]));

    const rows = new Map(sellerRows.map((s) => {
        const a = accountOf.get(s.user_id);
        return [s.user_id, {
            id: s.user_id, name: a ? accountName(a) : 'Unknown account', avatarUrl: a?.avatar_url || null,
            rank: s.rank, active: s.active !== false, unranked: Boolean(s.unranked), away: onVacation(s),
            airlines: {}, sold: {}, orders: {}, soldTotal: 0
        }];
    }));
    for (const al of airlines || []) {
        const r = rows.get(al.owner_id);
        if (!r) continue;
        addDivision(al.alliance);
        (r.airlines[al.alliance] ||= []).push(al.name);
    }

    const firstClaim = new Map();
    for (const c of claims) if (!firstClaim.has(c.order_id)) firstClaim.set(c.order_id, c.created_at);
    const demand = {};
    const dem = (d) => (demand[d] ||= { orders: 0, aircraft: 0, waiting: 0, toDeliver: 0, waits: [] });
    for (const o of orders) {
        const div = o.alliance || null;
        const inPeriod = !since || new Date(o.created_at).getTime() >= since;
        if (div) {
            addDivision(div);
            const d = dem(div);
            if (o.status === 'PENDING') d.waiting++;
            if (ACTIVE.includes(o.status)) d.toDeliver += Math.max(0, (o.total_qty || 0) - (o.filled || 0));
            if (inPeriod) {
                d.orders++;
                d.aircraft += o.total_qty || 0;
                const c = firstClaim.get(o.id);
                if (c) d.waits.push((new Date(c) - new Date(o.created_at)) / 36e5);
            }
        }
        if (!inPeriod) continue;
        const buyerDivisions = new Set(orderAirlines(o).map((a) => a.alliance).filter(Boolean));
        for (const sh of deliveryShares(o)) {
            if (!(sh.total > 0)) continue;
            const r = rows.get(sh.sellerId);
            if (!r) continue;
            const to = sh.alliance && buyerDivisions.has(sh.alliance) ? sh.alliance : div;
            if (!to) continue;
            addDivision(to);
            r.sold[to] = (r.sold[to] || 0) + sh.total;
            r.orders[to] = (r.orders[to] || 0) + 1;
            r.soldTotal += sh.total;
        }
    }

    return {
        ok: true, days, statsSince: resetAt ? new Date(resetAt).toISOString() : null,
        divisions: names,
        sellers: [...rows.values()].sort((a, b) => b.soldTotal - a.soldTotal || a.name.localeCompare(b.name)),
        demand: Object.fromEntries(names.map((n) => {
            const { waits, ...d } = demand[n] || { orders: 0, aircraft: 0, waiting: 0, toDeliver: 0, waits: [] };
            const m = median(waits);
            return [n, { ...d, waitHours: m == null ? null : Math.round(m * 10) / 10 }];
        })),
        generatedAt: new Date().toISOString()
    };
}
