// POST /api/admin/community — admins (Market Admins, Lead Ambassadors, admins added by hand) and Community Managers.
// Body: { action, ... }
//   list                                   everything below, for the seller desk's Community tab
//   reward-grant  { discordId, tier: 1|2|3, reason, expiresAt (ISO date or null = never) }
//                 { discordId, tier: 0, extraB: 5, reason, expiresAt }   custom: $5B extra on top of their tier
//                 Raises a market user's daily budget (presets: Tier 1 $25B, Tier 2 $40B, Tier 3 $50B; custom
//                 extras add up). The reason is for admins only; the buyer gets a "thank you" pop-up (and a DM).
//                 Tier 3 is also automatic for server boosters, and Tier 1 / Tier 2 for DISCORD_TIER1_ROLE_ID /
//                 DISCORD_TIER2_ROLE_ID.
//   reward-revoke { id }
//   announce      { title, body }          a pop-up shown to every buyer (until deleted)
//   announce-delete { id }
//   watch-add     { discordId, reason }    alert list: orders from this Discord account warn the sellers
//                 ("be cautious, check with admins"). The reason is for admins only; the buyer never knows.
//   watch-remove  { id }
// None of these tables is readable from the browser except announcements: everything goes through here.
import {
    admin, handler, requireUser, requireActiveSeller, isStaff, accountName, body, cleanText, rateLimit, sendDM, syncDiscord,
    budgetFor, BUDGET_TIERS, BUYER_URL, EMBED_COLORS, HttpError
} from '../../lib/server.js';

const OPEN = ['PENDING', 'CLAIMED', 'PARTIAL'];
const discordIdOf = (v) => {
    const id = String(v || '').trim();
    // Same rule as moderation (lib/moderation.js resolveTarget); real IDs are 17–20 digits.
    if (!/^\d{5,25}$/.test(id)) throw new HttpError(400, 'A Discord user ID is a long number: right-click the user → Copy User ID.');
    return id;
};
const usdB = (n) => `$${n / 1e9}B`;

export default handler(['POST'], async (req, res) => {
    const account = await requireUser(req);
    const me = await requireActiveSeller(account);
    if (!isStaff(me)) throw new HttpError(403, 'Only admins, Lead Ambassadors and Community Managers can do this.');
    await rateLimit('community:' + account.id, 120, 600);
    const input = body(req);
    const db = admin();
    const by = { granted_by: account.id, granted_by_name: accountName(account) };
    const missingTable = (error) => error && ['42P01', 'PGRST205', 'PGRST204'].includes(error.code);
    const need = (error) => {
        if (missingTable(error)) throw new HttpError(503, 'This needs a database update: re-run supabase/schema.sql.');
        if (error) throw error;
    };

    switch (input.action) {
        case 'list': {
            const now = new Date().toISOString();
            const [rw, bo, rt, an, wl] = await Promise.all([
                db.from('budget_rewards').select('*').is('revoked_at', null).or(`expires_at.is.null,expires_at.gt.${now}`).order('created_at', { ascending: false }),
                db.from('accounts').select('id, discord_id, display_name, discord_username').eq('booster', true),
                db.from('accounts').select('discord_id, display_name, discord_username, role_tier').gt('role_tier', 0),
                db.from('announcements').select('*').order('created_at', { ascending: false }),
                db.from('watchlist').select('*').order('created_at', { ascending: false })
            ]);
            need(rw.error); need(an.error); need(wl.error);
            // Names for the Discord IDs, from their market accounts.
            const ids = [...new Set([...(rw.data || []), ...(wl.data || [])].map((r) => r.discord_id))];
            const { data: accts } = ids.length ? await db.from('accounts').select('discord_id, display_name, discord_username').in('discord_id', ids) : { data: [] };
            const nameOf = Object.fromEntries((accts || []).map((a) => [a.discord_id, accountName(a)]));
            return res.json({
                ok: true,
                tiers: BUDGET_TIERS,
                rewards: (rw.data || []).map((r) => ({ ...r, name: nameOf[r.discord_id] || null })),
                boosters: (bo.data || []).map((a) => ({ discord_id: a.discord_id, name: accountName(a) })),
                // Tier 1 / Tier 2 from Discord roles (empty until the roles are set up and people open the market).
                roleTiers: (rt.data || []).map((a) => ({ discord_id: a.discord_id, name: accountName(a), tier: a.role_tier })),
                announcements: an.data || [],
                watchlist: (wl.data || []).map((w) => ({ ...w, name: nameOf[w.discord_id] || null }))
            });
        }

        case 'reward-grant': {
            const discordId = discordIdOf(input.discordId);
            const tier = Number(input.tier);
            if (![0, 1, 2, 3].includes(tier)) throw new HttpError(400, 'Choose Tier 1, 2 or 3, or a custom extra amount.');
            const extra = tier === 0 ? Math.round(Number(input.extraB) * 1e9) : 0;
            if (tier === 0 && !(extra >= 1e8 && extra <= 1e12)) throw new HttpError(400, 'The custom extra amount must be between $0.1B and $1,000B.');
            const reason = cleanText(input.reason, 500);
            if (!reason) throw new HttpError(400, 'Write the reason (only admins see it).');
            let expiresAt = null;
            if (input.expiresAt) {
                const d = new Date(input.expiresAt);
                if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw new HttpError(400, 'The end date must be in the future (or choose "never").');
                expiresAt = d.toISOString();
            }
            const { data: buyer } = await db.from('accounts').select('*').eq('discord_id', discordId).maybeSingle();
            if (!buyer) throw new HttpError(404, "That Discord account isn't on the market yet: they need to sign in on the market website once.");
            const { data: reward, error } = await db.from('budget_rewards').insert({
                discord_id: discordId, tier, bonus_usd: extra, reason, expires_at: expiresAt, ...by
            }).select().single();
            if (error?.code === '23514' || error?.code === 'PGRST204') throw new HttpError(503, 'Custom rewards need a database update: re-run supabase/schema.sql.');
            need(error);
            const until = expiresAt ? ` until ${new Date(expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT/, '')}` : '';
            const now = await budgetFor(buyer);   // with every reward they have, this one included
            const dm = await sendDM(buyer, {
                title: '🎉 Your Echo Market daily budget was raised!',
                color: EMBED_COLORS.request,
                description: extra
                    ? `Congratulations, and thank you for being part of the Echo Alliances community! As a reward, you get **${usdB(extra)} extra** daily market budget${until}: your daily budget is now **${usdB(now.limit)}** (normally ${usdB(BUDGET_TIERS[0].limit)}).`
                    : `Thank you for your active dedication to the Echo Alliances community! As a thank-you, your daily market budget is now **${usdB(now.limit)}**${until} (normally ${usdB(BUDGET_TIERS[0].limit)}).`,
                url: BUYER_URL || undefined
            });
            return res.json({ ok: true, reward, dm });
        }

        case 'reward-revoke': {
            const { data, error } = await db.from('budget_rewards').update({ revoked_at: new Date().toISOString(), revoked_by_name: accountName(account) })
                .eq('id', Number(input.id) || 0).is('revoked_at', null).select();
            need(error);
            if (!data?.length) throw new HttpError(404, 'That reward was already ended.');
            return res.json({ ok: true });
        }

        case 'announce': {
            const text = cleanText(input.body, 1500);
            if (!text) throw new HttpError(400, 'Write the message first.');
            const { data, error } = await db.from('announcements').insert({
                title: cleanText(input.title, 100) || null, body: text, created_by: account.id, created_by_name: accountName(account)
            }).select().single();
            need(error);
            return res.json({ ok: true, announcement: data });
        }

        case 'announce-delete': {
            const { error } = await db.from('announcements').delete().eq('id', Number(input.id) || 0);
            need(error);
            return res.json({ ok: true });
        }

        case 'watch-add': {
            const discordId = discordIdOf(input.discordId);
            const reason = cleanText(input.reason, 500);
            if (!reason) throw new HttpError(400, 'Write the reason (only admins and Lead Ambassadors see it).');
            if (discordId === account.discord_id) throw new HttpError(400, "That's your own Discord ID.");
            const { data, error } = await db.from('watchlist').upsert({
                discord_id: discordId, reason, added_by: account.id, added_by_name: accountName(account), created_at: new Date().toISOString()
            }, { onConflict: 'discord_id' }).select().single();
            need(error);
            // Orders this person already has open get the warning too.
            const { data: open } = await db.from('orders').select('*').eq('buyer_discord_id', discordId).in('status', OPEN);
            for (const o of open || []) {
                await db.from('order_alerts').upsert({ order_id: o.id, discord_id: discordId });
                await syncDiscord(o, `⚠️ ${o.serial ? `#${o.serial} · ` : ''}${o.id}: buyer on the alert list`);
            }
            return res.json({ ok: true, entry: data, openOrders: (open || []).length });
        }

        case 'watch-remove': {
            const { data: entry } = await db.from('watchlist').select('*').eq('id', Number(input.id) || 0).maybeSingle();
            if (!entry) throw new HttpError(404, 'Not on the alert list.');
            const { error } = await db.from('watchlist').delete().eq('id', entry.id);
            need(error);
            // Take the warning off this person's open orders.
            const { data: open } = await db.from('orders').select('*').eq('buyer_discord_id', entry.discord_id).in('status', OPEN);
            for (const o of open || []) {
                await db.from('order_alerts').delete().eq('order_id', o.id);
                await syncDiscord(o, `${o.serial ? `#${o.serial} · ` : ''}${o.id}: alert removed`);
            }
            return res.json({ ok: true });
        }

        default:
            throw new HttpError(400, 'Unknown action.');
    }
});
