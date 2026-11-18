// Vacation days for sellers (any rank).
//
// Granting: only the Lead Ambassador (rank 'lead') or someone with the Alliance Leader role
// (DISCORD_ALLIANCE_LEADER_ROLE_ID), checked with Discord at the moment they grant. Grants add to the seller's
// balance (sellers.vacation_days) and leave a pop-up for them (sellers.vacation_news) plus a line in vacation_grants.
//
// Spending: the seller picks how many days (or all) on their profile. From then until sellers.vacation_until:
//   - the seller desk shows only the holiday screen (seller/js/seller.js, VacationScreen)
//   - no bot DMs or push notifications reach them (sendDM / sendPush in lib/server.js)
//   - the activity alerts skip them, and the quiet-days clock restarts when they come back (lib/activity.js)
//   - a missing-plane report on their order tells the buyer they're away (buyer/api/orders/[orderId].js)
// Coming back early returns the unused days (rounded to the nearest day) to the balance.
import { admin, accountName, onVacation, HttpError } from './server.js';

export const MAX_GRANT = 60;      // days per grant
export const MAX_BALANCE = 365;   // days a seller can hold
const DAY = 864e5;
const uuid = (x) => (typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x) ? x : null);
const missingColumns = () => new HttpError(503, 'Vacation days need a database update: re-run supabase/schema.sql.');

// May this seller (from requireActiveSeller, with its fresh Discord standing) grant vacation days?
export const canGrantVacation = (me) => Boolean(me && (
    me.standing ? (me.standing.rank === 'lead' || me.standing.allianceLeader) : me.rank === 'lead'));

// What the seller desk shows about someone's vacation.
export function vacationView(row, now = Date.now()) {
    return {
        days: Number(row?.vacation_days) || 0,
        from: row?.vacation_from || null,
        until: row?.vacation_until || null,
        away: onVacation(row, now),
        news: row?.vacation_news || null
    };
}

export async function grantVacation(granter, me, input) {
    if (!canGrantVacation(me)) throw new HttpError(403, 'Only the Lead Alliance Ambassador or an Alliance Leader can grant vacation days.');
    const sellerId = uuid(input.sellerId);
    const days = Math.floor(Number(input.days));
    if (!sellerId) throw new HttpError(400, 'Choose a seller.');
    if (!(days >= 1 && days <= MAX_GRANT)) throw new HttpError(400, `Grant between 1 and ${MAX_GRANT} days.`);
    const note = String(input.note || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    const db = admin();
    const { data: row, error } = await db.from('sellers').select('*').eq('user_id', sellerId).maybeSingle();
    if (error) throw error;
    if (!row) throw new HttpError(404, 'That person is not on the seller list.');
    if (!('vacation_days' in row)) throw missingColumns();
    const balance = Math.min(MAX_BALANCE, (Number(row.vacation_days) || 0) + days);
    if (balance === (Number(row.vacation_days) || 0)) throw new HttpError(409, `They already hold the most vacation days possible (${MAX_BALANCE}).`);
    const by = accountName(granter);
    // Several grants before they look: the pop-up adds them up.
    const prev = row.vacation_news && typeof row.vacation_news === 'object' ? row.vacation_news : null;
    const news = { days: (prev?.days || 0) + days, by: prev && prev.by !== by ? `${prev.by}, ${by}` : by, note: note || prev?.note || null, at: new Date().toISOString() };
    const { error: upErr } = await db.from('sellers').update({ vacation_days: balance, vacation_news: news }).eq('user_id', sellerId);
    if (upErr) throw missingColumns();
    await db.from('vacation_grants').insert({ seller_id: sellerId, days, note, granted_by: granter.id, granted_by_name: by });
    return { ok: true, days: balance, granted: days };
}

export async function startVacation(account, input) {
    const db = admin();
    const { data: row, error } = await db.from('sellers').select('*').eq('user_id', account.id).maybeSingle();
    if (error) throw error;
    if (!row || !('vacation_days' in row)) throw missingColumns();
    if (onVacation(row)) throw new HttpError(409, "You're already on vacation.");
    const balance = Number(row.vacation_days) || 0;
    if (!balance) throw new HttpError(409, "You don't have any vacation days yet.");
    const days = input.all === true ? balance : Math.floor(Number(input.days));
    if (!(days >= 1 && days <= balance)) throw new HttpError(400, `Choose between 1 and ${balance} days.`);
    const now = Date.now();
    const patch = { vacation_days: balance - days, vacation_from: new Date(now).toISOString(), vacation_until: new Date(now + days * DAY).toISOString(), vacation_news: null };
    const { error: upErr } = await db.from('sellers').update(patch).eq('user_id', account.id);
    if (upErr) throw upErr;
    return { ok: true, vacation: vacationView({ ...row, ...patch }) };
}

// Back to work early: the unused whole days go back to the balance.
export async function endVacation(account) {
    const db = admin();
    const { data: row, error } = await db.from('sellers').select('*').eq('user_id', account.id).maybeSingle();
    if (error) throw error;
    if (!row || !onVacation(row)) throw new HttpError(409, "You're not on vacation.");
    const now = Date.now();
    const back = Math.round((new Date(row.vacation_until).getTime() - now) / DAY);   // 12 h or more left counts as a day
    const patch = { vacation_days: Math.min(MAX_BALANCE, (Number(row.vacation_days) || 0) + back), vacation_until: new Date(now).toISOString(),
        activity_alert_at: null };
    const { error: upErr } = await db.from('sellers').update(patch).eq('user_id', account.id);
    if (upErr) throw upErr;
    return { ok: true, returned: back, vacation: vacationView({ ...row, ...patch }) };
}

export async function seenVacationNews(account) {
    await admin().from('sellers').update({ vacation_news: null }).eq('user_id', account.id);
    return { ok: true };
}

export async function vacationHistory(sellerId) {
    const { data } = await admin().from('vacation_grants').select('days, note, granted_by_name, created_at')
        .eq('seller_id', sellerId).order('created_at', { ascending: false }).limit(20);
    return data || [];
}
