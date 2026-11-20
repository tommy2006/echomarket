// Waiting-order reminders: run by the scheduled job (api/cron/bans.js, twice a day). Every order that has been
// waiting in the open queue for WAIT_HOURS or more gets the sellers who could take it a reminder DM from the Echo
// Market bot, and again every WAIT_HOURS while it keeps waiting.
//
// Who gets reminded: counted sellers (switched on, a seller rank, not Unranked: isCountedSeller in lib/activity.js)
// with an airline in one of the order's divisions (the divisions of the buyer's airlines), who haven't passed on it.
// Sellers on vacation and sellers who turned DMs off get nothing (sendDM). One DM per seller per run, listing all
// their waiting orders.
//
// When each order was last reminded is kept in market_settings 'wait_reminders' ({ order id: ISO time }), so no
// database update is needed. A reminder is due again after WAIT_HOURS minus SLACK_HOURS (the job's start time
// can drift by up to an hour).
import { admin, sendDM, getSetting, setSetting, orderAirlines, orderRef, md, onVacation, SELLER_URL, EMBED_COLORS } from './server.js';
import { isCountedSeller } from './activity.js';

export const WAIT_HOURS = 12;
const SLACK_HOURS = 1.5;
const LIST_MAX = 10;   // orders listed in one DM
const ms = (t) => (t ? new Date(t).getTime() || 0 : 0);
// When the order (last) entered the open queue: same as queuedSince in js/seller.js.
export const queuedSince = (o) => {
    const history = Array.isArray(o.status_history) ? o.status_history : [];
    const lastPending = [...history].reverse().find((h) => h.status === 'PENDING');
    return (o.status === 'PENDING' ? ms(o.status_changed_at) : 0) || ms(lastPending?.at) || ms(o.created_at);
};
const waitText = (h) => (h < 48 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} d ${Math.floor(h % 24)} h`);

export async function waitReminders({ now = Date.now() } = {}) {
    const db = admin();
    const { data: open, error } = await db.from('orders')
        .select('id, serial, status, alliance, airline_id, airline_name, airlines, total_qty, filled, buyer_name, status_changed_at, status_history, created_at')
        .eq('status', 'PENDING');
    if (error) throw error;
    const state = { ...(await getSetting('wait_reminders', {}) || {}) };
    for (const id of Object.keys(state)) if (!(open || []).some((o) => o.id === id)) delete state[id];   // no longer waiting
    const due = (open || []).filter((o) => {
        if (now - queuedSince(o) < WAIT_HOURS * 36e5) return false;
        const last = ms(state[o.id]);
        // Never reminded, back in the queue since the last reminder (taken, then released), or WAIT_HOURS later.
        return !last || last < queuedSince(o) || now - last >= (WAIT_HOURS - SLACK_HOURS) * 36e5;
    });
    if (!due.length) {
        await setSetting('wait_reminders', state, 'scheduled job');
        return { waiting: (open || []).length, due: 0 };
    }

    const [{ data: sellers, error: sErr }, { data: declines, error: dErr }] = await Promise.all([
        db.from('sellers').select('*').eq('active', true),
        db.from('order_declines').select('order_id, seller_id').in('order_id', due.map((o) => o.id))
    ]);
    if (sErr) throw sErr;
    if (dErr) throw dErr;
    const counted = (sellers || []).filter((s) => isCountedSeller(s) && !onVacation(s, now));
    const ids = counted.map((s) => s.user_id);
    const [{ data: airlines }, { data: accounts }] = ids.length
        ? await Promise.all([
            db.from('airlines').select('owner_id, alliance').in('owner_id', ids),
            db.from('accounts').select('*').in('id', ids)
        ])
        : [{ data: [] }, { data: [] }];
    const divisionsOf = new Map();
    for (const a of airlines || []) {
        if (!divisionsOf.has(a.owner_id)) divisionsOf.set(a.owner_id, new Set());
        divisionsOf.get(a.owner_id).add(a.alliance);
    }
    const passed = new Set((declines || []).map((d) => `${d.order_id}|${d.seller_id}`));
    const orderDivisions = (o) => [...new Set(orderAirlines(o).map((a) => a.alliance).filter(Boolean))];

    const results = { sent: 0, off: 0, blocked: 0, vacation: 0, error: 0, unavailable: 0 };
    const reached = new Set();   // orders at least one seller was reminded about
    for (const acc of accounts || []) {
        const mine = divisionsOf.get(acc.id);
        if (!mine) continue;
        const list = due.filter((o) => orderDivisions(o).some((d) => mine.has(d)) && !passed.has(`${o.id}|${acc.id}`))
            .sort((a, b) => queuedSince(a) - queuedSince(b));
        if (!list.length) continue;
        const lines = list.slice(0, LIST_MAX).map((o) => {
            const divs = orderDivisions(o).filter((d) => mine.has(d));
            return `**${md(orderRef(o).split(' · ')[0])}** · ${md(o.buyer_name || 'buyer')} (${divs.map(md).join(', ')}) · `
                + `${o.total_qty - (o.filled || 0)} aircraft · waiting **${waitText((now - queuedSince(o)) / 36e5)}**`;
        });
        if (list.length > LIST_MAX) lines.push(`…and ${list.length - LIST_MAX} more.`);
        const r = await sendDM(acc, {
            title: `⏰ ${list.length === 1 ? '1 order' : `${list.length} orders`} in your divisions waiting ${WAIT_HOURS}+ hours`,
            description: `${lines.join('\n')}\n\nThese buyers are still waiting for a seller. Take one on the seller desk, or pass on it so it stops coming back to you.`,
            color: EMBED_COLORS.request,
            url: SELLER_URL || undefined
        });
        results[r] = (results[r] || 0) + 1;
        if (r === 'sent') list.forEach((o) => reached.add(o.id));
    }
    // Every due order counts as reminded (also when nobody could be reached), so it is checked again in WAIT_HOURS.
    for (const o of due) state[o.id] = new Date(now).toISOString();
    await setSetting('wait_reminders', state, 'scheduled job');
    return {
        waiting: (open || []).length, due: due.length, dms: results,
        noSeller: due.filter((o) => !reached.has(o.id)).map((o) => orderRef(o).split(' · ')[0])
    };
}
