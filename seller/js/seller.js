// Echo Market — seller desk.
// Sign-in is Discord via Supabase; access requires a row in public.sellers.
// Reads come straight from Supabase (RLS lets sellers see all orders);
// every change goes through /api/orders/:id so Discord stays in sync.
import {
    html, useState, useEffect, useMemo, useCallback, useRef, sb, isConfigured, CONFIG, api, store,
    signInWithDiscord, fmtUSD, fmtUSDShort, fmtDate, timeAgo, plural, STATUS, ACTIVE_STATUSES,
    StatusBadge, OrderStepper, ProgressBar, Icon, Toasts, toast, Modal, DialogHost, ask, Button, DiscordLogo, fmtDuration, toneClass,
    Spinner, Avatar, EmptyState, NotConfigured, notifyBrowser, displayStatus, orderLines, ItemProgress,
    orderRef, OrderCode, greetingFor, orderAirlines, airlineNames, orderAlliances, deliverableTo
} from './ui.js';

const LS_SELL_AS = 'echo_seller_airline_v2';

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
const LS_PAGE_SIZE = 'echo_seller_page_size_v1';
const PAGE_SIZES = [5, 10, 25, 50, 'all'];

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
            return { tone: wait > 24 * 36e5 ? 'rose' : wait > 6 * 36e5 ? 'amber' : 'slate', text: `Waiting ${fmtDuration(wait)}` };
        }
        case 'CLAIMED':
        case 'PARTIAL': {
            const taken = ms(o.claimed_at);
            const waited = taken ? taken - queuedSince(o) : null;
            return { tone: 'slate', text: `${waited != null ? `Taken after ${fmtDuration(waited)} · ` : ''}with seller ${fmtDuration(now - (taken || ms(o.status_changed_at) || now))}` };
        }
        case 'FULFILLED':
            return { tone: 'emerald', text: `Done in ${fmtDuration((ms(o.fulfilled_at) || ms(o.status_changed_at) || now) - ms(o.created_at))}` };
        default:
            return { tone: 'slate', text: `Closed after ${fmtDuration((ms(o.status_changed_at) || now) - ms(o.created_at))}` };
    }
}
function WaitChip({ order, now }) {
    const t = timing(order, now);
    return html`<span className=${`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold whitespace-nowrap ${toneClass(t.tone)}`}>
        <${Icon} name="timer" className="w-3 h-3" />${t.text}</span>`;
}
const FLAG_META = {
    NORMAL: { label: 'Normal', cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10', icon: 'shield-check' },
    SUSPICIOUS: { label: 'Suspicious', cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10', icon: 'flag' },
    BLACKLISTED: { label: 'Blacklisted', cls: 'text-rose-300 border-rose-500/30 bg-rose-500/10', icon: 'ban' }
};

function App() {
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
    const [msgSeen, setMsgSeen] = useState(() => store.get(LS_MSG_SEEN, {}));
    useEffect(() => { store.set(LS_MSG_SEEN, msgSeen); }, [msgSeen]);
    const [loading, setLoading] = useState(true);

    const [tab, setTab] = useState('open');
    const [pageSize, setPageSize] = useState(() => { const v = store.get(LS_PAGE_SIZE, 5); return PAGE_SIZES.includes(v) ? v : 5; });
    const [now, setNow] = useState(() => Date.now());   // ticks every minute so wait times stay current
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);
    useEffect(() => { store.set(LS_PAGE_SIZE, pageSize); }, [pageSize]);
    const [statusFilter, setStatusFilter] = useState('ALL');
    const [query, setQuery] = useState('');
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
                    if (me) toast(`Welcome to the seller desk! You were added because you're a ${RANK_LABEL[rankOf(me)]} on Discord.`, 'success');
                }
            } else {
                // Role sellers can only read orders while their role was confirmed in the last hour, so refresh
                // the check first when it's older than 30 minutes (or once per visit). This also brings the
                // rank (colour and title) up to date with the highest seller role on Discord.
                const age = me.role_checked_at ? Date.now() - new Date(me.role_checked_at).getTime() : Infinity;
                if (!roleChecked.current || (me.source === 'discord_role' && age > 30 * 60e3)) {
                    roleChecked.current = true;
                    const r = await api('/api/enroll').catch(() => null);
                    if (r && !r.seller) me = null;
                    else if (r?.rank) me = { ...me, rank: r.rank, admin_now: r.admin };   // promoted or demoted on Discord
                }
            }
        }
        me = withAdmin(me);
        if (me) window.setSellerTint?.(rankOf(me));
        setSeller(me);
        if (!me) { setLoading(false); return; }
        const [ord, fl, air, dec, team, msg] = await Promise.all([
            sb.from('orders').select('*').order('created_at', { ascending: false }).limit(1000),
            sb.from('order_flags').select('*'),
            sb.from('airlines').select('*').eq('owner_id', userId).order('created_at'),
            sb.from('order_declines').select('*'),
            sb.from('sellers').select('user_id').eq('active', true),
            sb.from('order_messages').select('*').order('created_at').limit(2000)
        ]);
        setMessages(msg.data || []);
        setDeclines(dec.data || []);
        setTeamSize(Math.max(1, (team.data || []).length));
        if (ord.error) toast('Could not load orders: ' + ord.error.message, 'error');
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
                    toast(`New order ${orderRef(p.new)} from ${airlineNames(p.new)}`, 'success');
                    notifyBrowser('New Echo Market order', `${airlineNames(p.new)}: ${plural(p.new.total_qty, 'aircraft')}`);
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
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_messages' }, (p) => {
                setMessages((l) => [...l.filter((m) => m.id !== p.new.id), p.new]);
                if (p.new.from_role === 'buyer') {
                    toast(`💬 New message from the buyer of ${p.new.order_id}`, 'info');
                    notifyBrowser('Echo Market: buyer message', p.new.body.slice(0, 120), 'om' + p.new.id);
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
    const messagesOf = (orderId) => messages.filter((m) => m.order_id === orderId);
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
    const closeDetail = () => { history.replaceState(null, '', window.location.pathname); setDetailId(null); };

    const actions = {
        claim: (order) => {
            if (!airlines.length) return toast('Create an airline profile on the market\'s Airlines page first — buyers see which airline is selling to them.', 'error');
            setModal({ kind: 'claim', order });
        },
        progress: (order) => setModal({ kind: 'progress', order }),
        flag: (order) => setModal({ kind: 'flag', order }),
        release: async (order) => {
            const left = order.total_qty - order.filled;
            const ok = order.filled > 0
                ? await ask({ title: `Pass on the rest of ${orderRef(order)}?`, confirmLabel: 'Pass on the rest',
                    message: `${order.filled} of ${order.total_qty} aircraft are delivered and stay counted. The remaining ${left} go back to the open queue as "partly delivered" for another seller to finish. The buyer is told.` })
                : await ask({ title: `Release ${orderRef(order)}?`, confirmLabel: 'Release order',
                    message: 'It goes back to the open queue for another seller. The buyer is told it is waiting again.' });
            if (ok) act(order, { action: 'release' }, order.filled > 0 ? `The remaining ${left} aircraft are back in the open queue.` : `${orderRef(order)} is back in the open queue.`);
        },
        decline: async (order) => {
            const left = othersLeft(order);
            if (left > 0) {
                const note = await ask({
                    title: `Pass on ${orderRef(order)}?`, confirmLabel: 'Pass',
                    message: `It disappears from your open queue but stays open for the other ${plural(left, 'seller')}. The buyer is not told. The order is only declined if every seller passes.`,
                    input: { required: false, placeholder: 'Optional note for the other sellers (e.g. price too low for me)' }
                });
                if (note === false) return;
                act(order, { action: 'decline', reason: note || '' }, (r) => r.declinedForEveryone ? `${orderRef(order)} declined.` : `You passed on ${orderRef(order)}. ${plural(r.sellersLeft, 'seller')} can still take it.`);
            } else {
                const reason = await ask({
                    title: `Decline ${orderRef(order)} for good?`, danger: true, confirmLabel: 'Decline order',
                    message: 'Every other seller has already passed, so declining closes the order. The buyer will see your reason. This cannot be undone.',
                    input: { required: true, placeholder: 'e.g. Price level too low for this type right now' }
                });
                if (reason) act(order, { action: 'decline', reason }, `${orderRef(order)} declined.`);
            }
        },
        forceDecline: async (order) => {
            const reason = await ask({
                title: `Decline ${orderRef(order)} for everyone?`, danger: true, confirmLabel: 'Decline for everyone',
                message: 'Admin action: closes the order for the whole seller team right away (for spam or rule breaks). The buyer will see your reason.',
                input: { required: true, placeholder: 'Reason shown to the buyer' }
            });
            if (reason) act(order, { action: 'decline', reason, force: true }, `${orderRef(order)} declined for everyone.`);
        },
        remove: async (order) => {
            if (await ask({ title: `Delete ${orderRef(order)}?`, message: 'This permanently removes the order and its history for everyone, including the buyer. Prefer "Decline" unless this is spam.', confirmLabel: 'Delete forever', danger: true })) {
                act(order, { action: 'delete' }, `${orderRef(order)} deleted.`);
            }
        }
    };

    if (!authReady) return html`<div className="min-h-screen flex items-center justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`;
    if (!session) return html`<${SignInScreen} />`;
    if (seller === undefined) return html`<div className="min-h-screen flex items-center justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`;
    if (!seller) return html`<${NotASeller} account=${account} />`;

    // ---- filtering
    const q = query.trim().toLowerCase();
    const matches = (o) => !q || [o.id, o.serial ? '#' + o.serial : '', ...orderAirlines(o).flatMap((a) => [a.name, a.alliance]), o.buyer_name, o.seller_airline_name, o.buyer_note, o.seller_note,
        ...(o.items || []).map((i) => i.model)].join(' ').toLowerCase().includes(q);
    const tabs = {
        open: { label: 'Open queue', icon: 'inbox', fn: (o) => o.status === 'PENDING' && !iPassed(o) },
        mine: { label: 'My orders', icon: 'briefcase', fn: (o) => o.seller_id === userId && ['CLAIMED', 'PARTIAL'].includes(o.status) },
        all: { label: 'All orders', icon: 'list', fn: (o) => statusFilter === 'ALL' || o.status === statusFilter },
        // Admins only: seller performance (the API refuses everyone else too).
        ...(seller.is_admin ? { team: { label: 'Sellers', icon: 'trophy', fn: () => false },
                                mod: { label: 'Moderation', icon: 'shield', fn: () => false } } : {})
    };
    if (!tabs[tab]) setTimeout(() => setTab('open'));
    const counts = {
        open: orders.filter(tabs.open.fn).length,
        mine: orders.filter(tabs.mine.fn).length,
        all: orders.length
    };
    const list = orders.filter((o) => (tabs[tab] || tabs.open).fn(o) && matches(o));
    // Open queue: longest-waiting first. Other tabs stay newest first.
    if (tab === 'open') list.sort((a, b) => queuedSince(a) - queuedSince(b));
    // All orders: show the first N, the rest behind "Show more".
    const paged = tab === 'all' && pageSize !== 'all' ? list.slice(0, pageSize) : list;
    const detail = orders.find((o) => o.id === detailId);

    return html`<div className="min-h-screen pb-12">
        <header className="sticky top-0 z-40 bg-page/85 backdrop-blur border-b border-slate-800/80">
            <div className="max-w-6xl mx-auto px-4 md:px-6 h-14 md:h-16 flex items-center gap-3">
                <img src="echo_logo.png" alt="" className="w-8 h-8 rounded-lg" />
                <div className="leading-tight">
                    <p className="font-extrabold text-white">Seller desk</p>
                    <p className="text-[11px] text-sky-300">${RANK_LABEL[rankOf(seller)]}${adminSuffix(seller)}</p>
                </div>
                <div className="flex-1"></div>
                <${SellAsPicker} airlines=${airlines} sellAs=${sellAs} onChange=${setSellAsId} />
                <a href=${CONFIG.BUYER_URL || "#"} className="hidden sm:flex p-2.5 rounded-full text-slate-400 hover:bg-slate-800 hover:text-white" title="Open the market"><${Icon} name="shopping-bag" className="w-5 h-5" /></a>
                <${AccountMenu} account=${account} seller=${seller} airlines=${airlines} sellAs=${sellAs} onSellAs=${setSellAsId} />
            </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 md:px-6 pt-4 md:pt-6 space-y-4 md:space-y-5">
            <${SellerGreeting} account=${account} now=${now} open=${orders.filter(tabs.open.fn)} mine=${counts.mine}
                unreadOrders=${orders.filter((o) => unreadOf(o.id) > 0).length} />
            ${!airlines.length && html`<div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-2xl border border-amber-500/30 bg-amber-500/5">
                <${Icon} name="triangle-alert" className="w-5 h-5 text-amber-300" />
                <p className="flex-1 text-sm text-amber-100"><b>You need an airline profile to take orders.</b> Buyers see which airline is selling to them. Create one on the market site's Airlines page (same Discord login), then come back.</p>
                <a href=${(CONFIG.BUYER_URL || "") + "/#airlines"}><${Button} size="sm" variant="white">Create airline<//></a>
            </div>`}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
                <${Stat} label="Waiting for a seller" value=${counts.open} icon="inbox" tone="text-amber-300" />
                <${Stat} label="My active orders" value=${counts.mine} icon="briefcase" tone="text-sky-400" />
                <${Stat} label="In delivery (all sellers)" value=${orders.filter((o) => ['CLAIMED', 'PARTIAL'].includes(o.status)).length} icon="truck" tone="text-violet-300" />
                <${Stat} label="Delivered" value=${orders.filter((o) => o.status === 'FULFILLED').length} icon="circle-check" tone="text-emerald-300" />
            </div>

            <div className="flex flex-col md:flex-row gap-2 md:items-center">
                <div className="flex p-1 rounded-full bg-slate-900 border border-slate-800 overflow-x-auto no-scrollbar">
                    ${Object.entries(tabs).map(([k, t]) => html`<button key=${k} onClick=${() => setTab(k)}
                        className=${`shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold ${tab === k ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>
                        <${Icon} name=${t.icon} className="w-3.5 h-3.5" />${t.label}${counts[k] != null && html`<span className="opacity-60">${counts[k]}</span>`}
                    </button>`)}
                </div>
                ${tab === 'all' && html`<select value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)} className="input md:!w-48">
                    <option value="ALL">Any status</option>
                    ${Object.entries(STATUS).map(([k, m]) => html`<option key=${k} value=${k}>${m.label}</option>`)}
                </select>`}
                ${!['team', 'mod'].includes(tab) && html`<label className="relative flex-1">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"><${Icon} name="search" /></span>
                    <input value=${query} onChange=${(e) => setQuery(e.target.value)} placeholder="Search order, airline, buyer, aircraft…" className="input pl-10" />
                </label>`}
            </div>

            ${tab === 'mod' && seller.is_admin ? html`<${ModerationView} userId=${userId} />`
            : tab === 'team' && seller.is_admin ? html`<${SellerStats} userId=${userId} onOpenOrder=${openDetail} />`
            : loading ? html`<div className="py-16 flex justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`
            : !list.length ? html`<${EmptyState} icon=${tab === 'open' ? 'party-popper' : 'inbox'}
                title=${tab === 'open' ? 'Queue is empty' : tab === 'mine' ? 'You have no active orders' : 'No orders found'}
                text=${tab === 'open' ? 'New orders appear here instantly (and on Discord). Orders you passed on are under All orders.' : tab === 'mine' ? 'Take one from the open queue.' : 'Try a different search or status.'} />`
            : html`<div className="space-y-2">${paged.map((o) => html`<${OrderRow} key=${o.id} order=${o} flag=${flags[o.id]} userId=${userId} airlines=${airlines}
                passed=${passedOn(o)} teamSize=${teamSize} now=${now} onBuyer=${setBuyerOf} unread=${unreadOf(o.id)}
                seller=${seller} actions=${actions} onOpen=${() => openDetail(o.id)} />`)}
                ${tab === 'all' && list.length > 5 && html`<${PageSizeBar} total=${list.length} shown=${paged.length} pageSize=${pageSize} setPageSize=${setPageSize} />`}
            </div>`}
        </main>

        ${detail && html`<${OrderDetail} order=${detail} flag=${flags[detail.id]} userId=${userId} seller=${seller} airlines=${airlines} now=${now}
            passed=${passedOn(detail)} teamSize=${teamSize} onBuyer=${setBuyerOf}
            messages=${messagesOf(detail.id)} onSeen=${() => markSeen(detail.id)}
            onMessage=${(m) => setMessages((l) => [...l.filter((x) => x.id !== m.id), m])}
            actions=${actions} onClose=${closeDetail} />`}
        ${buyerOf && html`<${BuyerModal} order=${buyerOf} orders=${orders} flags=${flags} isAdmin=${seller.is_admin} onClose=${() => setBuyerOf(null)}
            onOpenOrder=${(id) => { setBuyerOf(null); openDetail(id); }} />`}
        ${detailId && !detail && !loading && html`<${Modal} open=${true} onClose=${closeDetail} title="Order not found" size="sm">
            <p className="text-sm text-slate-400">${detailId} doesn't exist or was deleted.</p><//>`}

        ${modal?.kind === 'claim' && html`<${ClaimModal} order=${modal.order} airlines=${airlines} sellAs=${sellAs}
            onClose=${() => setModal(null)}
            onConfirm=${async (airlineId) => {
                setSellAsId(airlineId);
                const ok = await act(modal.order, { action: 'claim', airlineId }, `You took ${orderRef(modal.order)}. The buyer has been notified.`);
                if (ok) { setModal(null); setTab('mine'); }
            }} />`}
        ${modal?.kind === 'progress' && html`<${ProgressModal} order=${modal.order} onClose=${() => setModal(null)}
            onSave=${async (payload) => {
                let ok = true;
                if (payload.changed || payload.note) ok = await act(modal.order, { action: 'progress', items: payload.items, note: payload.note });
                if (ok && payload.sellerNote !== (modal.order.seller_note || '')) ok = await act(modal.order, { action: 'note', sellerNote: payload.sellerNote });
                if (ok) { setModal(null); toast(`${orderRef(modal.order)} updated.`, 'success'); }
            }} />`}
        ${modal?.kind === 'flag' && html`<${FlagModal} order=${modal.order} flag=${flags[modal.order.id]} onClose=${() => setModal(null)}
            onSave=${async (flagStatus, flagReason) => {
                if (await act(modal.order, { action: 'flag', flagStatus, flagReason }, 'Flag saved.')) setModal(null);
            }} />`}

        <${Toasts} />
        <${DialogHost} />
    </div>`;
}

// ---------------------------------------------------------------- screens
function SignInScreen() {
    return html`<div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
            <img src="echo_logo.png" alt="" className="w-14 h-14 rounded-2xl mx-auto" />
            <h1 className="text-2xl font-black text-white mt-5">Echo Market seller desk</h1>
            <p className="text-sm text-slate-400 mt-2">For Verified Sellers, Ambassadors and the Lead Ambassador. Sign in with your Discord account.</p>
            <${Button} variant="discord" size="lg" className="w-full mt-7" onClick=${signInWithDiscord}><${DiscordLogo} /> Sign in with Discord<//>
            <a href=${CONFIG.BUYER_URL || "#"} className="inline-block mt-6 text-xs font-bold text-slate-500 hover:text-slate-300">← Back to Echo Market</a>
        </div>
    </div>`;
}

function NotASeller({ account }) {
    const copy = () => { navigator.clipboard?.writeText(account?.discord_id || ''); toast('Discord ID copied.'); };
    return html`<div className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
            <div className="w-14 h-14 rounded-2xl mx-auto bg-slate-900 border border-slate-800 flex items-center justify-center"><${Icon} name="lock" className="w-6 h-6 text-slate-400" /></div>
            <h1 className="text-xl font-black text-white mt-5">You're not on the seller list yet</h1>
            <p className="text-sm text-slate-400 mt-2">Signed in as <b className="text-slate-200">${account?.display_name || account?.discord_username}</b>.
                <b className="text-slate-200">Verified Sellers</b>, Ambassadors and the Lead Ambassador get in automatically through their role on the Echo Discord server. To become a Verified Seller, apply through the Verified Seller application form. Got the role just now? Check again.
                Otherwise, send your Discord ID to an Echo Market admin.</p>
            <button onClick=${copy} className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 font-mono text-sm hover:border-slate-600">
                ${account?.discord_id || 'unknown'} <${Icon} name="copy" className="w-4 h-4 text-slate-500" />
            </button>
            <div className="mt-7 flex flex-wrap justify-center gap-2">
                <${Button} icon="refresh-cw" onClick=${() => window.location.reload()}>Check again<//>
                <a href=${CONFIG.BUYER_URL || "#"}><${Button} variant="secondary">Go to Echo Market<//></a>
                <${Button} variant="ghost" onClick=${() => sb.auth.signOut()}>Sign out<//>
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
        : !data ? html`<div className="py-16 flex justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`
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
            : !data ? html`<div className="py-10 flex justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`
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
                        ${data.orders.map((o) => html`<li key=${o.id}>
                            <button onClick=${() => onOpenOrder(o.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/40">
                                <span className="flex-1 min-w-0">
                                    <${OrderCode} order=${o} />
                                    <span className="block text-sm text-slate-200 truncate">${airlineNames(o)} <span className="text-slate-500">· ${o.buyer_name}</span></span>
                                    <span className="block text-[11px] text-slate-500">took it ${fmtDate(o.takenAt)} · delivered ${o.deliveredBySeller} of ${plural(o.total_qty, 'aircraft')}${!o.stillTheirs && ['PENDING', 'CLAIMED', 'PARTIAL'].includes(o.status) ? ' · now with another seller' : ''}</span>
                                </span>
                                <${StatusBadge} status=${displayStatus(o)} />
                            </button>
                        </li>`)}
                    </ul>`}
                </div>
            `}
        </div>
    <//>`;
}

// Same local-time greeting as the buyer site, with a one-line summary of the queue.
function SellerGreeting({ account, now, open, mine, unreadOrders = 0 }) {
    const date = new Date(now);
    const g = greetingFor(date);
    const name = account?.display_name || account?.discord_username || '';
    const oldest = open.reduce((m, o) => Math.min(m, queuedSince(o)), Infinity);
    const when = date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + ' · ' +
        date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return html`<section>
        <p className="label text-sky-300 flex items-center gap-2"><${Icon} name=${g.icon} className="w-4 h-4" />${when}</p>
        <h1 className="text-2xl md:text-4xl font-black tracking-tight text-white mt-1.5 md:mt-2 truncate">${g.text}${name ? `, ${name}` : ''}.</h1>
        <p className="text-sm text-slate-400 mt-1">${open.length
            ? `${plural(open.length, 'order')} waiting for a seller · the longest for ${fmtDuration(now - oldest)}.`
            : 'The open queue is empty.'}${mine ? ` You have ${plural(mine, 'active order')}.` : ''}${unreadOrders ? ` 💬 ${plural(unreadOrders, 'order')} with new buyer messages.` : ''}</p>
    </section>`;
}

// Profile picture → small menu. Signing out needs this extra tap, so it can't happen by accident.
function AccountMenu({ account, seller, airlines, sellAs, onSellAs }) {
    const [open, setOpen] = useState(false);
    const signOut = async () => {
        setOpen(false);
        if (await ask({ title: 'Sign out of the seller desk?', confirmLabel: 'Sign out', message: "You'll need to sign in with Discord again to take orders." })) sb.auth.signOut();
    };
    return html`<div className="relative">
        <button onClick=${() => setOpen(!open)} aria-label="Account menu" aria-expanded=${open}
            className="flex items-center gap-1.5 h-10 pl-1 pr-2 rounded-full hover:bg-slate-800">
            <${Avatar} account=${account} /><${Icon} name="chevron-down" className="w-4 h-4 text-slate-500" />
        </button>
        ${open && html`<div className="fixed inset-0 z-40" onClick=${() => setOpen(false)}></div>
        <div className="absolute right-0 mt-2 w-72 max-w-[calc(100vw-2rem)] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-2 z-50 animate-pop">
            <div className="flex items-center gap-3 px-3 py-2.5 border-b border-slate-800 mb-1">
                <${Avatar} account=${account} size="w-10 h-10" />
                <div className="min-w-0">
                    <p className="font-bold text-sm text-white truncate">${account?.display_name || account?.discord_username || 'Signed in'}</p>
                    <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5"><${DiscordLogo} className="w-3.5 h-3.5" /> ${account?.discord_username || 'Discord'}</p>
                    <div className="mt-1.5"><${RankBadge} rank=${rankOf(seller)} admin=${seller?.is_admin} /></div>
                </div>
            </div>
            ${airlines.length > 0 && html`<label className="sm:hidden block px-3 py-2">
                <span className="block text-[11px] font-bold text-slate-500 mb-1">Selling as</span>
                <select value=${sellAs?.id || ''} onChange=${(e) => onSellAs(e.target.value)} className="input !py-2">
                    ${airlines.map((a) => html`<option key=${a.id} value=${a.id}>${a.name} · ${a.alliance}</option>`)}
                </select>
            </label>`}
            <a href=${CONFIG.BUYER_URL || '#'} className="menu-item"><${Icon} name="shopping-bag" /> Open the market</a>
            <button onClick=${signOut} className="menu-item w-full text-rose-300"><${Icon} name="log-out" /> Sign out</button>
        </div>`}
    </div>`;
}

// The buyer airline's name, as a link to the buyer's Discord info.
function BuyerLink({ order, onBuyer }) {
    return html`<button type="button" title="See the buyer's Discord info"
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
    const name = buyer?.display_name || buyer?.discord_username || order.buyer_name || 'Unknown buyer';
    const theirs = orders.filter((o) => (order.buyer_id ? o.buyer_id === order.buyer_id : o.buyer_discord_id === discordId));
    const count = (fn) => theirs.filter(fn).length;
    const airlines = [...new Map(theirs.flatMap(orderAirlines).map((a) => [a.name + '|' + a.alliance, a])).values()];
    const flagged = theirs.filter((o) => flags[o.id] && flags[o.id].status !== 'NORMAL');
    const copy = (text, what) => { navigator.clipboard?.writeText(text); toast(`${what} copied.`); };
    const dm = !buyer ? null : buyer.dm_enabled === false ? 'turned off' : buyer.dm_status === 'blocked' ? "can't reach them (DMs closed or not in the server)" : buyer.dm_status === 'ok' ? 'on' : 'on (not tried yet)';

    return html`<${Modal} open=${true} onClose=${onClose} size="md" title="Buyer" subtitle=${`From ${orderRef(order)} · ${airlineNames(order)}`}>
        <div className="space-y-5">
            <div className="flex items-center gap-4">
                ${buyer === undefined ? html`<span className="w-14 h-14 rounded-full bg-slate-800 animate-pulse"></span>`
                    : html`<${Avatar} account=${buyer || { display_name: name }} size="w-14 h-14" />`}
                <div className="min-w-0">
                    <p className="text-lg font-extrabold text-white truncate">${name}</p>
                    ${buyer?.discord_username && html`<p className="text-sm text-slate-400 truncate">@${buyer.discord_username}</p>`}
                    ${buyer?.created_at && html`<p className="text-xs text-slate-500">On Echo Market since ${new Date(buyer.created_at).toLocaleDateString()}</p>`}
                    ${buyer === null && html`<p className="text-xs text-amber-300">This market account no longer exists.</p>`}
                </div>
            </div>

            ${discordId ? html`<div className="space-y-2">
                <div className="flex items-center gap-2 p-3 rounded-2xl bg-slate-950 border border-slate-800">
                    <span className="text-[#8b93ff]"><${DiscordLogo} /></span>
                    <span className="flex-1 min-w-0"><span className="block text-[11px] font-bold text-slate-500">Discord user ID</span>
                        <span className="block font-mono text-sm text-slate-100 truncate">${discordId}</span></span>
                    <${Button} size="sm" variant="secondary" icon="copy" onClick=${() => copy(discordId, 'Discord ID')}>Copy<//>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <a href=${`https://discord.com/users/${discordId}`} target="_blank" rel="noopener"
                        className="inline-flex items-center justify-center gap-2 rounded-full font-bold px-4 py-2.5 text-sm bg-[#5865F2] text-[#fff] hover:bg-[#4752C4]">
                        <${DiscordLogo} className="w-4 h-4" /> Open profile</a>
                    <${Button} variant="secondary" icon="at-sign" onClick=${() => copy(`<@${discordId}>`, 'Mention')}>Copy @mention<//>
                </div>
                <p className="text-[11px] text-slate-500">"Open profile" works when you share a Discord server with them. Paste the @mention in any Discord channel to ping them.</p>
            </div>` : html`<p className="text-sm text-slate-400">No Discord ID was saved with this order.</p>`}

            ${dm && html`<p className="text-xs text-slate-400 flex items-center gap-1.5"><${Icon} name="bell" className="w-3.5 h-3.5" /> Bot DMs about their orders: <b className="text-slate-200">${dm}</b></p>`}

            <div>
                <p className="label text-slate-500 mb-2">Their orders</p>
                <div className="grid grid-cols-4 gap-2 text-center">
                    ${[['Total', theirs.length], ['Active', count((o) => ACTIVE_STATUSES.includes(o.status))],
                        ['Delivered', count((o) => o.status === 'FULFILLED')], ['Closed', count((o) => ['CANCELLED', 'DECLINED'].includes(o.status))]]
                        .map(([l, v]) => html`<div key=${l} className="p-2 rounded-xl bg-slate-950 border border-slate-800">
                            <p className="text-lg font-black text-white">${v}</p><p className="text-[10px] font-bold text-slate-500">${l}</p></div>`)}
                </div>
                <p className="text-xs text-slate-400 mt-2">${plural(theirs.reduce((sum, o) => sum + (o.status === 'CANCELLED' || o.status === 'DECLINED' ? 0 : o.filled), 0), 'aircraft')} received so far.</p>
                ${flagged.length > 0 && html`<p className="text-xs text-rose-300 mt-1 flex items-center gap-1.5"><${Icon} name="flag" className="w-3.5 h-3.5" />${plural(flagged.length, 'order')} flagged by sellers.</p>`}
            </div>

            ${airlines.length > 0 && html`<div>
                <p className="label text-slate-500 mb-2">Airlines they ordered for</p>
                <div className="flex flex-wrap gap-1.5">${airlines.map((a) => html`<span key=${a.name + a.alliance} className="px-2.5 py-1 rounded-full bg-slate-800 text-xs font-bold text-slate-200">${a.name} <span className="text-slate-500">${a.alliance}</span></span>`)}</div>
            </div>`}

            ${theirs.length > 0 && html`<ul className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60">
                ${theirs.slice(0, 8).map((o) => html`<li key=${o.id}>
                    <button onClick=${() => onOpenOrder(o.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/40">
                        <span className="flex-1 min-w-0"><${OrderCode} order=${o} />
                            <span className="block text-xs text-slate-400 truncate">${airlineNames(o)} · ${plural(o.total_qty, 'aircraft')} · ${timeAgo(o.created_at)}</span></span>
                        <${StatusBadge} status=${displayStatus(o)} />
                    </button>
                </li>`)}
                ${theirs.length > 8 && html`<li className="px-3 py-2 text-xs text-slate-500">+ ${theirs.length - 8} older (search their name under All orders)</li>`}
            </ul>`}

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
            toast('Sent. The buyer gets a notification and a Discord DM.', 'success');
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };
    return html`<div className="space-y-2">
        ${!messages.length && html`<p className="text-xs text-slate-500">No messages yet. Buyers can write once an order has waited 5 days without being fully delivered; you can write to them any time.</p>`}
        ${messages.map((m) => html`<div key=${m.id} className=${`p-2.5 rounded-xl text-sm ${m.from_role === 'buyer' ? 'mr-8 bg-slate-800/70' : 'ml-8 bg-sky-500/10 border border-sky-500/20'}`}>
            <p className="text-[11px] text-slate-400">${m.from_role === 'buyer' ? `${m.author_name} · buyer` : `${m.author_name} · seller team`} · ${fmtDate(m.created_at)}</p>
            <p className="text-slate-100 whitespace-pre-line break-words">${m.body}</p>
        </div>`)}
        <div className="flex gap-2 items-end">
            <textarea value=${text} maxLength="1000" rows="2" onChange=${(e) => setText(e.target.value)} className="input flex-1" placeholder="Write to the buyer (they get a DM)"></textarea>
            <${Button} size="sm" icon="send" busy=${busy} disabled=${!text.trim()} onClick=${send}>Send<//>
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
        ${bans === null ? html`<${Spinner} />` : html`
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
        setTarget({ accountId: data?.id || null, discordId: id, name: data ? (data.display_name || data.discord_username) : `Discord user ${id}` });
    };
    return html`<section className="space-y-4">
        <div>
            <h2 className="text-lg font-extrabold text-white">Moderation</h2>
            <p className="text-xs text-slate-500">Admins only. Market bans cover every airline of a Discord account. Everything here is DMed to the person and logged.</p>
        </div>
        <div className="card p-4 space-y-2">
            <p className="field-label !mb-0">Ban or message anyone by Discord ID (also people who never used the market)</p>
            <div className="flex gap-2">
                <input value=${discordId} onChange=${(e) => setDiscordId(e.target.value)} placeholder="Discord user ID, e.g. 526234727321960450" className="input font-mono" />
                <${Button} icon="search" onClick=${lookUp}>Open<//>
            </div>
            <p className="text-[11px] text-slate-500">Or click a buyer's airline name on any order.</p>
        </div>
        ${target && html`<${Modal} open=${true} onClose=${() => setTarget(null)} size="sm" title=${target.name} subtitle=${`Discord ID ${target.discordId}`}>
            <${ModerationPanel} target=${target} onChanged=${load} />
        <//>`}
        <div>
            <p className="label text-slate-500 mb-2">Active market bans (${bans ? bans.length : '…'})</p>
            ${bans === null ? html`<${Spinner} />` : !bans.length ? html`<p className="text-sm text-slate-400">Nobody is banned right now.</p>`
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

function Stat({ label, value, icon, tone }) {
    return html`<div className="card !rounded-2xl md:!rounded-3xl p-3 md:p-4">
        <div className="flex items-center justify-between gap-2"><p className="text-[11px] font-bold text-slate-500 leading-tight">${label}</p><span className=${tone}><${Icon} name=${icon} /></span></div>
        <p className="text-xl md:text-2xl font-black text-white mt-1">${value}</p>
    </div>`;
}

function SellAsPicker({ airlines, sellAs, onChange }) {
    if (!airlines.length) return null;
    return html`<label className="hidden sm:flex items-center gap-2 pl-3 pr-1 py-1 rounded-full border border-slate-800 bg-slate-900 text-xs" title="The airline buyers see when you take an order">
        <span className="text-slate-500 font-bold">Selling as</span>
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
        title=${`None of your airlines is in ${orderAlliances(order).join(' or ')}`}>
        <${Icon} name="users-round" className="w-3 h-3" />NO SHARED ALLIANCE</span>`;
}

function itemsSummary(order, withDelivery = false) {
    return orderLines(order).map((i) => `${i.qty}× ${i.model} @${i.pricePercent}%${withDelivery && i.filled ? ` (${i.filled}/${i.qty})` : ''}`).join(' · ');
}

function PassedBadge({ passed, userId, teamSize }) {
    if (!passed?.length) return null;
    const me = passed.some((d) => d.seller_id === userId);
    return html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black text-slate-300 border-slate-700 bg-slate-800/60"
        title=${passed.map((d) => d.seller_name + (d.note ? `: ${d.note}` : '')).join('\n')}>
        <${Icon} name="user-x" className="w-3 h-3" />${me ? 'YOU PASSED · ' : ''}${passed.length}/${teamSize} PASSED</span>`;
}

// Which buttons a seller gets for an order.
function OrderActions({ order, userId, seller, actions, compact }) {
    const mine = order.seller_id === userId;
    const canManage = mine || seller.is_admin;
    const size = compact ? 'sm' : 'md';
    const stop = (fn) => (e) => { e.stopPropagation(); fn(order); };
    return html`<div className="flex flex-wrap gap-1.5" onClick=${(e) => e.stopPropagation()}>
        ${order.status === 'PENDING' && html`<${Button} size=${size} icon="hand" onClick=${stop(actions.claim)}>Take order<//>`}
        ${['CLAIMED', 'PARTIAL', 'FULFILLED'].includes(order.status) && canManage && html`<${Button} size=${size} icon="truck" variant=${order.status === 'FULFILLED' ? 'secondary' : 'primary'} onClick=${stop(actions.progress)}>Update delivery<//>`}
        ${['CLAIMED', 'PARTIAL'].includes(order.status) && canManage && !compact && html`<${Button} size=${size} variant="secondary" icon=${order.filled > 0 ? 'forward' : 'undo-2'} onClick=${stop(actions.release)}>${order.filled > 0 ? 'Pass on the rest' : 'Release'}<//>`}
        ${order.status === 'PENDING' && !compact && html`<${Button} size=${size} variant="ghost" icon="ban" onClick=${stop(actions.decline)}>Decline<//>`}
        ${seller.is_admin && ACTIVE_STATUSES.includes(order.status) && !compact && html`<${Button} size=${size} variant="ghost" icon="octagon-x" className="!text-rose-300" onClick=${stop(actions.forceDecline)}>Decline for all<//>`}
        ${!compact && html`<${Button} size=${size} variant="ghost" icon="flag" onClick=${stop(actions.flag)}>Flag<//>`}
        ${seller.is_admin && !compact && html`<${Button} size=${size} variant="ghost" icon="trash-2" className="!text-rose-300" onClick=${stop(actions.remove)}>Delete<//>`}
    </div>`;
}

function OrderRow({ order, flag, userId, airlines, seller, actions, onOpen, passed, teamSize, now, onBuyer, unread = 0 }) {
    const mine = order.seller_id === userId;
    return html`<article onClick=${onOpen} className=${`card !rounded-2xl md:!rounded-3xl p-3 md:p-4 cursor-pointer hover:border-slate-600 ${flag?.status === 'BLACKLISTED' ? 'border-rose-500/40' : ''}`}>
        <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                    <${OrderCode} order=${order} />
                    <${StatusBadge} status=${displayStatus(order)} />
                    <${FlagBadge} flag=${flag} />
                    ${order.status === 'PENDING' && html`<${AllianceBadge} airlines=${airlines} order=${order} />`}
                    ${order.status === 'PENDING' && html`<${PassedBadge} passed=${passed} userId=${userId} teamSize=${teamSize} />`}
                    ${mine && html`<span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300">YOURS</span>`}
                    <${WaitChip} order=${order} now=${now} />
                    ${unread > 0 && html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-400 text-slate-950">
                        <${Icon} name="message-circle" className="w-3 h-3" />${unread} NEW MESSAGE${unread === 1 ? '' : 'S'}</span>`}
                    <span className="text-[11px] text-slate-500" title=${fmtDate(order.created_at)}>ordered ${timeAgo(order.created_at)}</span>
                </div>
                <p className="font-extrabold text-white truncate"><${BuyerLink} order=${order} onBuyer=${onBuyer} /> <span className="text-slate-500 font-semibold text-sm">· ${orderAlliances(order).join(', ')} · ${order.buyer_name}</span></p>
                <p className="text-xs text-slate-400 truncate">${itemsSummary(order, true)}</p>
                ${order.seller_airline_name && !mine && html`<p className="text-[11px] text-slate-500">Seller: ${order.seller_airline_name} (${order.seller_name})</p>`}
            </div>
            <div className="flex md:flex-col items-center md:items-end justify-between gap-2 shrink-0">
                <div className="md:text-right">
                    <p className="font-black text-white">${fmtUSDShort(order.total_usd)}</p>
                    <p className="text-[11px] text-slate-500">${order.filled}/${order.total_qty} delivered</p>
                </div>
                <${OrderActions} order=${order} userId=${userId} seller=${seller} actions=${actions} compact=${true} />
            </div>
        </div>
    </article>`;
}

function OrderDetail({ order, flag, userId, seller, airlines, actions, onClose, passed, teamSize, now, onBuyer, messages = [], onSeen, onMessage }) {
    useEffect(() => { onSeen?.(); }, [order.id, messages.length]);
    const [events, setEvents] = useState([]);
    useEffect(() => {
        sb.from('order_events').select('*').eq('order_id', order.id).order('created_at').then(({ data }) => setEvents(data || []));
    }, [order.id, order.updated_at]);
    const items = orderLines(order);
    const previous = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];
    return html`<${Modal} open=${true} onClose=${onClose} size="lg" title=${html`${orderRef(order)} · <${BuyerLink} order=${order} onBuyer=${onBuyer} />`}
        subtitle=${`${order.id} · ${orderAlliances(order).join(', ')} · ordered by ${order.buyer_name} · ${fmtDate(order.created_at)}`}
        footer=${html`<${OrderActions} order=${order} userId=${userId} seller=${seller} actions=${actions} compact=${false} />`}>
        <div className="space-y-5">
            <div className="flex flex-wrap gap-2 items-center"><${StatusBadge} status=${displayStatus(order)} /><${FlagBadge} flag=${flag} /><${AllianceBadge} airlines=${airlines} order=${order} />
                ${order.status === 'PENDING' && html`<${PassedBadge} passed=${passed} userId=${userId} teamSize=${teamSize} />`}
            </div>
            <button onClick=${() => onBuyer(order)} className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-950 border border-slate-800 hover:border-slate-600 text-left">
                <span className="w-9 h-9 rounded-xl bg-[#5865F2]/15 text-[#8b93ff] flex items-center justify-center shrink-0"><${DiscordLogo} className="w-4 h-4" /></span>
                <span className="flex-1 min-w-0">
                    <span className="block text-[11px] font-bold text-slate-500">Buyer</span>
                    <span className="block font-bold text-white truncate">${order.buyer_name}${order.buyer_discord_id ? html` <span className="font-mono text-xs text-slate-500 font-normal">${order.buyer_discord_id}</span>` : ''}</span>
                </span>
                <span className="text-xs font-bold text-slate-300 shrink-0 flex items-center gap-1">Discord info <${Icon} name="chevron-right" /></span>
            </button>
            ${orderAirlines(order).length > 1 && html`<div>
                <p className="label text-slate-500 mb-1.5">Buyer accepts delivery to any of</p>
                <div className="flex flex-wrap gap-1.5">${orderAirlines(order).map((a) => {
                    const match = airlines.some((x) => x.alliance === a.alliance);
                    return html`<span key=${a.name + a.alliance} className=${`px-2.5 py-1 rounded-full text-xs font-bold ${match ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-200'}`}
                        title=${match ? 'You have an airline in this alliance' : ''}>${a.name} <span className="opacity-60">${a.alliance}</span></span>`;
                })}</div>
            </div>`}
            <${OrderStepper} order=${order} />
            ${order.seller_airline_name && html`<p className="text-sm text-slate-300">Seller: <b>${order.seller_airline_name}</b> (${order.seller_alliance}) — ${order.seller_name}${order.seller_id === userId ? ' (you)' : ''}</p>`}
            ${previous.length > 0 && html`<p className="text-sm text-slate-300">Earlier sellers: ${previous.map((p) => html`<b key=${p.at}>${p.seller_airline_name}</b>`).reduce((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}
                <span className="text-slate-400"> · delivered ${previous.map((p) => p.delivered).join(' + ')} before passing it on</span></p>`}
            ${order.status === 'PENDING' && passed?.length > 0 && html`<div className="text-sm p-3 rounded-2xl bg-slate-950 border border-slate-800">
                <p className="font-bold text-slate-200">Passed by ${passed.length} of ${teamSize} sellers</p>
                <ul className="text-xs text-slate-400 mt-1 space-y-0.5">${passed.map((d) => html`<li key=${d.seller_id}>${d.seller_name}${d.note ? ` — "${d.note}"` : ''}</li>`)}</ul>
            </div>`}
            ${order.closed_reason && html`<p className="text-sm p-3 rounded-2xl bg-slate-950 border border-slate-800"><b>Reason:</b> ${order.closed_reason}</p>`}
            ${flag && flag.status !== 'NORMAL' && html`<p className="text-sm p-3 rounded-2xl bg-rose-500/5 border border-rose-500/20 text-rose-100"><b>${flag.status}</b> by ${flag.flagged_by}: ${flag.reason || 'no reason given'} <span className="text-rose-300/60">(sellers only)</span></p>`}
            <div>
                <div className="flex justify-between text-xs mb-1.5"><span className="text-slate-400">Delivered</span><span className="font-bold">${order.filled} / ${order.total_qty}</span></div>
                <${ProgressBar} value=${order.filled} max=${order.total_qty} />
            </div>
            <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] text-slate-500"><th className="font-bold pb-2">Aircraft</th><th className="font-bold pb-2 text-right">Delivered</th><th className="font-bold pb-2 text-right">Level</th><th className="font-bold pb-2 text-right">Total</th></tr></thead>
                <tbody className="divide-y divide-slate-800">
                    ${items.map((it, i) => html`<tr key=${i}>
                        <td className="py-2 pr-2"><span className="text-slate-100">${it.model}</span> <span className="text-slate-500 text-xs">${it.code}</span>${it.note && html`<span className="block text-xs text-slate-400">“${it.note}”</span>`}</td>
                        <td className=${`py-2 text-right font-bold tabular-nums ${it.filled >= it.qty ? 'text-emerald-300' : ''}`}>${it.filled}/${it.qty}</td>
                        <td className="py-2 text-right">${it.pricePercent}%</td>
                        <td className="py-2 text-right">${fmtUSDShort(it.totalUSD)}</td>
                    </tr>`)}
                    <tr><td className="pt-2 font-bold">Total</td><td className="pt-2 text-right font-bold tabular-nums">${order.filled}/${order.total_qty}</td><td></td><td className="pt-2 text-right font-black">${fmtUSD(order.total_usd)}</td></tr>
                </tbody>
            </table></div>
            ${order.buyer_note && html`<div><p className="label text-slate-500 mb-1">Buyer note</p><p className="text-sm text-slate-200">${order.buyer_note}</p></div>`}
            ${order.seller_note && html`<div><p className="label text-slate-500 mb-1">Seller note (buyer can see)</p><p className="text-sm text-slate-200">${order.seller_note}</p></div>`}
            <div>
                <p className="label text-slate-500 mb-2">Messages with the buyer${messages.length ? ` (${messages.length})` : ''}</p>
                <${SellerThread} order=${order} messages=${messages} onMessage=${onMessage} />
            </div>
            <div>
                <p className="label text-slate-500 mb-2">Status history</p>
                <${StatusHistory} order=${order} now=${now} />
            </div>
            <div>
                <p className="label text-slate-500 mb-2">Timeline</p>
                <ol className="space-y-2 border-l border-slate-800 pl-4">
                    ${events.map((e) => html`<li key=${e.id} className="relative">
                        <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-slate-600"></span>
                        <p className="text-sm text-slate-200"><span className="font-mono text-[10px] text-slate-500 mr-1.5">${e.kind}</span>${e.message}</p>
                        <p className="text-[11px] text-slate-500">${e.actor_name} · ${fmtDate(e.created_at)}</p>
                    </li>`)}
                </ol>
            </div>
        </div>
    <//>`;
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
                const label = h.status === 'PENDING' && i > 0 ? 'Back in the open queue' : (STATUS[h.status]?.label || h.status);
                return html`<li key=${i} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0"><span className="font-bold text-slate-100">${label}</span>
                        <span className="block text-[11px] text-slate-500">${fmtDate(h.at)}</span></span>
                    ${Number.isFinite(lasted) && html`<span className="text-xs text-slate-400 shrink-0 tabular-nums">${next ? '' : 'for '}${fmtDuration(lasted)}${next ? '' : ' so far'}</span>`}
                </li>`;
            })}
        </ol>
    </div>`;
}
const CLOSED = ['FULFILLED', 'CANCELLED', 'DECLINED'];

// "Showing 5 of 23" + Show 5 / 10 / 25 / 50 / All, and a "Show N more" button.
function PageSizeBar({ total, shown, pageSize, setPageSize }) {
    const hidden = total - shown;
    const options = PAGE_SIZES.filter((p) => p === 'all' || p < total);
    const nextSize = PAGE_SIZES.find((p) => p !== 'all' && p > shown && p < total) || 'all';
    return html`<div className="card p-3 flex flex-wrap items-center gap-3">
        <span className="text-xs text-slate-400 mr-auto">Showing <b className="text-slate-200">${shown}</b> of ${total} orders${hidden > 0 ? ` · ${hidden} hidden` : ''}</span>
        ${hidden > 0 && html`<${Button} size="sm" variant="secondary" icon="chevron-down" onClick=${() => setPageSize(nextSize)}>
            Show ${nextSize === 'all' ? `all ${total}` : `${Math.min(nextSize, total) - shown} more`}<//>`}
        <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500">Show</span>
            <div className="flex p-1 rounded-full bg-slate-900 border border-slate-800">
                ${options.map((p) => html`<button key=${p} onClick=${() => setPageSize(p)} aria-pressed=${pageSize === p}
                    className=${`px-3 py-1 rounded-full text-xs font-bold ${pageSize === p ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>${p === 'all' ? 'All' : p}</button>`)}
            </div>
        </div>
    </div>`;
}

function ClaimModal({ order, airlines, sellAs, onClose, onConfirm }) {
    const buyerAlliances = orderAlliances(order);
    const same = (a) => buyerAlliances.includes(a.alliance);
    const sorted = [...airlines].sort((a, b) => same(b) - same(a));
    const [airlineId, setAirlineId] = useState(() =>
        (sellAs && same(sellAs) ? sellAs : sorted.find(same) || sellAs || sorted[0])?.id);
    const [busy, setBusy] = useState(false);
    const chosen = airlines.find((a) => a.id === airlineId);
    return html`<${Modal} open=${true} onClose=${onClose} title=${`Take ${orderRef(order)}`} size="sm"
        subtitle=${`${plural(order.total_qty, 'aircraft')} for ${airlineNames(order)} · ${fmtUSDShort(order.total_usd)}`}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Button} icon="hand" busy=${busy} disabled=${!chosen} onClick=${async () => { setBusy(true); await onConfirm(airlineId); setBusy(false); }}>Take order<//>`}>
        <p className="field-label">Sell as airline</p>
        <div className="space-y-1.5">
            ${sorted.map((a) => html`<button key=${a.id} onClick=${() => setAirlineId(a.id)}
                className=${`w-full flex items-center justify-between p-3 rounded-xl border text-left ${airlineId === a.id ? 'border-sky-400 bg-sky-400/10' : 'border-slate-800 hover:border-slate-600'}`}>
                <span><span className="font-bold text-white">${a.name}</span> <span className="text-xs text-slate-400">${a.alliance}</span>
                    ${same(a) && html`<span className="ml-2 text-[10px] font-black text-emerald-300">SAME ALLIANCE AS BUYER</span>`}</span>
                ${airlineId === a.id && html`<${Icon} name="check" className="w-4 h-4 text-sky-300" />`}
            </button>`)}
        </div>
        ${chosen && same(chosen) && html`<p className="text-xs text-emerald-300 mt-4">Deliver to the buyer's <b>${deliverableTo(order, chosen.alliance).map((a) => a.name).join(' or ')}</b> (${chosen.alliance}).</p>`}
        ${chosen && !same(chosen) && buyerAlliances.length > 0 && html`<p className="text-xs text-amber-300 mt-4 flex gap-1.5"><${Icon} name="triangle-alert" className="w-3.5 h-3.5 mt-px" />
            ${sorted.some(same) ? `${chosen.name} (${chosen.alliance}) is not in any of the buyer's alliances (${buyerAlliances.join(', ')}).`
                : `You share no alliance with this buyer (${buyerAlliances.join(', ')}).`} You can still take the order.</p>`}
        <p className="text-xs text-slate-400 mt-4">The buyer gets notified that <b className="text-slate-200">${chosen?.name}</b> is selling to them. Sell the aircraft in-game, then record deliveries here.</p>
    <//>`;
}

function ProgressModal({ order, onClose, onSave }) {
    const lines = orderLines(order);
    const [counts, setCounts] = useState(() => lines.map((it) => it.filled));
    const [note, setNote] = useState('');
    const [sellerNote, setSellerNote] = useState(order.seller_note || '');
    const [busy, setBusy] = useState(false);
    const setLine = (i, v) => setCounts((c) => c.map((n, j) => (j === i ? Math.max(lines[i].locked, Math.min(lines[i].qty, Math.floor(Number(v) || 0))) : n)));
    const total = counts.reduce((a, b) => a + b, 0);
    const max = order.total_qty;
    const next = total === 0 ? 'CLAIMED' : total >= max ? 'FULFILLED' : 'PARTIAL';
    const changed = counts.some((n, i) => n !== lines[i].filled);
    return html`<${Modal} open=${true} onClose=${onClose} title=${`Update delivery · ${orderRef(order)}`} size="md"
        subtitle=${`${airlineNames(order)} · ${plural(lines.length, 'aircraft type')}`}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Button} busy=${busy} onClick=${async () => { setBusy(true); await onSave({ items: counts, changed, note: note.trim(), sellerNote: sellerNote.trim() }); setBusy(false); }}>Save<//>`}>
        <div className="space-y-5">
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <p className="field-label !mb-0">Delivered in-game so far, per aircraft type</p>
                    <button onClick=${() => setCounts(lines.map((it) => it.qty))} className="px-3 py-1.5 rounded-xl text-xs font-bold bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20">Everything delivered</button>
                </div>
                ${lines.map((it, i) => html`<div key=${i} className="p-3 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-bold text-white min-w-0 truncate">${it.model} <span className="text-slate-500 font-medium">@${it.pricePercent}%</span></p>
                        ${it.locked > 0 && html`<span className="text-[10px] text-slate-400 shrink-0">${it.locked} by earlier seller</span>`}
                    </div>
                    <div className="flex items-center gap-2">
                        <button className="stepper !w-9 !h-9" aria-label=${`One less ${it.model}`} disabled=${counts[i] <= it.locked} onClick=${() => setLine(i, counts[i] - 1)}><${Icon} name="minus" /></button>
                        <input type="number" value=${counts[i]} min=${it.locked} max=${it.qty} onChange=${(e) => setLine(i, e.target.value)} className="input !w-20 !py-2 text-center font-bold" aria-label=${`${it.model} delivered`} />
                        <button className="stepper !w-9 !h-9" aria-label=${`One more ${it.model}`} onClick=${() => setLine(i, counts[i] + 1)}><${Icon} name="plus" /></button>
                        <span className="text-sm text-slate-400">of ${it.qty}</span>
                        <button onClick=${() => setLine(i, it.qty)} className="ml-auto px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-300 hover:bg-slate-800">All</button>
                    </div>
                    <${ProgressBar} value=${counts[i]} max=${it.qty} />
                </div>`)}
                <p className="text-xs text-slate-400">Total ${total} of ${max} · new status: <b className="text-slate-200">${STATUS[next].label}</b></p>
            </div>
            <label className="block"><span className="field-label">Update message (optional, shown in the buyer's timeline)</span>
                <input value=${note} maxLength="500" onChange=${(e) => setNote(e.target.value)} className="input" placeholder="e.g. First 5 delivered at WIII" /></label>
            <label className="block"><span className="field-label">Seller note (pinned on the order, buyer can see)</span>
                <textarea value=${sellerNote} maxLength="1000" rows="2" onChange=${(e) => setSellerNote(e.target.value)} className="input"></textarea></label>
        </div>
    <//>`;
}

function FlagModal({ order, flag, onClose, onSave }) {
    const [status, setStatus] = useState(flag?.status || 'NORMAL');
    const [reason, setReason] = useState(flag?.reason || '');
    const [busy, setBusy] = useState(false);
    return html`<${Modal} open=${true} onClose=${onClose} title=${`Flag ${orderRef(order)}`} size="sm" subtitle="Only sellers can see flags. The buyer is not notified."
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Button} busy=${busy} onClick=${async () => { setBusy(true); await onSave(status, reason.trim()); setBusy(false); }}>Save flag<//>`}>
        <div className="grid grid-cols-3 gap-1.5">
            ${Object.entries(FLAG_META).map(([k, m]) => html`<button key=${k} onClick=${() => setStatus(k)}
                className=${`p-3 rounded-xl border text-xs font-bold flex flex-col items-center gap-1.5 ${status === k ? m.cls : 'border-slate-800 text-slate-400'}`}>
                <${Icon} name=${m.icon} className="w-5 h-5" />${m.label}</button>`)}
        </div>
        <label className="block mt-4"><span className="field-label">Reason</span>
            <textarea value=${reason} rows="3" maxLength="500" onChange=${(e) => setReason(e.target.value)} className="input" placeholder="Why is this order flagged?"></textarea></label>
    <//>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(isConfigured ? html`<${App} />` : html`<${NotConfigured} />`);
