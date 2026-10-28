// Sellers' Cup: a knockout competition between sellers (table seller_cups, schema.sql 8b).
//
//   1. An admin starts a Cup on the seller desk (Sellers tab → Cup): name, seeding period, round length,
//      bracket size, pairing rule and the Discord channel for announcements.
//   2. Seeding period (from the start): every seller with a Discord seller role (Verified Seller, Ambassador,
//      Lead Ambassador) takes part automatically. They are ranked by orders completed in that period; ties go to
//      the higher total value of those orders, then to whoever joined the seller team first. The best
//      `bracket_size` sellers (or everyone) are seeded #1, #2, …
//   3. Rounds, one after the other, each `round_hours` long: sellers are paired, and whoever completes more orders
//      in the round goes through. A tie sends the higher seed through. Uneven numbers: the top seeds get a bye in
//      round 1. Someone who left the seller team (or was disqualified by an admin) loses automatically.
//      The number of rounds follows from the number of seeds.
//   4. The last one standing is the champion.
//
// Only orders a seller completes ON THEIR OWN count: when more than one seller delivered aircraft on an order
// (take over, pass on the rest), it counts for nobody, and every seller involved is told by DM.
// An order counts in the period in which it was first completed (orders.status must still be FULFILLED).
//
// The timeline is fixed when the Cup starts, so it doesn't matter when advanceCup() runs: whenever a seller opens
// the desk, an admin opens the Cup tab, and once a day (cron). Pairings and results are posted in Discord once
// the new state is saved (guarded by `version`, so two calls at the same time can't post twice).
import { admin, accountName, discordBot, sendDM, deliveryShares, orderRef, md, RANKS, SELLER_URL, HttpError } from './server.js';

export const PAIRINGS = {
    fold: 'Highest seed vs lowest seed, every round (1 v last, 2 v second-last, …)',
    bracket: 'Fixed bracket from the seeds (1 and 2 can only meet in the final)',
    random: 'Random draw every round (top seeds still get the round-1 byes)'
};
const HOUR = 36e5;
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

const seedingEnd = (cup) => new Date(cup.started_at).getTime() + cup.seeding_hours * HOUR;
export const roundsFor = (n) => (n < 2 ? 0 : Math.ceil(Math.log2(n)));
export function roundName(round, total) {
    const left = total - round;
    return left === 0 ? 'Final' : left === 1 ? 'Semi-finals' : left === 2 ? 'Quarter-finals' : `Round ${round}`;
}

// Sellers who can take part: active, with a Discord seller role (rank), plus their account details.
export async function eligibleSellers() {
    const db = admin();
    const { data: sellers, error } = await db.from('sellers').select('user_id, rank, active, added_at').eq('active', true);
    if (error) throw error;
    const list = (sellers || []).filter((s) => RANKS.includes(s.rank));
    if (!list.length) return [];
    const { data: accounts, error: accErr } = await db.from('accounts').select('id, display_name, discord_username, discord_id').in('id', list.map((s) => s.user_id));
    if (accErr) throw accErr;
    const byId = new Map((accounts || []).map((a) => [a.id, a]));
    return list.map((s) => ({ sellerId: s.user_id, rank: s.rank, addedAt: s.added_at, name: byId.get(s.user_id) ? accountName(byId.get(s.user_id)) : 'Unknown seller', discordId: byId.get(s.user_id)?.discord_id || null }));
}

// Orders completed in [from, to) by ONE seller alone → Map sellerId → { orders, value }.
export async function cupCredits(from, to) {
    const db = admin();
    const events = await all(() => db.from('order_events').select('order_id, created_at').eq('kind', 'FULFILLED')
        .gte('created_at', new Date(from).toISOString()).lt('created_at', new Date(to).toISOString()));
    const ids = [...new Set(events.map((e) => e.order_id))];
    const credits = new Map();
    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        // Completed before this period already (and corrected since)? Then it counted back then, not now.
        const { data: earlier, error: e1 } = await db.from('order_events').select('order_id').eq('kind', 'FULFILLED')
            .in('order_id', chunk).lt('created_at', new Date(from).toISOString());
        if (e1) throw e1;
        const before = new Set((earlier || []).map((e) => e.order_id));
        const { data: orders, error: e2 } = await db.from('orders')
            .select('id, status, items, filled, total_qty, total_usd, seller_id, seller_name, seller_airline_name, seller_alliance, helpers, previous_sellers')
            .in('id', chunk.filter((id) => !before.has(id))).eq('status', 'FULFILLED');
        if (e2) throw e2;
        for (const o of orders || []) {
            const who = [...new Set(deliveryShares(o).filter((sh) => sh.total > 0 && sh.sellerId).map((sh) => sh.sellerId))];
            if (who.length !== 1) continue;   // shared (or unknown): counts for nobody
            const c = credits.get(who[0]) || { orders: 0, value: 0 };
            c.orders++;
            c.value += Number(o.total_usd) || 0;
            credits.set(who[0], c);
        }
    }
    return credits;
}

// ---------------- pairings
const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
function bracketOrder(size) {   // seed positions of a standard bracket: 8 → [1, 8, 4, 5, 2, 7, 3, 6]
    let order = [1, 2];
    while (order.length < size) order = order.flatMap((s) => [s, order.length * 2 + 1 - s]);
    return order;
}
function shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}
const match = (x, y, seedOf) => (y && seedOf(y) < seedOf(x) ? { a: y, b: x } : { a: x, b: y || null });
// players: seller ids still in, previous: the round before (for 'bracket').
function makeMatches(players, cup, previous) {
    const seedOf = (id) => cup.seeds.find((s) => s.sellerId === id)?.seed || 999;
    const bySeed = [...players].sort((x, y) => seedOf(x) - seedOf(y));
    if (cup.pairing === 'bracket') {
        if (!previous) {
            const slots = bracketOrder(nextPow2(bySeed.length)).map((seed) => bySeed[seed - 1] || null);
            const out = [];
            for (let i = 0; i < slots.length; i += 2) out.push(match(slots[i], slots[i + 1], seedOf));
            return out;
        }
        const winners = previous.matches.map((m) => m.winner);
        const out = [];
        for (let i = 0; i < winners.length; i += 2) out.push(match(winners[i], winners[i + 1], seedOf));
        return out;
    }
    // fold / random: the top seeds get byes until the field is a power of two (round 1 only).
    const byes = nextPow2(bySeed.length) - bySeed.length;
    const out = bySeed.slice(0, byes).map((id) => ({ a: id, b: null }));
    let rest = bySeed.slice(byes);
    if (cup.pairing === 'random') rest = shuffle(rest);
    if (cup.pairing === 'random') for (let i = 0; i < rest.length; i += 2) out.push(match(rest[i], rest[i + 1], seedOf));
    else for (let i = 0; i < rest.length / 2; i++) out.push(match(rest[i], rest[rest.length - 1 - i], seedOf));
    return out;
}
function newRound(cup, number, players, previous) {
    const startsAt = seedingEnd(cup) + (number - 1) * cup.round_hours * HOUR;
    return { round: number, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(startsAt + cup.round_hours * HOUR).toISOString(),
        resolved: false, matches: makeMatches(players, cup, previous).map((m) => ({ ...m, scoreA: null, scoreB: null, winner: null, how: null })) };
}

// ---------------- Discord
const mention = (cup, id) => { const s = cup.seeds.find((x) => x.sellerId === id); return s?.discordId ? `<@${s.discordId}>` : `**${md(s?.name || 'Unknown')}**`; };
const seedTag = (cup, id) => `\`#${cup.seeds.find((x) => x.sellerId === id)?.seed ?? '?'}\``;
const when = (iso, style = 'F') => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;
const GOLD = 0xF5B700;
function pairingsEmbed(cup, round, totalRounds) {
    const lines = round.matches.map((m) => (m.b
        ? `${seedTag(cup, m.a)} ${mention(cup, m.a)}  ⚔️  ${seedTag(cup, m.b)} ${mention(cup, m.b)}`
        : `${seedTag(cup, m.a)} ${mention(cup, m.a)}  ✈️ *bye: straight through*`));
    return {
        title: `⚔️ ${cup.name} · ${roundName(round.round, totalRounds)} · the draw`,
        color: 0xE11D74,
        description: `${lines.join('\n')}\n\nMost orders completed **on your own** wins. Tie? The higher seed goes through.\n⏱️ Ends ${when(round.endsAt)} (${when(round.endsAt, 'R')})`
    };
}
function resultsEmbed(cup, round, totalRounds) {
    const lines = round.matches.map((m) => {
        if (!m.b) return `✈️ ${mention(cup, m.a)} had a bye`;
        const [w, l] = m.winner === m.a ? ['a', 'b'] : ['b', 'a'];
        const score = `**${m[`score${w.toUpperCase()}`] ?? 0}** – ${m[`score${l.toUpperCase()}`] ?? 0}`;
        const why = m.how === 'tie-seed' ? ' *(tie: higher seed through)*' : m.how === 'walkover' ? ' *(walkover)*' : '';
        return `✅ ${mention(cup, m[w])} ${score} ${mention(cup, m[l])} ❌${why}`;
    });
    return { title: `🏁 ${cup.name} · ${roundName(round.round, totalRounds)} · results`, color: 0x22C55E, description: lines.join('\n') };
}
async function post(cup, { content, embeds, users = [] }) {
    if (!cup.channel_id) return false;
    try {
        const r = await discordBot(`/channels/${cup.channel_id}/messages`, 'POST', {
            content, embeds: embeds.map((e) => ({ ...e, footer: { text: `${cup.name} · Echo Market` }, timestamp: new Date().toISOString(), url: SELLER_URL || undefined })),
            allowed_mentions: { users: [...new Set(users)].slice(0, 100) }
        });
        if (!r.ok) console.error('cup post failed:', r.status, JSON.stringify(r.json));
        return r.ok;
    } catch (err) {
        console.error('cup post failed:', err.message);
        return false;
    }
}
const discordIds = (cup, ids) => ids.map((id) => cup.seeds.find((s) => s.sellerId === id)?.discordId).filter(Boolean);

// ---------------- reading and advancing
export async function currentCup() {
    const { data, error } = await admin().from('seller_cups').select('*').order('started_at', { ascending: false }).limit(1);
    if (error && (error.code === '42P01' || error.code === 'PGRST205')) throw new HttpError(503, "The Sellers' Cup needs a database update: re-run supabase/schema.sql in Supabase.");
    if (error) throw error;
    return data?.[0] || null;
}

// Moves the active Cup forward to "now": seeds at the end of the seeding period, resolves finished rounds, draws
// the next ones, crowns the champion. Returns the (possibly updated) Cup. Never throws for Discord problems.
export async function advanceCup(cup = null) {
    cup = cup || await currentCup();
    if (!cup || !['seeding', 'running'].includes(cup.status)) return cup;
    const now = Date.now();
    const next = { ...cup, seeds: [...cup.seeds], rounds: cup.rounds.map((r) => ({ ...r, matches: r.matches.map((m) => ({ ...m })) })) };
    const posts = [];
    const removed = new Set(cup.removed || []);

    if (next.status === 'seeding') {
        if (now < seedingEnd(next)) return cup;
        const eligible = (await eligibleSellers()).filter((s) => !removed.has(s.sellerId));
        const credits = await cupCredits(new Date(next.started_at).getTime(), seedingEnd(next));
        const ranked = eligible.map((s) => ({ ...s, orders: credits.get(s.sellerId)?.orders || 0, value: credits.get(s.sellerId)?.value || 0 }))
            .sort((x, y) => y.orders - x.orders || y.value - x.value || String(x.addedAt).localeCompare(String(y.addedAt)));
        const field = next.bracket_size ? ranked.slice(0, next.bracket_size) : ranked;
        next.seeds = field.map((s, i) => ({ sellerId: s.sellerId, name: s.name, discordId: s.discordId, seed: i + 1, orders: s.orders, value: s.value }));
        if (next.seeds.length < 2) {
            next.status = 'cancelled';
            next.note = 'Not enough sellers for a bracket at the end of the seeding period.';
            next.ended_at = new Date(now).toISOString();
            posts.push({ embeds: [{ title: `🛑 ${next.name} is off`, color: 0x94A3B8, description: 'Not enough sellers took part to make a bracket. See you at the next Cup!' }] });
        } else {
            next.status = 'running';
            const total = roundsFor(next.seeds.length);
            next.rounds = [newRound(next, 1, next.seeds.map((s) => s.sellerId), null)];
            const seedLines = next.seeds.map((s) => `${seedTag(next, s.sellerId)} ${mention(next, s.sellerId)} · ${s.orders} order${s.orders === 1 ? '' : 's'}`);
            posts.push({
                content: `🏆 **${next.name}**: the seeds are in and the draw is made! ${discordIds(next, next.seeds.map((s) => s.sellerId)).map((d) => `<@${d}>`).join(' ')}`.slice(0, 1900),
                users: discordIds(next, next.seeds.map((s) => s.sellerId)),
                embeds: [{ title: `📋 ${next.name} · the seeds`, color: GOLD, description: `${seedLines.join('\n').slice(0, 3500)}\n\n${next.seeds.length} sellers · ${total} round${total === 1 ? '' : 's'} to the title.` },
                    pairingsEmbed(next, next.rounds[0], total)]
            });
        }
    }

    // Resolve every round that has ended (several, if nothing ran for a while).
    while (next.status === 'running') {
        const round = next.rounds[next.rounds.length - 1];
        if (round.resolved || now < new Date(round.endsAt).getTime()) break;
        const total = roundsFor(next.seeds.length);
        const credits = await cupCredits(new Date(round.startsAt).getTime(), new Date(round.endsAt).getTime());
        const stillIn = new Set((await eligibleSellers()).map((s) => s.sellerId).filter((id) => !removed.has(id)));
        const seedOf = (id) => next.seeds.find((s) => s.sellerId === id)?.seed || 999;
        for (const m of round.matches) {
            if (!m.b) { m.winner = m.a; m.how = 'bye'; continue; }
            m.scoreA = credits.get(m.a)?.orders || 0;
            m.scoreB = credits.get(m.b)?.orders || 0;
            const inA = stillIn.has(m.a), inB = stillIn.has(m.b);
            if (inA !== inB) { m.winner = inA ? m.a : m.b; m.how = 'walkover'; continue; }
            if (m.scoreA !== m.scoreB) { m.winner = m.scoreA > m.scoreB ? m.a : m.b; m.how = 'score'; continue; }
            m.winner = seedOf(m.a) < seedOf(m.b) ? m.a : m.b;
            m.how = 'tie-seed';
        }
        round.resolved = true;
        const winners = round.matches.map((m) => m.winner);
        const result = { embeds: [resultsEmbed(next, round, total)], users: discordIds(next, round.matches.flatMap((m) => [m.a, m.b]).filter(Boolean)) };
        if (winners.length === 1) {
            next.status = 'finished';
            next.champion_id = winners[0];
            next.ended_at = new Date(now).toISOString();
            const final = round.matches[0];
            result.content = `🏆🎉 **${next.name}** has a champion: ${mention(next, winners[0])}! 🎉🏆`;
            result.embeds.push({ title: `🏆 ${next.name} CHAMPION`, color: GOLD,
                description: `👑 ${mention(next, winners[0])} (seed ${seedTag(next, winners[0])}) wins **${next.name}**!${final.b ? `\n\nFinal: ${mention(next, final.winner)} beat ${mention(next, final.winner === final.a ? final.b : final.a)} **${Math.max(final.scoreA, final.scoreB)} – ${Math.min(final.scoreA, final.scoreB)}**.` : ''}\n\nThanks to every seller who took part. GG! 🛫` });
        } else {
            const upcoming = newRound(next, round.round + 1, winners, round);
            next.rounds.push(upcoming);
            result.content = `🔥 **${next.name}**: ${roundName(round.round, total)} is over. On to the ${roundName(upcoming.round, total).toLowerCase()}! ${discordIds(next, winners).map((d) => `<@${d}>`).join(' ')}`.slice(0, 1900);
            result.users.push(...discordIds(next, winners));
            result.embeds.push(pairingsEmbed(next, upcoming, total));
        }
        posts.push(result);
    }

    if (!posts.length) return cup;   // nothing happened (every change above comes with an announcement)
    const { data: saved, error } = await admin().from('seller_cups')
        .update({ status: next.status, seeds: next.seeds, rounds: next.rounds, champion_id: next.champion_id || null, note: next.note || null,
            ended_at: next.ended_at || null, version: cup.version + 1, updated_at: new Date().toISOString() })
        .eq('id', cup.id).eq('version', cup.version).select().maybeSingle();
    if (error) throw error;
    if (!saved) return currentCup();   // someone else advanced it at the same moment (and posted)
    for (const p of posts) await post(saved, p);
    return saved;
}

// ---------------- admin actions
export async function startCup(account, input) {
    const db = admin();
    const name = String(input.name || '').trim().slice(0, 80);
    if (name.length < 3) throw new HttpError(400, 'Give the Cup a name.');
    const days = (v, label) => {
        const n = Number(v);
        if (!(n >= 1 / 24 && n <= 90)) throw new HttpError(400, `${label} must be between 1 hour and 90 days.`);
        return Math.max(1, Math.round(n * 24));
    };
    const roundHours = days(input.roundDays, 'The round length');
    const seedingHours = days(input.seedingDays ?? input.roundDays, 'The seeding period');
    const size = Number(input.bracketSize) || null;
    if (size !== null && !(Number.isInteger(size) && size >= 2 && size <= 256)) throw new HttpError(400, 'The bracket size must be a whole number from 2 to 256 (or empty for everyone).');
    const pairing = PAIRINGS[input.pairing] ? input.pairing : 'fold';
    const channelId = String(input.channelId || '').trim();
    if (channelId && !/^\d{17,20}$/.test(channelId)) throw new HttpError(400, 'The channel ID is a long number (Discord: right-click the channel → Copy Channel ID).');
    if (channelId) {
        const ch = await discordBot(`/channels/${channelId}`);
        if (!ch.ok) throw new HttpError(400, "The bot can't see that channel. Check the ID and that the bot may post there.");
    }
    const active = await advanceCup();
    if (active && ['seeding', 'running'].includes(active.status)) throw new HttpError(409, 'A Cup is already running. Cancel it first to start a new one.');
    const { data: cup, error } = await db.from('seller_cups').insert({
        name, pairing, bracket_size: size, seeding_hours: seedingHours, round_hours: roundHours, channel_id: channelId || null, started_by: account.id
    }).select().single();
    if (error) {
        if (error.code === '23505') throw new HttpError(409, 'A Cup is already running. Cancel it first to start a new one.');
        throw error;
    }
    const eligible = await eligibleSellers();
    const field = size ? Math.min(size, eligible.length) : eligible.length;
    const rounds = roundsFor(field);
    await post(cup, {
        content: `🏆 **${name}** starts NOW! Every Verified Seller is in. ${eligible.map((s) => s.discordId).filter(Boolean).map((d) => `<@${d}>`).join(' ')}`.slice(0, 1900),
        users: eligible.map((s) => s.discordId).filter(Boolean),
        embeds: [{
            title: `🏆 ${name} is ON!`,
            color: GOLD,
            description: [
                `**Seeding period:** until ${when(new Date(seedingEnd(cup)).toISOString())} (${when(new Date(seedingEnd(cup)).toISOString(), 'R')}). Every order you complete **on your own** counts toward your seed.`,
                `**Bracket:** ${size ? `the top ${size} sellers` : 'every seller'} · ${rounds} knockout round${rounds === 1 ? '' : 's'} of ${fmtLength(roundHours)} each.`,
                '**Rules:** head-to-head, most orders completed on your own goes through. Tie? Higher seed. Orders shared between sellers count for nobody.',
                '',
                'Good luck, and happy selling! ✈️'
            ].join('\n')
        }]
    });
    return cup;
}
const fmtLength = (hours) => (hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hours`);

export async function cancelCup(account, reason) {
    const cup = await currentCup();
    if (!cup || !['seeding', 'running'].includes(cup.status)) throw new HttpError(409, 'No Cup is running.');
    const note = String(reason || '').trim().slice(0, 300) || 'Cancelled by an admin.';
    const { data: saved, error } = await admin().from('seller_cups')
        .update({ status: 'cancelled', note, ended_at: new Date().toISOString(), version: cup.version + 1, updated_at: new Date().toISOString() })
        .eq('id', cup.id).eq('version', cup.version).select().maybeSingle();
    if (error) throw error;
    if (!saved) throw new HttpError(409, 'The Cup just changed. Try again.');
    await post(saved, { embeds: [{ title: `🛑 ${saved.name} has been cancelled`, color: 0x94A3B8, description: md(note) }] });
    return saved;
}

// Disqualify a seller: they lose their current match (walkover) and can't be seeded.
export async function disqualify(account, sellerId) {
    const cup = await currentCup();
    if (!cup || !['seeding', 'running'].includes(cup.status)) throw new HttpError(409, 'No Cup is running.');
    if (!/^[0-9a-f-]{36}$/i.test(String(sellerId))) throw new HttpError(400, 'Pick a seller.');
    const removed = [...new Set([...(cup.removed || []), sellerId])];
    const { data: saved, error } = await admin().from('seller_cups')
        .update({ removed, version: cup.version + 1, updated_at: new Date().toISOString() })
        .eq('id', cup.id).eq('version', cup.version).select().maybeSingle();
    if (error) throw error;
    if (!saved) throw new HttpError(409, 'The Cup just changed. Try again.');
    return saved;
}

// Live numbers for the desk: the seeding table, or the current round's scores.
export async function cupView(cup) {
    if (!cup) return { cup: null };
    const view = { cup, totalRounds: roundsFor(cup.seeds.length), seedingEndsAt: new Date(seedingEnd(cup)).toISOString() };
    if (cup.status === 'seeding') {
        const eligible = await eligibleSellers();
        const removed = new Set(cup.removed || []);
        const credits = await cupCredits(new Date(cup.started_at).getTime(), Math.min(Date.now() + 1, seedingEnd(cup)));
        view.standings = eligible.filter((s) => !removed.has(s.sellerId))
            .map((s) => ({ sellerId: s.sellerId, name: s.name, orders: credits.get(s.sellerId)?.orders || 0, value: credits.get(s.sellerId)?.value || 0, addedAt: s.addedAt }))
            .sort((x, y) => y.orders - x.orders || y.value - x.value || String(x.addedAt).localeCompare(String(y.addedAt)))
            .map(({ addedAt, ...s }, i) => ({ ...s, place: i + 1 }));
        view.totalRounds = roundsFor(cup.bracket_size ? Math.min(cup.bracket_size, view.standings.length) : view.standings.length);
    } else if (cup.status === 'running') {
        const round = cup.rounds[cup.rounds.length - 1];
        const credits = await cupCredits(new Date(round.startsAt).getTime(), Math.min(Date.now() + 1, new Date(round.endsAt).getTime()));
        view.live = Object.fromEntries(round.matches.flatMap((m) => [m.a, m.b]).filter(Boolean).map((id) => [id, credits.get(id)?.orders || 0]));
    }
    return view;
}

// An order was just completed: if more than one seller delivered on it while a Cup is on, it counts for nobody.
// Tell every seller involved, so nobody wonders why their score didn't move.
export async function noticeSharedOrder(order) {
    try {
        const cup = await currentCup();
        if (!cup || !['seeding', 'running'].includes(cup.status)) return;
        const sellerIds = [...new Set(deliveryShares(order).filter((sh) => sh.total > 0 && sh.sellerId).map((sh) => sh.sellerId))];
        if (sellerIds.length < 2) return;
        const { data: accounts } = await admin().from('accounts').select('*').in('id', sellerIds);
        const names = (accounts || []).map(accountName).join(', ');
        for (const account of accounts || []) {
            await sendDM(account, {
                title: `🏆 ${cup.name}: order ${order.serial ? `#${order.serial}` : order.id} doesn't count`,
                description: `Order ${md(orderRef(order))} was completed by more than one seller (${md(names)}), so it counts for **nobody** in ${md(cup.name)}. Only orders a seller completes on their own count.`,
                color: GOLD,
                url: SELLER_URL || undefined
            });
        }
    } catch (err) {
        console.error('cup notice failed:', err.message);
    }
}
