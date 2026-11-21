// FFA listings: aircraft players list in the Discord channel #ffa-listings (first come, first served), shown on the
// buyer site's FFA page, coloured by division. Used by api/ffa.js.
//
// How it works (no always-on bot needed; the Echo Market bot only reads the channel through Discord's API):
//   1. When someone opens the FFA page (or the buyer site checks for listings), and the last check is older than
//      SYNC_MINUTES, the server reads the channel's messages of the last LISTING_DAYS days.
//   2. New or edited posts are sent, in batches, to a free AI model (any OpenAI-compatible chat API; Google Gemini's
//      free tier by default) that extracts airline, aircraft model, quantity and division. Without an AI key, or
//      when the AI fails, a basic built-in reader (aircraft names from aircraft_pricelist.json) is used instead.
//   3. Each post is matched to the poster's market account (their Discord ID): an airline named in the post is
//      matched to their airline profiles, which gives the division. If the post names no division or airline and
//      all of the poster's airlines are in one division, that division is used.
//   4. A listing disappears after LISTING_DAYS days, when the post is deleted, when it is edited to say sold out
//      (or struck through), or when the poster replies to it saying it is sold out.
//
// Needs: DISCORD_BOT_TOKEN, FFA_CHANNEL_ID (the channel's ID), the bot allowed to view the channel and read its
// history, and "Message Content Intent" switched on (Developer Portal → Bot). AI: FFA_AI_KEY (free key from
// Google AI Studio), optional FFA_AI_MODEL / FFA_AI_URL to use another model or provider (e.g. Groq).
// Listings are stored in public.ffa_listings (supabase/schema.sql); the last check in market_settings 'ffa_sync'.
import { createHash } from 'crypto';
import { admin, discordBot, getSetting, setSetting, DM_AVAILABLE, GUILD_IDS } from './server.js';
import { AIRCRAFT } from './pricing.js';

const env = (n) => process.env[n] || '';
export const FFA_CHANNEL_ID = env('FFA_CHANNEL_ID').trim();
const AI_KEY = env('FFA_AI_KEY');
const AI_URL = env('FFA_AI_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const AI_MODEL = env('FFA_AI_MODEL') || 'gemini-flash-lite-latest';
export const FFA_AVAILABLE = Boolean(DM_AVAILABLE && FFA_CHANNEL_ID);
export const FFA_AI = Boolean(AI_KEY);

export const LISTING_DAYS = 5;
const SYNC_MINUTES = 3;
const MAX_PAGES = 10;          // 100 messages each: up to 1000 posts in 5 days
const AI_BATCH = 15;           // posts per AI request (the free tier allows few requests per minute)
const AI_PER_SYNC = 4;         // AI requests per check at most; the rest wait for the next check
const DAY = 864e5;

const SOLD_RE = /\b(sold[\s-]*out|all\s+sold|all\s+gone|all\s+taken|fully\s+claimed|no\s+(?:more\s+)?(?:planes?|aircraft|stock)\s+left|nothing\s+left|none\s+left|out\s+of\s+stock|listing\s+(?:closed|ended))\b|^\s*(?:sold|gone)\b|\b(?:sold|gone)\s*[!.✅]*\s*$/i;
const isSoldText = (text) => {
    const t = String(text || '').trim();
    if (!t || /\?\s*$/.test(t)) return false;   // "is it sold out?" is a question, not an update
    return SOLD_RE.test(t);
};
// The whole post struck through (~~…~~) also means it is over.
const struckThrough = (text) => /^\s*~~[\s\S]+~~\s*$/.test(String(text || ''));
const hash = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- Aircraft names → the price list's model names -------------------------------------------------------------
const MODEL_KEYS = AIRCRAFT.map((a) => {
    const m = a.model;
    const short = m.replace(/^(Airbus|Boeing|Bombardier|Embraer|De Havilland Canada|Comac|Sukhoi)\s+/i, '').replace(/\s+Dreamliner$/i, '');
    const keys = new Set([norm(m), norm(short)]);
    // "A320neo" / "320neo", "B737-800" / "737-800" / "738", "B77W"-style codes are matched through the code below.
    keys.add(norm(short.replace(/^A(\d)/, '$1')));
    if (/^Boeing/.test(m)) keys.add(norm('B' + short));
    keys.add(norm(short.replace(/-\d00$/, '')));   // "A330-300" → "A330" only when unambiguous (checked below)
    return { aircraft: a, keys: [...keys].filter((k) => k.length >= 3) };
});
const KEY_COUNT = new Map();
for (const { keys } of MODEL_KEYS) for (const k of keys) KEY_COUNT.set(k, (KEY_COUNT.get(k) || 0) + 1);
const CODE_COUNT = new Map();
for (const a of AIRCRAFT) CODE_COUNT.set(norm(a.code), (CODE_COUNT.get(norm(a.code)) || 0) + 1);

export function matchModel(name) {
    const n = norm(name);
    if (!n) return null;
    const exact = MODEL_KEYS.find(({ keys }) => keys.some((k) => k === n && KEY_COUNT.get(k) === 1));
    if (exact) return exact.aircraft.model;
    const byName = AIRCRAFT.find((a) => norm(a.model) === n);
    if (byName) return byName.model;
    if (CODE_COUNT.get(n) === 1) return AIRCRAFT.find((a) => norm(a.code) === n).model;
    // Longest key contained in the name ("airbus a320neo x5" → A320neo).
    let best = null;
    for (const { aircraft, keys } of MODEL_KEYS) {
        for (const k of keys) if (KEY_COUNT.get(k) === 1 && k.length >= 4 && n.includes(k) && (!best || k.length > best.len)) best = { len: k.length, model: aircraft.model };
    }
    return best?.model || null;
}

// ---- Basic reader (no AI): finds "5x A320neo", "A320neo x5", "A320neo - 5", "5 A320neo" ------------------------
// Divisions: named on the line ("5x A320neo Kyra"), else the last header line ("Kyra:" / "**Aegis**"), else the
// post's only division. A line naming several divisions ("A320neo: Kyra 5, Aegis 3") gives one line per division,
// each with the number next to that division's name.
const divRe = (d) => new RegExp(`\\b${d}\\b`, 'i');
const qtyOf = (line) => {
    // A number glued to a model name ("737-800", "A350") is never the quantity.
    const q = line.match(/(?<![\w.-])(\d{1,4})\s*(?:x|×|pcs|planes?|aircraft|units?)(?![\w-])/i) || line.match(/(?:^|\s)(?:x|×)\s*(\d{1,4})\b/i)
        || line.match(/\s[-:=]\s*(\d{1,4})\s*(?:$|left|avail)/i) || line.match(/^\s*(\d{1,4})\s+\D/);
    const n = q ? Number(q[1]) : null;
    return n && n < 5000 ? n : null;
};
// "Kyra 5", "Kyra: 5", "5 in Kyra", "5x Kyra": the number written next to a division's name.
const nearQty = (line, d) => {
    const m = line.match(new RegExp(`\\b${d}\\b\\s*[:=x×-]?\\s*(\\d{1,4})(?![\\w-])`, 'i'))
        || line.match(new RegExp(`(?<![\\w.-])(\\d{1,4})\\s*(?:x|×)?\\s*(?:in|for|@)?\\s*\\b${d}\\b`, 'i'));
    return m ? Number(m[1]) : null;
};
export function basicParse(text, divisions) {
    const items = [];
    const named = divisions.filter((d) => divRe(d).test(text));
    let header = null;
    for (const rawLine of String(text).split('\n')) {
        let lastModel = null;   // "A320neo: Kyra 5, Aegis 3": the model carries over to "Aegis 3"
        for (const raw of rawLine.split(/,|;|\|/)) {
            const line = raw.replace(/[*_`>~]/g, ' ').trim();
            if (!line) continue;
            const here = divisions.filter((d) => divRe(d).test(line));
            const model = matchModel(line) || (here.length && /\d/.test(line) ? lastModel : null);
            if (!model) {
                if (here.length === 1) header = here[0];   // a division heading
                continue;
            }
            lastModel = model;
            if (here.length > 1) {
                for (const d of here) items.push({ model, qty: nearQty(line, d) ?? qtyOf(line), division: d, airline: null });
                continue;
            }
            const division = here[0] || header || (named.length === 1 ? named[0] : null);
            const qty = (here[0] && nearQty(line, here[0])) ?? qtyOf(line);
            items.push({ model, qty, division, airline: null });
        }
    }
    return { isListing: items.length > 0, soldOut: isSoldText(text) || struckThrough(text), items };
}

// ---- AI reader --------------------------------------------------------------------------------------------------
const SYSTEM = (divisions) => `You read aircraft listings posted in a Discord channel of an Airline Manager game community. Players post aircraft they offer to others (first come, first served).
For each post, extract every aircraft line: the aircraft model (as written, e.g. "A320neo", "B737-800", "ATR 72-600"), the quantity offered (a number, or null if not stated), the division if stated (exactly one of: ${divisions.join(', ')}; or null), and the airline name if stated (or null).
A post can offer aircraft in several divisions. Then give one item per model AND division, each with the quantity offered in that division (e.g. "A320neo: Kyra 5, Aegis 3" gives two items: A320neo 5 Kyra, A320neo 3 Aegis). Never put two divisions in one item. Headings like "Kyra:" apply to the lines under them.
Also say whether the post is an aircraft listing at all (isListing: false for chat, questions, rules, thanks), and whether it says the listing is sold out / all gone / closed (soldOut).
Answer with JSON only: {"posts":[{"id":"<post id>","isListing":true,"soldOut":false,"items":[{"model":"","qty":0,"division":null,"airline":null}]}]}`;

async function aiParse(posts, divisions) {
    const user = posts.map((p) => `--- post id ${p.id}${p.airlines.length ? ` (poster's airlines: ${p.airlines.map((a) => `${a.name} [${a.alliance}]`).join(', ')})` : ''}\n${p.content.slice(0, 1500)}`).join('\n\n');
    const res = await fetch(AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
        body: JSON.stringify({
            model: AI_MODEL, temperature: 0, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: SYSTEM(divisions) }, { role: 'user', content: user }]
        }),
        signal: AbortSignal.timeout(20e3)
    });
    if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const out = new Map();
    for (const p of Array.isArray(parsed?.posts) ? parsed.posts : []) out.set(String(p.id), p);
    return out;
}

// Cleans one post's result: known models only, known divisions only, and the division filled in from the
// poster's airlines (the airline named in the post, else their only division).
function finish(result, post, divisions) {
    const known = new Map(divisions.map((d) => [d.toLowerCase(), d]));
    const own = post.airlines;
    const ownDivisions = [...new Set(own.map((a) => a.alliance))];
    const findAirline = (name) => {
        const n = norm(name);
        if (!n) return null;
        return own.find((a) => norm(a.name) === n) || own.find((a) => n.length >= 3 && (norm(a.name).includes(n) || n.includes(norm(a.name)))) || null;
    };
    const postAirline = own.find((a) => norm(post.content).includes(norm(a.name)) && norm(a.name).length >= 3) || null;
    const items = [];
    for (const it of Array.isArray(result?.items) ? result.items : []) {
        const model = matchModel(it?.model);
        if (!model) continue;
        const qty = Number.isFinite(Number(it.qty)) && Number(it.qty) > 0 ? Math.min(Math.round(Number(it.qty)), 5000) : null;
        const airline = findAirline(it.airline) || postAirline;
        // One division per line: "Kyra, Aegis" (or a list) from the model becomes one line per division.
        const stated = (Array.isArray(it.division) ? it.division : String(it.division || '').split(/[,/&+]|and/i))
            .map((d) => known.get(String(d).trim().toLowerCase())).filter(Boolean);
        const divs = stated.length ? [...new Set(stated)] : [airline?.alliance || (ownDivisions.length === 1 ? ownDivisions[0] : null)];
        for (const division of divs) items.push({ model, qty, division, airline: airline?.name || (it.airline ? String(it.airline).slice(0, 60) : null), matched: Boolean(airline) });
    }
    // Same model + division listed twice: add the quantities.
    const merged = [];
    for (const it of items) {
        const same = merged.find((m) => m.model === it.model && m.division === it.division && m.airline === it.airline);
        if (same) same.qty = same.qty != null && it.qty != null ? same.qty + it.qty : same.qty ?? it.qty;
        else merged.push(it);
    }
    return {
        isListing: Boolean(result?.isListing ?? merged.length) && merged.length > 0,
        soldOut: Boolean(result?.soldOut) || isSoldText(post.content) || struckThrough(post.content),
        items: merged
    };
}

// ---- Reading the channel ------------------------------------------------------------------------------------------
async function readChannel(since) {
    const messages = [];
    let before = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const r = await discordBot(`/channels/${FFA_CHANNEL_ID}/messages?limit=100${before ? `&before=${before}` : ''}`);
        if (!r.ok) {
            const why = r.status === 403 ? 'the bot is not allowed to read #ffa-listings (needs View Channel + Read Message History)'
                : r.status === 404 ? 'FFA_CHANNEL_ID is not a channel the bot can see' : `Discord answered ${r.status}`;
            throw Object.assign(new Error(why), { discord: r.status });
        }
        const list = Array.isArray(r.json) ? r.json : [];
        messages.push(...list);
        if (list.length < 100) break;
        before = list[list.length - 1].id;
        if (new Date(list[list.length - 1].timestamp).getTime() < since) break;
    }
    return messages.filter((m) => new Date(m.timestamp).getTime() >= since);
}

// Text of a message, including embeds (some players post through bots or with embeds).
const messageText = (m) => [m.content, ...(m.embeds || []).flatMap((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)])]
    .filter(Boolean).join('\n').trim();

export async function syncFfa({ force = false, now = Date.now() } = {}) {
    if (!FFA_AVAILABLE) return { skipped: 'not set up' };
    const state = await getSetting('ffa_sync', {}) || {};
    if (!force && state.at && now - new Date(state.at).getTime() < SYNC_MINUTES * 60e3) return { skipped: 'recent' };
    // Mark the check as started first, so visitors arriving at the same moment don't all read Discord.
    await setSetting('ffa_sync', { ...state, at: new Date(now).toISOString() }, 'ffa');

    const db = admin();
    const since = now - LISTING_DAYS * DAY;
    let messages;
    try {
        messages = await readChannel(since);
    } catch (err) {
        await setSetting('ffa_sync', { ...state, at: new Date(now).toISOString(), error: err.message, errorAt: new Date(now).toISOString() }, 'ffa');
        return { error: err.message };
    }
    const { data: alliances } = await db.from('alliances').select('name').order('sort_order');
    const divisions = (alliances || []).map((a) => a.name);
    const { data: stored, error } = await db.from('ffa_listings').select('id, content_hash, sold_at, sold_reason, parse_source, items, is_listing');
    if (error) throw error;
    const byId = new Map((stored || []).map((r) => [r.id, r]));

    const posts = messages.filter((m) => !m.author?.bot && (m.type === 0 || m.type === 19));
    const seen = new Set(posts.map((m) => m.id));
    // Sold-out replies from the poster.
    const soldByReply = new Map();
    for (const m of posts) {
        const target = m.message_reference?.message_id;
        const parent = target && posts.find((p) => p.id === target);
        if (parent && parent.author?.id === m.author?.id && isSoldText(messageText(m))) soldByReply.set(target, m.timestamp);
    }

    // Posters → their market accounts and airline profiles.
    const authorIds = [...new Set(posts.map((m) => m.author.id))];
    const { data: accounts } = authorIds.length ? await db.from('accounts').select('id, discord_id').in('discord_id', authorIds) : { data: [] };
    const accountOf = new Map((accounts || []).map((a) => [a.discord_id, a.id]));
    const accIds = [...accountOf.values()];
    const { data: airlines } = accIds.length ? await db.from('airlines').select('owner_id, name, alliance').in('owner_id', accIds) : { data: [] };
    const airlinesOf = new Map();
    for (const a of airlines || []) (airlinesOf.get(a.owner_id) || airlinesOf.set(a.owner_id, []).get(a.owner_id)).push(a);

    // Which posts need reading (new, or edited since).
    const work = [];
    const rows = [];
    for (const m of posts) {
        const replyTo = m.message_reference?.message_id;
        if (replyTo && posts.some((p) => p.id === replyTo) && !extractable(messageText(m))) continue;   // a reply, not a listing
        const content = messageText(m);
        if (!content) continue;
        const h = hash(content);
        const old = byId.get(m.id);
        const accountId = accountOf.get(m.author.id) || null;
        const post = { id: m.id, content, airlines: accountId ? airlinesOf.get(accountId) || [] : [] };
        const base = {
            id: m.id, channel_id: FFA_CHANNEL_ID, author_discord_id: m.author.id, account_id: accountId,
            author_name: m.member?.nick || m.author.global_name || m.author.username || 'player',
            author_avatar: m.author.avatar ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64` : null,
            content: content.slice(0, 4000), content_hash: h, posted_at: m.timestamp, edited_at: m.edited_timestamp || null
        };
        if (old && old.content_hash === h && old.parse_source !== 'basic-wait') {
            rows.push({ ...base, keep: true, old });
        } else {
            work.push(post);
            rows.push({ ...base, post });
        }
    }

    // Read new/edited posts: AI in batches, the basic reader for the rest.
    const results = new Map();
    let aiUsed = 0, aiError = null;
    if (FFA_AI) {
        for (let i = 0; i < work.length && aiUsed < AI_PER_SYNC; i += AI_BATCH) {
            const batch = work.slice(i, i + AI_BATCH);
            try {
                aiUsed++;
                const out = await aiParse(batch, divisions);
                for (const p of batch) if (out.has(p.id)) results.set(p.id, { r: finish(out.get(p.id), p, divisions), source: 'ai' });
            } catch (err) {
                aiError = err.message;
                console.warn('FFA AI failed:', err.message);
                break;
            }
        }
    }
    const nowIso = new Date(now).toISOString();
    const upserts = rows.map((row) => {
        const { keep, old, post, ...base } = row;
        let parsed;
        if (keep) parsed = { items: old.items, isListing: old.is_listing, source: old.parse_source };
        else {
            const hit = results.get(row.id);
            const r = hit?.r || finish(basicParse(post.content, divisions), post, divisions);
            // Read with the basic reader because the AI was busy: read again by the AI next time.
            const source = hit ? 'ai' : FFA_AI ? 'basic-wait' : 'basic';
            parsed = { items: r.items, isListing: r.isListing, source, soldOut: r.soldOut };
        }
        const soldNow = parsed.soldOut ?? (keep ? null : false);
        let sold_at = old?.sold_at || null, sold_reason = old?.sold_reason || null;
        if (soldByReply.has(row.id)) { sold_at ||= soldByReply.get(row.id); sold_reason = 'reply'; }
        else if (!keep && soldNow) { sold_at ||= nowIso; sold_reason = 'edited'; }
        else if (!keep && !soldNow && sold_reason === 'edited') { sold_at = null; sold_reason = null; }   // edited back
        return {
            ...base, items: parsed.items, is_listing: Boolean(parsed.isListing), parse_source: parsed.source,
            divisions: [...new Set((parsed.items || []).map((it) => it.division).filter(Boolean))],
            sold_at, sold_reason, parsed_at: keep ? undefined : nowIso, updated_at: nowIso
        };
    }).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));

    for (let i = 0; i < upserts.length; i += 200) {
        const { error: upErr } = await db.from('ffa_listings').upsert(upserts.slice(i, i + 200));
        if (upErr) throw upErr;
    }
    // Deleted posts and posts older than LISTING_DAYS days.
    const gone = (stored || []).map((r) => r.id).filter((id) => !seen.has(id));
    for (let i = 0; i < gone.length; i += 100) await db.from('ffa_listings').delete().in('id', gone.slice(i, i + 100));

    await setSetting('ffa_sync', { at: nowIso, ok: nowIso, posts: posts.length, read: work.length, ai: aiUsed, aiError, error: null }, 'ffa');
    return { posts: posts.length, read: work.length, ai: aiUsed, aiError, removed: gone.length };
}
// A reply that itself lists aircraft counts as a post of its own.
const extractable = (text) => basicParse(text, []).items.length > 0;

// Active listings for the buyer site: listings with at least one aircraft line, not sold out, younger than
// LISTING_DAYS days.
export async function activeListings({ now = Date.now() } = {}) {
    const since = new Date(now - LISTING_DAYS * DAY).toISOString();
    const { data, error } = await admin().from('ffa_listings')
        .select('id, author_name, author_avatar, account_id, content, posted_at, edited_at, items, divisions, parse_source')
        .eq('is_listing', true).is('sold_at', null).gte('posted_at', since).order('posted_at', { ascending: false }).limit(300);
    if (error) throw error;
    const guild = GUILD_IDS[0];
    // One web posting per division: a message offering aircraft in Kyra and Aegis becomes two postings, each with
    // only that division's lines and quantities (key = "<message id>:<division>"). Lines without a division
    // stay together in one posting.
    return (data || []).flatMap((l) => {
        const groups = new Map();
        for (const it of l.items || []) {
            const k = it.division || '';
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(it);
        }
        return [...groups].map(([division, items]) => ({
            ...l, key: `${l.id}:${division}`, division: division || null, divisions: division ? [division] : [], items,
            url: guild ? `https://discord.com/channels/${guild}/${FFA_CHANNEL_ID}/${l.id}` : null,
            expiresAt: new Date(new Date(l.posted_at).getTime() + LISTING_DAYS * DAY).toISOString()
        }));
    });
}

export const channelUrl = () => (GUILD_IDS[0] && FFA_CHANNEL_ID ? `https://discord.com/channels/${GUILD_IDS[0]}/${FFA_CHANNEL_ID}` : null);
