// Echo Market — seller desk.
// Sign-in is Discord via Supabase; access requires a row in public.sellers.
// Reads come straight from Supabase (RLS lets sellers see all orders);
// every change goes through /api/orders/:id so Discord stays in sync.
import {
    html, useState, useEffect, useMemo, useCallback, useRef, sb, isConfigured, CONFIG, api, store,
    signInWithDiscord, fmtUSD, fmtUSDShort, fmtDate, timeAgo, plural, STATUS, ACTIVE_STATUSES,
    StatusBadge, OrderStepper, ProgressBar, Icon, Toasts, toast, Modal, DialogHost, ask, Button, DiscordLogo, fmtDuration, toneClass,
    Spinner, EchoLoader, Avatar, EmptyState, NotConfigured, notifyBrowser, displayStatus, orderLines, ItemProgress,
    orderRef, OrderCode, greetingFor, orderAirlines, airlineNames, orderAlliances, deliverableTo,
    orderListValue, orderHelpers, deliveryShares, SellerShares, takeoverIn, TAKEOVER_HOURS, GuidedTour,
    t, tj, tx, useLang, LanguageMenu, greetingLine, setLang, savedLang
} from './ui.js';
import { GUIDE } from './guide.js';
// Languages: the seller screens follow the language menu; admin screens (Sellers, Moderation, Community) and the Alliances statistics
// stay in English, like the Echo Alliances site's admin pages.

// "Helping": this seller joined the order (take over) without being its main seller.
const isHelping = (order, userId) => orderHelpers(order).some((h) => h.seller_id === userId);
const MAX_HELPERS = 3;
// Other sellers may take over once the order has been taken this long without being fully delivered.
const canTakeOver = (order, userId, now = Date.now()) => ['CLAIMED', 'PARTIAL'].includes(order.status)
    && order.seller_id !== userId && !isHelping(order, userId) && orderHelpers(order).length < MAX_HELPERS && takeoverIn(order, now) === 0;
// Completed orders: the sellers who listed aircraft on it may remind the buyer to buy them (seller API: remind).
const deliveredOn = (order, userId) => order.status === 'FULFILLED' && deliveryShares(order).some((sh) => sh.sellerId === userId && sh.total > 0);
const REMIND_HOURS = 6;   // same as seller/api/orders/[orderId].js
// List price of what is still to deliver: roughly what the sellers pay to buy those aircraft new in-game.
const listStillToBuy = (order) => orderLines(order).reduce((sum, it) => sum + (Number(it.listPriceUSD) || 0) * Math.max(0, it.qty - it.filled), 0);

const LS_SELL_AS = 'echo_seller_airline_v2';
const CAUTION_TEXT = 'This buyer is on the alert list. Be cautious and check with the admins if necessary when taking this order.';
const LS_SELLER_TOUR = 'echo_seller_tour_done_v1:';   // + user id

// First-time walkthrough of the seller desk (same look as the buyer site's). Targets: data-tour="…".
// Step texts are English keys: GuidedTour shows them in the chosen language (tx).
const SELLER_TOUR = [
    { target: null, icon: 'store', title: (n) => (n ? t('Welcome to the seller desk, {name}!', { name: n }) : t('Welcome to the seller desk!')),
      text: 'A 30-second tour of how selling works. You can skip it any time.' },
    { target: 'tab-open', icon: 'inbox', title: () => t('1 · Open queue'),
      text: 'New orders land here (and ping the seller role on Discord). Use Sort and Filters to find the ones you want, then Take one, or Decline to leave it to the other sellers.' },
    { target: 'sellas', icon: 'building-2', title: () => t('2 · Sell as'),
      text: "Pick the airline you sell from. Sharing an alliance with the buyer's airline makes delivery easier." },
    { target: 'tab-mine', icon: 'truck', title: () => t('3 · Deliver'),
      text: 'List the aircraft in-game, then press Update delivery and record what you listed. Each order shows its list value: roughly what buying those aircraft new costs you.' },
    { target: 'tab-all', icon: 'users', title: () => t('4 · Help out'),
      get text() { return t('If an order is still unfinished {n} hours after it was taken, other sellers can Take over part of it. The buyer sees exactly who listed what.', { n: TAKEOVER_HOURS }); } },
    { target: 'account', icon: 'circle-user', title: () => t('5 · Your account'),
      text: 'Replay this tour, open the market or sign out here.' }
];

// Echo hierarchy (sellers.rank). Lead Ambassadors are admins; anyone else can be made admin by hand.
const RANK_LABEL = { lead: 'Lead Ambassador', ambassador: 'Ambassador', verified: 'Verified Seller', admin: 'Admin' };
// 'admin' = admin added by hand without any Discord seller role (black-and-white look); only shown while
// they really are an admin.
const rankOf = (row) => {
    const r = RANK_LABEL[row?.rank] ? row.rank : 'verified';
    return r === 'admin' && !(row.is_admin || row.isAdmin) ? 'verified' : r;
};
// "· admin" after the title, unless the title already says so.
const adminSuffix = (row) => ((row?.is_admin || row?.isAdmin) && !['lead', 'admin'].includes(rankOf(row)) ? ' · admin' : '');
// Effective admin, the same rule as the server's isAdminSeller().
// admin_now: what the last role check said (includes the Market Admin role).
const withAdmin = (row) => row && { ...row, is_admin: Boolean(row.admin_now ?? (row.is_admin || row.rank === 'lead' || row.market_admin)) };
const LS_MSG_SEEN = 'echo_seller_msg_seen_v1';   // order id → newest buyer message id this seller has seen
function RankBadge({ rank, admin }) {
    const c = window.ECHO_RANK_COLORS?.[rank] || {};
    return html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap"
        style=${{ color: c.text, backgroundColor: (c.soft || '#888') + '26', border: `1px solid ${(c.soft || '#888')}55` }}>
        ${RANK_LABEL[rank] || 'Seller'}${admin && !['lead', 'admin'].includes(rank) ? ' · admin' : ''}</span>`;
}
const PAGE_SIZES = [5, 10, 25, 50, 'all'];

// ---- sorting and filtering the order lists (remembered per device)
const LS_ORDER_VIEW = 'echo_seller_order_view_v1';
const LS_MEOW = 'echo_seller_meow_v1';   // false = no sound for new orders

// A soft "meow" when a new order comes in while the desk is open: sounds/meow.mp3, the first meow of
// visuals/meow.m4a, trimmed, with the background noise removed (ffmpeg afftdn + gate) and the volume evened out.
// Browsers only allow sound after the page has been clicked or tapped once, so the audio starts on the first tap.
let meowCtx = null;
let meowSound = null;   // the decoded clip (a promise until it has loaded)
let lastMeow = 0;
function audio() {
    if (!meowCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        meowCtx = new Ctx();
        meowSound = fetch('/sounds/meow.mp3').then((r) => r.arrayBuffer()).then((b) => meowCtx.decodeAudioData(b))
            .then((buf) => (meowSound = buf)).catch(() => (meowSound = null));
    }
    if (meowCtx.state === 'suspended') meowCtx.resume().catch(() => {});
    return meowCtx;
}
['pointerdown', 'keydown'].forEach((type) => window.addEventListener(type, () => { if (store.get(LS_MEOW, true)) audio(); }, { once: true, capture: true }));
async function playMeow() {
    if (!store.get(LS_MEOW, true) || Date.now() - lastMeow < 3000) return;   // several orders at once: one meow
    const ctx = audio();
    if (!ctx || ctx.state !== 'running') return;
    lastMeow = Date.now();
    const buf = await meowSound;
    if (!buf) return;
    const source = ctx.createBufferSource();
    const volume = ctx.createGain();
    source.buffer = buf;
    volume.gain.value = 0.7;
    source.connect(volume).connect(ctx.destination);
    source.start();
}
const ORDER_TABS = ['open', 'mine', 'all'];
const NO_FILTERS = { alliance: '', types: '', qtyMin: '', qtyMax: '', listMin: '', listMax: '', mineOnly: false, unreadOnly: false };
const typeCount = (o) => orderLines(o).length;
const sort = (label, fn) => ({ get label() { return t(label); }, fn });
const SORTS = {
    default: sort('Default order'),   // open queue: longest waiting first; other tabs: newest first
    'price-desc': sort('Price: high to low', (a, b) => b.total_usd - a.total_usd),
    'price-asc': sort('Price: low to high', (a, b) => a.total_usd - b.total_usd),
    'list-desc': sort('List value: high to low', (a, b) => orderListValue(b) - orderListValue(a)),
    'list-asc': sort('List value: low to high', (a, b) => orderListValue(a) - orderListValue(b)),
    'qty-desc': sort('Most aircraft', (a, b) => b.total_qty - a.total_qty),
    'qty-asc': sort('Fewest aircraft', (a, b) => a.total_qty - b.total_qty),
    'types-desc': sort('Most aircraft types', (a, b) => typeCount(b) - typeCount(a)),
    'types-asc': sort('Fewest aircraft types', (a, b) => typeCount(a) - typeCount(b)),
    newest: sort('Newest first', (a, b) => ms(b.created_at) - ms(a.created_at)),
    oldest: sort('Oldest first', (a, b) => ms(a.created_at) - ms(b.created_at))
};
const num = (v) => (String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// Does an order pass the filters? List value is entered in $ millions.
// mineOnly: orders this seller listed at least one aircraft on (as seller, after taking over, or before passing it on).
// unreadOnly: orders with buyer messages this seller hasn't read yet (not remembered between visits).
function passesFilters(o, f, userId, unreadOf) {
    if (f.unreadOnly && !(unreadOf?.(o.id) > 0)) return false;
    if (f.mineOnly && !deliveryShares(o).some((sh) => sh.sellerId === userId && sh.total > 0)) return false;
    if (f.alliance && !orderAlliances(o).includes(f.alliance)) return false;
    const types = typeCount(o);
    if (f.types === '3' ? types < 3 : f.types && types !== Number(f.types)) return false;
    const qMin = num(f.qtyMin), qMax = num(f.qtyMax), lMin = num(f.listMin), lMax = num(f.listMax);
    if (qMin != null && o.total_qty < qMin) return false;
    if (qMax != null && o.total_qty > qMax) return false;
    const listM = orderListValue(o) / 1e6;
    if (lMin != null && listM < lMin) return false;
    if (lMax != null && listM > lMax) return false;
    return true;
}
const activeFilterCount = (f) => Object.keys(NO_FILTERS).filter((k) => (typeof NO_FILTERS[k] === 'boolean' ? f[k] === true : String(f[k] ?? '').trim() !== '')).length;

// ---- order timing (status_changed_at / status_history are kept by the database)
const ms = (iso) => (iso ? new Date(iso).getTime() : null);
// When the order (last) entered the open queue: new orders, released and passed-on orders.
const queuedSince = (o) => {
    const history = Array.isArray(o.status_history) ? o.status_history : [];
    const lastPending = [...history].reverse().find((h) => h.status === 'PENDING');
    return (o.status === 'PENDING' ? ms(o.status_changed_at) : null) || ms(lastPending?.at) || ms(o.created_at);
};
function timing(o, now) {
    switch (o.status) {
        case 'PENDING': {
            const wait = now - queuedSince(o);
            return { tone: wait > 24 * 36e5 ? 'rose' : wait > 6 * 36e5 ? 'amber' : 'slate', text: t('Waiting {time}', { time: fmtDuration(wait) }) };
        }
        case 'CLAIMED':
        case 'PARTIAL': {
            const taken = ms(o.claimed_at);
            const waited = taken ? taken - queuedSince(o) : null;
            const withSeller = t('with seller {time}', { time: fmtDuration(now - (taken || ms(o.status_changed_at) || now)) });
            return { tone: 'slate', text: waited != null ? `${t('Taken after {time}', { time: fmtDuration(waited) })} · ${withSeller}` : withSeller };
        }
        case 'FULFILLED':
            return { tone: 'emerald', text: t('Done in {time}', { time: fmtDuration((ms(o.fulfilled_at) || ms(o.status_changed_at) || now) - ms(o.created_at)) }) };
        default:
            return { tone: 'slate', text: t('Closed after {time}', { time: fmtDuration((ms(o.status_changed_at) || now) - ms(o.created_at)) }) };
    }
}
function WaitChip({ order, now }) {
    const tm = timing(order, now);
    return html`<span className=${`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold whitespace-nowrap ${toneClass(tm.tone)}`}>
        <${Icon} name="timer" className="w-3 h-3" />${tm.text}</span>`;
}
// Flags and the alert-list CAUTION tag are solid pink (Tailwind's own pink, not the rank accent), so they stand
// out from the soft order tags around them: lighter = milder.
const flagMeta = (label, cls, icon) => ({ get label() { return t(label); }, cls, icon });
const FLAG_META = {
    NORMAL: flagMeta('Normal', 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10', 'shield-check'),
    SUSPICIOUS: flagMeta('Suspicious', 'text-slate-950 border-pink-400 bg-pink-400', 'flag'),
    BLACKLISTED: flagMeta('Blacklisted', 'text-[#fff] border-pink-600 bg-pink-600', 'ban')
};

function App() {
    useLang();   // re-render everything when the language changes
    const [authReady, setAuthReady] = useState(false);
    const [session, setSession] = useState(null);
    const [account, setAccount] = useState(null);
    const [seller, setSeller] = useState(undefined); // undefined = loading, null = not a seller
    const [airlines, setAirlines] = useState([]);
    const [orders, setOrders] = useState([]);
    const [flags, setFlags] = useState({});
    const [declines, setDeclines] = useState([]);      // [{ order_id, seller_id, seller_name, note }]
    const [teamSize, setTeamSize] = useState(1);        // active sellers
    const [messages, setMessages] = useState([]);       // order_messages (buyers ↔ seller team)
    const [reports, setReports] = useState([]);         // missing_reports (buyers: "my planes were taken")
    const [culprits, setCulprits] = useState([]);       // missing_report_culprits (who took them; sellers only)
    const [alerts, setAlerts] = useState({});           // order id → true: buyer is on the alert list (order_alerts)
    const [alertReasons, setAlertReasons] = useState({}); // admins only: discord id → reason
    const [msgSeen, setMsgSeen] = useState(() => store.get(LS_MSG_SEEN, {}));
    useEffect(() => { store.set(LS_MSG_SEEN, msgSeen); }, [msgSeen]);
    const [loading, setLoading] = useState(true);

    const [tab, setTab] = useState('open');
    const [tourOpen, setTourOpen] = useState(false);
    const [pageSize, setPageSize] = useState(5);   // every list starts at 5 (also after switching tabs)
    const [now, setNow] = useState(() => Date.now());   // ticks every minute so wait times stay current
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);
    useEffect(() => { setPageSize(5); }, [tab]);
    const [statusFilter, setStatusFilter] = useState('ALL');
    const [query, setQuery] = useState('');
    const [view, setView] = useState(() => {
        const v = store.get(LS_ORDER_VIEW, {});
        return { sort: SORTS[v.sort] ? v.sort : 'default', filters: { ...NO_FILTERS, ...(v.filters || {}) } };
    });
    useEffect(() => { store.set(LS_ORDER_VIEW, { ...view, filters: { ...view.filters, unreadOnly: false } }); }, [view]);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [sellAsId, setSellAsId] = useState(() => store.get(LS_SELL_AS, null));
    const [detailId, setDetailId] = useState(() => window.location.hash.replace('#', '') || null);
    const [modal, setModal] = useState(null); // { kind: 'claim'|'progress'|'flag', order }
    const [buyerOf, setBuyerOf] = useState(null); // order whose buyer's Discord info is open

    const userId = session?.user?.id;
    const roleChecked = useRef(false);   // seller role re-checked at least once per visit

    useEffect(() => {
        sb.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
        const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
        const onHash = () => setDetailId(window.location.hash.replace('#', '') || null);
        window.addEventListener('hashchange', onHash);
        return () => { sub.subscription.unsubscribe(); window.removeEventListener('hashchange', onHash); };
    }, []);
    useEffect(() => { if (sellAsId) store.set(LS_SELL_AS, sellAsId); }, [sellAsId]);

    const loadAll = useCallback(async () => {
        if (!userId) return;
        const [acc, sel] = await Promise.all([
            sb.from('accounts').select('*').eq('id', userId).maybeSingle(),
            sb.from('sellers').select('*').eq('user_id', userId).maybeSingle()
        ]);
        setAccount(acc.data || null);
        let me = sel.data?.active ? sel.data : null;
        // People with a seller role on Discord get in automatically (see api/enroll.js), and everyone's rank
        // (colour and title) follows the highest seller role on their Discord profile, also for people added
        // by hand. Not a seller yet (or switched off after losing the role): wait for the check.
        if (!sel.data || sel.data.active || sel.data.source === 'discord_role') {
            if (!me) {
                const r = await api('/api/enroll').catch(() => null);
                if (r?.changed && r.seller) {
                    const again = await sb.from('sellers').select('*').eq('user_id', userId).maybeSingle();
                    me = again.data?.active ? again.data : null;
                    if (me) toast(t("Welcome to the seller desk! You were added because you're a {rank} on Discord.", { rank: RANK_LABEL[rankOf(me)] }), 'success');
                }
            } else {
                // Once per visit (and every 30 minutes) the Discord role is checked again: rank (colour and title)
                // follows the highest seller role. Role sellers can only read orders while that check is under
                // an hour old, so only then does the desk wait for it (Discord can take a second or two);
                // otherwise the desk opens straight away and the check runs alongside.
                const age = me.role_checked_at ? Date.now() - new Date(me.role_checked_at).getTime() : Infinity;
                if (!roleChecked.current || (me.source === 'discord_role' && age > 30 * 60e3)) {
                    roleChecked.current = true;
                    const check = api('/api/enroll').catch(() => null);
                    if (me.source === 'discord_role' && age > 50 * 60e3) {
                        const r = await check;
                        if (r && !r.seller) me = null;
                        else if (r?.rank) me = { ...me, rank: r.rank, admin_now: r.admin };   // promoted or demoted on Discord
                    } else {
                        check.then((r) => {
                            if (r && !r.seller) { setSeller(null); return; }   // lost the seller role on Discord
                            if (!r?.rank) return;
                            setSeller((cur) => {
                                const next = cur && withAdmin({ ...cur, rank: r.rank, admin_now: r.admin });
                                if (next) window.setSellerTint?.(rankOf(next));
                                return next;
                            });
                        });
                    }
                }
            }
        }
        me = withAdmin(me);
        if (me) window.setSellerTint?.(rankOf(me));
        setSeller(me);
        if (!me) { setLoading(false); return; }
        const [ord, fl, air, dec, team, msg, rep, oal, cul] = await Promise.all([
            sb.from('orders').select('*').order('created_at', { ascending: false }).limit(1000),
            sb.from('order_flags').select('*'),
            sb.from('airlines').select('*').eq('owner_id', userId).order('created_at'),
            sb.from('order_declines').select('*'),
            sb.from('sellers').select('user_id').eq('active', true),
            sb.from('order_messages').select('*').order('created_at').limit(2000),
            sb.from('missing_reports').select('*').order('created_at').limit(1000),
            sb.from('order_alerts').select('order_id').limit(2000),
            sb.from('missing_report_culprits').select('*').order('created_at').limit(2000)
        ]);
        setCulprits(cul.data || []);   // (empty until schema.sql has the table)
        setAlerts(Object.fromEntries((oal.data || []).map((a) => [a.order_id, true])));
        // Admins and Lead Ambassadors also see why someone is on the alert list.
        if (me.is_admin) api('/api/admin/community', { action: 'list' })
            .then((r) => setAlertReasons(Object.fromEntries((r.watchlist || []).map((w) => [w.discord_id, w.reason])))).catch(() => {});
        setMessages(msg.data || []);
        setReports(rep.data || []);   // (empty until schema.sql has the table)
        setDeclines(dec.data || []);
        setTeamSize(Math.max(1, (team.data || []).length));
        if (ord.error) toast(t('Could not load orders: {msg}', { msg: ord.error.message }), 'error');
        setOrders(ord.data || []);
        setFlags(Object.fromEntries((fl.data || []).map((f) => [f.order_id, f])));
        setAirlines(air.data || []);
        setLoading(false);
    }, [userId]);

    useEffect(() => { if (userId) loadAll(); else { setSeller(undefined); setLoading(true); } }, [userId, loadAll]);

    // Live updates.
    useEffect(() => {
        if (!seller) return;
        const channel = sb.channel('seller-desk')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (p) => {
                if (p.eventType === 'DELETE') return setOrders((l) => l.filter((o) => o.id !== p.old.id));
                if (p.eventType === 'INSERT') {
                    playMeow();
                    toast(t('New order {ref} from {airline}', { ref: orderRef(p.new), airline: airlineNames(p.new) }), 'success');
                    notifyBrowser(t('New Echo Market order'), `${airlineNames(p.new)}: ${plural(p.new.total_qty, 'aircraft')}`);
                }
                setOrders((l) => [p.new, ...l.filter((o) => o.id !== p.new.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'order_declines' }, (p) => {
                setDeclines((l) => {
                    const key = (d) => d.order_id + '|' + d.seller_id;
                    const rest = l.filter((d) => key(d) !== key(p.eventType === 'DELETE' ? p.old : p.new));
                    return p.eventType === 'DELETE' ? rest : [...rest, p.new];
                });
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'order_alerts' }, (p) => {
                if (p.eventType === 'DELETE') setAlerts((a) => { const n = { ...a }; delete n[p.old.order_id]; return n; });
                else if (p.new?.order_id) setAlerts((a) => ({ ...a, [p.new.order_id]: true }));
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'missing_reports' }, (p) => {
                if (!p.new?.id) return;
                setReports((l) => [...l.filter((r) => r.id !== p.new.id), p.new]);
                if (p.eventType === 'INSERT') {
                    toast(t('🚨 Missing planes reported on {ref}', { ref: p.new.order_id }), 'error');
                    notifyBrowser(t('Missing planes reported'), `${p.new.buyer_name || t('A buyer')}: ${p.new.details}`, p.new.order_id);
                }
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'missing_report_culprits' }, (p) => {
                if (p.eventType === 'DELETE') return setCulprits((l) => l.filter((c) => c.id !== p.old.id));
                if (p.new?.id) setCulprits((l) => [...l.filter((c) => c.id !== p.new.id), p.new]);
            })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_messages' }, (p) => {
                setMessages((l) => [...l.filter((m) => m.id !== p.new.id), p.new]);
                if (p.new.from_role === 'buyer') {
                    toast(t('💬 New message from the buyer of {ref}', { ref: p.new.order_id }), 'info');
                    notifyBrowser(t('Echo Market: buyer message'), p.new.body.slice(0, 120), 'om' + p.new.id);
                }
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'order_flags' }, (p) => {
                setFlags((f) => {
                    const next = { ...f };
                    if (p.eventType === 'DELETE') delete next[p.old.order_id]; else next[p.new.order_id] = p.new;
                    return next;
                });
            })
            .subscribe();
        const onVisible = () => { if (document.visibilityState === 'visible') loadAll(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { sb.removeChannel(channel); document.removeEventListener('visibilitychange', onVisible); };
    }, [seller, loadAll]);

    const sellAs = airlines.find((a) => a.id === sellAsId) || airlines[0] || null;
    // First visit to the seller desk: the short tour (once per seller, per device).
    useEffect(() => {
        if (seller && userId && !store.get(LS_SELLER_TOUR + userId, false)) setTourOpen(true);
    }, [Boolean(seller), userId]);
    const endTour = () => { setTourOpen(false); if (userId) store.set(LS_SELLER_TOUR + userId, true); };
    const messagesOf = (orderId) => messages.filter((m) => m.order_id === orderId);
    const reportsOf = (orderId) => reports.filter((r) => r.order_id === orderId);
    const culpritsByReport = useMemo(() => {
        const by = {};
        for (const c of culprits) (by[c.report_id] ||= []).push(c);
        return by;
    }, [culprits]);
    const onReport = (r) => setReports((l) => [...l.filter((x) => x.id !== r.id), r]);
    // After naming culprits: fetch that report's list now (realtime also brings it, a moment later).
    const refreshCulprits = async (reportId) => {
        const { data } = await sb.from('missing_report_culprits').select('*').eq('report_id', reportId);
        if (data) setCulprits((l) => [...l.filter((c) => c.report_id !== reportId), ...data]);
    };
    // Confirmed thefts whose culprit is still "under investigation".
    const investigating = reports.filter((r) => r.status === 'CONFIRMED' && r.investigating);
    // Open reports this seller should check: on orders they delivered (now or earlier), or all of them for admins.
    const onOrder = (o) => deliveryShares(o).some((sh) => sh.sellerId === userId);
    const reportsToCheck = reports.filter((r) => r.status === 'OPEN')
        .map((r) => ({ r, o: orders.find((o) => o.id === r.order_id) }))
        .filter(({ o }) => o && (seller?.is_admin || onOrder(o)));
    const unreadOf = (orderId) => messagesOf(orderId).filter((m) => m.from_role === 'buyer' && m.id > (msgSeen[orderId] || 0)).length;
    const markSeen = (orderId) => {
        const newest = Math.max(0, ...messagesOf(orderId).map((m) => m.id));
        if (newest > (msgSeen[orderId] || 0)) setMsgSeen((m) => ({ ...m, [orderId]: newest }));
    };
    const passedOn = (order) => declines.filter((d) => d.order_id === order.id);
    const iPassed = (order) => passedOn(order).some((d) => d.seller_id === userId);
    // Sellers who could still take the order if I pass on it now.
    const othersLeft = (order) => teamSize - passedOn(order).filter((d) => d.seller_id !== userId).length - 1;
    const replaceOrder = (o) => setOrders((l) => l.map((x) => (x.id === o.id ? o : x)));
    const act = async (order, payload, success) => {
        try {
            const res = await api(`/api/orders/${order.id}`, payload);
            if (res.order) replaceOrder(res.order);
            if (payload.action === 'decline' && res.declinedForEveryone === false) {
                setDeclines((l) => [...l.filter((d) => !(d.order_id === order.id && d.seller_id === userId)),
                    { order_id: order.id, seller_id: userId, seller_name: account?.display_name, note: payload.reason || null }]);
            }
            if (payload.action === 'claim') setDeclines((l) => l.filter((d) => !(d.order_id === order.id && d.seller_id === userId)));
            if (payload.action === 'delete') { setOrders((l) => l.filter((o) => o.id !== order.id)); closeDetail(); }
            if (payload.action === 'flag') setFlags((f) => ({ ...f, [order.id]: { order_id: order.id, status: payload.flagStatus, reason: payload.flagReason, flagged_by: account?.display_name } }));
            if (success) toast(typeof success === 'function' ? success(res) : success, 'success');
            return true;
        } catch (err) {
            toast(err.message, 'error');
            if (/changed|taken|closed/i.test(err.message)) loadAll();
            return false;
        }
    };
    const openDetail = (id) => { window.location.hash = id; };
    // "💬 2 orders with new buyer messages" → All orders, only those, right away.
    const showUnread = () => {
        setTab('all'); setStatusFilter('ALL'); setQuery('');
        setView((v) => ({ ...v, filters: { ...NO_FILTERS, unreadOnly: true } }));
        setTimeout(() => document.getElementById('order-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };
    const closeDetail = () => { history.replaceState(null, '', window.location.pathname); setDetailId(null); };

    const actions = {
        claim: (order) => {
            if (!airlines.length) return toast(t("Create an airline profile on the market's Airlines page first — buyers see which airline is selling to them."), 'error');
            setModal({ kind: 'claim', order });
        },
        progress: (order) => setModal({ kind: 'progress', order }),
        join: (order) => {
            if (!airlines.length) return toast(t("Create an airline profile on the market's Airlines page first — buyers see which airline is selling to them."), 'error');
            setModal({ kind: 'join', order });
        },
        flag: (order) => setModal({ kind: 'flag', order }),
        remind: (order) => setModal({ kind: 'remind', order }),
        release: async (order) => {
            const left = order.total_qty - order.filled;
            if (order.seller_id !== userId && isHelping(order, userId)) {
                const mineNow = deliveryShares(order).find((sh) => sh.role === 'helper' && sh.sellerId === userId)?.total || 0;
                const ok = await ask({ title: t('Stop delivering {ref}?', { ref: orderRef(order) }), confirmLabel: t('Stop delivering'),
                    message: mineNow ? t("The {n} aircraft you listed stay counted as yours. The order's seller carries on with the rest.", { n: mineNow }) : t("The order's seller carries on with the rest.") });
                if (ok) act(order, { action: 'release' }, t('You stopped delivering {ref}.', { ref: orderRef(order) }));
                return;
            }
            if (orderHelpers(order).length) {
                const next = orderHelpers(order)[0];
                const ok = await ask({ title: t('Hand {ref} to {airline}?', { ref: orderRef(order), airline: next.seller_airline_name }), confirmLabel: t('Hand over'),
                    message: t("What you listed stays counted as yours. {airline} (who took over part of it) becomes the order's seller and carries on with the rest.", { airline: next.seller_airline_name }) });
                if (ok) act(order, { action: 'release' }, t('{airline} now handles {ref}.', { airline: next.seller_airline_name, ref: orderRef(order) }));
                return;
            }
            const ok = order.filled > 0
                ? await ask({ title: t('Pass on the rest of {ref}?', { ref: orderRef(order) }), confirmLabel: t('Pass on the rest'),
                    message: t('{filled} of {total} aircraft are delivered and stay counted. The remaining {left} go back to the open queue as "partly delivered" for another seller to finish. The buyer is told.', { filled: order.filled, total: order.total_qty, left }) })
                : await ask({ title: t('Release {ref}?', { ref: orderRef(order) }), confirmLabel: t('Release order'),
                    message: t('It goes back to the open queue for another seller. The buyer is told it is waiting again.') });
            if (ok) act(order, { action: 'release' }, order.filled > 0 ? t('The remaining {n} aircraft are back in the open queue.', { n: left }) : t('{ref} is back in the open queue.', { ref: orderRef(order) }));
        },
        decline: async (order) => {
            const left = othersLeft(order);
            if (left > 0) {
                const note = await ask({
                    title: t('Pass on {ref}?', { ref: orderRef(order) }), confirmLabel: t('Pass'),
                    message: t('It disappears from your open queue but stays open for the other {count}. The buyer is not told. The order is only declined if every seller passes.', { count: plural(left, 'seller') }),
                    input: { required: false, placeholder: t('Optional note for the other sellers (e.g. price too low for me)') }
                });
                if (note === false) return;
                act(order, { action: 'decline', reason: note || '' }, (r) => r.declinedForEveryone ? t('{ref} declined.', { ref: orderRef(order) }) : t('You passed on {ref}. {count} can still take it.', { ref: orderRef(order), count: plural(r.sellersLeft, 'seller') }));
            } else {
                const reason = await ask({
                    title: t('Decline {ref} for good?', { ref: orderRef(order) }), danger: true, confirmLabel: t('Decline order'),
                    message: t('Every other seller has already passed, so declining closes the order. The buyer will see your reason. This cannot be undone.'),
                    input: { required: true, placeholder: t('e.g. Price level too low for this type right now') }
                });
                if (reason) act(order, { action: 'decline', reason }, t('{ref} declined.', { ref: orderRef(order) }));
            }
        },
        forceDecline: async (order) => {
            const reason = await ask({
                title: t('Decline {ref} for everyone?', { ref: orderRef(order) }), danger: true, confirmLabel: t('Decline for everyone'),
                message: t('Admin action: closes the order for the whole seller team right away (for spam or rule breaks). The buyer will see your reason.'),
                input: { required: true, placeholder: t('Reason shown to the buyer') }
            });
            if (reason) act(order, { action: 'decline', reason, force: true }, t('{ref} declined for everyone.', { ref: orderRef(order) }));
        },
        remove: async (order) => {
            if (await ask({ title: t('Delete {ref}?', { ref: orderRef(order) }), message: t('This permanently removes the order and its history for everyone, including the buyer. Prefer "Decline" unless this is spam.'), confirmLabel: t('Delete forever'), danger: true })) {
                act(order, { action: 'delete' }, t('{ref} deleted.', { ref: orderRef(order) }));
            }
        }
    };

    if (!authReady) return html`<${EchoLoader} full />`;
    if (!session) return html`<${SignInScreen} />`;
    if (seller === undefined) return html`<${EchoLoader} full />`;
    if (!seller) return html`<${NotASeller} account=${account} />`;
    // Every seller goes through the sellers' welcome once ("A new era begins"). Older databases: no column, no redirect.
    if ('welcome_done_at' in seller && !seller.welcome_done_at) {
        window.location.replace('/welcome.html');
        return html`<${EchoLoader} full />`;
    }

    // ---- filtering
    const q = query.trim().toLowerCase();
    const matches = (o) => !q || [o.id, o.serial ? '#' + o.serial : '', ...orderAirlines(o).flatMap((a) => [a.name, a.alliance]), o.buyer_name, o.seller_airline_name, o.buyer_note, o.seller_note,
        ...(o.items || []).map((i) => i.model)].join(' ').toLowerCase().includes(q);
    const tabs = {
        open: { label: t('Open queue'), icon: 'inbox', fn: (o) => o.status === 'PENDING' && !iPassed(o) },
        mine: { label: t('My orders'), icon: 'briefcase', fn: (o) => (o.seller_id === userId || isHelping(o, userId)) && ['CLAIMED', 'PARTIAL'].includes(o.status) },
        all: { label: t('All orders'), icon: 'list', fn: (o) => statusFilter === 'ALL' || o.status === statusFilter },
        thefts: { label: t('Theft reports'), icon: 'shield-alert', fn: () => false },   // every seller
        alliances: { label: t('Alliances'), icon: 'chart-column', fn: () => false },     // every seller
        // Admins only: seller performance and alliance statistics (the API refuses everyone else too).
        ...(seller.is_admin ? { team: { label: 'Sellers', icon: 'trophy', fn: () => false },
                                mod: { label: 'Moderation', icon: 'shield', fn: () => false },
                                community: { label: 'Community', icon: 'sparkles', fn: () => false } } : {})
    };
    if (!tabs[tab]) setTimeout(() => setTab('open'));
    const counts = {
        open: orders.filter(tabs.open.fn).length,
        mine: orders.filter(tabs.mine.fn).length,
        all: orders.length
    };
    const inTab = orders.filter((o) => (tabs[tab] || tabs.open).fn(o) && matches(o));
    const list = inTab.filter((o) => passesFilters(o, view.filters, userId, unreadOf));
    // Default: open queue longest-waiting first, other tabs newest first. Or the seller's chosen sort.
    if (SORTS[view.sort]?.fn) list.sort(SORTS[view.sort].fn);
    else if (tab === 'open') list.sort((a, b) => queuedSince(a) - queuedSince(b));
    const orderTab = ORDER_TABS.includes(tab);
    const filterCount = activeFilterCount(view.filters);
    const allianceOptions = [...new Set(orders.flatMap((o) => orderAlliances(o)))].filter(Boolean).sort();
    // Every order list: the first 5, the rest behind "Show more" / 10 / 25 / 50 / All.
    const paged = pageSize !== 'all' ? list.slice(0, pageSize) : list;
    const detail = orders.find((o) => o.id === detailId);

    return html`<div className="min-h-screen pb-12">
        <header className="sticky top-0 z-40 bg-page/85 backdrop-blur border-b border-slate-800/80">
            <div className="max-w-6xl mx-auto px-4 md:px-6 h-14 md:h-16 flex items-center gap-3">
                <img src="echo_logo.png" alt="" className="w-8 h-8 rounded-lg" />
                <div className="leading-tight">
                    <p className="font-extrabold text-white">${t('Seller desk')}</p>
                    <p className="text-[11px] text-sky-300">${RANK_LABEL[rankOf(seller)]}${adminSuffix(seller)}</p>
                </div>
                <div className="flex-1"></div>
                <${SellAsPicker} airlines=${airlines} sellAs=${sellAs} onChange=${setSellAsId} />
                <${LanguageMenu} packs=${['app']} />
                <a href=${CONFIG.BUYER_URL || "#"} className="hidden sm:flex p-2.5 rounded-full text-slate-400 hover:bg-slate-800 hover:text-white" title=${t('Open the market')}><${Icon} name="shopping-bag" className="w-5 h-5" /></a>
                <${AccountMenu} account=${account} seller=${seller} airlines=${airlines} sellAs=${sellAs} onSellAs=${setSellAsId} onTour=${() => setTourOpen(true)} />
            </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 md:px-6 pt-4 md:pt-6 space-y-4 md:space-y-5">
            <${SellerGreeting} account=${account} now=${now} open=${orders.filter(tabs.open.fn)} mine=${counts.mine}
                unreadOrders=${orders.filter((o) => unreadOf(o.id) > 0).length} onShowUnread=${showUnread} />
            <${CupBanner} userId=${userId} />
            <${OrderTabButtons} tab=${tab} setTab=${setTab} tabs=${tabs} counts=${counts} />
            <${AdminShortcuts} tab=${tab} setTab=${setTab} isAdmin=${seller.is_admin}
                theftHint=${investigating.length ? t('{n} under investigation', { n: investigating.length }) : reportsToCheck.length ? t('{n} to check', { n: reportsToCheck.length }) : ''} />
            ${reportsToCheck.length > 0 && html`<div className="p-4 rounded-2xl border border-rose-500/40 bg-rose-500/[0.07] space-y-2">
                <p className="font-extrabold text-white flex items-center gap-2"><${Icon} name="shield-alert" className="w-5 h-5 text-rose-300" />
                    ${t('{count} to check in-game', { count: plural(reportsToCheck.length, 'missing-plane report') })}</p>
                <ul className="space-y-1.5">${reportsToCheck.map(({ r, o }) => html`<li key=${r.id}>
                    <button onClick=${() => openDetail(o.id)} className="w-full text-left text-sm text-rose-100 hover:text-white flex flex-wrap gap-x-2">
                        <b>${orderRef(o)}</b><span className="opacity-80">${r.buyer_name}: “${r.details}”</span><span className="text-xs opacity-60">${timeAgo(r.created_at)}</span>
                    </button></li>`)}</ul>
            </div>`}
            ${!airlines.length && html`<div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-2xl border border-amber-500/30 bg-amber-500/5">
                <${Icon} name="triangle-alert" className="w-5 h-5 text-amber-300" />
                <p className="flex-1 text-sm text-amber-100"><b>${t('You need an airline profile to take orders.')}</b> ${t("Buyers see which airline is selling to them. Create one on the market site's Airlines page (same Discord login), then come back.")}</p>
                <a href=${(CONFIG.BUYER_URL || "") + "/#airlines"}><${Button} size="sm" variant="white">${t('Create airline')}<//></a>
            </div>`}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
                <${Stat} label=${t('Waiting for a seller')} value=${counts.open} icon="inbox" tone="text-amber-300" />
                <${Stat} label=${t('My active orders')} value=${counts.mine} icon="briefcase" tone="text-sky-400" />
                <${Stat} label=${t('In delivery (all sellers)')} value=${orders.filter((o) => ['CLAIMED', 'PARTIAL'].includes(o.status)).length} icon="truck" tone="text-violet-300" />
                <${Stat} label=${t('Delivered')} value=${orders.filter((o) => o.status === 'FULFILLED').length} icon="circle-check" tone="text-emerald-300" />
            </div>

            <div id="order-list" className="flex flex-col lg:flex-row gap-2 lg:items-center scroll-mt-20">
                <div className="hidden md:flex p-1 rounded-full bg-slate-900 border border-slate-800 overflow-x-auto no-scrollbar">
                    ${ORDER_TABS.map((k) => html`<button key=${k} onClick=${() => setTab(k)} data-tour=${'tab-' + k}
                        className=${`shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold ${tab === k ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>
                        <${Icon} name=${tabs[k].icon} className="w-3.5 h-3.5" />${tabs[k].label}<span className="opacity-60">${counts[k]}</span>
                    </button>`)}
                </div>
                ${orderTab && html`<div className="flex flex-1 flex-wrap sm:flex-nowrap gap-2">
                    <label className="relative flex-1 min-w-[12rem]">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"><${Icon} name="search" /></span>
                        <input value=${query} onChange=${(e) => setQuery(e.target.value)} placeholder=${t('Search order, airline, buyer, aircraft…')} className="input pl-10" />
                    </label>
                    <select value=${view.sort} onChange=${(e) => setView((v) => ({ ...v, sort: e.target.value }))} className="input !w-auto" aria-label=${t('Sort orders')}>
                        ${Object.entries(SORTS).map(([k, s]) => html`<option key=${k} value=${k}>${k === 'default' ? (tab === 'open' ? t('Longest waiting first') : t('Newest first')) : s.label}</option>`)}
                    </select>
                    <${Button} size="md" variant=${filterCount ? 'primary' : 'secondary'} icon="sliders-horizontal" onClick=${() => setFiltersOpen(!filtersOpen)}
                        aria-expanded=${filtersOpen}>${t('Filters')}${filterCount ? ` · ${filterCount}` : ''}<//>
                </div>`}
            </div>
            ${orderTab && (filtersOpen || filterCount > 0) && html`<${OrderFilters} filters=${view.filters} alliances=${allianceOptions} tab=${tab}
                statusFilter=${statusFilter} setStatusFilter=${setStatusFilter} open=${filtersOpen}
                onChange=${(filters) => setView((v) => ({ ...v, filters }))} onToggle=${() => setFiltersOpen(!filtersOpen)}
                shown=${list.length} total=${inTab.length} />`}
            ${orderTab && tab === 'all' && !filtersOpen && html`<div className="flex items-center gap-2 -mt-1">
                <span className="text-xs text-slate-500 shrink-0">${t('Status')}</span>
                <select value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)} className="input !py-1.5 !w-auto min-w-0 text-xs">
                    <option value="ALL">${t('Any status')}</option>
                    ${Object.entries(STATUS).map(([k, m]) => html`<option key=${k} value=${k}>${m.label}</option>`)}
                </select>
            </div>`}

            ${tab === 'thefts' ? html`<${TheftsView} reports=${reports} orders=${orders} culpritsByReport=${culpritsByReport} seller=${seller} userId=${userId}
                onOpenOrder=${openDetail} onReport=${onReport} onCulprits=${refreshCulprits} />`
            : tab === 'community' && seller.is_admin ? html`<${CommunityView} onAlertsChanged=${(list) => setAlertReasons(Object.fromEntries(list.map((w) => [w.discord_id, w.reason])))} />`
            : tab === 'mod' && seller.is_admin ? html`<${ModerationView} userId=${userId} />`
            : tab === 'team' && seller.is_admin ? html`<${SellersTab} userId=${userId} onOpenOrder=${openDetail} />`
            : tab === 'alliances' ? html`<${AllianceStats} />`
            : loading ? html`<${EchoLoader} className="py-16" />`
            : !list.length ? html`<${EmptyState} icon=${tab === 'open' ? 'party-popper' : 'inbox'}
                title=${inTab.length && filterCount ? 'No orders match your filters' : tab === 'open' ? 'Queue is empty' : tab === 'mine' ? 'You have no active orders' : 'No orders found'}
                text=${inTab.length && filterCount ? t('{count} hidden by your filters. Change or clear them to see more.', { count: plural(inTab.length, 'order') })
                    : tab === 'open' ? 'New orders appear here instantly (and on Discord). Orders you passed on are under All orders.' : tab === 'mine' ? 'Take one from the open queue.' : 'Try a different search or status.'} />`
            : html`<div className="space-y-2">${paged.map((o) => html`<${OrderRow} key=${o.id} order=${o} flag=${flags[o.id]} userId=${userId} airlines=${airlines}
                passed=${passedOn(o)} teamSize=${teamSize} now=${now} onBuyer=${setBuyerOf} unread=${unreadOf(o.id)} caution=${alerts[o.id]} missing=${reportsOf(o.id).filter((r) => r.status === 'OPEN').length}
                seller=${seller} actions=${actions} onOpen=${() => openDetail(o.id)} />`)}
                ${list.length > 5 && html`<${PageSizeBar} total=${list.length} shown=${paged.length} pageSize=${pageSize} setPageSize=${setPageSize} />`}
            </div>`}
        </main>

        ${detail && html`<${OrderDetail} order=${detail} flag=${flags[detail.id]} userId=${userId} seller=${seller} airlines=${airlines} now=${now}
            passed=${passedOn(detail)} teamSize=${teamSize} onBuyer=${setBuyerOf}
            messages=${messagesOf(detail.id)} onSeen=${() => markSeen(detail.id)} reports=${reportsOf(detail.id)}
            caution=${alerts[detail.id]} cautionReason=${alertReasons[detail.buyer_discord_id]}
            culpritsByReport=${culpritsByReport} onReport=${onReport} onCulprits=${refreshCulprits}
            onMessage=${(m) => setMessages((l) => [...l.filter((x) => x.id !== m.id), m])}
            actions=${actions} onClose=${closeDetail} />`}
        ${buyerOf && html`<${BuyerModal} order=${buyerOf} orders=${orders} flags=${flags} isAdmin=${seller.is_admin} onClose=${() => setBuyerOf(null)}
            onOpenOrder=${(id) => { setBuyerOf(null); openDetail(id); }} />`}
        ${detailId && !detail && !loading && html`<${Modal} open=${true} onClose=${closeDetail} title=${t('Order not found')} size="sm">
            <p className="text-sm text-slate-400">${t("{ref} doesn't exist or was deleted.", { ref: detailId })}</p><//>`}

        ${modal?.kind === 'claim' && html`<${ClaimModal} order=${modal.order} airlines=${airlines} sellAs=${sellAs} caution=${alerts[modal.order.id]}
            onClose=${() => setModal(null)}
            onConfirm=${async (airlineId) => {
                setSellAsId(airlineId);
                const ok = await act(modal.order, { action: 'claim', airlineId }, t('You took {ref}. The buyer has been notified.', { ref: orderRef(modal.order) }));
                if (ok) { setModal(null); setTab('mine'); }
            }} />`}
        ${modal?.kind === 'join' && html`<${ClaimModal} order=${modal.order} airlines=${airlines} sellAs=${sellAs} join=${true} caution=${alerts[modal.order.id]}
            onClose=${() => setModal(null)}
            onConfirm=${async (airlineId) => {
                setSellAsId(airlineId);
                const ok = await act(modal.order, { action: 'join', airlineId }, t('You took over part of {ref}. The buyer is told you will also be delivering.', { ref: orderRef(modal.order) }));
                if (ok) { setModal(null); setTab('mine'); }
            }} />`}
        ${modal?.kind === 'progress' && html`<${ProgressModal} order=${modal.order} userId=${userId} onClose=${() => setModal(null)}
            onSave=${async (payload) => {
                let ok = true;
                if (payload.changed || payload.note) ok = await act(modal.order, { action: 'progress', mine: payload.mine, note: payload.note });
                if (ok && payload.sellerNote !== undefined && payload.sellerNote !== (modal.order.seller_note || '')) ok = await act(modal.order, { action: 'note', sellerNote: payload.sellerNote });
                if (ok) { setModal(null); toast(t('{ref} updated.', { ref: orderRef(modal.order) }), 'success'); }
            }} />`}
        ${modal?.kind === 'remind' && html`<${RemindModal} order=${modal.order} onClose=${() => setModal(null)}
            onSend=${async (note) => {
                const ok = await act(modal.order, { action: 'remind', note }, (r) => (r.dm === 'sent'
                    ? t('Reminder sent. The buyer sees it on Echo Market and got a Discord DM.')
                    : t("Reminder sent on Echo Market. The Discord DM couldn't be delivered (DMs off or closed).")));
                if (ok) setModal(null);
            }} />`}
        ${modal?.kind === 'flag' && html`<${FlagModal} order=${modal.order} flag=${flags[modal.order.id]} onClose=${() => setModal(null)}
            onSave=${async (flagStatus, flagReason) => {
                if (await act(modal.order, { action: 'flag', flagStatus, flagReason }, t('Flag saved.'))) setModal(null);
            }} />`}

        ${tourOpen && html`<${GuidedTour} steps=${SELLER_TOUR} label=${t('Seller desk tour')} name=${account?.display_name || account?.discord_username || ''}
            finishLabel=${t('Start selling')} finishIcon="check" onDone=${() => { endTour(); setTab('open'); }} />`}
        <${Toasts} />
        <${DialogHost} />
    </div>`;
}

// ---------------------------------------------------------------- screens
function SignInScreen() {
    return html`<div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
            <img src="echo_logo.png" alt="" className="w-14 h-14 rounded-2xl mx-auto" />
            <div className="flex justify-center mt-4"><${LanguageMenu} packs=${['app']} /></div>
            <h1 className="text-2xl font-black text-white mt-5">${t('Echo Market seller desk')}</h1>
            <p className="text-sm text-slate-400 mt-2">${t('For Verified Sellers, Ambassadors and the Lead Ambassador. Sign in with your Discord account.')}</p>
            <${Button} variant="discord" size="lg" className="w-full mt-7" onClick=${signInWithDiscord}><${DiscordLogo} /> ${t('Sign in with Discord')}<//>
            <a href=${CONFIG.BUYER_URL || "#"} className="inline-block mt-6 text-xs font-bold text-slate-500 hover:text-slate-300">${t('← Back to Echo Market')}</a>
        </div>
    </div>`;
}

function NotASeller({ account }) {
    const copy = () => { navigator.clipboard?.writeText(account?.discord_id || ''); toast(t('Discord ID copied.')); };
    return html`<div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
            <div className="w-14 h-14 rounded-2xl mx-auto bg-slate-900 border border-slate-800 flex items-center justify-center"><${Icon} name="lock" className="w-6 h-6 text-slate-400" /></div>
            <h1 className="text-xl font-black text-white mt-5">${t("You're not on the seller list yet")}</h1>
            <p className="text-sm text-slate-400 mt-2">${tj('Signed in as {name}.', { name: html`<b className="text-slate-200">${account?.display_name || account?.discord_username}</b>` })}
                ${t('Verified Sellers, Ambassadors and the Lead Ambassador get in automatically through their role on the Echo Discord server. To become a Verified Seller, apply through the Verified Seller application form. Got the role just now? Check again.')}
                ${t('Otherwise, send your Discord ID to an Echo Market admin.')}</p>
            <button onClick=${copy} className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 font-mono text-sm hover:border-slate-600">
                ${account?.discord_id || t('unknown')} <${Icon} name="copy" className="w-4 h-4 text-slate-500" />
            </button>
            <div className="mt-7 flex flex-wrap justify-center gap-2">
                <${Button} icon="refresh-cw" onClick=${() => window.location.reload()}>${t('Check again')}<//>
                <a href=${CONFIG.BUYER_URL || "#"}><${Button} variant="secondary">${t('Go to Echo Market')}<//></a>
                <${Button} variant="ghost" onClick=${() => sb.auth.signOut()}>${t('Sign out')}<//>
            </div>
        </div>
        <${Toasts} />
    </div>`;
}

// ------------------------------------------------------------- components
// Admins only: how much each seller has done. Numbers come from /api/admin/sellers.
// Ranked by orders taken, then aircraft delivered. Sale value is shown small and never ranked on,
// because it would favour sellers of expensive aircraft types.
const STAT_PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']];
const periodText = (days) => (days ? `in the last ${days} days` : 'all time');

function PeriodPicker({ days, setDays }) {
    return html`<div className="flex p-1 rounded-full bg-slate-900 border border-slate-800 self-start">
        ${STAT_PERIODS.map(([d, label]) => html`<button key=${d} onClick=${() => setDays(d)} aria-pressed=${days === d}
            className=${`px-3 py-1.5 rounded-full text-xs font-bold ${days === d ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>${label}</button>`)}
    </div>`;
}

const sellerTags = (x) => [x.source === 'discord_role' ? 'via Discord role' : x.onList && 'added by hand',
    !x.onList ? 'no longer on the list' : !x.active && 'switched off'].filter(Boolean);

function SellerStats({ userId, onOpenOrder }) {
    const [days, setDays] = useState(30);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [picked, setPicked] = useState(null);   // seller whose details are open
    useEffect(() => {
        let gone = false;
        setData(null); setError(null);
        api('/api/admin/sellers', { days }).then((r) => { if (!gone) setData(r); }).catch((e) => { if (!gone) setError(e.message); });
        return () => { gone = true; };
    }, [days]);
    const max = Math.max(1, ...(data?.sellers || []).map((x) => x.ordersTaken));

    return html`<section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
                <h2 className="text-lg font-extrabold text-white">Seller performance</h2>
                <p className="text-xs text-slate-500">Only admins can see this. Click a seller for their details and orders.</p>
            </div>
            <${PeriodPicker} days=${days} setDays=${setDays} />
        </div>

        ${error ? html`<div className="card p-5 text-sm text-rose-300">${error}</div>`
        : !data ? html`<${EchoLoader} className="py-16" />`
        : html`
            <div className="grid grid-cols-2 gap-2 md:gap-3">
                <div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4">
                    <p className="text-[11px] font-bold text-slate-500">Orders taken · ${periodText(days)}</p>
                    <p className="text-2xl md:text-3xl font-black text-white mt-1 tabular-nums">${data.totals.ordersTaken}</p>
                    <p className="text-[11px] text-slate-500">${plural(data.totals.ordersDone, 'order')} completed</p>
                </div>
                <div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4">
                    <p className="text-[11px] font-bold text-slate-500">Aircraft delivered · ${periodText(days)}</p>
                    <p className="text-2xl md:text-3xl font-black text-white mt-1 tabular-nums">${data.totals.aircraftSold}</p>
                    <p className="text-[11px] text-slate-600">≈ ${fmtUSDShort(data.totals.saleValue)} in sales</p>
                </div>
            </div>

            ${!data.sellers.length ? html`<${EmptyState} icon="trophy" title="No sellers yet" text="Sellers appear here once they're on the seller list." />`
            : html`<ol className="space-y-2">${data.sellers.map((x, i) => html`<li key=${x.id}>
                <button onClick=${() => setPicked(x)} className=${`card w-full text-left !rounded-2xl md:!rounded-3xl p-3 md:p-4 hover:border-slate-600 ${x.active ? '' : 'opacity-60'}`}>
                    <div className="flex items-center gap-3">
                        <span className="w-6 text-center text-sm font-black text-slate-500 tabular-nums shrink-0">${i + 1}</span>
                        <${Avatar} account=${{ avatar_url: x.avatarUrl, display_name: x.name }} size="w-9 h-9" />
                        <div className="flex-1 min-w-0">
                            <p className="font-bold text-white truncate flex items-center gap-2"><span className="truncate">${x.name}${x.id === userId ? html` <span className="text-slate-500 font-medium text-xs">(you)</span>` : ''}</span>
                                ${x.onList && html`<${RankBadge} rank=${rankOf(x)} admin=${x.isAdmin} />`}</p>
                            <p className="text-[11px] text-slate-500 truncate">${[...sellerTags(x),
                                x.inProgress ? `${x.inProgress} in progress` : null,
                                x.lastActive ? `last active ${timeAgo(x.lastActive)}` : 'no activity in this period'].filter(Boolean).join(' · ')}</p>
                        </div>
                        <div className="flex items-end gap-4 md:gap-6 shrink-0 text-right">
                            <div><p className="text-2xl font-black text-white tabular-nums leading-none">${x.ordersTaken}</p><p className="text-[10px] font-bold text-slate-400 mt-1">orders taken</p></div>
                            <div><p className="text-lg font-bold text-slate-300 tabular-nums leading-none">${x.aircraftSold}</p><p className="text-[10px] font-bold text-slate-500 mt-1">aircraft delivered</p></div>
                        </div>
                        <${Icon} name="chevron-right" className="w-4 h-4 text-slate-600 shrink-0" />
                    </div>
                    <div className="flex items-center gap-3 mt-2.5 pl-9">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden" title="Orders taken, compared with the most active seller">
                            <div className="h-full rounded-full" style=${{ width: Math.round(x.ordersTaken / max * 100) + '%', backgroundColor: window.ECHO_RANK_COLORS?.[rankOf(x)]?.bar || '#F472B6' }}></div>
                        </div>
                        <span className="text-[10px] text-slate-600 tabular-nums shrink-0" title="Approximate value of the aircraft they delivered">≈ ${fmtUSDShort(x.saleValue)}</span>
                    </div>
                </button>
            </li>`)}</ol>`}
            ${data.statsSince && html`<p className="text-[11px] text-amber-300/80">The leaderboard was reset: it counts from ${fmtDate(data.statsSince)}.</p>`}
            <p className="text-[11px] text-slate-500">Ranked by orders taken, then aircraft delivered. Orders taken counts every time a seller took an order, including ones they later passed on. Aircraft delivered counts what each seller delivered themselves. Sale value (≈) uses each order's average price per aircraft and is only shown for reference.</p>
        `}
        ${picked && html`<${SellerDetailModal} seller=${picked} initialDays=${days} userId=${userId}
            onClose=${() => setPicked(null)} onOpenOrder=${(id) => { setPicked(null); onOpenOrder(id); }} />`}
    </section>`;
}

// One seller: who they are, their numbers for a period, and every order they took in it.
function SellerDetailModal({ seller, initialDays, userId, onClose, onOpenOrder }) {
    const [days, setDays] = useState(initialDays);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let gone = false;
        setData(null); setError(null);
        api('/api/admin/sellers', { days, sellerId: seller.id }).then((r) => { if (!gone) setData(r); }).catch((e) => { if (!gone) setError(e.message); });
        return () => { gone = true; };
    }, [days, seller.id]);
    const x = data?.seller || seller;
    const copy = (text, what) => { navigator.clipboard?.writeText(text); toast(`${what} copied.`); };
    // Orders they took, latest first, 5 at a time.
    const taken = useMemo(() => [...(data?.orders || [])].sort((a, b) => ms(b.takenAt) - ms(a.takenAt)), [data]);
    const [takenShown, takenBar] = usePaged(taken);

    return html`<${Modal} open=${true} onClose=${onClose} size="lg" title=${x.name + (x.id === userId ? ' (you)' : '')}
        subtitle=${[x.onList ? RANK_LABEL[rankOf(x)] + adminSuffix(x) : null, ...sellerTags(x)].filter(Boolean).join(' · ')}>
        <div className="space-y-5">
            <div className="flex items-center gap-4">
                <${Avatar} account=${{ avatar_url: x.avatarUrl, display_name: x.name }} size="w-14 h-14" />
                <div className="min-w-0 text-sm space-y-0.5">
                    ${x.discordUsername && html`<p className="text-slate-300">@${x.discordUsername}</p>`}
                    ${data?.seller?.discordId && html`<button onClick=${() => copy(data.seller.discordId, 'Discord ID')} className="font-mono text-xs text-slate-400 hover:text-white flex items-center gap-1.5">
                        <${DiscordLogo} className="w-3.5 h-3.5" />${data.seller.discordId}<${Icon} name="copy" className="w-3 h-3" /></button>`}
                    <p className="text-xs text-slate-500">${[
                        data?.seller?.addedAt && `on the seller list since ${new Date(data.seller.addedAt).toLocaleDateString()}`,
                        x.source === 'discord_role' && data?.seller?.roleCheckedAt && `role last confirmed ${timeAgo(data.seller.roleCheckedAt)}`,
                        `${x.inProgress || 0} in progress now`].filter(Boolean).join(' · ')}</p>
                    ${data?.seller?.note && html`<p className="text-xs text-slate-500 italic">${data.seller.note}</p>`}
                </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <p className="label text-slate-500">Activity · ${periodText(days)}</p>
                <${PeriodPicker} days=${days} setDays=${setDays} />
            </div>

            ${error ? html`<p className="text-sm text-rose-300">${error}</p>`
            : !data ? html`<${EchoLoader} className="py-10" />`
            : html`
                <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="p-3 rounded-2xl bg-slate-950 border border-slate-800"><p className="text-2xl font-black text-white tabular-nums">${x.ordersTaken}</p><p className="text-[10px] font-bold text-slate-400">orders taken</p></div>
                    <div className="p-3 rounded-2xl bg-slate-950 border border-slate-800"><p className="text-xl font-bold text-slate-200 tabular-nums">${x.aircraftSold}</p><p className="text-[10px] font-bold text-slate-500">aircraft delivered</p></div>
                    <div className="p-3 rounded-2xl bg-slate-950 border border-slate-800"><p className="text-xl font-bold text-slate-200 tabular-nums">${x.ordersDone}</p><p className="text-[10px] font-bold text-slate-500">orders completed</p></div>
                </div>
                <p className="text-[11px] text-slate-600 -mt-3 text-right">≈ ${fmtUSDShort(x.saleValue)} in sales</p>

                <div>
                    <p className="label text-slate-500 mb-2">Orders taken (${data.orders.length})</p>
                    ${!data.orders.length ? html`<p className="text-sm text-slate-400">No orders taken ${periodText(days)}.</p>`
                    : html`<ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60">
                        ${takenShown.map((o) => html`<li key=${o.id}>
                            <button onClick=${() => onOpenOrder(o.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/40">
                                <span className="flex-1 min-w-0">
                                    <${OrderCode} order=${o} />
                                    <span className="block text-sm text-slate-200 truncate">${airlineNames(o)} <span className="text-slate-500">· ${o.buyer_name}</span></span>
                                    <span className="block text-[11px] text-slate-500">took it ${fmtDate(o.takenAt)} · delivered ${o.deliveredBySeller} of ${plural(o.total_qty, 'aircraft')}${!o.stillTheirs && ['PENDING', 'CLAIMED', 'PARTIAL'].includes(o.status) ? ' · now with another seller' : ''}</span>
                                </span>
                                <${StatusBadge} status=${displayStatus(o)} />
                            </button>
                        </li>`)}
                    </ul>${takenBar}`}
                </div>
            `}
        </div>
    <//>`;
}

// ---------------- Alliances tab (admins only): which alliances order the most, from /api/admin/sellers { view: 'alliances' }.
// Colours (checked for colour blindness on the desk's dark cards): one blue for single-series bars; outcomes in the
// fixed order completed (green) | in progress (blue) | declined or cancelled (red), so green and red never touch;
// "who supplies whom" uses one blue ramp, darker = fewer aircraft.
const VIZ = { bar: '#3987e5', done: '#0ca30c', active: '#3987e5', closed: '#d03b3b' };
const HEAT = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
const pct = (n, d) => (d ? Math.round(n / d * 100) : 0);
const fmtHours = (h) => (h == null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} d`);
const ALLIANCE_METRICS = [
    { key: 'orders', label: 'Orders', about: 'Orders placed by buyers in the alliance.', fmt: (v) => String(v) },
    { key: 'aircraft', label: 'Aircraft', about: 'Aircraft ordered.', fmt: (v) => String(v) },
    { key: 'value', label: 'Value', about: 'What the buyers pay for their orders (at their price level).', fmt: (v) => fmtUSDShort(v) },
    { key: 'buyers', label: 'Buyers', about: 'Different buyers who ordered.', fmt: (v) => String(v) },
    { key: 'avgSize', label: 'Order size', about: 'Average aircraft per order.', fmt: (v) => v.toFixed(1) },
    { key: 'priceLevel', label: 'Price level', about: 'Average price level, weighted by aircraft.', fmt: (v) => `${v}%` },
    { key: 'completion', label: 'Completed', about: 'Share of orders fully delivered.', fmt: (v) => `${v}%` },
    { key: 'waitHours', label: 'Wait', about: 'Median time until a seller first took an order (shortest first).', fmt: fmtHours, ascending: true }
];
const AIRCRAFT_METRICS = [
    { key: 'aircraft', label: 'Aircraft', about: 'Aircraft ordered of each type.', fmt: (v) => String(v) },
    { key: 'orders', label: 'Orders', about: 'Orders that include each type.', fmt: (v) => String(v) },
    { key: 'value', label: 'Value', about: 'What buyers pay for each type.', fmt: (v) => fmtUSDShort(v) }
];
const metricValue = (a, key) => key === 'avgSize' ? (a.orders ? a.aircraft / a.orders : null)
    : key === 'completion' ? (a.orders ? pct(a.completed, a.orders) : null) : a[key];
const sortByMetric = (key) => {
    const ascending = ALLIANCE_METRICS.find((x) => x.key === key)?.ascending;
    return (x, y) => {
        const vx = metricValue(x, key), vy = metricValue(y, key);
        return (vx == null) - (vy == null) || (ascending ? vx - vy : vy - vx) || y.orders - x.orders || x.name.localeCompare(y.name);
    };
};
const bucketLabel = (iso, bucketDays) => (bucketDays === 1 ? '' : 'week of ') +
    new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Hover (and focus / tap) tooltip shared by the charts.
function useChartTip() {
    const [tip, setTip] = useState(null);
    useEffect(() => {
        if (!tip) return;
        const hide = () => setTip(null);
        window.addEventListener('scroll', hide, true);
        return () => window.removeEventListener('scroll', hide, true);
    }, [tip]);
    const bind = (content, { tap = true } = {}) => ({
        tabIndex: 0,
        onMouseMove: (e) => setTip({ x: e.clientX, y: e.clientY, content }),
        onMouseLeave: () => setTip(null),
        onFocus: (e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ x: r.left + r.width / 2, y: r.top, content }); },
        onBlur: () => setTip(null),
        ...(tap ? { onClick: (e) => setTip({ x: e.clientX, y: e.clientY, content }) } : {})
    });
    const below = tip && tip.y < 140;
    const node = tip && ReactDOM.createPortal(html`<div role="tooltip"
        className="fixed z-[70] pointer-events-none w-max max-w-[16rem] px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 shadow-2xl text-xs text-slate-200"
        style=${{ left: Math.min(window.innerWidth - 136, Math.max(136, tip.x)), top: below ? tip.y + 18 : tip.y - 12,
            transform: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)' }}>${tip.content}</div>`, document.body);
    return [bind, node];
}
const TipRows = ({ title, rows }) => html`<p className="font-bold text-white mb-1">${title}</p>
    ${rows.map(([k, v]) => html`<p key=${k} className="flex justify-between gap-4"><span className="text-slate-400">${k}</span><span className="tabular-nums">${v}</span></p>`)}`;
const allianceTip = (a) => html`<${TipRows} title=${a.name} rows=${[
    ['Orders', a.orders], ['Aircraft', `${a.aircraft} (${a.delivered} delivered)`], ['Value', fmtUSDShort(a.value)], ['Buyers', a.buyers],
    ['Price level', a.priceLevel == null ? '—' : `${a.priceLevel}%`], ['Completed', `${pct(a.completed, a.orders)}%`], ['Median wait', fmtHours(a.waitHours)]]} />`;

function VizCard({ title, about, children }) {
    return html`<section className="card !rounded-2xl md:!rounded-3xl p-3 md:p-5 min-w-0">
        <h3 className="font-extrabold text-white">${title}</h3>
        ${about && html`<p className="text-[11px] text-slate-500 mt-0.5">${about}</p>`}
        <div className="mt-3">${children}</div>
    </section>`;
}

// Columns over time (one per day or week), on a given scale.
function MiniColumns({ series, max, height = 'h-12', tipFor, bind }) {
    return html`<div className=${`${height} flex items-end gap-px border-b border-slate-700`}>
        ${series.map((n, i) => html`<span key=${i} ...${bind(tipFor(n, i))} className="flex-1 h-full flex items-end outline-none hover:bg-slate-800/60 focus-visible:bg-slate-800/60">
            <span className="w-full rounded-t-sm" style=${{ height: n ? `max(${(n / max * 100).toFixed(1)}%, 2px)` : 0, backgroundColor: VIZ.bar }}></span>
        </span>`)}
    </div>`;
}

function AllianceStats() {
    const [days, setDays] = useState(30);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [metric, setMetric] = useState('orders');
    const [sortBy, setSortBy] = useState('orders');
    const [picked, setPicked] = useState(null);
    const [typesBy, setTypesBy] = useState('aircraft');
    const [allTypes, setAllTypes] = useState(false);
    const [bind, tipNode] = useChartTip();
    useEffect(() => {
        let gone = false;
        setData(null); setError(null);
        api('/api/admin/sellers', { view: 'alliances', days }).then((r) => { if (!gone) setData(r); }).catch((e) => { if (!gone) setError(e.message); });
        return () => { gone = true; };
    }, [days]);

    const header = html`<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
            <h2 className="text-lg font-extrabold text-white">Alliance statistics</h2>
            <p className="text-xs text-slate-500">Every seller can see this. Hover or tap a chart for details; click an alliance for more.</p>
        </div>
        <${PeriodPicker} days=${days} setDays=${setDays} />
    </div>`;
    if (error) return html`<section className="space-y-3">${header}<div className="card p-5 text-sm text-rose-300">${error}</div></section>`;
    if (!data) return html`<section className="space-y-3">${header}<${EchoLoader} className="py-16" /></section>`;
    const list = data.alliances;
    if (!list.length) return html`<section className="space-y-3">${header}
        <${EmptyState} icon="chart-column" title="No orders yet" text=${`No orders were placed ${periodText(days)}.`} /></section>`;

    const m = ALLIANCE_METRICS.find((x) => x.key === metric);
    const ranked = [...list].sort(sortByMetric(metric));
    const maxV = Math.max(...ranked.map((a) => metricValue(a, metric) || 0)) || 1;
    const top = list[0];
    const { totals, bucketStarts, bucketDays, trade } = data;
    const per = bucketDays === 1 ? 'day' : 'week';

    // Orders over time: one small chart per alliance (the busiest six, the rest together), all on one scale.
    const multiples = list.length > 7
        ? [...list.slice(0, 6), { name: `Other alliances (${list.length - 6})`, orders: list.slice(6).reduce((s, a) => s + a.orders, 0),
            series: list.slice(6).reduce((s, a) => s.map((n, i) => n + a.series[i]), new Array(bucketStarts.length).fill(0)) }]
        : list;
    const seriesMax = Math.max(1, ...multiples.flatMap((a) => a.series));

    // Who supplies whom: buyer alliances (rows) × seller alliances (columns), aircraft delivered.
    const sellerTotals = new Map();
    for (const c of trade) sellerTotals.set(c.seller, (sellerTotals.get(c.seller) || 0) + c.aircraft);
    const sellerCols = [...sellerTotals].sort((x, y) => y[1] - x[1]).map(([name]) => name);
    const tradeRows = list.filter((a) => trade.some((c) => c.buyer === a.name));
    const cell = (buyer, seller) => trade.find((c) => c.buyer === buyer && c.seller === seller)?.aircraft || 0;
    const tradeMax = Math.max(1, ...trade.map((c) => c.aircraft));
    const heatStep = (v) => Math.min(HEAT.length - 1, Math.floor(Math.sqrt(v / tradeMax) * HEAT.length));

    // Most popular aircraft types over every alliance.
    const typeMetric = AIRCRAFT_METRICS.find((x) => x.key === typesBy);
    const types = [...(data.aircraft || [])].sort((x, y) => y[typesBy] - x[typesBy] || y.aircraft - x.aircraft);
    const typesShown = allTypes ? types : types.slice(0, 10);
    const typesMax = Math.max(1, ...types.map((x) => x[typesBy]));

    const outcomes = [['done', 'Completed'], ['active', 'Waiting or in delivery'], ['closed', 'Declined or cancelled']];
    const outcomeCount = (a, k) => (k === 'done' ? a.completed : k === 'active' ? a.active : a.declined + a.cancelled);

    return html`<section className="space-y-3">
        ${header}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
            <div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4 min-w-0">
                <p className="text-[11px] font-bold text-slate-500">Most orders · ${periodText(days)}</p>
                <p className="text-xl md:text-2xl font-black text-white mt-1 truncate">${top.name}</p>
                <p className="text-[11px] text-slate-500">${plural(top.orders, 'order')} · ${pct(top.orders, totals.orders)}% of all</p>
            </div>
            <div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4">
                <p className="text-[11px] font-bold text-slate-500">Orders</p>
                <p className="text-2xl md:text-3xl font-black text-white mt-1 tabular-nums">${totals.orders}</p>
                <p className="text-[11px] text-slate-500">${pct(totals.completed, totals.orders)}% completed · ${plural(list.length, 'alliance')}</p>
            </div>
            <div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4">
                <p className="text-[11px] font-bold text-slate-500">Aircraft ordered</p>
                <p className="text-2xl md:text-3xl font-black text-white mt-1 tabular-nums">${totals.aircraft}</p>
                <p className="text-[11px] text-slate-500">${totals.delivered} delivered so far</p>
            </div>
            <div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4">
                <p className="text-[11px] font-bold text-slate-500">Order value</p>
                <p className="text-2xl md:text-3xl font-black text-white mt-1 tabular-nums">${fmtUSDShort(totals.value)}</p>
                <p className="text-[11px] text-slate-500">from ${plural(totals.buyers, 'buyer')}</p>
            </div>
        </div>

        <${VizCard} title=${`Ranking · ${m.label}`} about=${m.about}>
            <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-3 px-3 md:mx-0 md:px-0 mb-3" role="group" aria-label="Rank by">
                ${ALLIANCE_METRICS.map((x) => html`<button key=${x.key} onClick=${() => setMetric(x.key)} aria-pressed=${metric === x.key}
                    className=${`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border ${metric === x.key ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}>${x.label}</button>`)}
            </div>
            <ol className="space-y-0.5">${ranked.map((a, i) => {
                const v = metricValue(a, metric);
                return html`<li key=${a.name}>
                    <button ...${bind(allianceTip(a), { tap: false })} onClick=${() => setPicked(a)}
                        className="w-full grid grid-cols-[1.25rem_minmax(0,6.5rem)_1fr_auto] sm:grid-cols-[1.5rem_minmax(0,10rem)_1fr_auto] items-center gap-2 py-1 rounded-lg hover:bg-slate-800/40 text-left">
                        <span className="text-xs font-black text-slate-500 tabular-nums text-center">${i + 1}</span>
                        <span className="text-sm text-slate-200 truncate">${a.name}</span>
                        <span className="h-4 flex items-center min-w-0">${v == null ? html`<span className="text-[11px] text-slate-600">no data</span>`
                            : html`<span className="h-3 rounded-r" style=${{ width: `max(${(v / maxV * 100).toFixed(1)}%, 3px)`, backgroundColor: VIZ.bar }}></span>`}</span>
                        <span className="text-sm font-bold text-white tabular-nums text-right min-w-[3.5rem]">${v == null ? '—' : m.fmt(v)}</span>
                    </button>
                </li>`;
            })}</ol>
        <//>

        ${types.length > 0 && html`<${VizCard} title="Most popular aircraft" about=${`${typeMetric.about} All alliances together; hover or tap a bar for details.`}>
            <div className="flex gap-1.5 mb-3" role="group" aria-label="Rank aircraft by">
                ${AIRCRAFT_METRICS.map((x) => html`<button key=${x.key} onClick=${() => setTypesBy(x.key)} aria-pressed=${typesBy === x.key}
                    className=${`px-3 py-1.5 rounded-full text-xs font-bold border ${typesBy === x.key ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-400 hover:text-white'}`}>${x.label}</button>`)}
            </div>
            <ol className="space-y-0.5">${typesShown.map((ty, i) => html`<li key=${ty.model}
                ...${bind(html`<${TipRows} title=${ty.model} rows=${[['Aircraft ordered', ty.aircraft], ['Orders', ty.orders], ['Delivered', ty.delivered],
                    ['Value', fmtUSDShort(ty.value)], ['Price level', ty.priceLevel == null ? '—' : `${ty.priceLevel}%`], ['Alliances ordering', ty.alliances]]} />`)}
                className="grid grid-cols-[1.25rem_minmax(0,8rem)_1fr_auto] sm:grid-cols-[1.5rem_minmax(0,14rem)_1fr_auto] items-center gap-2 py-1 rounded-lg hover:bg-slate-800/40 outline-none focus-visible:bg-slate-800/40">
                <span className="text-xs font-black text-slate-500 tabular-nums text-center">${i + 1}</span>
                <span className="text-sm text-slate-200 truncate">${ty.model}</span>
                <span className="h-4 flex items-center min-w-0"><span className="h-3 rounded-r" style=${{ width: `max(${(ty[typesBy] / typesMax * 100).toFixed(1)}%, 3px)`, backgroundColor: VIZ.bar }}></span></span>
                <span className="text-sm font-bold text-white tabular-nums text-right min-w-[3.5rem]">${typeMetric.fmt(ty[typesBy])}</span>
            </li>`)}</ol>
            ${types.length > 10 && html`<button onClick=${() => setAllTypes(!allTypes)} className="mt-2 text-xs font-bold text-sky-300 hover:text-white">${allTypes ? 'Show the top 10' : `Show all ${types.length}`}</button>`}
        <//>`}

        <div className="grid lg:grid-cols-2 gap-3">
            <${VizCard} title="Orders over time" about=${`Orders placed per ${per}. Every chart uses the same scale, so heights compare.`}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                    ${multiples.map((a) => html`<div key=${a.name} className="min-w-0">
                        <p className="flex justify-between gap-2 text-xs mb-1"><span className="text-slate-200 font-bold truncate">${a.name}</span><span className="text-slate-500 tabular-nums shrink-0">${a.orders}</span></p>
                        <${MiniColumns} series=${a.series} max=${seriesMax} bind=${bind}
                            tipFor=${(n, i) => html`<${TipRows} title=${a.name} rows=${[[bucketLabel(bucketStarts[i], bucketDays), plural(n, 'order')]]} />`} />
                    </div>`)}
                </div>
                <p className="flex justify-between text-[10px] text-slate-500 mt-2"><span>${bucketLabel(bucketStarts[0], bucketDays)}</span><span>now</span></p>
            <//>

            <${VizCard} title="Order outcomes" about="How each alliance's orders stand so far.">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400 mb-3">
                    ${outcomes.map(([k, label]) => html`<span key=${k} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style=${{ backgroundColor: VIZ[k] }}></span>${label}</span>`)}
                </div>
                <ul className="space-y-2">${list.slice(0, 12).map((a) => html`<li key=${a.name} className="grid grid-cols-[minmax(0,6rem)_1fr] sm:grid-cols-[minmax(0,8rem)_1fr] items-center gap-2">
                    <span className="text-xs text-slate-200 truncate">${a.name}</span>
                    <span className="flex h-5 gap-0.5 min-w-0">${outcomes.filter(([k]) => outcomeCount(a, k) > 0).map(([k, label]) => {
                        const n = outcomeCount(a, k);
                        return html`<span key=${k} ...${bind(html`<${TipRows} title=${a.name} rows=${[[label, `${n} of ${a.orders} (${pct(n, a.orders)}%)`]]} />`)}
                            className="first:rounded-l last:rounded-r flex items-center justify-center text-[10px] font-bold text-white overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-white"
                            style=${{ flexGrow: n, flexBasis: 0, backgroundColor: VIZ[k] }}>${pct(n, a.orders) >= 15 ? `${pct(n, a.orders)}%` : ''}</span>`;
                    })}</span>
                </li>`)}</ul>
                ${list.length > 12 && html`<p className="text-[11px] text-slate-500 mt-2">The 12 alliances with the most orders; the table below has them all.</p>`}
            <//>
        </div>

        <${VizCard} title="Who supplies whom" about="Aircraft delivered by sellers from each alliance (columns) to buyers in each alliance (rows). Brighter = more aircraft.">
            ${!sellerCols.length ? html`<p className="text-sm text-slate-400">No aircraft delivered on these orders yet.</p>`
            : html`<div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0">
                <table className="text-xs border-separate [border-spacing:2px]">
                    <thead><tr>
                        <th className="text-left text-[10px] font-bold text-slate-500 pr-2 align-bottom whitespace-nowrap">Buyers ↓ · Sellers →</th>
                        ${sellerCols.map((name) => html`<th key=${name} scope="col" className="text-[10px] font-bold text-slate-400 px-1 align-bottom max-w-[5.5rem] truncate" title=${name}>${name}</th>`)}
                    </tr></thead>
                    <tbody>${tradeRows.map((a) => html`<tr key=${a.name}>
                        <th scope="row" className="text-left font-medium text-slate-200 pr-2 max-w-[8rem] truncate" title=${a.name}>${a.name}</th>
                        ${sellerCols.map((name) => {
                            const v = cell(a.name, name);
                            const step = heatStep(v);
                            return html`<td key=${name} ...${bind(html`<${TipRows} title=${`${name} sellers → ${a.name} buyers`} rows=${[['Aircraft delivered', v], [`Share of ${a.name}'s deliveries`, `${pct(v, a.delivered)}%`]]} />`)}
                                className="h-9 min-w-[3.5rem] rounded text-center tabular-nums font-bold outline-none focus-visible:ring-2 focus-visible:ring-white"
                                style=${v ? { backgroundColor: HEAT[step], color: step >= 4 ? '#020617' : '#ffffff' } : { backgroundColor: '#1e293b', color: '#475569' }}>${v || '·'}</td>`;
                        })}
                    </tr>`)}</tbody>
                </table>
            </div>
            <div className="flex items-center gap-2 mt-3 text-[10px] text-slate-500">
                <span>fewer</span>
                <span className="flex gap-0.5">${HEAT.map((c) => html`<span key=${c} className="w-5 h-2.5 rounded-sm" style=${{ backgroundColor: c }}></span>`)}</span>
                <span>more aircraft (most in one cell: ${tradeMax})</span>
            </div>`}
        <//>

        <${VizCard} title="All alliances" about="Click a column to sort, or an alliance for its details.">
            <div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0">
                <table className="w-full text-xs">
                    <thead><tr className="text-slate-500 border-b border-slate-800">
                        <th className="text-left font-bold py-2 pr-3">Alliance</th>
                        ${ALLIANCE_METRICS.map((x) => html`<th key=${x.key} className="text-right font-bold py-2 px-2 whitespace-nowrap" aria-sort=${sortBy === x.key ? (x.ascending ? 'ascending' : 'descending') : 'none'}>
                            <button onClick=${() => setSortBy(x.key)} className=${sortBy === x.key ? 'text-white' : 'hover:text-white'}>${x.label}${sortBy === x.key ? (x.ascending ? ' ↑' : ' ↓') : ''}</button></th>`)}
                    </tr></thead>
                    <tbody>${[...list].sort(sortByMetric(sortBy)).map((a) => html`<tr key=${a.name} className="border-b border-slate-800/60 hover:bg-slate-800/40">
                        <td className="py-2 pr-3"><button onClick=${() => setPicked(a)} className="font-bold text-slate-200 hover:text-white text-left">${a.name}</button></td>
                        ${ALLIANCE_METRICS.map((x) => { const v = metricValue(a, x.key); return html`<td key=${x.key} className="text-right tabular-nums text-slate-300 px-2 whitespace-nowrap">${v == null ? '—' : x.fmt(v)}</td>`; })}
                    </tr>`)}</tbody>
                </table>
            </div>
        <//>
        <p className="text-[11px] text-slate-500">An order counts for the alliance of the buyer's (first) delivery airline, and for the period in which it was placed. Value is what buyers pay at their price level. Wait is the median time from placing an order until a seller first took it. Orders without a known alliance are under “No alliance”.</p>
        ${tipNode}
        ${picked && html`<${AllianceDetailModal} alliance=${picked} data=${data} days=${days} onClose=${() => setPicked(null)} />`}
    </section>`;
}

// One alliance: its numbers, its orders over time, what it orders and who delivers to it.
function AllianceDetailModal({ alliance: a, data, days, onClose }) {
    const [bind, tipNode] = useChartTip();
    const suppliers = data.trade.filter((c) => c.buyer === a.name).sort((x, y) => y.aircraft - x.aircraft);
    const tiles = [['Orders', a.orders], ['Aircraft', a.aircraft], ['Value', fmtUSDShort(a.value)], ['Buyers', a.buyers],
        ['Price level', a.priceLevel == null ? '—' : `${a.priceLevel}%`], ['Median wait', fmtHours(a.waitHours)]];
    const bars = (rows) => {
        const max = Math.max(1, ...rows.map((r) => r[1]));
        return html`<ul className="space-y-1.5">${rows.map(([label, n]) => html`<li key=${label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
            <span className="text-slate-200 truncate">${label}</span>
            <span className="h-3 flex items-center min-w-0"><span className="h-full rounded-r" style=${{ width: `max(${(n / max * 100).toFixed(1)}%, 3px)`, backgroundColor: VIZ.bar }}></span></span>
            <span className="font-bold text-white tabular-nums">${n}</span>
        </li>`)}</ul>`;
    };
    return html`<${Modal} open=${true} onClose=${onClose} title=${a.name} subtitle=${`Alliance · ${periodText(days)}`} size="lg">
        <div className="space-y-5">
            <div className="grid grid-cols-3 gap-2 text-center">${tiles.map(([k, v]) => html`<div key=${k} className="p-3 rounded-2xl bg-slate-950 border border-slate-800">
                <p className="text-lg md:text-xl font-black text-white tabular-nums">${v}</p><p className="text-[10px] font-bold text-slate-500">${k}</p></div>`)}</div>
            <div>
                <p className="label text-slate-500 mb-2">Orders per ${data.bucketDays === 1 ? 'day' : 'week'}</p>
                <${MiniColumns} series=${a.series} max=${Math.max(1, ...a.series)} height="h-24" bind=${bind}
                    tipFor=${(n, i) => html`<${TipRows} title=${bucketLabel(data.bucketStarts[i], data.bucketDays)} rows=${[['Orders', n]]} />`} />
                <p className="flex justify-between text-[10px] text-slate-500 mt-1"><span>${bucketLabel(data.bucketStarts[0], data.bucketDays)}</span><span>now</span></p>
            </div>
            <div>
                <p className="label text-slate-500 mb-2">Most-ordered aircraft</p>
                ${bars(a.topAircraft.map((x) => [x.model, x.qty]))}
            </div>
            <div>
                <p className="label text-slate-500 mb-2">Delivered by sellers from</p>
                ${suppliers.length ? bars(suppliers.map((c) => [c.seller, c.aircraft])) : html`<p className="text-sm text-slate-400">Nothing delivered yet.</p>`}
            </div>
            <p className="text-[11px] text-slate-500">${a.completed} completed · ${a.active} waiting or in delivery · ${a.declined} declined · ${a.cancelled} cancelled · ${a.delivered} of ${a.aircraft} aircraft delivered.</p>
        </div>
        ${tipNode}
    <//>`;
}

// ---------------- Sellers' Cup (seller/lib/cup.js): banner for every seller, bracket, and the admins' Cup panel.
const cupRoundName = (round, total) => {
    const left = total - round;
    return left === 0 ? t('Final') : left === 1 ? t('Semi-finals') : left === 2 ? t('Quarter-finals') : t('Round {n}', { n: round });
};
const cupActive = (cup) => cup && ['seeding', 'running'].includes(cup.status);
const cupSeed = (cup, id) => cup.seeds.find((s) => s.sellerId === id);
const fmtCupLength = (hours) => (hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hours`);

// The Cup as columns of rounds; the current round shows live scores.
function CupBracket({ view, userId }) {
    const { cup, totalRounds, live = {} } = view;
    if (!cup.rounds.length) return null;
    const rounds = [...cup.rounds];
    return html`<div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0">
        <div className="flex gap-3 min-w-max">
            ${rounds.map((r) => html`<div key=${r.round} className="w-52 shrink-0">
                <p className="text-xs font-extrabold text-white">${cupRoundName(r.round, totalRounds)}</p>
                <p className="text-[10px] text-slate-500 mb-2">${new Date(r.startsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(r.endsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${r.resolved ? '' : ` · ${t('live')}`}</p>
                <ul className="space-y-2">${r.matches.map((m, i) => html`<li key=${i} className="rounded-xl border border-slate-800 bg-slate-950/60 divide-y divide-slate-800">
                    ${[m.a, m.b].map((id, side) => {
                        if (!id) return html`<p key="bye" className="px-2.5 py-1.5 text-[11px] text-slate-500 italic">${t('bye')}</p>`;
                        const s = cupSeed(cup, id);
                        const score = r.resolved ? (side ? m.scoreB : m.scoreA) : live[id];
                        const won = r.resolved && m.winner === id;
                        const lost = r.resolved && m.winner && m.winner !== id;
                        return html`<p key=${id} className=${`flex items-center gap-2 px-2.5 py-1.5 text-xs ${won ? 'text-white font-extrabold' : lost ? 'text-slate-500 line-through decoration-slate-600' : 'text-slate-200'} ${id === userId ? 'bg-sky-400/10' : ''}`}>
                            <span className="text-[10px] text-slate-500 tabular-nums w-6 shrink-0">#${s?.seed ?? '?'}</span>
                            <span className="flex-1 truncate">${s?.name || '?'}${id === userId ? ` (${t('you')})` : ''}</span>
                            ${m.b && score != null && html`<span className="tabular-nums font-bold">${score}</span>`}
                            ${won && html`<${Icon} name=${cup.champion_id === id ? 'trophy' : 'check'} className="w-3.5 h-3.5 text-emerald-400 shrink-0" />`}
                        </p>`;
                    })}
                    ${r.resolved && m.how === 'tie-seed' && html`<p className="px-2.5 py-1 text-[10px] text-slate-500">${t('Tie: higher seed through')}</p>`}
                    ${r.resolved && m.how === 'walkover' && html`<p className="px-2.5 py-1 text-[10px] text-slate-500">${t('Walkover')}</p>`}
                </li>`)}</ul>
            </div>`)}
        </div>
    </div>`;
}

// Seeding period: everyone's completed orders so far; the bracket cut-off line.
function CupStandings({ view, userId }) {
    const { cup, standings = [] } = view;
    return html`<ol className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60">
        ${standings.map((s) => html`<li key=${s.sellerId} className=${`flex items-center gap-3 px-3 py-2 text-sm ${s.sellerId === userId ? 'bg-sky-400/10' : ''} ${cup.bracket_size && s.place === cup.bracket_size ? 'border-b-2 !border-b-sky-400/60' : ''}`}>
            <span className="w-6 text-center text-xs font-black text-slate-500 tabular-nums">${s.place}</span>
            <span className="flex-1 truncate text-slate-200">${s.name}${s.sellerId === userId ? ` (${t('you')})` : ''}</span>
            <span className="text-[11px] text-slate-500 tabular-nums">${fmtUSDShort(s.value)}</span>
            <span className="w-16 text-right font-bold text-white tabular-nums">${plural(s.orders, 'order')}</span>
        </li>`)}
    </ol>`;
}

function CupDetails({ view, userId }) {
    const { cup } = view;
    return html`<div className="space-y-4">
        <p className="text-xs text-slate-400">${t('Only orders you complete on your own count. Tie: the higher seed goes through.')}</p>
        ${cup.status === 'seeding' ? html`<div>
            <p className="label text-slate-500 mb-2">${t('Seeding standings')} · ${t('ends {date}', { date: fmtDate(view.seedingEndsAt) })}</p>
            <${CupStandings} view=${view} userId=${userId} />
            ${cup.bracket_size && html`<p className="text-[11px] text-slate-500 mt-2">${t('The top {n} make the bracket.', { n: cup.bracket_size })}</p>`}
        </div>` : html`<${CupBracket} view=${view} userId=${userId} />`}
        ${cup.status === 'finished' && cup.champion_id && html`<p className="p-3 rounded-2xl bg-amber-400/10 border border-amber-400/30 text-amber-200 font-bold flex items-center gap-2">
            <${Icon} name="trophy" className="w-5 h-5" /> ${t('Champion: {name}', { name: cupSeed(cup, cup.champion_id)?.name || '?' })}</p>`}
        ${cup.status === 'cancelled' && html`<p className="text-sm text-slate-400">${t('Cancelled.')} ${cup.note || ''}</p>`}
    </div>`;
}

// Front page, every seller: where the Cup stands and how they are doing.
function CupBanner({ userId }) {
    useLang();
    const [view, setView] = useState(null);
    const [open, setOpen] = useState(false);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        let gone = false;
        const load = () => api('/api/admin/sellers', { view: 'cup' }).then((r) => { if (!gone) { setView(r); setNow(Date.now()); } }).catch(() => {});
        load();
        const onVisible = () => { if (document.visibilityState === 'visible') load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { gone = true; document.removeEventListener('visibilitychange', onVisible); };
    }, []);
    const cup = view?.cup;
    // Shown while it runs, and for three days after a champion is crowned.
    if (!cup || !(cupActive(cup) || (cup.status === 'finished' && now - new Date(cup.ended_at).getTime() < 3 * 864e5))) return null;
    let text;
    if (cup.status === 'seeding') {
        const me = (view.standings || []).find((s) => s.sellerId === userId);
        const left = fmtDuration(new Date(view.seedingEndsAt).getTime() - now);
        text = me ? t('{cup} · seeding: you have {n} (#{place}) · ends in {time}', { cup: cup.name, n: plural(me.orders, 'completed order'), place: me.place, time: left })
            : t('{cup} · seeding · ends in {time}', { cup: cup.name, time: left });
    } else if (cup.status === 'running') {
        const round = cup.rounds[cup.rounds.length - 1];
        const name = cupRoundName(round.round, view.totalRounds);
        const left = fmtDuration(new Date(round.endsAt).getTime() - now);
        const m = round.matches.find((x) => x.a === userId || x.b === userId);
        const other = m && (m.a === userId ? m.b : m.a);
        text = !m ? t('{cup} · {round} in progress · ends in {time}', { cup: cup.name, round: name, time: left })
            : !other ? t('{cup} · {round}: you have a bye and go straight through', { cup: cup.name, round: name })
            : t('{cup} · {round}: you {mine} – {theirs} {name} · ends in {time}', { cup: cup.name, round: name, mine: view.live?.[userId] ?? 0,
                theirs: view.live?.[other] ?? 0, name: cupSeed(cup, other)?.name || '?', time: left });
    } else {
        text = t('{name} won {cup}!', { name: cupSeed(cup, cup.champion_id)?.name || '?', cup: cup.name });
    }
    return html`<div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 md:p-4 rounded-2xl border border-amber-400/30 bg-amber-400/[0.07]">
        <span className="w-9 h-9 rounded-xl bg-amber-400/15 text-amber-300 flex items-center justify-center shrink-0"><${Icon} name="trophy" className="w-5 h-5" /></span>
        <p className="flex-1 min-w-[12rem] text-sm font-bold text-amber-100">${text}</p>
        <${Button} size="sm" variant="secondary" icon="swords" onClick=${() => setOpen(true)}>${t('See the Cup')}<//>
        <${Modal} open=${open} onClose=${() => setOpen(false)} title=${cup.name} size="lg">
            <${CupDetails} view=${view} userId=${userId} />
        <//>
    </div>`;
}

// Admins: Sellers tab → Cup. Start a Cup, watch it, cancel it, disqualify a seller.
function CupAdmin({ userId }) {
    const [view, setView] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const monthName = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const [form, setForm] = useState({ name: `Sellers' Cup · ${monthName}`, seedingDays: 7, roundDays: 7, bracketSize: '', pairing: 'fold', channelId: '' });
    const load = () => api('/api/admin/sellers', { view: 'cup' }).then((r) => {
        setView(r);
        if (r.cup?.channel_id) setForm((f) => (f.channelId ? f : { ...f, channelId: r.cup.channel_id }));
    }).catch((e) => setError(e.message));
    useEffect(() => { load(); }, []);
    const run = async (payload, done) => {
        setBusy(true);
        try { await api('/api/admin/sellers', payload); toast(done, 'success'); await load(); } catch (e) { toast(e.message, 'error'); }
        setBusy(false);
    };
    if (error) return html`<div className="card p-5 text-sm text-rose-300">${error}</div>`;
    if (!view) return html`<${EchoLoader} className="py-16" />`;
    const { cup } = view;
    const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

    if (cupActive(cup)) {
        const round = cup.rounds[cup.rounds.length - 1];
        const people = cup.status === 'seeding' ? (view.standings || []) : cup.seeds.filter((s) => round?.matches.some((m) => !m.winner && (m.a === s.sellerId || m.b === s.sellerId)));
        return html`<div className="space-y-3">
            <div className="card !rounded-2xl md:!rounded-3xl p-4 md:p-5 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <p className="label text-amber-300 flex items-center gap-1.5"><${Icon} name="trophy" className="w-4 h-4" />${cup.status === 'seeding' ? 'Seeding period' : cupRoundName(round.round, view.totalRounds)}</p>
                        <h3 className="text-xl font-black text-white mt-1">${cup.name}</h3>
                        <p className="text-xs text-slate-400 mt-1">${cup.status === 'seeding' ? `Seeding ends ${fmtDate(view.seedingEndsAt)}` : `Round ends ${fmtDate(round.endsAt)}`}
                            · rounds of ${fmtCupLength(cup.round_hours)} · ${cup.bracket_size ? `top ${cup.bracket_size}` : 'every seller'} · ${cup.pairing === 'fold' ? '1 v last' : cup.pairing}
                            · ${cup.channel_id ? `posts in channel ${cup.channel_id}` : 'no Discord channel'}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <${Button} size="sm" variant="secondary" icon="refresh-cw" busy=${busy} onClick=${() => { setBusy(true); load().finally(() => setBusy(false)); }}>Refresh<//>
                        <${Button} size="sm" variant="ghost" icon="octagon-x" className="!text-rose-300" busy=${busy} onClick=${async () => {
                            const reason = await ask({ title: `Cancel ${cup.name}?`, danger: true, confirmLabel: 'Cancel the Cup', message: 'The Cup stops for everyone and the cancellation is posted in the Cup channel. This cannot be undone.', input: { placeholder: 'Reason (shown in Discord)' } });
                            if (reason !== null && reason !== false) run({ action: 'cup-cancel', reason: typeof reason === 'string' ? reason : '' }, 'Cup cancelled.');
                        }}>Cancel Cup<//>
                    </div>
                </div>
                ${people.length > 0 && html`<label className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    Disqualify a seller (they lose their match by walkover):
                    <select className="input !py-1.5 !w-auto min-w-0 text-xs" value="" onChange=${async (e) => {
                        const id = e.target.value;
                        const who = people.find((p) => p.sellerId === id);
                        if (id && await ask({ title: `Disqualify ${who?.name}?`, danger: true, confirmLabel: 'Disqualify', message: cup.status === 'seeding' ? 'They will not be seeded.' : 'They lose their current match by walkover when the round ends.' })) run({ action: 'cup-disqualify', sellerId: id }, `${who?.name} disqualified.`);
                    }}>
                        <option value="">Choose…</option>
                        ${people.filter((p) => !(cup.removed || []).includes(p.sellerId)).map((p) => html`<option key=${p.sellerId} value=${p.sellerId}>${p.name}</option>`)}
                    </select>
                </label>`}
            </div>
            <div className="card !rounded-2xl md:!rounded-3xl p-4 md:p-5"><${CupDetails} view=${view} userId=${userId} /></div>
        </div>`;
    }

    const size = Number(form.bracketSize) || view.eligible || 0;
    const field = Math.min(size, view.eligible || 0);
    return html`<div className="space-y-3">
        <div className="card !rounded-2xl md:!rounded-3xl p-4 md:p-5 space-y-4">
            <div>
                <h3 className="font-extrabold text-white flex items-center gap-2"><${Icon} name="trophy" className="w-4 h-4 text-amber-300" />Start a Sellers' Cup</h3>
                <p className="text-xs text-slate-500 mt-1">Every seller with a Discord seller role (Verified Seller, Ambassador, Lead Ambassador) takes part automatically: ${view.eligible ?? 0} right now.
                    The seeding period starts the moment you press Start; sellers are seeded by orders completed on their own (ties: higher order value). Then head-to-head rounds, one after the other.</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
                <label className="block sm:col-span-2"><span className="label text-slate-500">Cup name</span><input className="input mt-1" maxLength="80" value=${form.name} onInput=${set('name')} /></label>
                <label className="block"><span className="label text-slate-500">Seeding period (days)</span><input className="input mt-1" type="number" min="0.5" max="90" step="0.5" value=${form.seedingDays} onInput=${set('seedingDays')} /></label>
                <label className="block"><span className="label text-slate-500">Each round (days)</span><input className="input mt-1" type="number" min="0.5" max="90" step="0.5" value=${form.roundDays} onInput=${set('roundDays')} /></label>
                <label className="block"><span className="label text-slate-500">Bracket size (empty = every seller)</span><input className="input mt-1" type="number" min="2" max="256" placeholder="Everyone" value=${form.bracketSize} onInput=${set('bracketSize')} /></label>
                <label className="block"><span className="label text-slate-500">Pairings</span>
                    <select className="input mt-1" value=${form.pairing} onChange=${set('pairing')}>
                        ${Object.entries(view.pairings || {}).map(([k, label]) => html`<option key=${k} value=${k}>${label}</option>`)}
                    </select></label>
                <label className="block sm:col-span-2"><span className="label text-slate-500">Discord channel ID for pairings and results</span>
                    <input className="input mt-1" inputmode="numeric" placeholder="e.g. 1234567890123456789" value=${form.channelId} onInput=${set('channelId')} />
                    <span className="block text-[11px] text-slate-500 mt-1">Right-click the channel → Copy Channel ID. The bot needs permission to post there. Empty = no Discord posts.</span></label>
            </div>
            <p className="text-xs text-slate-400">${field >= 2 ? `${field} sellers → ${Math.ceil(Math.log2(field))} round${Math.ceil(Math.log2(field)) === 1 ? '' : 's'}${field & (field - 1) ? ` (the top ${2 ** Math.ceil(Math.log2(field)) - field} seed${2 ** Math.ceil(Math.log2(field)) - field === 1 ? ' gets' : 's get'} a bye in round 1)` : ''}, about ${Math.round(Number(form.seedingDays) + Math.ceil(Math.log2(field)) * Number(form.roundDays))} days in total.` : 'At least 2 sellers are needed when seeding ends.'}</p>
            <${Button} icon="trophy" busy=${busy} onClick=${async () => {
                if (await ask({ title: `Start ${form.name}?`, confirmLabel: 'Start the Cup', message: `The seeding period starts now and the Cup is announced${form.channelId ? ' in the Cup channel, pinging every seller' : ''}.` })) {
                    run({ action: 'cup-start', ...form, bracketSize: form.bracketSize || null }, 'The Cup has started!');
                }
            }}>Start the Cup<//>
        </div>
        ${cup && html`<div className="card !rounded-2xl md:!rounded-3xl p-4 md:p-5">
            <p className="label text-slate-500 mb-1">Last Cup</p>
            <h3 className="font-extrabold text-white mb-3">${cup.name}</h3>
            <${CupDetails} view=${view} userId=${userId} />
        </div>`}
    </div>`;
}

// Admins' Sellers tab: the leaderboard, or the Cup.
function SellersTab({ userId, onOpenOrder }) {
    const [part, setPart] = useState('leaderboard');
    return html`<section className="space-y-3">
        <div className="flex p-1 rounded-full bg-slate-900 border border-slate-800 self-start w-max">
            ${[['leaderboard', 'Leaderboard', 'trophy'], ['cup', "Sellers' Cup", 'swords']].map(([k, label, icon]) => html`<button key=${k} onClick=${() => setPart(k)} aria-pressed=${part === k}
                className=${`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${part === k ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}><${Icon} name=${icon} className="w-3.5 h-3.5" />${label}</button>`)}
        </div>
        ${part === 'cup' ? html`<${CupAdmin} userId=${userId} />` : html`<${SellerStats} userId=${userId} onOpenOrder=${onOpenOrder} />`}
    </section>`;
}

// Same local-time greeting as the buyer site, with a one-line summary of the queue.
function SellerGreeting({ account, now, open, mine, unreadOrders = 0, onShowUnread }) {
    const date = new Date(now);
    const g = greetingFor(date);
    const name = account?.display_name || account?.discord_username || '';
    const oldest = open.reduce((m, o) => Math.min(m, queuedSince(o)), Infinity);
    const when = date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' +
        date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return html`<section>
        <p className="label text-sky-300 flex items-center gap-2"><${Icon} name=${g.icon} className="w-4 h-4" />${when}</p>
        <h1 className="text-2xl md:text-4xl font-black tracking-tight text-white mt-1.5 md:mt-2 truncate">${greetingLine(g, name)}</h1>
        <p className="text-sm text-slate-400 mt-1">${open.length
            ? t('{count} waiting for a seller · the longest for {time}.', { count: plural(open.length, 'order'), time: fmtDuration(now - oldest) })
            : t('The open queue is empty.')}${mine ? ` ${t('You have {count}.', { count: plural(mine, 'active order') })}` : ''}
            ${unreadOrders > 0 && html` <button type="button" onClick=${onShowUnread} title=${t('Show these orders')}
                className="font-bold text-sky-300 hover:text-white underline decoration-dotted underline-offset-4">💬 ${t('{count} with new buyer messages', { count: plural(unreadOrders, 'order') })}</button>`}</p>
    </section>`;
}

// Profile picture → small menu. Signing out needs this extra tap, so it can't happen by accident.
function AccountMenu({ account, seller, airlines, sellAs, onSellAs, onTour }) {
    const [open, setOpen] = useState(false);
    const [guideOpen, setGuideOpen] = useState(false);
    const [meow, setMeow] = useState(() => store.get(LS_MEOW, true));
    const toggleMeow = () => {
        store.set(LS_MEOW, !meow);
        setMeow(!meow);
        if (!meow) { lastMeow = 0; audio(); setTimeout(playMeow, 150); }   // turning it on plays a sample
    };
    const signOut = async () => {
        setOpen(false);
        if (await ask({ title: t('Sign out of the seller desk?'), confirmLabel: t('Sign out'), message: t("You'll need to sign in with Discord again to take orders.") })) sb.auth.signOut();
    };
    return html`<div className="relative">
        <button onClick=${() => setOpen(!open)} aria-label=${t('Account menu')} aria-expanded=${open} data-tour="account"
            className="flex items-center gap-1.5 h-10 pl-1 pr-2 rounded-full hover:bg-slate-800">
            <${Avatar} account=${account} /><${Icon} name="chevron-down" className="w-4 h-4 text-slate-500" />
        </button>
        ${open && html`<div className="fixed inset-0 z-40" onClick=${() => setOpen(false)}></div>
        <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-2 z-50 animate-pop">
            <div className="flex items-center gap-3 px-3 py-2.5 border-b border-slate-800 mb-1">
                <${Avatar} account=${account} size="w-10 h-10" />
                <div className="min-w-0">
                    <p className="font-bold text-sm text-white truncate">${account?.display_name || account?.discord_username || t('Signed in')}</p>
                    <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5"><${DiscordLogo} className="w-3.5 h-3.5" /> ${account?.discord_username || 'Discord'}</p>
                    <div className="mt-1.5"><${RankBadge} rank=${rankOf(seller)} admin=${seller?.is_admin} /></div>
                </div>
            </div>
            ${airlines.length > 0 && html`<label className="sm:hidden block px-3 py-2">
                <span className="block text-[11px] font-bold text-slate-500 mb-1">${t('Selling as')}</span>
                <select value=${sellAs?.id || ''} onChange=${(e) => onSellAs(e.target.value)} className="input !py-2">
                    ${airlines.map((a) => html`<option key=${a.id} value=${a.id}>${a.name} · ${a.alliance}</option>`)}
                </select>
            </label>`}
            <a href=${CONFIG.BUYER_URL || '#'} className="menu-item"><${Icon} name="shopping-bag" /> ${t('Open the market')}</a>
            <button onClick=${() => { setOpen(false); onTour?.(); }} className="menu-item w-full"><${Icon} name="compass" /> ${t('Show me around')}</button>
            <button onClick=${toggleMeow} aria-pressed=${meow} className="menu-item w-full">
                <${Icon} name=${meow ? 'volume-2' : 'volume-x'} /> <span className="flex-1 text-left">${t('Meow for new orders')}</span>
                <span className=${`text-[11px] font-bold ${meow ? 'text-sky-300' : 'text-slate-500'}`}>${meow ? t('On') : t('Off')}</span>
            </button>
            <button onClick=${() => { setOpen(false); setGuideOpen(true); }} className="menu-item w-full"><${Icon} name="book-open" /> ${t('Seller guide')}</button>
            <a href="/welcome.html?replay=1" className="menu-item"><${Icon} name="plane-takeoff" /> ${t('Seller welcome')}</a>
            <button onClick=${signOut} className="menu-item w-full text-rose-300"><${Icon} name="log-out" /> ${t('Sign out')}</button>
        </div>`}
        <${SellerGuide} open=${guideOpen} onClose=${() => setGuideOpen(false)} isAdmin=${Boolean(seller?.is_admin)} />
    </div>`;
}

// Every desk feature, one line each (seller/js/guide.js), with a search box. Admin tools only for admins.
function SellerGuide({ open, onClose, isAdmin }) {
    useLang();
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const sections = GUIDE.filter((s) => isAdmin || !s.admin)
        .map((s) => ({ ...s, items: s.items.filter(([name, text]) => !q || `${name} ${text}`.toLowerCase().includes(q)) }))
        .filter((s) => s.items.length);
    const note = t('The seller guide is shown in English.');
    return html`<${Modal} open=${open} onClose=${() => { setQuery(''); onClose(); }} title=${t('Seller guide')} subtitle=${t('Every seller desk feature, one line each.')} size="lg">
        <div className="space-y-4">
            ${note !== 'The seller guide is shown in English.' && html`<p className="text-xs text-slate-400 flex items-center gap-1.5"><${Icon} name="languages" className="w-3.5 h-3.5 shrink-0" /> ${note}</p>`}
            <label className="relative block">
                <span className="sr-only">${t('Search the guide')}</span>
                <${Icon} name="search" className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input type="search" value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder=${t('Search the guide')} className="input !pl-9" />
            </label>
            ${!sections.length ? html`<p className="text-sm text-slate-400 py-6 text-center">${t('Nothing in the guide matches your search.')}</p>`
            : sections.map((s) => html`<section key=${s.title} lang="en">
                <h3 className="flex items-center gap-2 text-sm font-extrabold text-white mb-1.5">
                    <span className="w-7 h-7 rounded-lg bg-sky-400/10 text-sky-300 flex items-center justify-center shrink-0"><${Icon} name=${s.icon} className="w-4 h-4" /></span>${s.title}</h3>
                ${s.note && html`<p className="text-[11px] text-slate-500 mb-1.5">${s.note}</p>`}
                <ul className="space-y-1.5 text-sm">
                    ${s.items.map(([name, text]) => html`<li key=${name} className="flex gap-2 text-slate-300">
                        <span className="text-slate-600 shrink-0" aria-hidden="true">•</span>
                        <span><span className="font-bold text-white">${name}:</span> ${text}</span>
                    </li>`)}
                </ul>
            </section>`)}
        </div>
    <//>`;
}

// The buyer airline's name, as a link to the buyer's Discord info.
function BuyerLink({ order, onBuyer }) {
    return html`<button type="button" title=${t("See the buyer's Discord info")}
        onClick=${(e) => { e.stopPropagation(); onBuyer(order); }}
        className="font-[inherit] text-left underline decoration-dotted decoration-slate-500 underline-offset-4 hover:text-sky-300 hover:decoration-sky-400">${airlineNames(order)}</button>`;
}

// Who is behind an order: Discord profile, plus everything they've ordered so far.
function BuyerModal({ order, orders, flags, onClose, onOpenOrder, isAdmin }) {
    const [buyer, setBuyer] = useState(undefined);   // undefined = loading, null = account gone
    useEffect(() => {
        if (!order.buyer_id) { setBuyer(null); return; }
        sb.from('accounts').select('*').eq('id', order.buyer_id).maybeSingle().then(({ data }) => setBuyer(data || null));
    }, [order.buyer_id]);
    const discordId = buyer?.discord_id || order.buyer_discord_id;
    const name = buyer?.display_name || buyer?.discord_username || order.buyer_name || t('Unknown buyer');
    const theirs = orders.filter((o) => (order.buyer_id ? o.buyer_id === order.buyer_id : o.buyer_discord_id === discordId))
        .sort((a, b) => ms(b.created_at) - ms(a.created_at));
    const [theirsShown, theirsBar] = usePaged(theirs);
    const count = (fn) => theirs.filter(fn).length;
    const airlines = [...new Map(theirs.flatMap(orderAirlines).map((a) => [a.name + '|' + a.alliance, a])).values()];
    const flagged = theirs.filter((o) => flags[o.id] && flags[o.id].status !== 'NORMAL');
    const copy = (text, msg) => { navigator.clipboard?.writeText(text); toast(msg); };
    const dm = !buyer ? null : buyer.dm_enabled === false ? t('turned off') : buyer.dm_status === 'blocked' ? t("can't reach them (DMs closed or not in the server)") : buyer.dm_status === 'ok' ? t('on') : t('on (not tried yet)');

    return html`<${Modal} open=${true} onClose=${onClose} size="md" title=${t('Buyer')} subtitle=${t('From {ref} · {airline}', { ref: orderRef(order), airline: airlineNames(order) })}>
        <div className="space-y-5">
            <div className="flex items-center gap-4">
                ${buyer === undefined ? html`<span className="w-14 h-14 rounded-full bg-slate-800 animate-pulse"></span>`
                    : html`<${Avatar} account=${buyer || { display_name: name }} size="w-14 h-14" />`}
                <div className="min-w-0">
                    <p className="text-lg font-extrabold text-white truncate">${name}</p>
                    ${buyer?.discord_username && html`<p className="text-sm text-slate-400 truncate">@${buyer.discord_username}</p>`}
                    ${buyer?.created_at && html`<p className="text-xs text-slate-500">${t('On Echo Market since {date}', { date: new Date(buyer.created_at).toLocaleDateString() })}</p>`}
                    ${buyer === null && html`<p className="text-xs text-amber-300">${t('This market account no longer exists.')}</p>`}
                </div>
            </div>

            ${discordId ? html`<div className="space-y-2">
                <div className="flex items-center gap-2 p-3 rounded-2xl bg-slate-950 border border-slate-800">
                    <span className="text-[#8b93ff]"><${DiscordLogo} /></span>
                    <span className="flex-1 min-w-0"><span className="block text-[11px] font-bold text-slate-500">${t('Discord user ID')}</span>
                        <span className="block font-mono text-sm text-slate-100 truncate">${discordId}</span></span>
                    <${Button} size="sm" variant="secondary" icon="copy" onClick=${() => copy(discordId, t('Discord ID copied.'))}>${t('Copy')}<//>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <a href=${`https://discord.com/users/${discordId}`} target="_blank" rel="noopener"
                        className="inline-flex items-center justify-center gap-2 rounded-full font-bold px-4 py-2.5 text-sm bg-[#5865F2] text-[#fff] hover:bg-[#4752C4]">
                        <${DiscordLogo} className="w-4 h-4" /> ${t('Open profile')}</a>
                    <${Button} variant="secondary" icon="at-sign" onClick=${() => copy(`<@${discordId}>`, t('Mention copied.'))}>${t('Copy @mention')}<//>
                </div>
                <p className="text-[11px] text-slate-500">${t('"Open profile" works when you share a Discord server with them. Paste the @mention in any Discord channel to ping them.')}</p>
            </div>` : html`<p className="text-sm text-slate-400">${t('No Discord ID was saved with this order.')}</p>`}

            ${dm && html`<p className="text-xs text-slate-400 flex items-center gap-1.5"><${Icon} name="bell" className="w-3.5 h-3.5" /> ${t('Bot DMs about their orders:')} <b className="text-slate-200">${dm}</b></p>`}

            <div>
                <p className="label text-slate-500 mb-2">${t('Their orders')}</p>
                <div className="grid grid-cols-4 gap-2 text-center">
                    ${[[t('Total'), theirs.length], [t('Active'), count((o) => ACTIVE_STATUSES.includes(o.status))],
                        [t('Delivered'), count((o) => o.status === 'FULFILLED')], [t('Closed'), count((o) => ['CANCELLED', 'DECLINED'].includes(o.status))]]
                        .map(([l, v]) => html`<div key=${l} className="p-2 rounded-xl bg-slate-950 border border-slate-800">
                            <p className="text-lg font-black text-white">${v}</p><p className="text-[10px] font-bold text-slate-500">${l}</p></div>`)}
                </div>
                <p className="text-xs text-slate-400 mt-2">${t('{count} received so far.', { count: plural(theirs.reduce((sum, o) => sum + (o.status === 'CANCELLED' || o.status === 'DECLINED' ? 0 : o.filled), 0), 'aircraft') })}</p>
                ${flagged.length > 0 && html`<p className="text-xs text-rose-300 mt-1 flex items-center gap-1.5"><${Icon} name="flag" className="w-3.5 h-3.5" />${t('{count} flagged by sellers.', { count: plural(flagged.length, 'order') })}</p>`}
            </div>

            ${airlines.length > 0 && html`<div>
                <p className="label text-slate-500 mb-2">${t('Airlines they ordered for')}</p>
                <div className="flex flex-wrap gap-1.5">${airlines.map((a) => html`<span key=${a.name + a.alliance} className="px-2.5 py-1 rounded-full bg-slate-800 text-xs font-bold text-slate-200">${a.name} <span className="text-slate-500">${a.alliance}</span></span>`)}</div>
            </div>`}

            ${theirs.length > 0 && html`<ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60">
                ${theirsShown.map((o) => html`<li key=${o.id}>
                    <button onClick=${() => onOpenOrder(o.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/40">
                        <span className="flex-1 min-w-0"><${OrderCode} order=${o} />
                            <span className="block text-xs text-slate-400 truncate">${airlineNames(o)} · ${plural(o.total_qty, 'aircraft')} · ${timeAgo(o.created_at)}</span></span>
                        <${StatusBadge} status=${displayStatus(o)} />
                    </button>
                </li>`)}
            </ul>`}
            ${theirsBar}

            ${isAdmin && discordId && html`<${ModerationPanel} target=${{ accountId: buyer?.id || order.buyer_id || null, discordId, name }} />`}
        </div>
    <//>`;
}

// ---------------------------------------------------------------- order messages (seller side)
function SellerThread({ order, messages, onMessage }) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const send = async () => {
        setBusy(true);
        try {
            const r = await api(`/api/orders/${order.id}`, { action: 'message', body: text.trim() });
            onMessage?.(r.message);
            setText('');
            toast(t('Sent. The buyer gets a notification and a Discord DM.'), 'success');
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    return html`<div className="space-y-2">
        ${!messages.length && html`<p className="text-xs text-slate-500">${t('No messages yet. Buyers can write once an order has waited 24 hours without being fully delivered; you can write to them any time.')}</p>`}
        ${messages.map((m) => html`<div key=${m.id} className=${`p-2.5 rounded-xl text-sm ${m.from_role === 'buyer' ? 'mr-8 bg-slate-800/70' : 'ml-8 bg-sky-500/10 border border-sky-500/20'}`}>
            <p className="text-[11px] text-slate-400">${m.author_name} · ${m.from_role === 'buyer' ? t('buyer') : t('seller team')} · ${fmtDate(m.created_at)}</p>
            <p className="text-slate-100 whitespace-pre-line break-words">${m.body}</p>
        </div>`)}
        <div className="flex gap-2 items-end">
            <textarea value=${text} maxLength="1000" rows="2" onChange=${(e) => setText(e.target.value)} className="input flex-1" placeholder=${t('Write to the buyer (they get a DM)')}></textarea>
            <${Button} size="sm" icon="send" busy=${busy} disabled=${!text.trim()} onClick=${send}>${t('Send')}<//>
        </div>
    </div>`;
}

// ---------------------------------------------------------------- moderation (admins)
const BAN_LENGTHS = [['week', '1 week'], ['month', '1 month'], ['permanent', 'Permanent']];
const banUntil = (b) => (b.ends_at ? `until ${fmtDate(b.ends_at)}` : 'permanent');
const isActiveBan = (b) => !b.revoked_at && (!b.ends_at || new Date(b.ends_at).getTime() > Date.now());
const deliveryText = (d = {}) => [d.dm === 'sent' ? 'DM sent' : d.dm && d.dm !== 'skipped' ? "DM couldn't be delivered" : null,
    d.role === true ? 'Market Banned role updated' : d.role === false ? 'role not changed (check the health page)' : null,
    d.logged ? 'logged' : d.logged === false ? 'not logged (no log channel)' : null].filter(Boolean).join(' · ');

// Ban / lift / message one person. target: { accountId, discordId, name }
// The buyer's disciplinary record at a glance on the order: warnings and bans, details one tap away.
function BuyerRecord({ discordId }) {
    const [data, setData] = useState(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (!discordId) return;
        Promise.all([
            sb.from('market_bans').select('*').eq('discord_id', discordId).order('created_at', { ascending: false }),
            sb.from('market_messages').select('*').eq('discord_id', discordId).eq('kind', 'warning').order('created_at', { ascending: false }).limit(50)
        ]).then(([b, m]) => setData({ bans: b.data || [], warnings: m.data || [] }));
    }, [discordId]);
    if (!discordId || !data) return null;
    const active = data.bans.find(isActiveBan);
    const n = data.warnings.length;
    const clean = !n && !data.bans.length;
    return html`<div className=${`rounded-2xl border px-3 py-2.5 text-sm ${active ? 'border-rose-500/40 bg-rose-500/[0.07]' : n ? 'border-amber-500/30 bg-amber-500/5' : 'border-slate-800 bg-slate-950/60'}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <${Icon} name=${clean ? 'shield-check' : 'shield-alert'} className=${`w-4 h-4 shrink-0 ${active ? 'text-rose-300' : n ? 'text-amber-300' : 'text-emerald-300'}`} />
            <span className="flex-1 min-w-0 text-slate-200">
                ${clean ? t('No warnings or bans on record.') : html`${tj('Buyer has {count} on record.', { count: html`<b className="text-white">${plural(n, 'warning')}</b>` })}${data.bans.length ? html` · ${active ? html`<b className="text-rose-200">${active.ends_at ? t('market banned until {date}', { date: fmtDate(active.ends_at) }) : t('market banned permanently')}</b>` : plural(data.bans.length, 'earlier ban')}` : ''}`}
            </span>
            ${!clean && html`<button type="button" onClick=${() => setOpen(!open)} aria-expanded=${open} className="text-xs font-bold text-slate-300 hover:text-white flex items-center gap-1">
                ${open ? t('Hide details') : t('Show details')}<${Icon} name=${open ? 'chevron-up' : 'chevron-down'} className="w-3.5 h-3.5" /></button>`}
        </div>
        ${open && html`<ul className="mt-2.5 pt-2.5 border-t border-slate-800 space-y-2">
            ${data.bans.map((b) => html`<li key=${'b' + b.id} className="text-xs">
                <p className=${isActiveBan(b) ? 'font-bold text-rose-200' : 'font-bold text-slate-300'}>⛔ ${t('Market ban ({length})', { length: t(b.duration) })}${isActiveBan(b) ? ` · ${b.ends_at ? t('until {date}', { date: fmtDate(b.ends_at) }) : t('permanent')}` : b.revoked_at ? ` · ${t('lifted')}` : ` · ${t('ended')}`}</p>
                <p className="text-slate-300">${b.reason}</p>
                <p className="text-slate-500">${b.issued_by_name || t('an admin')} · ${fmtDate(b.created_at)}</p>
            </li>`)}
            ${data.warnings.map((w) => html`<li key=${'w' + w.id} className="text-xs">
                <p className="font-bold text-amber-200">⚠️ ${t('Warning')}</p>
                <p className="text-slate-300 whitespace-pre-line break-words">${w.body}</p>
                <p className="text-slate-500">${w.sent_by_name || t('Market Admins')}${w.source === 'theft' ? ` · ${t('automatic (plane theft)')}` : w.source === 'bot' ? ` · ${t('via Discord')}` : ''} · ${fmtDate(w.created_at)}</p>
            </li>`)}
        </ul>`}
    </div>`;
}

function ModerationPanel({ target, onChanged }) {
    const [bans, setBans] = useState(null);
    const [msgs, setMsgs] = useState([]);
    const [dialog, setDialog] = useState(null);   // 'ban' | 'message'
    const load = useCallback(async () => {
        const [b, m] = await Promise.all([
            sb.from('market_bans').select('*').eq('discord_id', target.discordId).order('created_at', { ascending: false }),
            sb.from('market_messages').select('*').eq('discord_id', target.discordId).order('created_at', { ascending: false }).limit(20)
        ]);
        setBans(b.data || []); setMsgs(m.data || []);
    }, [target.discordId]);
    useEffect(() => { load(); }, [load]);
    const active = (bans || []).find(isActiveBan);
    const warnings = msgs.filter((m) => m.kind === 'warning');
    const lift = async () => {
        const note = await ask({ title: `Lift ${target.name}'s market ban?`, confirmLabel: 'Lift ban', message: 'They can use Echo Market again straight away and get a DM.', input: { required: false, placeholder: 'Optional note (shown to them)' } });
        if (note === false) return;
        try { const r = await api('/api/admin/moderation', { action: 'unban', banId: active.id, note }); toast(`Ban lifted. ${deliveryText(r.delivery)}`, 'success'); load(); onChanged?.(); }
        catch (err) { toast(err.message, 'error'); }
    };
    return html`<div className="p-3 rounded-2xl border border-slate-800 bg-slate-950/60 space-y-3">
        <p className="label text-slate-500 flex items-center gap-1.5"><${Icon} name="shield" className="w-3.5 h-3.5" />Moderation · admins only</p>
        ${bans === null ? html`<${EchoLoader} size="sm" className="py-6" />` : html`
            ${active ? html`<div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-sm">
                <p className="font-bold text-rose-200">Market banned ${banUntil(active)}</p>
                <p className="text-rose-100/80 text-xs mt-0.5">${active.reason} · by ${active.issued_by_name || 'an admin'}${active.source === 'bot' ? ' (bot)' : ''}</p>
            </div>` : html`<p className="text-sm text-slate-300">Not banned.${bans.length ? ` ${plural(bans.length, 'earlier ban')}.` : ''}</p>`}
            <p className="text-xs text-slate-400">${plural(warnings.length, 'warning')} · ${plural(msgs.length - warnings.length, 'info message')}${msgs[0] ? ` · last ${timeAgo(msgs[0].created_at)}` : ''}</p>
            <div className="flex flex-wrap gap-2">
                <${Button} size="sm" variant="secondary" icon="megaphone" onClick=${() => setDialog('message')}>Send message<//>
                ${active ? html`<${Button} size="sm" variant="secondary" icon="undo-2" onClick=${lift}>Lift ban<//>`
                    : html`<${Button} size="sm" variant="danger" icon="ban" onClick=${() => setDialog('ban')}>Market ban<//>`}
            </div>`}
        ${dialog === 'ban' && html`<${BanDialog} target=${target} onClose=${() => setDialog(null)} onDone=${() => { setDialog(null); load(); onChanged?.(); }} />`}
        ${dialog === 'message' && html`<${MessageDialog} target=${target} onClose=${() => setDialog(null)} onDone=${() => { setDialog(null); load(); onChanged?.(); }} />`}
    </div>`;
}

function BanDialog({ target, onClose, onDone }) {
    const [duration, setDuration] = useState('week');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            const r = await api('/api/admin/moderation', { action: 'ban', accountId: target.accountId || undefined, discordId: target.discordId, duration, reason: reason.trim() });
            toast(`${target.name} is banned from the market. ${deliveryText(r.delivery)}`, 'success');
            onDone();
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    return html`<${Modal} open=${true} onClose=${onClose} size="sm" title=${`Market ban: ${target.name}`}
        subtitle="Covers every airline of this Discord account. They get a DM and the Market Banned role; it's logged."
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Button} variant="danger" icon="ban" busy=${busy} disabled=${!reason.trim()} onClick=${save}>Ban from the market<//>`}>
        <p className="field-label">How long</p>
        <div className="grid grid-cols-3 gap-1.5">${BAN_LENGTHS.map(([k, label]) => html`<button key=${k} type="button" onClick=${() => setDuration(k)}
            className=${`py-2.5 rounded-xl border text-sm font-bold ${duration === k ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>${label}</button>`)}</div>
        <label className="block mt-4"><span className="field-label">Reason (they will see it)</span>
            <textarea value=${reason} rows="3" maxLength="500" onChange=${(e) => setReason(e.target.value)} className="input" placeholder="Which rule was broken"></textarea></label>
    <//>`;
}

function MessageDialog({ target, onClose, onDone }) {
    const [kind, setKind] = useState('info');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            const r = await api('/api/admin/moderation', { action: 'message', accountId: target.accountId || undefined, discordId: target.discordId, kind, body: text.trim() });
            toast(`${kind === 'warning' ? 'Warning' : 'Message'} sent. ${deliveryText(r.delivery)}`, 'success');
            onDone();
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    return html`<${Modal} open=${true} onClose=${onClose} size="sm" title=${`Message ${target.name}`}
        subtitle="Shown in their Echo Market notifications and sent as a Discord DM."
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Button} variant=${kind === 'warning' ? 'danger' : 'primary'} icon="send" busy=${busy} disabled=${!text.trim()} onClick=${save}>Send ${kind === 'warning' ? 'warning' : 'message'}<//>`}>
        <div className="grid grid-cols-2 gap-1.5">${[['info', 'Information'], ['warning', 'Warning']].map(([k, label]) => html`<button key=${k} type="button" onClick=${() => setKind(k)}
            className=${`py-2.5 rounded-xl border text-sm font-bold ${kind === k ? (k === 'warning' ? 'bg-rose-500 text-[#fff] border-rose-500' : 'bg-white text-slate-950 border-white') : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>${label}</button>`)}</div>
        <textarea value=${text} rows="4" maxLength="1500" onChange=${(e) => setText(e.target.value)} className="input mt-4"
            placeholder=${kind === 'warning' ? 'What they did and what happens if it continues' : 'Your message'}></textarea>
        ${kind === 'warning' && html`<p className="text-[11px] text-slate-500 mt-2">Warnings are also posted in the moderation log channel.</p>`}
    <//>`;
}

// The bot's slash commands (/market, /airline, /order): install / update them, and choose the channel(s)
// where buyers may use /order and /airline. Saved on the server, so changing channel needs no redeploy.
function DiscordCommandsCard() {
    const [state, setState] = useState(null);   // null = checking, { commands, orderChannels } or { error }
    const [busy, setBusy] = useState('');
    const [channelText, setChannelText] = useState('');
    const run = async (action, extra = {}) => {
        setBusy(action);
        try {
            const r = await api('/api/admin/discord-commands', { action, ...extra });
            setState({ commands: r.commands, orderChannels: r.orderChannels || [] });
            setChannelText((r.orderChannels || []).map((c) => c.id).join(', '));
            if (action === 'install') toast('Discord commands installed.', 'success');
            if (action === 'channel') toast(r.orderChannels?.length ? `Buyers can now order only in ${r.orderChannels.map((c) => '#' + c.name).join(', ')}.` : 'Buyers can now order in any channel.', 'success');
        } catch (err) {
            if (action === 'status') setState({ error: err.message }); else toast(err.message, 'error');
        } finally { setBusy(''); }
    };
    useEffect(() => { run('status'); }, []);
    const cmdText = !state ? 'Checking…' : state.error ? state.error
        : state.commands.length ? `Installed: ${state.commands.join(', ')}` : 'Not installed yet: /market (Market Admins), /airline and /order.';
    const channels = state?.orderChannels || [];
    return html`<div className="card p-4 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0">
                <p className="font-bold text-white text-sm flex items-center gap-2"><${DiscordLogo} className="w-4 h-4" /> Discord bot commands</p>
                <p className="text-xs text-slate-400 mt-0.5">${cmdText}</p>
            </div>
            <${Button} size="sm" variant="secondary" icon="refresh-cw" busy=${busy === 'install'} onClick=${() => run('install')}>${state?.commands?.length ? 'Update commands' : 'Install commands'}<//>
        </div>
        ${state && !state.error && html`<div className="pt-3 border-t border-slate-800 space-y-2">
            <p className="text-sm text-slate-200"><b>Ordering channel:</b> ${channels.length
                ? channels.map((c) => c.error ? html`<span key=${c.id} className="text-rose-300"> ${c.error}</span>` : html`<span key=${c.id} className="font-mono text-sky-300"> #${c.name}</span>`)
                : html`<span className="text-amber-300"> any channel (not restricted)</span>`}</p>
            <p className="text-[11px] text-slate-500">Buyers can use /order and /airline only here; elsewhere the bot tells them where to go. /market works in any channel for Market Admins. Right-click the channel → Copy Channel ID. Several: separate with commas. Empty = any channel.</p>
            <div className="flex gap-2">
                <input value=${channelText} onChange=${(e) => setChannelText(e.target.value)} placeholder="Channel ID, e.g. 1234567890123456789" className="input font-mono" />
                <${Button} size="sm" icon="check" busy=${busy === 'channel'} onClick=${() => run('channel', { channelIds: channelText })}>Save<//>
            </div>
        </div>`}
    </div>`;
}

// The Moderation tab: active bans, recent messages, and banning/messaging anyone by Discord ID
// (also people who never used the market).
function ModerationView({ userId }) {
    const [bans, setBans] = useState(null);
    const [msgs, setMsgs] = useState([]);
    const [people, setPeople] = useState({});
    const [discordId, setDiscordId] = useState('');
    const [target, setTarget] = useState(null);
    const load = useCallback(async () => {
        const [b, m] = await Promise.all([
            sb.from('market_bans').select('*').is('revoked_at', null).order('created_at', { ascending: false }).limit(200),
            sb.from('market_messages').select('*').order('created_at', { ascending: false }).limit(30)
        ]);
        const active = (b.data || []).filter(isActiveBan);
        setBans(active); setMsgs(m.data || []);
        const ids = [...new Set([...active, ...(m.data || [])].map((x) => x.discord_id))];
        if (ids.length) {
            const { data } = await sb.from('accounts').select('id, discord_id, display_name, discord_username, avatar_url').in('discord_id', ids);
            setPeople(Object.fromEntries((data || []).map((a) => [a.discord_id, a])));
        }
    }, []);
    useEffect(() => { load(); }, [load]);
    const who = (id) => people[id]?.display_name || people[id]?.discord_username || `Discord user ${id}`;
    const pick = (id) => setTarget({ accountId: people[id]?.id || null, discordId: id, name: who(id) });
    const lookUp = async () => {
        const id = discordId.trim();
        if (!/^\d{5,25}$/.test(id)) return toast('Paste a Discord user ID (numbers only): right-click the user → Copy User ID.', 'error');
        const { data } = await sb.from('accounts').select('id, discord_id, display_name, discord_username').eq('discord_id', id).maybeSingle();
        const who = data ? null : await lookupDiscord(id);   // not on the market: ask Discord for the username
        const username = data?.discord_username || (who?.found ? who.username : null);
        const name = data?.display_name || who?.name || username || `Discord user ${id}`;
        setTarget({ accountId: data?.id || null, discordId: id, name: username && name !== username ? `${name} (@${username})` : username ? `@${username}` : name });
    };
    return html`<section className="space-y-4">
        <div>
            <h2 className="text-lg font-extrabold text-white">Moderation</h2>
            <p className="text-xs text-slate-500">Admins only. Market bans cover every airline of a Discord account. Everything here is DMed to the person and logged.</p>
        </div>
        <${DiscordCommandsCard} />
        <div className="card p-4 space-y-2">
            <p className="field-label !mb-0">Ban or message anyone by Discord ID (also people who never used the market)</p>
            <div className="flex gap-2">
                <input value=${discordId} onChange=${(e) => setDiscordId(e.target.value)} placeholder="Discord user ID, e.g. 526234727321960450" className="input font-mono" />
                <${Button} icon="search" onClick=${lookUp}>Open<//>
            </div>
            <${DiscordName} id=${discordId} min=${5} />
            <p className="text-[11px] text-slate-500">Or click a buyer's airline name on any order.</p>
        </div>
        ${target && html`<${Modal} open=${true} onClose=${() => setTarget(null)} size="sm" title=${target.name} subtitle=${`Discord ID ${target.discordId}`}>
            <${ModerationPanel} target=${target} onChanged=${load} />
        <//>`}
        <div>
            <p className="label text-slate-500 mb-2">Active market bans (${bans ? bans.length : '…'})</p>
            ${bans === null ? html`<${EchoLoader} size="sm" className="py-6" />` : !bans.length ? html`<p className="text-sm text-slate-400">Nobody is banned right now.</p>`
            : html`<ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60">${bans.map((b) => html`<li key=${b.id}>
                <button onClick=${() => pick(b.discord_id)} className="w-full text-left px-3 py-2.5 hover:bg-slate-800/40">
                    <span className="block font-bold text-white text-sm">${who(b.discord_id)} <span className="text-rose-300 font-medium text-xs">· ${banUntil(b)}</span></span>
                    <span className="block text-xs text-slate-400 truncate">${b.reason} · by ${b.issued_by_name || 'an admin'} · ${timeAgo(b.created_at)}</span>
                </button></li>`)}</ul>`}
        </div>
        <div>
            <p className="label text-slate-500 mb-2">Recent messages and warnings</p>
            ${!msgs.length ? html`<p className="text-sm text-slate-400">None yet.</p>`
            : html`<ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60">${msgs.map((m) => html`<li key=${m.id}>
                <button onClick=${() => pick(m.discord_id)} className="w-full text-left px-3 py-2.5 hover:bg-slate-800/40">
                    <span className="block text-sm text-white"><b>${who(m.discord_id)}</b> <span className=${m.kind === 'warning' ? 'text-rose-300 text-xs' : 'text-slate-400 text-xs'}>· ${m.kind === 'warning' ? 'warning' : 'info'}</span></span>
                    <span className="block text-xs text-slate-400 truncate">${m.body} · by ${m.sent_by_name || 'an admin'} · ${timeAgo(m.created_at)}</span>
                </button></li>`)}</ul>`}
        </div>
    </section>`;
}

// =========================================================================
//  Community (admins and Lead Ambassadors): pop-up announcements for buyers, daily budget rewards, alert list.
// =========================================================================
const usdB = (n) => `$${Math.round(n / 1e9)}B`;
function CommunityView({ onAlertsChanged }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const load = useCallback(async () => {
        try { const r = await api('/api/admin/community', { action: 'list' }); setData(r); setError(''); onAlertsChanged?.(r.watchlist || []); }
        catch (err) { setError(err.message); }
    }, []);
    useEffect(() => { load(); }, [load]);
    const run = async (payload, success) => {
        try { const r = await api('/api/admin/community', payload); toast(typeof success === 'function' ? success(r) : success, 'success'); await load(); return true; }
        catch (err) { toast(err.message, 'error'); return false; }
    };
    if (error) return html`<div className="card p-5 text-sm text-rose-200">${error}</div>`;
    if (!data) return html`<${EchoLoader} className="py-16" />`;
    return html`<div className="grid lg:grid-cols-2 gap-4 items-start">
        <${AnnouncementsCard} items=${data.announcements} run=${run} />
        <${AlertListCard} items=${data.watchlist} run=${run} />
        <div className="lg:col-span-2"><${RewardsCard} data=${data} run=${run} /></div>
    </div>`;
}

function AnnouncementsCard({ items, run }) {
    const [title, setTitle] = useState('');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const post = async () => {
        setBusy(true);
        if (await run({ action: 'announce', title: title.trim(), body: text.trim() }, 'Posted. Buyers see it as a pop-up the next time they open the market (live for those online).')) { setTitle(''); setText(''); }
        setBusy(false);
    };
    return html`<section className="card p-4 space-y-3">
        <div><p className="font-bold text-white flex items-center gap-2"><${Icon} name="megaphone" className="w-4 h-4" /> Announcements</p>
            <p className="text-xs text-slate-400 mt-0.5">A pop-up for every buyer (once each), and a banner on their home page until you delete it.</p></div>
        <input value=${title} maxLength="100" onChange=${(e) => setTitle(e.target.value)} className="input" placeholder="Title (optional), e.g. Fewer sellers this week" />
        <textarea value=${text} maxLength="1500" rows="3" onChange=${(e) => setText(e.target.value)} className="input"
            placeholder="e.g. Due to special circumstances, there are fewer active sellers than normal. Orders may take longer this week."></textarea>
        <div className="flex justify-end"><${Button} size="sm" icon="send" busy=${busy} disabled=${!text.trim()} onClick=${post}>Post to all buyers<//></div>
        ${items.length > 0 && html`<ul className="space-y-2 pt-2 border-t border-slate-800">${items.map((a) => html`<li key=${a.id} className="flex gap-2 items-start">
            <div className="flex-1 min-w-0"><p className="text-sm font-bold text-white">${a.title || 'Notice from the Market Admins'}</p>
                <p className="text-xs text-slate-300 whitespace-pre-line break-words">${a.body}</p>
                <p className="text-[11px] text-slate-500">${a.created_by_name} · ${timeAgo(a.created_at)}</p></div>
            <${Button} size="sm" variant="ghost" icon="trash-2" className="!text-rose-300" onClick=${async () => {
                if (await ask({ title: 'Delete this announcement?', message: 'Buyers will no longer see it.', confirmLabel: 'Delete', danger: true })) run({ action: 'announce-delete', id: a.id }, 'Announcement deleted.');
            }}>Delete<//>
        </li>`)}</ul>`}
    </section>`;
}

function AlertListCard({ items, run }) {
    const [id, setId] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const idOk = /^\d{17,20}$/.test(id.trim());
    const add = async () => {
        setBusy(true);
        if (await run({ action: 'watch-add', discordId: id.trim(), reason: reason.trim() }, (r) => `Added to the alert list${r.openOrders ? `; ${r.openOrders} open order${r.openOrders === 1 ? '' : 's'} now carry the warning` : ''}.`)) { setId(''); setReason(''); }
        setBusy(false);
    };
    return html`<section className="card p-4 space-y-3">
        <div><p className="font-bold text-white flex items-center gap-2"><${Icon} name="eye" className="w-4 h-4" /> Alert list</p>
            <p className="text-xs text-slate-400 mt-0.5">Orders from these Discord accounts warn the sellers (seller desk and Discord): "be cautious and check with the admins". The reason is for admins and Lead Ambassadors only; the buyer is never told.</p></div>
        <input value=${id} onChange=${(e) => setId(e.target.value)} inputMode="numeric" className="input font-mono" placeholder="Discord user ID, e.g. 123456789012345678" />
        <${DiscordName} id=${id} />
        <input value=${reason} maxLength="500" onChange=${(e) => setReason(e.target.value)} className="input" placeholder="Reason, e.g. possible spy from a rival alliance" />
        <div className="flex justify-end"><${Button} size="sm" icon="eye" busy=${busy} disabled=${!idOk || !reason.trim()} onClick=${add}>Add to alert list<//></div>
        ${items.length > 0 && html`<ul className="space-y-2 pt-2 border-t border-slate-800">${items.map((w) => html`<li key=${w.id} className="flex gap-2 items-start">
            <div className="flex-1 min-w-0"><p className="text-sm text-white"><b>${w.name || 'Not on the market yet'}</b> <span className="font-mono text-xs text-slate-500">${w.discord_id}</span></p>
                <p className="text-xs text-amber-200/90">${w.reason}</p>
                <p className="text-[11px] text-slate-500">${w.added_by_name} · ${timeAgo(w.created_at)}</p></div>
            <${Button} size="sm" variant="ghost" icon="x" onClick=${async () => {
                if (await ask({ title: 'Remove from the alert list?', message: 'Their open orders lose the caution warning.', confirmLabel: 'Remove' })) run({ action: 'watch-remove', id: w.id }, 'Removed from the alert list.');
            }}>Remove<//>
        </li>`)}</ul>`}
    </section>`;
}

function RewardsCard({ data, run }) {
    const [id, setId] = useState('');
    const [tier, setTier] = useState(1);
    const [reason, setReason] = useState('');
    const [never, setNever] = useState(true);
    const [until, setUntil] = useState('');
    const [busy, setBusy] = useState(false);
    const tiers = data.tiers || {};
    const idOk = /^\d{17,20}$/.test(id.trim());
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const grant = async () => {
        setBusy(true);
        const ok = await run({ action: 'reward-grant', discordId: id.trim(), tier, reason: reason.trim(), expiresAt: never ? null : new Date(until + 'T23:59:59Z').toISOString() },
            (r) => `Reward granted. The buyer sees a "thank you" pop-up${r.dm === 'sent' ? ' and got a DM' : ''}.`);
        if (ok) { setId(''); setReason(''); setUntil(''); setNever(true); }
        setBusy(false);
    };
    return html`<section className="card p-4 space-y-3">
        <div><p className="font-bold text-white flex items-center gap-2"><${Icon} name="gift" className="w-4 h-4" /> Daily budget rewards</p>
            <p className="text-xs text-slate-400 mt-0.5">Raise a market user's 24-hour limit as a thank-you for their activity. Tier 0 is ${usdB(tiers[0]?.limit || 10e9)} for everyone; server boosters get Tier 3 automatically. They get a celebration pop-up; the reason stays with the admins.</p></div>
        <div className="grid sm:grid-cols-4 gap-1.5">${[0, 1, 2, 3].map((t) => html`<div key=${t} className=${`p-2.5 rounded-xl border text-center ${t === 1 || t === 2 ? 'border-slate-700' : 'border-slate-800 opacity-70'}`}>
            <p className="text-xs font-black text-white">Tier ${t} · ${usdB(tiers[t]?.limit || 0)}</p>
            <p className="text-[10px] text-slate-400">${t === 0 ? 'everyone (default)' : t === 1 ? 'active members · Tier 1 role or granted' : t === 2 ? 'big contribution / even more active · Tier 2 role or granted' : 'server boosters (automatic)'}</p>
        </div>`)}</div>
        <div className="grid sm:grid-cols-2 gap-2">
            <div className="space-y-1">
                <input value=${id} onChange=${(e) => setId(e.target.value)} inputMode="numeric" className="input font-mono" placeholder="Discord user ID (must be on the market)" />
                <${DiscordName} id=${id} />
            </div>
            <div className="grid grid-cols-2 gap-1.5">${[1, 2].map((t) => html`<button key=${t} type="button" onClick=${() => setTier(t)}
                className=${`py-2 rounded-xl border text-xs font-bold ${tier === t ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>Tier ${t} · ${usdB(tiers[t]?.limit || 0)}</button>`)}</div>
        </div>
        <input value=${reason} maxLength="500" onChange=${(e) => setReason(e.target.value)} className="input" placeholder="Reason (admins only), e.g. very active in events this month" />
        <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-200"><input type="checkbox" checked=${never} onChange=${(e) => setNever(e.target.checked)} /> Never ends</label>
            ${!never && html`<label className="flex items-center gap-2 text-xs text-slate-300">Ends on <input type="date" min=${tomorrow} value=${until} onChange=${(e) => setUntil(e.target.value)} className="input !py-1.5 !w-auto" /></label>`}
            <span className="flex-1"></span>
            <${Button} size="sm" icon="gift" busy=${busy} disabled=${!idOk || !reason.trim() || (!never && !until)} onClick=${grant}>Grant reward<//>
        </div>
        <div className="grid md:grid-cols-2 gap-3 pt-2 border-t border-slate-800">
            <div>
                <p className="label text-slate-500 mb-1.5">Active rewards (${data.rewards.length})</p>
                ${!data.rewards.length ? html`<p className="text-xs text-slate-500">None yet.</p>`
                : html`<ul className="space-y-2">${data.rewards.map((r) => html`<li key=${r.id} className="flex gap-2 items-start">
                    <div className="flex-1 min-w-0"><p className="text-sm text-white"><b>${r.name || r.discord_id}</b> · Tier ${r.tier} (${usdB(tiers[r.tier]?.limit || 0)})</p>
                        <p className="text-xs text-slate-300">${r.reason}</p>
                        <p className="text-[11px] text-slate-500">${r.granted_by_name} · ${r.expires_at ? `until ${fmtDate(r.expires_at)}` : 'no end date'}</p></div>
                    <${Button} size="sm" variant="ghost" icon="x" onClick=${async () => {
                        if (await ask({ title: 'End this reward now?', message: 'Their daily budget goes back to their normal tier.', confirmLabel: 'End reward' })) run({ action: 'reward-revoke', id: r.id }, 'Reward ended.');
                    }}>End<//>
                </li>`)}</ul>`}
            </div>
            <div>
                ${(data.roleTiers || []).length > 0 && html`<p className="label text-slate-500 mb-1.5">From Discord roles (${data.roleTiers.length})</p>
                <ul className="space-y-1 mb-3">${data.roleTiers.map((m) => html`<li key=${m.discord_id} className="text-sm text-white">${m.name} <span className="text-xs text-slate-400">· Tier ${m.tier} (${usdB(tiers[m.tier]?.limit || 0)})</span> <span className="font-mono text-xs text-slate-500">${m.discord_id}</span></li>`)}</ul>`}
                <p className="label text-slate-500 mb-1.5">Server boosters · Tier 3 (${data.boosters.length})</p>
                ${!data.boosters.length ? html`<p className="text-xs text-slate-500">Nobody yet. Boosters are picked up automatically when they open the market.</p>`
                : html`<ul className="space-y-1">${data.boosters.map((b) => html`<li key=${b.discord_id} className="text-sm text-white">💜 ${b.name} <span className="font-mono text-xs text-slate-500">${b.discord_id}</span></li>`)}</ul>`}
            </div>
        </div>
    </section>`;
}

// Admin tools, one tap away on the desk's front page (instead of at the end of a scrolling tab bar).
// Every seller: the theft reports (identify and warn culprits) and the alliance statistics. Admins also get their tools.
const THEFT_TOOL = { tab: 'thefts', icon: 'shield-alert', get label() { return t('Theft reports'); }, get hint() { return t('Identify and warn culprits'); } };
const ALLIANCES_TOOL = { tab: 'alliances', icon: 'chart-column', get label() { return t('Alliances'); }, get hint() { return t('Who orders the most'); } };
// (The admin tools below stay in English, like the admin screens they open.)
const ADMIN_TOOLS = [
    { tab: 'team', icon: 'trophy', label: 'Sellers', hint: "Leaderboard, Sellers' Cup" },
    { tab: 'mod', icon: 'shield', label: 'Moderation', hint: 'Bans, warnings, bot' },
    { tab: 'community', icon: 'sparkles', label: 'Community', hint: 'Rewards, notices, alert list' }
];
// Phones: the order tabs as big buttons at the top, in the same style as the admin tools (desktop keeps the tab bar).
function OrderTabButtons({ tab, setTab, tabs, counts }) {
    return html`<nav aria-label=${t('Orders')} className="md:hidden grid grid-cols-3 gap-2">
        ${ORDER_TABS.map((k) => {
            const on = tab === k;
            return html`<button key=${k} onClick=${() => setTab(k)} aria-pressed=${on} data-tour=${'tab-' + k}
                className=${`flex flex-col items-center gap-1.5 p-2.5 rounded-2xl border text-center transition-colors ${on ? 'bg-white text-slate-950 border-white' : 'bg-slate-900/80 border-slate-800 text-slate-200 hover:border-slate-600'}`}>
                <span className=${`relative w-8 h-8 shrink-0 rounded-xl flex items-center justify-center ${on ? 'bg-slate-950/10' : 'bg-sky-400/10 text-sky-300'}`}>
                    <${Icon} name=${tabs[k].icon} className="w-4 h-4" />
                    ${counts[k] > 0 && html`<span className=${`absolute -top-1.5 -right-2 min-w-5 h-5 px-1 rounded-full text-[10px] font-black flex items-center justify-center ${on ? 'bg-slate-950 text-white' : 'bg-sky-400 text-slate-950'}`}>${counts[k]}</span>`}
                </span>
                <span className="block text-xs font-extrabold">${tabs[k].label}</span>
            </button>`;
        })}
    </nav>`;
}

function AdminShortcuts({ tab, setTab, isAdmin, theftHint = '' }) {
    const tools = isAdmin ? [THEFT_TOOL, ALLIANCES_TOOL, ...ADMIN_TOOLS] : [THEFT_TOOL, ALLIANCES_TOOL];
    return html`<nav aria-label=${t('Theft reports')} className=${`grid gap-2 ${isAdmin ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5' : 'grid-cols-2'}`}>
        ${tools.map((tool) => {
            const hint = tool.tab === 'thefts' && theftHint ? theftHint : tool.hint;
            const alert = tool.tab === 'thefts' && theftHint;
            const on = tab === tool.tab;
            return html`<button key=${tool.tab} onClick=${() => setTab(on ? 'open' : tool.tab)} aria-pressed=${on}
                className=${`flex flex-col sm:flex-row items-center gap-1.5 sm:gap-2.5 p-2.5 md:p-3 rounded-2xl border text-center sm:text-left transition-colors ${on ? 'bg-white text-slate-950 border-white' : 'bg-slate-900/80 border-slate-800 text-slate-200 hover:border-slate-600'}`}>
                <span className=${`w-8 h-8 md:w-9 md:h-9 shrink-0 rounded-xl flex items-center justify-center ${on ? 'bg-slate-950/10' : alert ? 'bg-rose-500/15 text-rose-300' : 'bg-sky-400/10 text-sky-300'}`}><${Icon} name=${tool.icon} className="w-4 h-4" /></span>
                <span className="min-w-0">
                    <span className="block text-xs sm:text-sm font-extrabold sm:truncate">${tool.label}</span>
                    <span className=${`${isAdmin ? 'hidden sm:block' : 'block'} text-[11px] truncate ${on ? 'text-slate-600' : alert ? 'text-rose-300' : 'text-slate-500'}`}>${on ? t('Open · tap to go back to orders') : hint}</span>
                </span>
            </button>`;
        })}
    </nav>`;
}

// Sort / filter panel for the order lists: alliance, number of aircraft types, number of aircraft, list value.
function OrderFilters({ filters, alliances, tab, statusFilter, setStatusFilter, open, onChange, onToggle, shown, total }) {
    const set = (patch) => onChange({ ...filters, ...patch });
    const count = activeFilterCount(filters);
    if (!open) {
        return html`<div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 -mt-1">
            <${Icon} name="sliders-horizontal" className="w-3.5 h-3.5" />
            <span>${t('{count} on · showing {shown} of {total}', { count: plural(count, 'filter'), shown, total })}</span>
            <button onClick=${onToggle} className="font-bold text-slate-200 hover:text-white">${t('Edit')}</button>
            <button onClick=${() => onChange({ ...NO_FILTERS })} className="font-bold text-rose-300 hover:text-rose-200">${t('Clear')}</button>
        </div>`;
    }
    const range = (minKey, maxKey, unit, step) => html`<div className="flex items-center gap-1.5">
        <input type="number" min="0" step=${step} value=${filters[minKey]} onChange=${(e) => set({ [minKey]: e.target.value })} placeholder=${t('min')} className="input !py-2 text-sm" aria-label=${t('Minimum {what}', { what: unit })} />
        <span className="text-slate-500 text-xs">${t('to')}</span>
        <input type="number" min="0" step=${step} value=${filters[maxKey]} onChange=${(e) => set({ [maxKey]: e.target.value })} placeholder=${t('max')} className="input !py-2 text-sm" aria-label=${t('Maximum {what}', { what: unit })} />
    </div>`;
    return html`<section className="card p-3 md:p-4 space-y-3">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block"><span className="field-label">${t('Alliance (buyer can receive in)')}</span>
                <select value=${filters.alliance} onChange=${(e) => set({ alliance: e.target.value })} className="input !py-2 text-sm">
                    <option value="">${t('Any alliance')}</option>
                    ${alliances.map((a) => html`<option key=${a} value=${a}>${a}</option>`)}
                </select></label>
            <div><span className="field-label">${t('Aircraft types in the order')}</span>
                <div className="grid grid-cols-4 gap-1">${[['', t('Any')], ['1', '1'], ['2', '2'], ['3', '3+']].map(([v, l]) => html`<button key=${v || 'any'} type="button" onClick=${() => set({ types: v })}
                    className=${`py-2 rounded-xl border text-xs font-bold ${filters.types === v ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>${l}</button>`)}</div></div>
            <div><span className="field-label">${t('Number of aircraft')}</span>${range('qtyMin', 'qtyMax', t('aircraft'), 1)}</div>
            <div><span className="field-label">${t('List value ($ millions)')}</span>${range('listMin', 'listMax', t('list value in millions'), 50)}</div>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-slate-200 cursor-pointer w-fit">
            <input type="checkbox" checked=${filters.mineOnly === true} onChange=${(e) => set({ mineOnly: e.target.checked })} className="w-4 h-4 accent-sky-400" />
            ${t('Only orders I delivered on')} <span className="text-xs text-slate-500">${t('(partly or fully, also after taking over or passing on)')}</span>
        </label>
        <label className="flex items-center gap-2.5 text-sm text-slate-200 cursor-pointer w-fit">
            <input type="checkbox" checked=${filters.unreadOnly === true} onChange=${(e) => set({ unreadOnly: e.target.checked })} className="w-4 h-4 accent-sky-400" />
            ${t('Only orders with new buyer messages')}
        </label>
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800">
            ${tab === 'all' && html`<label className="flex items-center gap-2 text-xs text-slate-400 min-w-0 max-w-full">${t('Status')}
                <select value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)} className="input !py-1.5 !w-auto min-w-0 text-xs">
                    <option value="ALL">${t('Any status')}</option>
                    ${Object.entries(STATUS).map(([k, m]) => html`<option key=${k} value=${k}>${m.label}</option>`)}
                </select></label>`}
            <span className="text-xs text-slate-400 mr-auto">${tj('Showing {shown} of {total}', { shown: html`<b className="text-slate-200">${shown}</b>`, total })}${count ? ` · ${t('{count} on', { count: plural(count, 'filter') })}` : ''}</span>
            ${count > 0 && html`<${Button} size="sm" variant="ghost" icon="x" onClick=${() => onChange({ ...NO_FILTERS })}>${t('Clear filters')}<//>`}
            <${Button} size="sm" variant="secondary" icon="chevron-up" onClick=${onToggle}>${t('Done')}<//>
        </div>
    </section>`;
}

function Stat({ label, value, icon, tone }) {
    return html`<div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4">
        <div className="flex items-center justify-between gap-2"><p className="text-[11px] font-bold text-slate-500 leading-tight">${label}</p><span className=${tone}><${Icon} name=${icon} /></span></div>
        <p className="text-xl md:text-2xl font-black text-white mt-1">${value}</p>
    </div>`;
}

function SellAsPicker({ airlines, sellAs, onChange }) {
    if (!airlines.length) return null;
    return html`<label data-tour="sellas" className="hidden sm:flex items-center gap-2 pl-3 pr-1 py-1 rounded-full border border-slate-800 bg-slate-900 text-xs" title=${t('The airline buyers see when you take an order')}>
        <span className="text-slate-500 font-bold">${t('Selling as')}</span>
        <select value=${sellAs?.id || ''} onChange=${(e) => onChange(e.target.value)} className="bg-transparent font-bold text-white outline-none py-1 pr-1 max-w-40">
            ${airlines.map((a) => html`<option key=${a.id} value=${a.id} className="bg-slate-900">${a.name}</option>`)}
        </select>
    </label>`;
}

function FlagBadge({ flag }) {
    if (!flag || flag.status === 'NORMAL') return null;
    const m = FLAG_META[flag.status];
    return html`<span className=${`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black ${m.cls}`} title=${flag.reason || ''}>
        <${Icon} name=${m.icon} className="w-3 h-3" />${m.label.toUpperCase()}</span>`;
}

// Does any of the seller's airlines share the buyer's alliance?
const sharesAlliance = (airlines, order) => !orderAlliances(order).length || airlines.some((a) => orderAlliances(order).includes(a.alliance));

function AllianceBadge({ airlines, order }) {
    if (!airlines.length || sharesAlliance(airlines, order)) return null;
    return html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black text-amber-300 border-amber-500/30 bg-amber-500/10"
        title=${t('None of your airlines is in {alliances}', { alliances: orderAlliances(order).join(' / ') })}>
        <${Icon} name="users-round" className="w-3 h-3" />${t('NO SHARED ALLIANCE')}</span>`;
}

function itemsSummary(order, withDelivery = false) {
    return orderLines(order).map((i) => `${i.qty}× ${i.model} @${i.pricePercent}%${withDelivery && i.filled ? ` (${i.filled}/${i.qty})` : ''}`).join(' · ');
}

function PassedBadge({ passed, userId, teamSize }) {
    if (!passed?.length) return null;
    const me = passed.some((d) => d.seller_id === userId);
    return html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black text-slate-300 border-slate-700 bg-slate-800/60"
        title=${passed.map((d) => d.seller_name + (d.note ? `: ${d.note}` : '')).join('\n')}>
        <${Icon} name="user-x" className="w-3 h-3" />${me ? `${t('YOU PASSED')} · ` : ''}${t('{n}/{total} PASSED', { n: passed.length, total: teamSize })}</span>`;
}

// Which buttons a seller gets for an order.
function OrderActions({ order, userId, seller, actions, compact }) {
    const mine = order.seller_id === userId;
    const helping = !mine && isHelping(order, userId);
    const canManage = mine || seller.is_admin;
    const canUpdate = canManage || helping;
    const size = compact ? 'sm' : 'md';
    const stop = (fn) => (e) => { e.stopPropagation(); fn(order); };
    return html`<div className="flex flex-wrap gap-1.5" onClick=${(e) => e.stopPropagation()}>
        ${order.status === 'PENDING' && html`<${Button} size=${size} icon="hand" onClick=${stop(actions.claim)}>${t('Take order')}<//>`}
        ${['CLAIMED', 'PARTIAL', 'FULFILLED'].includes(order.status) && canUpdate && html`<${Button} size=${size} icon="truck" variant=${order.status === 'FULFILLED' ? 'secondary' : 'primary'} onClick=${stop(actions.progress)}>${t('Update delivery')}<//>`}
        ${deliveredOn(order, userId) && html`<${Button} size=${size} icon="bell-ring" onClick=${stop(actions.remind)}>${t('Remind buyer')}<//>`}
        ${canTakeOver(order, userId) && html`<${Button} size=${size} icon="users" variant=${compact ? 'primary' : 'secondary'} onClick=${stop(actions.join)}>${t('Take over')}<//>`}
        ${['CLAIMED', 'PARTIAL'].includes(order.status) && (canManage || helping) && !compact && html`<${Button} size=${size} variant="secondary" icon=${helping ? 'log-out' : orderHelpers(order).length ? 'forward' : order.filled > 0 ? 'forward' : 'undo-2'} onClick=${stop(actions.release)}>${helping ? t('Stop delivering') : orderHelpers(order).length ? t('Hand over') : order.filled > 0 ? t('Pass on the rest') : t('Release')}<//>`}
        ${order.status === 'PENDING' && !compact && html`<${Button} size=${size} variant="ghost" icon="ban" onClick=${stop(actions.decline)}>${t('Decline')}<//>`}
        ${seller.is_admin && ACTIVE_STATUSES.includes(order.status) && !compact && html`<${Button} size=${size} variant="ghost" icon="octagon-x" className="!text-rose-300" onClick=${stop(actions.forceDecline)}>${t('Decline for all')}<//>`}
        ${!compact && html`<${Button} size=${size} variant="ghost" icon="flag" onClick=${stop(actions.flag)}>${t('Flag')}<//>`}
        ${seller.is_admin && !compact && html`<${Button} size=${size} variant="ghost" icon="trash-2" className="!text-rose-300" onClick=${stop(actions.remove)}>${t('Delete')}<//>`}
    </div>`;
}

function OrderRow({ order, flag, userId, airlines, seller, actions, onOpen, passed, teamSize, now, onBuyer, unread = 0, missing = 0, caution = false }) {
    const mine = order.seller_id === userId;
    const helping = !mine && isHelping(order, userId);
    const joined = orderHelpers(order);
    return html`<article onClick=${onOpen} className=${`card !rounded-2xl md:!rounded-3xl p-3 md:p-4 cursor-pointer hover:border-slate-600 ${flag?.status === 'BLACKLISTED' ? 'border-rose-500/40' : ''}`}>
        <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                    <${OrderCode} order=${order} />
                    <${StatusBadge} status=${displayStatus(order)} />
                    <${FlagBadge} flag=${flag} />
                    ${caution && html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-pink-300 text-slate-950" title=${t(CAUTION_TEXT)}><${Icon} name="eye" className="w-3 h-3" />${t('CAUTION')}</span>`}
                    ${order.status === 'PENDING' && html`<${AllianceBadge} airlines=${airlines} order=${order} />`}
                    ${order.status === 'PENDING' && html`<${PassedBadge} passed=${passed} userId=${userId} teamSize=${teamSize} />`}
                    ${mine && html`<span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300">${t('YOURS')}</span>`}
                    ${helping && html`<span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300">${t("YOU'RE HELPING")}</span>`}
                    ${missing > 0 && html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-500 text-[#fff]"><${Icon} name="shield-alert" className="w-3 h-3" />${t('MISSING PLANES REPORTED')}</span>`}
                    ${canTakeOver(order, userId, now) && html`<span className="text-[10px] font-black px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300" title=${t('Taken over {n} hours ago and not finished: you can take over part of it', { n: TAKEOVER_HOURS })}>${t('CAN TAKE OVER')}</span>`}
                    <${WaitChip} order=${order} now=${now} />
                    ${unread > 0 && html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-400 text-slate-950">
                        <${Icon} name="message-circle" className="w-3 h-3" />${unread === 1 ? t('1 NEW MESSAGE') : t('{n} NEW MESSAGES', { n: unread })}</span>`}
                    <span className="text-[11px] text-slate-500" title=${fmtDate(order.created_at)}>${t('ordered {time}', { time: timeAgo(order.created_at) })}</span>
                </div>
                <p className="font-extrabold text-white truncate"><${BuyerLink} order=${order} onBuyer=${onBuyer} /> <span className="text-slate-500 font-semibold text-sm">· ${orderAlliances(order).join(', ')} · ${order.buyer_name}</span></p>
                <p className="text-xs text-slate-400 truncate">${itemsSummary(order, true)}</p>
                ${order.seller_airline_name && (!mine || joined.length > 0) && html`<p className="text-[11px] text-slate-500">${t('Seller: {names}', { names: `${order.seller_airline_name} (${order.seller_name})` })}${joined.length ? ` + ${t('also delivering: {names}', { names: joined.map((h) => h.seller_airline_name).join(', ') })}` : ''}</p>`}
            </div>
            <div className="flex md:flex-col items-center md:items-end justify-between gap-2 shrink-0">
                <div className="md:text-right">
                    <p className="font-black text-white">${fmtUSDShort(order.total_usd)}</p>
                    <p className="text-[11px] text-amber-200/80" title=${t('List value: what buying these aircraft new in-game costs, roughly')}>${t('List {value} · est. cost new', { value: fmtUSDShort(orderListValue(order)) })}</p>
                    <p className="text-[11px] text-slate-500">${t('{done}/{total} delivered', { done: order.filled, total: order.total_qty })}</p>
                </div>
                <${OrderActions} order=${order} userId=${userId} seller=${seller} actions=${actions} compact=${true} />
            </div>
        </div>
    </article>`;
}

function OrderDetail({ order, flag, userId, seller, airlines, actions, onClose, passed, teamSize, now, onBuyer, messages = [], onSeen, onMessage, reports = [], onReport, culpritsByReport = {}, onCulprits, caution = false, cautionReason = '' }) {
    useEffect(() => { onSeen?.(); }, [order.id, messages.length]);
    const [events, setEvents] = useState([]);
    useEffect(() => {
        sb.from('order_events').select('*').eq('order_id', order.id).order('created_at').then(({ data }) => setEvents(data || []));
    }, [order.id, order.updated_at]);
    const items = orderLines(order);
    const previous = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];
    return html`<${Modal} open=${true} onClose=${onClose} size="lg" title=${html`${orderRef(order)} · <${BuyerLink} order=${order} onBuyer=${onBuyer} />`}
        subtitle=${`${order.id} · ${orderAlliances(order).join(', ')} · ${t('ordered by {name}', { name: order.buyer_name })} · ${fmtDate(order.created_at)}`}
        footer=${html`<${OrderActions} order=${order} userId=${userId} seller=${seller} actions=${actions} compact=${false} />`}>
        <div className="space-y-5">
            <div className="flex flex-wrap gap-2 items-center"><${StatusBadge} status=${displayStatus(order)} /><${FlagBadge} flag=${flag} /><${AllianceBadge} airlines=${airlines} order=${order} />
                ${order.status === 'PENDING' && html`<${PassedBadge} passed=${passed} userId=${userId} teamSize=${teamSize} />`}
            </div>
            ${caution && html`<div className="flex gap-3 p-3 rounded-2xl border border-pink-400/50 bg-pink-400/10 text-sm text-pink-100">
                <${Icon} name="eye" className="w-5 h-5 text-pink-300 shrink-0" />
                <div><p className="font-bold text-pink-200">${t('Caution: buyer on the alert list')}</p><p>${t(CAUTION_TEXT)}</p>
                    ${cautionReason && html`<p className="text-xs mt-1 text-pink-200/80">${t('Reason (admins only): {reason}', { reason: cautionReason })}</p>`}</div>
            </div>`}
            <button onClick=${() => onBuyer(order)} className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-950 border border-slate-800 hover:border-slate-600 text-left">
                <span className="w-9 h-9 rounded-xl bg-[#5865F2]/15 text-[#8b93ff] flex items-center justify-center shrink-0"><${DiscordLogo} className="w-4 h-4" /></span>
                <span className="flex-1 min-w-0">
                    <span className="block text-[11px] font-bold text-slate-500">${t('Buyer')}</span>
                    <span className="block font-bold text-white truncate">${order.buyer_name}${order.buyer_discord_id ? html` <span className="font-mono text-xs text-slate-500 font-normal">${order.buyer_discord_id}</span>` : ''}</span>
                </span>
                <span className="text-xs font-bold text-slate-300 shrink-0 flex items-center gap-1">${t('Discord info')} <${Icon} name="chevron-right" /></span>
            </button>
            <${BuyerRecord} discordId=${order.buyer_discord_id} />
            ${orderAirlines(order).length > 1 && html`<div>
                <p className="label text-slate-500 mb-1.5">${t('Buyer accepts delivery to any of')}</p>
                <div className="flex flex-wrap gap-1.5">${orderAirlines(order).map((a) => {
                    const match = airlines.some((x) => x.alliance === a.alliance);
                    return html`<span key=${a.name + a.alliance} className=${`px-2.5 py-1 rounded-full text-xs font-bold ${match ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-200'}`}
                        title=${match ? t('You have an airline in this alliance') : ''}>${a.name} <span className="opacity-60">${a.alliance}</span></span>`;
                })}</div>
            </div>`}
            <${OrderStepper} order=${order} />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 rounded-2xl border border-amber-500/20 bg-amber-500/5">
                <span className="text-sm text-amber-100"><b className="text-white">${t('List value {value}', { value: fmtUSD(orderListValue(order)) })}</b> · ${t('est. cost of buying these aircraft new in-game')}</span>
                ${order.filled > 0 && !['FULFILLED', 'CANCELLED', 'DECLINED'].includes(order.status) && html`<span className="text-xs text-amber-200/70">${t('{value} for the {n} still to deliver', { value: fmtUSDShort(listStillToBuy(order)), n: order.total_qty - order.filled })}</span>`}
                <span className="text-xs text-amber-200/70">${t('Buyer pays {value}', { value: fmtUSDShort(order.total_usd) })}</span>
            </div>
            ${order.seller_airline_name && html`<p className="text-sm text-slate-300">${tj('Seller: {names}', { names: html`<span><b>${order.seller_airline_name}</b> (${order.seller_alliance}) — ${order.seller_name}${order.seller_id === userId ? ` ${t('(you)')}` : ''}</span>` })}</p>`}
            ${['CLAIMED', 'PARTIAL'].includes(order.status) && order.seller_id !== userId && !isHelping(order, userId) && html`<p className="text-xs text-slate-400 flex items-center gap-1.5"><${Icon} name="users" className="w-3.5 h-3.5" />
                ${canTakeOver(order, userId, now) ? t('Taken over {n} hours ago and not finished: you can take over part of it. The current seller stays on it.', { n: TAKEOVER_HOURS })
                    : orderHelpers(order).length >= MAX_HELPERS ? t('Enough sellers are already helping with this order.')
                    : t("Other sellers can take over if it isn't finished {n} hours after it was taken (in about {h} h).", { n: TAKEOVER_HOURS, h: Math.ceil(takeoverIn(order, now)) })}</p>`}
            <${SellerShares} order=${order} userId=${userId} />
            ${previous.length > 0 && deliveryShares(order).length < 2 && html`<p className="text-sm text-slate-300">${t('Earlier sellers:')} ${previous.map((p) => html`<b key=${p.at}>${p.seller_airline_name}</b>`).reduce((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}
                <span className="text-slate-400"> · ${t('delivered {list} before passing it on', { list: previous.map((p) => p.delivered).join(' + ') })}</span></p>`}
            ${order.status === 'PENDING' && passed?.length > 0 && html`<div className="text-sm p-3 rounded-2xl bg-slate-950 border border-slate-800">
                <p className="font-bold text-slate-200">${t('Passed by {n} of {total} sellers', { n: passed.length, total: teamSize })}</p>
                <ul className="text-xs text-slate-400 mt-1 space-y-0.5">${passed.map((d) => html`<li key=${d.seller_id}>${d.seller_name}${d.note ? ` — "${d.note}"` : ''}</li>`)}</ul>
            </div>`}
            ${order.closed_reason && html`<p className="text-sm p-3 rounded-2xl bg-slate-950 border border-slate-800"><b>${t('Reason:')}</b> ${tx(order.closed_reason)}</p>`}
            ${flag && flag.status !== 'NORMAL' && html`<p className="text-sm p-3 rounded-2xl bg-rose-500/5 border border-rose-500/20 text-rose-100">${tj('{flag} by {name}: {reason}', { flag: html`<b>${FLAG_META[flag.status]?.label || flag.status}</b>`, name: flag.flagged_by, reason: flag.reason || t('no reason given') })} <span className="text-rose-300/60">${t('(sellers only)')}</span></p>`}
            <div>
                <div className="flex justify-between text-xs mb-1.5"><span className="text-slate-400">${t('Delivered')}</span><span className="font-bold">${order.filled} / ${order.total_qty}</span></div>
                <${ProgressBar} value=${order.filled} max=${order.total_qty} />
            </div>
            <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] text-slate-500"><th className="font-bold pb-2">${t('Aircraft')}</th><th className="font-bold pb-2 text-right">${t('Delivered')}</th><th className="font-bold pb-2 text-right">${t('Level')}</th><th className="font-bold pb-2 text-right">${t('Buyer pays')}</th><th className="font-bold pb-2 text-right">${t('List value')}</th></tr></thead>
                <tbody className="divide-y divide-slate-800">
                    ${items.map((it, i) => html`<tr key=${i}>
                        <td className="py-2 pr-2"><span className="text-slate-100">${it.model}</span> <span className="text-slate-500 text-xs">${it.code}</span>${it.note && html`<span className="block text-xs text-slate-400">“${it.note}”</span>`}</td>
                        <td className=${`py-2 text-right font-bold tabular-nums ${it.filled >= it.qty ? 'text-emerald-300' : ''}`}>${it.filled}/${it.qty}</td>
                        <td className="py-2 text-right">${it.pricePercent}%</td>
                        <td className="py-2 text-right">${fmtUSDShort(it.totalUSD)}</td>
                        <td className="py-2 text-right text-amber-200/90">${it.listPriceUSD ? fmtUSDShort(it.listPriceUSD * it.qty) : '–'}</td>
                    </tr>`)}
                    <tr><td className="pt-2 font-bold">${t('Total')}</td><td className="pt-2 text-right font-bold tabular-nums">${order.filled}/${order.total_qty}</td><td></td><td className="pt-2 text-right font-black">${fmtUSD(order.total_usd)}</td><td className="pt-2 text-right font-black text-amber-200">${fmtUSD(orderListValue(order))}</td></tr>
                </tbody>
            </table></div>
            ${order.buyer_note && html`<div><p className="label text-slate-500 mb-1">${t('Buyer note')}</p><p className="text-sm text-slate-200">${order.buyer_note}</p></div>`}
            ${order.seller_note && html`<div><p className="label text-slate-500 mb-1">${t('Seller note (buyer can see)')}</p><p className="text-sm text-slate-200">${order.seller_note}</p></div>`}
            ${reports.length > 0 && html`<div>
                <p className="label text-slate-500 mb-2">${t('Missing planes')} (${reports.length})</p>
                <div className="space-y-2">${[...reports].reverse().map((r) => html`<${MissingReport} key=${r.id} report=${r} order=${order}
                    culprits=${culpritsByReport[r.id] || []} onCulprits=${onCulprits}
                    canClose=${seller.is_admin || deliveryShares(order).some((sh) => sh.sellerId === userId)} onDone=${onReport} />`)}</div>
            </div>`}
            <div>
                <p className="label text-slate-500 mb-2">${t('Messages with the buyer')}${messages.length ? ` (${messages.length})` : ''}</p>
                <${SellerThread} order=${order} messages=${messages} onMessage=${onMessage} />
            </div>
            <div>
                <p className="label text-slate-500 mb-2">${t('Status history')}</p>
                <${StatusHistory} order=${order} now=${now} />
            </div>
            <div>
                <p className="label text-slate-500 mb-2">${t('Timeline')}</p>
                <ol className="space-y-2 border-l border-slate-800 pl-4">
                    ${events.map((e) => html`<li key=${e.id} className="relative">
                        <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-slate-600"></span>
                        <p className="text-sm text-slate-200"><span className="font-mono text-[10px] text-slate-500 mr-1.5">${e.kind}</span>${tx(e.message)}</p>
                        <p className="text-[11px] text-slate-500">${e.actor_name} · ${fmtDate(e.created_at)}</p>
                    </li>`)}
                </ol>
            </div>
        </div>
    <//>`;
}

// One missing-plane report on the seller desk. Open: the sellers on the order (and admins) check in-game who
// bought the planes, then close it. Theft confirmed → posted to the moderation log; with the culprit's Discord ID
// they also get an automatic market warning. The buyer is told the outcome either way.
function MissingReport({ report, order, culprits = [], canClose, onDone, onCulprits }) {
    const [outcome, setOutcome] = useState('confirmed');
    const [note, setNote] = useState('');
    const [known, setKnown] = useState(true);          // confirming: we know who took them (else: under investigation)
    const [ids, setIds] = useState(['']);
    const [busy, setBusy] = useState(false);
    // Reports from before several culprits: the one warning kept on the report (sellers can read it).
    const [legacy, setLegacy] = useState(null);
    useEffect(() => {
        if (!report.warning_id || culprits.length) return;
        sb.from('market_messages').select('discord_id').eq('id', report.warning_id).maybeSingle().then(({ data }) => setLegacy(data));
    }, [report.warning_id, culprits.length]);
    const named = culprits.length ? culprits : legacy ? [{ id: 'legacy', discord_id: legacy.discord_id }] : [];
    const after = () => onCulprits?.(report.id);
    const submit = async () => {
        setBusy(true);
        try {
            const list = outcome === 'confirmed' && known ? cleanIds(ids) : [];
            const r = await api(`/api/orders/${order.id}`, { action: 'missing', reportId: report.id, outcome, note: note.trim(), culprits: list });
            onDone?.(r.report); after();
            toast(outcome !== 'confirmed' ? t('Report closed. The buyer has been told.')
                : r.warned ? t('Theft logged, {count} warned. The buyer has been told.', { count: plural(r.warned, 'culprit') })
                : t('Theft logged, culprit under investigation. The buyer has been told.'), 'success');
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    // Name (more) culprits later: any seller.
    const [warning, setWarning] = useState(false);
    const [warnIds, setWarnIds] = useState(['']);
    const [closeIt, setCloseIt] = useState(true);
    const warn = async () => {
        setBusy(true);
        try {
            const r = await api(`/api/orders/${order.id}`, { action: 'missing-culprits', reportId: report.id, culprits: cleanIds(warnIds),
                done: report.investigating ? closeIt : false });
            onDone?.(r.report); after();
            setWarning(false); setWarnIds(['']);
            toast(r.report?.investigating ? t('{count} warned and logged. The investigation stays open.', { count: plural(r.warned, 'culprit') })
                : t('{count} warned and logged.', { count: plural(r.warned, 'culprit') }), 'success');
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    const giveUp = async () => {
        const ok = await ask({ title: t('Close the investigation?'), confirmLabel: t('Close investigation'),
            message: t('The theft stays confirmed, with the culprit marked as not identified. If someone finds out later, you can still add and warn them here.') });
        if (!ok) return;
        setBusy(true);
        try {
            const r = await api(`/api/orders/${order.id}`, { action: 'missing-culprits', reportId: report.id, culprits: [], done: true });
            onDone?.(r.report);
            toast(t('Investigation closed: culprit not identified.'), 'success');
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    // Clear a confirmed theft once the warned culprit(s) re-listed the planes (checked in-game).
    const [clearing, setClearing] = useState(false);
    const [clearNote, setClearNote] = useState('');
    const [verified, setVerified] = useState(false);
    const clear = async () => {
        setBusy(true);
        try {
            const r = await api(`/api/orders/${order.id}`, { action: 'missing-clear', reportId: report.id, note: clearNote.trim(), verified });
            onDone?.(r.report);
            setClearing(false);
            toast(r.culpritTold ? t('Theft cleared. The buyer was told to buy the re-listed planes, and the culprits were told the case is closed.')
                : t('Theft cleared. The buyer was told to buy the re-listed planes.'), 'success');
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    // Red: not dealt with yet (or the thief is still unknown). Yellow: thief identified and warned, planes not
    // re-listed yet (the warning stays on their record). Green: the thief re-listed the planes.
    const RED = 'text-rose-200 border-rose-500/40 bg-rose-500/[0.07]', YELLOW = 'text-amber-100 border-amber-400/40 bg-amber-400/[0.07]';
    const GREEN = 'text-emerald-200 border-emerald-500/40 bg-emerald-500/[0.07]', GREY = 'text-slate-200 border-slate-800 bg-slate-950';
    const head = report.status === 'OPEN' ? [RED, 'shield-alert', t('Reported, needs checking')]
        : report.status === 'CONFIRMED' && named.length ? [YELLOW, 'user-x', t('Thief identified · planes not re-listed yet')]
        : report.status === 'CONFIRMED' && report.investigating ? [RED, 'shield-x', t('Theft confirmed · thief not identified yet')]
        : report.status === 'CONFIRMED' ? [GREY, 'shield-x', t('Theft confirmed · thief could not be identified')]
        : report.status === 'CLEARED' ? [GREEN, 'shield-check', t('Planes re-listed by the thief')]
        : [GREY, 'circle-check', t('Not a theft')];
    // Green: take the warnings off the thieves' record (sellers on the order and admins).
    const clearRecord = async () => {
        const ok = await ask({ title: t("Clear it from the thief's record?"), confirmLabel: t('Clear from record'),
            message: named.length > 1 ? t("The theft warnings for this order will be removed from the culprits' records. They are told by DM, and it is logged. The report itself stays.")
                : t("The theft warning for this order will be removed from the culprit's record. They are told by DM, and it is logged. The report itself stays.") });
        if (!ok) return;
        setBusy(true);
        try {
            const r = await api(`/api/orders/${order.id}`, { action: 'missing-record-clear', reportId: report.id });
            onDone?.(r.report); after();
            toast(t('Removed from the record ({count}).', { count: plural(r.removed, 'warning') }), 'success');
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    const theft = ['CONFIRMED', 'CLEARED'].includes(report.status);
    const confirmIdsOk = !known || idsValid(ids);
    return html`<div className=${`p-3 rounded-2xl border space-y-2 ${head[0]}`}>
        <p className="text-sm font-bold flex flex-wrap items-center gap-1.5"><${Icon} name=${head[1]} className="w-4 h-4" />${head[2]}
            ${report.status === 'CONFIRMED' && report.investigating && html`<span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide bg-amber-400/15 text-amber-200 border border-amber-400/30">${t('Culprit under investigation')}</span>`}
            <span className="text-xs font-normal opacity-60">· ${timeAgo(report.created_at)}</span></p>
        <p className="text-sm text-slate-100">${report.buyer_name || t('Buyer')}: “${report.details}”</p>
        ${report.status !== 'OPEN' && html`<p className="text-xs text-slate-300">${report.resolved_by_name}: “${report.resolution_note}”</p>`}
        ${theft && html`<div className="rounded-xl border border-slate-800 bg-slate-900/60 p-2.5 space-y-1.5">
            <p className="label text-slate-500">${!named.length ? t('Culprit') : report.record_cleared_at ? t('Culprits ({n}) · warning removed from record', { n: named.length }) : t('Culprits ({n}) · warned', { n: named.length })}</p>
            ${named.length ? html`<ul className="space-y-1">${named.map((c) => html`<li key=${c.id} className="text-xs text-slate-200 flex flex-wrap items-center gap-x-2">
                    <${Icon} name="user-x" className="w-3.5 h-3.5 text-rose-300" /><b>${c.name || t('Discord user')}</b>
                    <span className="font-mono text-slate-400">${c.discord_id}</span>
                    ${c.added_by_name && html`<span className="text-slate-500">· ${t('by {name}', { name: c.added_by_name })}${c.created_at ? `, ${timeAgo(c.created_at)}` : ''}</span>`}
                </li>`)}</ul>`
            : html`<p className="text-xs text-slate-400">${report.investigating ? t('🔍 Not identified yet. Found out who it was? Warn them below.') : t('Not identified (investigation closed).')}</p>`}
        </div>`}
        ${report.status === 'CONFIRMED' && named.length > 0 && html`<p className="text-xs text-amber-100/90 flex items-center gap-1.5"><${Icon} name="triangle-alert" className="w-3.5 h-3.5" />${t("The warning stays on the thief's record until the planes are re-listed for the buyer.")}</p>`}
        ${report.status === 'CLEARED' && html`<p className="text-xs text-emerald-200/90">${report.cleared_by_name}: “${report.cleared_note}” · ${timeAgo(report.cleared_at)}</p>`}
        ${report.status === 'CLEARED' && report.record_cleared_at && html`<p className="text-xs text-emerald-200/90 flex items-center gap-1.5"><${Icon} name="eraser" className="w-3.5 h-3.5" />${t("Removed from the thief's record by {name}", { name: report.record_cleared_by_name || t('a seller') })} · ${timeAgo(report.record_cleared_at)}</p>`}
        ${report.status === 'CLEARED' && !report.record_cleared_at && named.length > 0 && canClose && !warning && html`<div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-emerald-500/20">
            <p className="text-xs text-emerald-100/80">${t('The thief re-listed the planes. Their warning is still on record.')}</p>
            <${Button} size="sm" variant="secondary" icon="eraser" busy=${busy} onClick=${clearRecord}>${t("Clear from the thief's record")}<//>
        </div>`}

        ${theft && !warning && !clearing && html`<div className="flex flex-wrap items-center gap-2 pt-1">
            <${Button} size="sm" variant="danger" icon="user-x" onClick=${() => setWarning(true)}>
                ${report.investigating ? t('Identify & warn culprits') : named.length ? t('Warn another culprit') : t('Warn a culprit')}<//>
            ${report.investigating && html`<${Button} size="sm" variant="ghost" busy=${busy} onClick=${giveUp}>${t("Can't identify: close investigation")}<//>`}
            ${report.status === 'CONFIRMED' && named.length > 0 && canClose && html`<${Button} size="sm" variant="secondary" icon="shield-check" className="ml-auto" onClick=${() => setClearing(true)}>${t('Clear theft')}<//>`}
        </div>`}
        ${theft && warning && html`<div className="pt-2 border-t border-slate-800 space-y-2">
            <p className="text-xs text-slate-300">${t('Each person gets an automatic market warning (Discord DM, logged in the moderation channel, on their disciplinary record). The buyer never learns who it was.')}</p>
            <${CulpritInputs} ids=${warnIds} setIds=${setWarnIds} />
            ${report.investigating && html`<label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
                <input type="checkbox" checked=${closeIt} onChange=${(e) => setCloseIt(e.target.checked)} className="mt-0.5 accent-rose-400" />
                <span>${t("That's everyone: close the investigation. (Untick if more culprits may still be found.)")}</span>
            </label>`}
            <div className="flex justify-end gap-2">
                <${Button} size="sm" variant="ghost" onClick=${() => setWarning(false)}>${t('Cancel')}<//>
                <${Button} size="sm" variant="danger" icon="user-x" busy=${busy} disabled=${!cleanIds(warnIds).length || !idsValid(warnIds)} onClick=${warn}>
                    ${t('Warn {count}', { count: plural(cleanIds(warnIds).length || 1, 'culprit') })}<//>
            </div>
        </div>`}
        ${report.status === 'CONFIRMED' && named.length > 0 && canClose && clearing && html`<div className="pt-2 border-t border-slate-800 space-y-2">
            <textarea value=${clearNote} maxLength="1000" rows="2" onChange=${(e) => setClearNote(e.target.value)} className="input"
                placeholder=${t('What was re-listed and where, e.g. 2× A320neo listed again at WIII')}></textarea>
            <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
                <input type="checkbox" checked=${verified} onChange=${(e) => setVerified(e.target.checked)} className="mt-0.5 accent-emerald-400" />
                <span>${t('I checked in-game: the planes are listed for the buyer again.')}</span>
            </label>
            <p className="text-[11px] text-slate-500">${t('Logged in the moderation channel. The buyer is told to buy them; the culprits are told the case is closed (the warnings stay on their record).')}</p>
            <div className="flex justify-end gap-2">
                <${Button} size="sm" variant="ghost" onClick=${() => setClearing(false)}>${t('Cancel')}<//>
                <${Button} size="sm" icon="shield-check" busy=${busy} disabled=${!verified || !clearNote.trim()} onClick=${clear}>${t('Clear theft')}<//>
            </div>
        </div>`}
        ${report.status === 'OPEN' && !canClose && html`<p className="text-xs text-slate-400">${t('The sellers on this order and the admins check this one.')}</p>`}
        ${report.status === 'OPEN' && canClose && html`<div className="pt-2 border-t border-slate-800 space-y-2">
            <p className="text-xs text-slate-300">${t('Check in-game who bought the planes you listed for this buyer, then:')}</p>
            <div className="grid grid-cols-2 gap-1.5">${[['confirmed', t('Theft confirmed')], ['not_theft', t('Not a theft')]].map(([k, label]) => html`<button key=${k} type="button" onClick=${() => setOutcome(k)}
                className=${`py-2 rounded-xl border text-xs font-bold ${outcome === k ? (k === 'confirmed' ? 'bg-rose-500 text-[#fff] border-rose-500' : 'bg-white text-slate-950 border-white') : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>${label}</button>`)}</div>
            <textarea value=${note} maxLength="1000" rows="2" onChange=${(e) => setNote(e.target.value)} className="input"
                placeholder=${outcome === 'confirmed' ? t('What happened, e.g. 2× A320neo bought by another player; relisted for the buyer') : t('What you found, e.g. the planes are still listed, buy them at WIII')}></textarea>
            ${outcome === 'confirmed' && html`<div className="space-y-2">
                <p className="text-xs font-bold text-slate-400">${t('Who took them?')}</p>
                <div className="grid grid-cols-2 gap-1.5">${[[true, t('I know who')], [false, t('Under investigation')]].map(([k, label]) => html`<button key=${String(k)} type="button" onClick=${() => setKnown(k)}
                    className=${`py-2 rounded-xl border text-xs font-bold ${known === k ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>${label}</button>`)}</div>
                ${known ? html`<${CulpritInputs} ids=${ids} setIds=${setIds} />`
                    : html`<p className="text-[11px] text-slate-400">${t('The theft is logged now. When you find out who it was, any seller can warn them from this report (or from Theft reports on the front page).')}</p>`}
            </div>`}
            <p className="text-[11px] text-slate-500">${outcome === 'confirmed' ? t('Posted in the moderation log channel. Each culprit gets an automatic warning. The buyer sees your note, never who it was.') : t('The buyer sees your note.')}</p>
            <div className="flex justify-end"><${Button} size="sm" variant=${outcome === 'confirmed' ? 'danger' : 'primary'} busy=${busy}
                disabled=${!note.trim() || (outcome === 'confirmed' && !confirmIdsOk)}
                icon=${outcome === 'confirmed' ? 'shield-x' : 'check'} onClick=${submit}>${outcome !== 'confirmed' ? t('Close report')
                    : known && cleanIds(ids).length ? t('Log theft & warn {count}', { count: plural(cleanIds(ids).length, 'culprit') }) : t('Log theft')}<//></div>
        </div>`}
    </div>`;
}

// Who is this Discord ID? /api/lookup (Echo Market accounts first, then Discord). Cached for the visit.
const lookupCache = new Map();
function lookupDiscord(id) {
    if (!lookupCache.has(id)) {
        lookupCache.set(id, api('/api/lookup', { discordId: id }).catch((err) => { lookupCache.delete(id); return { error: err.message }; }));
    }
    return lookupCache.get(id);
}
// The line under a Discord ID box: the person's avatar, @username and name, or "no Discord user with this ID".
function DiscordName({ id, min = 17 }) {
    const clean = String(id || '').trim();
    const valid = new RegExp(`^\\d{${min},25}$`).test(clean);
    const [who, setWho] = useState(null);
    useEffect(() => {
        setWho(null);
        if (!valid) return;
        let live = true;
        const t = setTimeout(() => lookupDiscord(clean).then((r) => { if (live) setWho(r); }), 350);
        return () => { live = false; clearTimeout(t); };
    }, [clean, valid]);
    if (!valid) return null;
    if (!who) return html`<p className="text-[11px] text-slate-500 flex items-center gap-2"><${Spinner} width=${12} /> ${t('Looking up this Discord ID…')}</p>`;
    if (who.error) return html`<p className="text-[11px] text-slate-500">${t("Couldn't look this ID up: {msg}", { msg: who.error })}</p>`;
    if (who.found === false) return html`<p className="text-[11px] font-bold text-rose-300 flex items-center gap-1.5"><${Icon} name="user-x" className="w-3.5 h-3.5" />${t('No Discord user has this ID. Check it.')}</p>`;
    if (who.found !== true) return html`<p className="text-[11px] text-slate-500">${t("Discord couldn't be asked right now; the ID will still work.")}</p>`;
    return html`<p className="text-[11px] text-emerald-200 flex items-center gap-2 min-w-0">
        ${who.avatar ? html`<img src=${who.avatar} alt="" className="w-5 h-5 rounded-full shrink-0" />` : html`<${Icon} name="circle-user" className="w-4 h-4 shrink-0" />`}
        <span className="truncate"><b className="text-white">@${who.username || 'unknown'}</b>${who.name && who.name !== who.username ? ` · ${who.name}` : ''}</span>
        <span className="shrink-0 text-slate-500">· ${who.onMarket ? t('on Echo Market') : t('not on Echo Market yet')}</span>
    </p>`;
}

// Discord user IDs typed into CulpritInputs.
const cleanIds = (list) => [...new Set(list.map((x) => x.trim()).filter(Boolean))];
const ID_RE = /^\d{17,20}$/;
const idsValid = (list) => list.every((x) => !x.trim() || ID_RE.test(x.trim()));
const MAX_CULPRITS = 10;

// One Discord user ID per culprit, with "Add another culprit" (a theft can have several).
function CulpritInputs({ ids, setIds }) {
    const set = (i, v) => setIds(ids.map((x, j) => (j === i ? v.replace(/[^\d]/g, '') : x)));
    return html`<div className="space-y-1.5">
        <p className="text-xs font-bold text-slate-400">${t('Culprit Discord user IDs')} <span className="font-normal text-slate-500">${t('(Discord: right-click the user → Copy User ID)')}</span></p>
        ${ids.map((v, i) => html`<div key=${i} className="space-y-1"><div className="flex gap-1.5">
            <input value=${v} onChange=${(e) => set(i, e.target.value)} inputMode="numeric" aria-label=${t('Culprit {n} Discord user ID', { n: i + 1 })}
                className=${`input font-mono !py-2 ${!v.trim() || ID_RE.test(v.trim()) ? '' : '!border-rose-500'}`} placeholder=${t('Culprit {n}, e.g. 123456789012345678', { n: i + 1 })} />
            ${ids.length > 1 && html`<button type="button" onClick=${() => setIds(ids.filter((_, j) => j !== i))} title=${t('Remove')}
                className="shrink-0 w-10 rounded-xl border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 flex items-center justify-center"><${Icon} name="x" /></button>`}
        </div><${DiscordName} id=${v} /></div>`)}
        ${ids.length < MAX_CULPRITS && html`<button type="button" onClick=${() => setIds([...ids, ''])}
            className="text-xs font-bold text-slate-300 hover:text-white flex items-center gap-1"><${Icon} name="user-plus" className="w-3.5 h-3.5" />${t('Add another culprit')}</button>`}
    </div>`;
}

// "Theft reports" (every seller): all missing-plane reports, so anyone who finds out who took planes can warn
// them straight away. Needs attention first: open reports and thefts with the culprit under investigation.
function TheftsView({ reports, orders, culpritsByReport, seller, userId, onOpenOrder, onReport, onCulprits }) {
    const [filter, setFilter] = useState('attention');
    const byId = useMemo(() => Object.fromEntries(orders.map((o) => [o.id, o])), [orders]);
    const all = [...reports].filter((r) => byId[r.order_id]).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const needs = (r) => r.status === 'OPEN' || (r.status === 'CONFIRMED' && r.investigating);
    const FILTERS = {
        attention: [t('Needs attention'), all.filter(needs)],
        thefts: [t('Confirmed thefts'), all.filter((r) => ['CONFIRMED', 'CLEARED'].includes(r.status))],
        all: [t('All reports'), all]
    };
    const list = FILTERS[filter][1];
    const [shown, bar] = usePaged(list, 'reports');
    return html`<section className="space-y-4">
        <div>
            <h2 className="text-lg font-extrabold text-white flex items-center gap-2"><${Icon} name="shield-alert" className="w-5 h-5 text-rose-300" />${t('Theft reports')}</h2>
            <p className="text-sm text-slate-400">${tj("Know who took a buyer's planes? Open the theft below and press {warn}: each culprit gets an automatic warning (Discord DM, moderation log, disciplinary record). Any seller can do this.", { warn: html`<b className="text-slate-200">${t('Warn')}</b>` })}</p>
        </div>
        <div className="flex p-1 rounded-full bg-slate-900 border border-slate-800 w-fit max-w-full overflow-x-auto no-scrollbar">
            ${Object.entries(FILTERS).map(([k, [label, items]]) => html`<button key=${k} onClick=${() => setFilter(k)} aria-pressed=${filter === k}
                className=${`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold ${filter === k ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>${label} <span className="opacity-60">${items.length}</span></button>`)}
        </div>
        ${!list.length ? html`<${EmptyState} icon="shield-check" title=${filter === 'attention' ? 'Nothing needs attention' : 'No reports yet'}
            text=${filter === 'attention' ? 'No open reports and no thefts with an unknown culprit.' : 'When buyers report missing planes, they show up here.'} />`
        : html`<div className="space-y-3">${shown.map((r) => {
            const o = byId[r.order_id];
            return html`<div key=${r.id} className="card p-3 space-y-2">
                <button onClick=${() => onOpenOrder(o.id)} className="w-full text-left flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm hover:text-white">
                    <b className="text-white">${orderRef(o)}</b><span className="text-slate-400">${airlineNames(o)}</span>
                    <span className="text-xs text-slate-500">· ${t('buyer {name}', { name: o.buyer_name || '-' })} · ${plural(o.total_qty, 'aircraft')}</span>
                    <span className="ml-auto text-xs font-bold text-sky-300 flex items-center gap-1">${t('Open order')}<${Icon} name="chevron-right" className="w-3.5 h-3.5" /></span>
                </button>
                <${MissingReport} report=${r} order=${o} culprits=${culpritsByReport[r.id] || []} onCulprits=${onCulprits} onDone=${onReport}
                    canClose=${seller.is_admin || deliveryShares(o).some((sh) => sh.sellerId === userId)} />
            </div>`;
        })}${bar}</div>`}
    </section>`;
}

function StatusHistory({ order, now }) {
    const history = Array.isArray(order.status_history) && order.status_history.length
        ? order.status_history : [{ status: order.status, at: order.created_at }];
    return html`<div className="space-y-2">
        <div className="flex flex-wrap gap-2"><${WaitChip} order=${order} now=${now} /></div>
        <ol className="text-sm divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60">
            ${history.map((h, i) => {
                const next = history[i + 1];
                const lasted = (next ? ms(next.at) : (CLOSED.includes(h.status) ? null : now)) - ms(h.at);
                const label = h.status === 'PENDING' && i > 0 ? t('Back in the open queue') : (STATUS[h.status]?.label || h.status);
                return html`<li key=${i} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0"><span className="font-bold text-slate-100">${label}</span>
                        <span className="block text-[11px] text-slate-500">${fmtDate(h.at)}</span></span>
                    ${Number.isFinite(lasted) && html`<span className="text-xs text-slate-400 shrink-0 tabular-nums">${next ? fmtDuration(lasted) : t('for {time} so far', { time: fmtDuration(lasted) })}</span>`}
                </li>`;
            })}
        </ol>
    </div>`;
}
const CLOSED = ['FULFILLED', 'CANCELLED', 'DECLINED'];

// "Showing 5 of 23" + Show 5 / 10 / 25 / 50 / All, and a "Show N more" button.
// Paging for short lists inside pop-ups (seller stats, buyer info): newest 5 first, same steps as the order tabs.
function usePaged(items, noun = 'orders') {
    const [size, setSize] = useState(5);
    const shown = size === 'all' ? items : items.slice(0, size);
    const bar = items.length > 5 ? html`<${PageSizeBar} total=${items.length} shown=${shown.length} pageSize=${size} setPageSize=${setSize} compact=${true} noun=${noun} />` : null;
    return [shown, bar];
}

function PageSizeBar({ total, shown, pageSize, setPageSize, compact = false, noun = 'orders' }) {
    const hidden = total - shown;
    const options = PAGE_SIZES.filter((p) => p === 'all' || p < total);
    const nextSize = PAGE_SIZES.find((p) => p !== 'all' && p > shown && p < total) || 'all';
    return html`<div className=${compact ? 'pt-2 flex flex-wrap items-center gap-2' : 'card p-3 flex flex-wrap items-center gap-3'}>
        <span className="text-xs text-slate-400 mr-auto">${tj(noun === 'reports' ? 'Showing {shown} of {total} reports' : 'Showing {shown} of {total} orders', { shown: html`<b className="text-slate-200">${shown}</b>`, total })}${hidden > 0 ? ` · ${t('{n} hidden', { n: hidden })}` : ''}</span>
        ${hidden > 0 && html`<${Button} size="sm" variant="secondary" icon="chevron-down" onClick=${() => setPageSize(nextSize)}>
            ${nextSize === 'all' ? t('Show all {n}', { n: total }) : t('Show {n} more', { n: Math.min(nextSize, total) - shown })}<//>`}
        <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500">${t('Show')}</span>
            <div className="flex p-1 rounded-full bg-slate-900 border border-slate-800">
                ${options.map((p) => html`<button key=${p} onClick=${() => setPageSize(p)} aria-pressed=${pageSize === p}
                    className=${`px-3 py-1 rounded-full text-xs font-bold ${pageSize === p ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>${p === 'all' ? t('All') : p}</button>`)}
            </div>
        </div>
    </div>`;
}

function ClaimModal({ order, airlines, sellAs, onClose, onConfirm, join = false, caution = false }) {
    const buyerAlliances = orderAlliances(order);
    const same = (a) => buyerAlliances.includes(a.alliance);
    const sorted = [...airlines].sort((a, b) => same(b) - same(a));
    const [airlineId, setAirlineId] = useState(() =>
        (sellAs && same(sellAs) ? sellAs : sorted.find(same) || sellAs || sorted[0])?.id);
    const [busy, setBusy] = useState(false);
    const chosen = airlines.find((a) => a.id === airlineId);
    return html`<${Modal} open=${true} onClose=${onClose} title=${join ? t('Take over {ref}', { ref: orderRef(order) }) : t('Take {ref}', { ref: orderRef(order) })} size="sm"
        subtitle=${`${t('{count} for {airline}', { count: plural(order.total_qty, 'aircraft'), airline: airlineNames(order) })} · ${fmtUSDShort(order.total_usd)}`}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>${t('Cancel')}<//>
            <${Button} icon=${join ? 'users' : 'hand'} busy=${busy} disabled=${!chosen} onClick=${async () => { setBusy(true); await onConfirm(airlineId); setBusy(false); }}>${join ? t('Take over') : t('Take order')}<//>`}>
        ${caution && html`<p className="text-sm text-pink-100 mb-4 p-3 rounded-2xl border border-pink-400/50 bg-pink-400/10 flex gap-2"><${Icon} name="eye" className="w-4 h-4 mt-0.5 text-pink-300 shrink-0" />${t(CAUTION_TEXT)}</p>`}
        ${join && html`<p className="text-sm text-slate-300 mb-4 p-3 rounded-2xl bg-slate-950 border border-slate-800">${t("{airline} took this order over {n} hours ago and hasn't finished it ({filled} of {total} delivered). You join them: they stay on the order, the buyer is told you will also be delivering, and you record only the aircraft you list.", { airline: order.seller_airline_name, n: TAKEOVER_HOURS, filled: order.filled, total: order.total_qty })}</p>`}
        <p className="field-label">${t('Sell as airline')}</p>
        <div className="space-y-1.5">
            ${sorted.map((a) => html`<button key=${a.id} onClick=${() => setAirlineId(a.id)}
                className=${`w-full flex items-center justify-between p-3 rounded-xl border text-left ${airlineId === a.id ? 'border-sky-400 bg-sky-400/10' : 'border-slate-800 hover:border-slate-600'}`}>
                <span><span className="font-bold text-white">${a.name}</span> <span className="text-xs text-slate-400">${a.alliance}</span>
                    ${same(a) && html`<span className="ml-2 text-[10px] font-black text-emerald-300">${t('SAME ALLIANCE AS BUYER')}</span>`}</span>
                ${airlineId === a.id && html`<${Icon} name="check" className="w-4 h-4 text-sky-300" />`}
            </button>`)}
        </div>
        ${chosen && same(chosen) && html`<p className="text-xs text-emerald-300 mt-4">${tj("Deliver to the buyer's {airlines} ({alliance}).", { airlines: html`<b>${deliverableTo(order, chosen.alliance).map((a) => a.name).join(' / ')}</b>`, alliance: chosen.alliance })}</p>`}
        ${chosen && !same(chosen) && buyerAlliances.length > 0 && html`<p className="text-xs text-amber-300 mt-4 flex gap-1.5"><${Icon} name="triangle-alert" className="w-3.5 h-3.5 mt-px" />
            ${sorted.some(same) ? t("{airline} ({alliance}) is not in any of the buyer's alliances ({alliances}).", { airline: chosen.name, alliance: chosen.alliance, alliances: buyerAlliances.join(', ') })
                : t('You share no alliance with this buyer ({alliances}).', { alliances: buyerAlliances.join(', ') })} ${t('You can still take the order.')}</p>`}
        <p className="text-xs text-slate-400 mt-4">${tj(join ? 'The buyer gets notified that {airline} will also be delivering. Sell the aircraft in-game, then record deliveries here.' : 'The buyer gets notified that {airline} is selling to them. Sell the aircraft in-game, then record deliveries here.', { airline: html`<b className="text-slate-200">${chosen?.name}</b>` })}</p>
    <//>`;
}

// Update delivery: every seller records only the aircraft they listed in-game themselves (the order's seller,
// or a seller who took over part of it). Other sellers' aircraft are shown but can't be changed here.
function ProgressModal({ order, userId, onClose, onSave }) {
    const lines = orderLines(order);
    const shares = deliveryShares(order);
    const helping = order.seller_id !== userId && isHelping(order, userId);
    const me = (helping ? shares.find((sh) => sh.role === 'helper' && sh.sellerId === userId) : shares.find((sh) => sh.role === 'seller'));
    const start = me?.items || lines.map(() => 0);
    const others = lines.map((it, i) => it.filled - start[i]);
    const [counts, setCounts] = useState(start);
    const [note, setNote] = useState('');
    const [sellerNote, setSellerNote] = useState(order.seller_note || '');
    const [busy, setBusy] = useState(false);
    const maxMine = (i) => Math.max(0, lines[i].qty - others[i]);
    const setLine = (i, v) => setCounts((c) => c.map((n, j) => (j === i ? Math.max(0, Math.min(maxMine(i), Math.floor(Number(v) || 0))) : n)));
    const total = counts.reduce((sum, n, i) => sum + n + others[i], 0);
    const max = order.total_qty;
    const next = total === 0 ? 'CLAIMED' : total >= max ? 'FULFILLED' : 'PARTIAL';
    const changed = counts.some((n, i) => n !== start[i]);
    const actingFor = order.seller_id !== userId && !helping;   // an admin updating for the order's seller
    return html`<${Modal} open=${true} onClose=${onClose} title=${`${t('Update delivery')} · ${orderRef(order)}`} size="md"
        subtitle=${`${airlineNames(order)} · ${plural(lines.length, 'aircraft type')}${actingFor ? ` · ${t('for {airline}', { airline: order.seller_airline_name })}` : ''}`}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>${t('Cancel')}<//>
            <${Button} busy=${busy} onClick=${async () => { setBusy(true); await onSave({ mine: counts, changed, note: note.trim(), sellerNote: helping ? undefined : sellerNote.trim() }); setBusy(false); }}>${t('Save')}<//>`}>
        <div className="space-y-5">
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                    <p className="field-label !mb-0">${actingFor ? t('Listed in-game by {airline}, per aircraft type', { airline: order.seller_airline_name }) : t('Listed in-game by you, per aircraft type')}</p>
                    <button onClick=${() => setCounts(lines.map((_, i) => maxMine(i)))} className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20">${t('All the rest')}</button>
                </div>
                ${lines.map((it, i) => html`<div key=${i} className="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-bold text-white min-w-0 truncate">${it.model} <span className="text-slate-500 font-medium">@${it.pricePercent}%</span></p>
                        ${others[i] > 0 && html`<span className="text-[10px] text-slate-400 shrink-0">${t('{n} by other sellers', { n: others[i] })}</span>`}
                    </div>
                    <div className="flex items-center gap-2">
                        <button className="stepper !w-9 !h-9" aria-label=${t('One less {model}', { model: it.model })} disabled=${counts[i] <= 0} onClick=${() => setLine(i, counts[i] - 1)}><${Icon} name="minus" /></button>
                        <input type="number" value=${counts[i]} min="0" max=${maxMine(i)} onChange=${(e) => setLine(i, e.target.value)} className="input !w-20 !py-2 text-center font-bold" aria-label=${t('{model} listed', { model: it.model })} />
                        <button className="stepper !w-9 !h-9" aria-label=${t('One more {model}', { model: it.model })} onClick=${() => setLine(i, counts[i] + 1)}><${Icon} name="plus" /></button>
                        <span className="text-sm text-slate-400">${others[i] > 0 ? `+ ${others[i]} = ${counts[i] + others[i]} ` : ''}${t('of {n}', { n: it.qty })}</span>
                        <button onClick=${() => setLine(i, maxMine(i))} className="ml-auto px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-300 hover:bg-slate-800">${t('All')}</button>
                    </div>
                    <${ProgressBar} value=${counts[i] + others[i]} max=${it.qty} />
                </div>`)}
                <p className="text-xs text-slate-400">${tj('Delivered in total {n} of {max} · new status: {status}', { n: total, max, status: html`<b className="text-slate-200">${STATUS[next].label}</b>` })}</p>
            </div>
            <label className="block"><span className="field-label">${t("Update message (optional, shown in the buyer's timeline)")}</span>
                <input value=${note} maxLength="500" onChange=${(e) => setNote(e.target.value)} className="input" placeholder=${t('e.g. First 5 listed, buy them at WIII')} /></label>
            ${!helping && html`<label className="block"><span className="field-label">${t('Seller note (pinned on the order, buyer can see)')}</span>
                <textarea value=${sellerNote} maxLength="1000" rows="2" onChange=${(e) => setSellerNote(e.target.value)} className="input"></textarea></label>`}
        </div>
    <//>`;
}

function FlagModal({ order, flag, onClose, onSave }) {
    const [status, setStatus] = useState(flag?.status || 'NORMAL');
    const [reason, setReason] = useState(flag?.reason || '');
    const [busy, setBusy] = useState(false);
    return html`<${Modal} open=${true} onClose=${onClose} title=${t('Flag {ref}', { ref: orderRef(order) })} size="sm" subtitle=${t('Only sellers can see flags. The buyer is not notified.')}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>${t('Cancel')}<//>
            <${Button} busy=${busy} onClick=${async () => { setBusy(true); await onSave(status, reason.trim()); setBusy(false); }}>${t('Save flag')}<//>`}>
        <div className="grid grid-cols-3 gap-1.5">
            ${Object.entries(FLAG_META).map(([k, m]) => html`<button key=${k} onClick=${() => setStatus(k)}
                className=${`p-3 rounded-xl border text-xs font-bold flex flex-col items-center gap-1.5 ${status === k ? m.cls : 'border-slate-800 text-slate-400'}`}>
                <${Icon} name=${m.icon} className="w-5 h-5" />${m.label}</button>`)}
        </div>
        <label className="block mt-4"><span className="field-label">${t('Reason')}</span>
            <textarea value=${reason} rows="3" maxLength="500" onChange=${(e) => setReason(e.target.value)} className="input" placeholder=${t('Why is this order flagged?')}></textarea></label>
    <//>`;
}

// A reminder to the buyer of a completed order: buy the aircraft listed for you in-game. Optional message.
function RemindModal({ order, onClose, onSend }) {
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    return html`<${Modal} open=${true} onClose=${onClose} title=${t('Remind the buyer · {ref}', { ref: orderRef(order) })} size="sm"
        subtitle=${t("For buyers who haven't bought the aircraft you listed yet.")}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>${t('Cancel')}<//>
            <${Button} icon="bell-ring" busy=${busy} onClick=${async () => { setBusy(true); await onSend(note.trim()); setBusy(false); }}>${t('Send reminder')}<//>`}>
        <p className="text-sm text-slate-300">${t('The buyer gets a reminder on Echo Market (order timeline and 🔔) and a Discord DM: your airline listed their aircraft in-game, and they should buy exactly what was listed.')}</p>
        <label className="block mt-4"><span className="field-label">${t('Your message (optional)')}</span>
            <textarea value=${note} rows="3" maxLength="500" onChange=${(e) => setNote(e.target.value)} className="input" placeholder=${t('e.g. Listed at WIII, please buy them today')}></textarea></label>
        <p className="text-[11px] text-slate-500 mt-2">${t('You can send one reminder per order every {n} hours.', { n: REMIND_HOURS })}</p>
    <//>`;
}

await setLang(savedLang(), ['app'], false).catch(() => {});
ReactDOM.createRoot(document.getElementById('root')).render(isConfigured ? html`<${App} />` : html`<${NotConfigured} />`);
