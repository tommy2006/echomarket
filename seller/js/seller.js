// Echo Market — seller desk.
// Sign-in is Discord via Supabase; access requires a row in public.sellers.
// Reads come straight from Supabase (RLS lets sellers see all orders);
// every change goes through /api/orders/:id so Discord stays in sync.
import {
    html, useState, useEffect, useMemo, useCallback, sb, isConfigured, CONFIG, api, store,
    signInWithDiscord, fmtUSD, fmtUSDShort, fmtDate, timeAgo, plural, STATUS, ACTIVE_STATUSES,
    StatusBadge, OrderStepper, ProgressBar, Icon, Toasts, toast, Modal, DialogHost, ask, Button, DiscordLogo,
    Spinner, Avatar, EmptyState, NotConfigured, notifyBrowser
} from './ui.js';

const LS_SELL_AS = 'echo_seller_airline_v2';
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
    const [loading, setLoading] = useState(true);

    const [tab, setTab] = useState('open');
    const [statusFilter, setStatusFilter] = useState('ALL');
    const [query, setQuery] = useState('');
    const [sellAsId, setSellAsId] = useState(() => store.get(LS_SELL_AS, null));
    const [detailId, setDetailId] = useState(() => window.location.hash.replace('#', '') || null);
    const [modal, setModal] = useState(null); // { kind: 'claim'|'progress'|'flag', order }

    const userId = session?.user?.id;

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
        const me = sel.data?.active ? sel.data : null;
        setSeller(me);
        if (!me) { setLoading(false); return; }
        const [ord, fl, air] = await Promise.all([
            sb.from('orders').select('*').order('created_at', { ascending: false }).limit(1000),
            sb.from('order_flags').select('*'),
            sb.from('airlines').select('*').eq('owner_id', userId).order('created_at')
        ]);
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
                    toast(`New order ${p.new.id} from ${p.new.airline_name}`, 'success');
                    notifyBrowser('New Echo Market order', `${p.new.airline_name}: ${plural(p.new.total_qty, 'aircraft')}`);
                }
                setOrders((l) => [p.new, ...l.filter((o) => o.id !== p.new.id)].sort((a, b) => b.created_at.localeCompare(a.created_at)));
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
    const replaceOrder = (o) => setOrders((l) => l.map((x) => (x.id === o.id ? o : x)));
    const act = async (order, payload, success) => {
        try {
            const res = await api(`/api/orders/${order.id}`, payload);
            if (res.order) replaceOrder(res.order);
            if (payload.action === 'delete') { setOrders((l) => l.filter((o) => o.id !== order.id)); closeDetail(); }
            if (payload.action === 'flag') setFlags((f) => ({ ...f, [order.id]: { order_id: order.id, status: payload.flagStatus, reason: payload.flagReason, flagged_by: account?.display_name } }));
            if (success) toast(success, 'success');
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
            if (await ask({ title: `Release ${order.id}?`, message: 'It goes back to the open queue for another seller. The buyer is told it is waiting again.', confirmLabel: 'Release order' })) {
                act(order, { action: 'release' }, `${order.id} is back in the open queue.`);
            }
        },
        decline: async (order) => {
            const reason = await ask({
                title: `Decline ${order.id}?`, danger: true, confirmLabel: 'Decline order',
                message: 'The buyer will see this reason. This cannot be undone.',
                input: { required: true, placeholder: 'e.g. Price level too low for this type right now' }
            });
            if (reason) act(order, { action: 'decline', reason }, `${order.id} declined.`);
        },
        remove: async (order) => {
            if (await ask({ title: `Delete ${order.id}?`, message: 'This permanently removes the order and its history for everyone, including the buyer. Prefer "Decline" unless this is spam.', confirmLabel: 'Delete forever', danger: true })) {
                act(order, { action: 'delete' }, `${order.id} deleted.`);
            }
        }
    };

    if (!authReady) return html`<div className="min-h-screen flex items-center justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`;
    if (!session) return html`<${SignInScreen} />`;
    if (seller === undefined) return html`<div className="min-h-screen flex items-center justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`;
    if (!seller) return html`<${NotASeller} account=${account} />`;

    // ---- filtering
    const q = query.trim().toLowerCase();
    const matches = (o) => !q || [o.id, o.airline_name, o.alliance, o.buyer_name, o.seller_airline_name, o.buyer_note, o.seller_note,
        ...(o.items || []).map((i) => i.model)].join(' ').toLowerCase().includes(q);
    const tabs = {
        open: { label: 'Open queue', icon: 'inbox', fn: (o) => o.status === 'PENDING' },
        mine: { label: 'My orders', icon: 'briefcase', fn: (o) => o.seller_id === userId && ['CLAIMED', 'PARTIAL'].includes(o.status) },
        all: { label: 'All orders', icon: 'list', fn: (o) => statusFilter === 'ALL' || o.status === statusFilter }
    };
    const counts = {
        open: orders.filter(tabs.open.fn).length,
        mine: orders.filter(tabs.mine.fn).length,
        all: orders.length
    };
    const list = orders.filter((o) => tabs[tab].fn(o) && matches(o));
    const detail = orders.find((o) => o.id === detailId);

    return html`<div className="min-h-screen pb-12">
        <header className="sticky top-0 z-40 bg-page/85 backdrop-blur border-b border-slate-800/80">
            <div className="max-w-6xl mx-auto px-4 md:px-6 h-16 flex items-center gap-3">
                <img src="echo_logo.png" alt="" className="w-8 h-8 rounded-lg" />
                <div className="leading-tight">
                    <p className="font-extrabold text-white">Seller desk</p>
                    <p className="text-[11px] text-slate-500">Echo Market${seller.is_admin ? ' · admin' : ''}</p>
                </div>
                <div className="flex-1"></div>
                <${SellAsPicker} airlines=${airlines} sellAs=${sellAs} onChange=${setSellAsId} />
                <a href=${CONFIG.BUYER_URL || "#"} className="hidden sm:flex p-2.5 rounded-full text-slate-400 hover:bg-slate-800 hover:text-white" title="Open the market"><${Icon} name="shopping-bag" className="w-5 h-5" /></a>
                <button onClick=${() => sb.auth.signOut()} className="flex items-center gap-2 p-1 pr-3 rounded-full hover:bg-slate-800 text-xs font-bold text-slate-400" title="Sign out">
                    <${Avatar} account=${account} /><span className="hidden sm:inline">Sign out</span>
                </button>
            </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 md:px-6 pt-6 space-y-5">
            ${!airlines.length && html`<div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-2xl border border-amber-500/30 bg-amber-500/5">
                <${Icon} name="triangle-alert" className="w-5 h-5 text-amber-300" />
                <p className="flex-1 text-sm text-amber-100"><b>You need an airline profile to take orders.</b> Buyers see which airline is selling to them. Create one on the market site's Airlines page (same Discord login), then come back.</p>
                <a href=${(CONFIG.BUYER_URL || "") + "/#airlines"}><${Button} size="sm" variant="white">Create airline<//></a>
            </div>`}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <${Stat} label="Waiting for a seller" value=${counts.open} icon="inbox" tone="text-amber-300" />
                <${Stat} label="My active orders" value=${counts.mine} icon="briefcase" tone="text-sky-300" />
                <${Stat} label="In delivery (all sellers)" value=${orders.filter((o) => ['CLAIMED', 'PARTIAL'].includes(o.status)).length} icon="truck" tone="text-violet-300" />
                <${Stat} label="Delivered" value=${orders.filter((o) => o.status === 'FULFILLED').length} icon="circle-check" tone="text-emerald-300" />
            </div>

            <div className="flex flex-col md:flex-row gap-2 md:items-center">
                <div className="flex p-1 rounded-full bg-slate-900 border border-slate-800 overflow-x-auto no-scrollbar">
                    ${Object.entries(tabs).map(([k, t]) => html`<button key=${k} onClick=${() => setTab(k)}
                        className=${`shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold ${tab === k ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>
                        <${Icon} name=${t.icon} className="w-3.5 h-3.5" />${t.label}<span className="opacity-60">${counts[k]}</span>
                    </button>`)}
                </div>
                ${tab === 'all' && html`<select value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)} className="input md:!w-48">
                    <option value="ALL">Any status</option>
                    ${Object.entries(STATUS).map(([k, m]) => html`<option key=${k} value=${k}>${m.label}</option>`)}
                </select>`}
                <label className="relative flex-1">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"><${Icon} name="search" /></span>
                    <input value=${query} onChange=${(e) => setQuery(e.target.value)} placeholder="Search order, airline, buyer, aircraft…" className="input pl-10" />
                </label>
            </div>

            ${loading ? html`<div className="py-16 flex justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`
            : !list.length ? html`<${EmptyState} icon=${tab === 'open' ? 'party-popper' : 'inbox'}
                title=${tab === 'open' ? 'Queue is empty' : tab === 'mine' ? 'You have no active orders' : 'No orders found'}
                text=${tab === 'open' ? 'New orders appear here instantly (and on Discord).' : tab === 'mine' ? 'Take one from the open queue.' : 'Try a different search or status.'} />`
            : html`<div className="space-y-2">${list.map((o) => html`<${OrderRow} key=${o.id} order=${o} flag=${flags[o.id]} userId=${userId} airlines=${airlines}
                seller=${seller} actions=${actions} onOpen=${() => openDetail(o.id)} />`)}</div>`}
        </main>

        ${detail && html`<${OrderDetail} order=${detail} flag=${flags[detail.id]} userId=${userId} seller=${seller} airlines=${airlines}
            actions=${actions} onClose=${closeDetail} />`}
        ${detailId && !detail && !loading && html`<${Modal} open=${true} onClose=${closeDetail} title="Order not found" size="sm">
            <p className="text-sm text-slate-400">${detailId} doesn't exist or was deleted.</p><//>`}

        ${modal?.kind === 'claim' && html`<${ClaimModal} order=${modal.order} airlines=${airlines} sellAs=${sellAs}
            onClose=${() => setModal(null)}
            onConfirm=${async (airlineId) => {
                setSellAsId(airlineId);
                const ok = await act(modal.order, { action: 'claim', airlineId }, `You took ${modal.order.id}. The buyer has been notified.`);
                if (ok) { setModal(null); setTab('mine'); }
            }} />`}
        ${modal?.kind === 'progress' && html`<${ProgressModal} order=${modal.order} onClose=${() => setModal(null)}
            onSave=${async (payload) => {
                let ok = true;
                if (payload.filled !== modal.order.filled || payload.note) ok = await act(modal.order, { action: 'progress', filled: payload.filled, note: payload.note });
                if (ok && payload.sellerNote !== (modal.order.seller_note || '')) ok = await act(modal.order, { action: 'note', sellerNote: payload.sellerNote });
                if (ok) { setModal(null); toast(`${modal.order.id} updated.`, 'success'); }
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
            <p className="text-sm text-slate-400 mt-2">Sign in with the Discord account the admins added to the seller list.</p>
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
            <p className="text-sm text-slate-400 mt-2">Signed in as <b className="text-slate-200">${account?.display_name || account?.discord_username}</b>. Send your Discord ID to an Echo Market admin so they can add you.</p>
            <button onClick=${copy} className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 font-mono text-sm hover:border-slate-600">
                ${account?.discord_id || 'unknown'} <${Icon} name="copy" className="w-4 h-4 text-slate-500" />
            </button>
            <div className="mt-7 flex justify-center gap-2">
                <a href=${CONFIG.BUYER_URL || "#"}><${Button} variant="secondary">Go to Echo Market<//></a>
                <${Button} variant="ghost" onClick=${() => sb.auth.signOut()}>Sign out<//>
            </div>
        </div>
        <${Toasts} />
    </div>`;
}

// ------------------------------------------------------------- components
function Stat({ label, value, icon, tone }) {
    return html`<div className="card p-4">
        <div className="flex items-center justify-between"><p className="text-[11px] font-bold text-slate-500">${label}</p><span className=${tone}><${Icon} name=${icon} /></span></div>
        <p className="text-2xl font-black text-white mt-1">${value}</p>
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
const sharesAlliance = (airlines, order) => !order.alliance || airlines.some((a) => a.alliance === order.alliance);

function AllianceBadge({ airlines, order }) {
    if (!airlines.length || sharesAlliance(airlines, order)) return null;
    return html`<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black text-amber-300 border-amber-500/30 bg-amber-500/10"
        title=${`None of your airlines is in the ${order.alliance} alliance`}>
        <${Icon} name="users-round" className="w-3 h-3" />NO SHARED ALLIANCE</span>`;
}

function itemsSummary(order) {
    const items = order.items || [];
    return items.map((i) => `${i.qty}× ${i.model} @${i.pricePercent}%`).join(' · ');
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
        ${order.status === 'CLAIMED' && order.filled === 0 && canManage && !compact && html`<${Button} size=${size} variant="secondary" icon="undo-2" onClick=${stop(actions.release)}>Release<//>`}
        ${(order.status === 'PENDING' || (ACTIVE_STATUSES.includes(order.status) && canManage)) && !compact && html`<${Button} size=${size} variant="ghost" icon="ban" onClick=${stop(actions.decline)}>Decline<//>`}
        ${!compact && html`<${Button} size=${size} variant="ghost" icon="flag" onClick=${stop(actions.flag)}>Flag<//>`}
        ${seller.is_admin && !compact && html`<${Button} size=${size} variant="ghost" icon="trash-2" className="!text-rose-300" onClick=${stop(actions.remove)}>Delete<//>`}
    </div>`;
}

function OrderRow({ order, flag, userId, airlines, seller, actions, onOpen }) {
    const mine = order.seller_id === userId;
    return html`<article onClick=${onOpen} className=${`card p-4 cursor-pointer hover:border-slate-600 ${flag?.status === 'BLACKLISTED' ? 'border-rose-500/40' : ''}`}>
        <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">${order.id}</span>
                    <${StatusBadge} status=${order.status} />
                    <${FlagBadge} flag=${flag} />
                    ${order.status === 'PENDING' && html`<${AllianceBadge} airlines=${airlines} order=${order} />`}
                    ${mine && html`<span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-sky-400/15 text-sky-300">YOURS</span>`}
                    <span className="text-[11px] text-slate-500">${timeAgo(order.created_at)}</span>
                </div>
                <p className="font-extrabold text-white truncate">${order.airline_name} <span className="text-slate-500 font-semibold text-sm">· ${order.alliance} · ${order.buyer_name}</span></p>
                <p className="text-xs text-slate-400 truncate">${itemsSummary(order)}</p>
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

function OrderDetail({ order, flag, userId, seller, airlines, actions, onClose }) {
    const [events, setEvents] = useState([]);
    useEffect(() => {
        sb.from('order_events').select('*').eq('order_id', order.id).order('created_at').then(({ data }) => setEvents(data || []));
    }, [order.id, order.updated_at]);
    const items = order.items || [];
    return html`<${Modal} open=${true} onClose=${onClose} size="lg" title=${`${order.id} · ${order.airline_name}`}
        subtitle=${`${order.alliance} · ordered by ${order.buyer_name} · ${fmtDate(order.created_at)}`}
        footer=${html`<${OrderActions} order=${order} userId=${userId} seller=${seller} actions=${actions} compact=${false} />`}>
        <div className="space-y-5">
            <div className="flex flex-wrap gap-2 items-center"><${StatusBadge} status=${order.status} /><${FlagBadge} flag=${flag} /><${AllianceBadge} airlines=${airlines} order=${order} />
                ${order.buyer_discord_id && html`<span className="text-xs text-slate-400 flex items-center gap-1"><${DiscordLogo} className="w-3.5 h-3.5" /> ID ${order.buyer_discord_id}</span>`}
            </div>
            <${OrderStepper} order=${order} />
            ${order.seller_airline_name && html`<p className="text-sm text-slate-300">Seller: <b>${order.seller_airline_name}</b> (${order.seller_alliance}) — ${order.seller_name}${order.seller_id === userId ? ' (you)' : ''}</p>`}
            ${order.closed_reason && html`<p className="text-sm p-3 rounded-2xl bg-slate-950 border border-slate-800"><b>Reason:</b> ${order.closed_reason}</p>`}
            ${flag && flag.status !== 'NORMAL' && html`<p className="text-sm p-3 rounded-2xl bg-rose-500/5 border border-rose-500/20 text-rose-100"><b>${flag.status}</b> by ${flag.flagged_by}: ${flag.reason || 'no reason given'} <span className="text-rose-300/60">(sellers only)</span></p>`}
            <div>
                <div className="flex justify-between text-xs mb-1.5"><span className="text-slate-400">Delivered</span><span className="font-bold">${order.filled} / ${order.total_qty}</span></div>
                <${ProgressBar} value=${order.filled} max=${order.total_qty} />
            </div>
            <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] text-slate-500"><th className="font-bold pb-2">Aircraft</th><th className="font-bold pb-2 text-right">Qty</th><th className="font-bold pb-2 text-right">Level</th><th className="font-bold pb-2 text-right">Total</th></tr></thead>
                <tbody className="divide-y divide-slate-800">
                    ${items.map((it, i) => html`<tr key=${i}>
                        <td className="py-2 pr-2"><span className="text-slate-100">${it.model}</span> <span className="text-slate-500 text-xs">${it.code}</span>${it.note && html`<span className="block text-xs text-slate-400">“${it.note}”</span>`}</td>
                        <td className="py-2 text-right font-bold">${it.qty}</td>
                        <td className="py-2 text-right">${it.pricePercent}%</td>
                        <td className="py-2 text-right">${fmtUSDShort(it.totalUSD)}</td>
                    </tr>`)}
                    <tr><td className="pt-2 font-bold">Total</td><td className="pt-2 text-right font-bold">${order.total_qty}</td><td></td><td className="pt-2 text-right font-black">${fmtUSD(order.total_usd)}</td></tr>
                </tbody>
            </table>
            ${order.buyer_note && html`<div><p className="label text-slate-500 mb-1">Buyer note</p><p className="text-sm text-slate-200">${order.buyer_note}</p></div>`}
            ${order.seller_note && html`<div><p className="label text-slate-500 mb-1">Seller note (buyer can see)</p><p className="text-sm text-slate-200">${order.seller_note}</p></div>`}
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

function ClaimModal({ order, airlines, sellAs, onClose, onConfirm }) {
    const same = (a) => a.alliance === order.alliance;
    const sorted = [...airlines].sort((a, b) => same(b) - same(a));
    const [airlineId, setAirlineId] = useState(() =>
        (sellAs && same(sellAs) ? sellAs : sorted.find(same) || sellAs || sorted[0])?.id);
    const [busy, setBusy] = useState(false);
    const chosen = airlines.find((a) => a.id === airlineId);
    return html`<${Modal} open=${true} onClose=${onClose} title=${`Take ${order.id}`} size="sm"
        subtitle=${`${plural(order.total_qty, 'aircraft')} for ${order.airline_name} · ${fmtUSDShort(order.total_usd)}`}
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
        ${chosen && !same(chosen) && order.alliance && html`<p className="text-xs text-amber-300 mt-4 flex gap-1.5"><${Icon} name="triangle-alert" className="w-3.5 h-3.5 mt-px" />
            ${sorted.some(same) ? `${chosen.name} (${chosen.alliance}) is not in the buyer's alliance (${order.alliance}).`
                : `You share no alliance with this buyer (${order.alliance}).`} You can still take the order.</p>`}
        <p className="text-xs text-slate-400 mt-4">The buyer gets notified that <b className="text-slate-200">${chosen?.name}</b> is selling to them. Sell the aircraft in-game, then record deliveries here.</p>
    <//>`;
}

function ProgressModal({ order, onClose, onSave }) {
    const [filled, setFilled] = useState(order.filled || 0);
    const [note, setNote] = useState('');
    const [sellerNote, setSellerNote] = useState(order.seller_note || '');
    const [busy, setBusy] = useState(false);
    const max = order.total_qty;
    const set = (v) => setFilled(Math.max(0, Math.min(max, Math.floor(Number(v) || 0))));
    const next = filled === 0 ? 'CLAIMED' : filled >= max ? 'FULFILLED' : 'PARTIAL';
    return html`<${Modal} open=${true} onClose=${onClose} title=${`Update delivery · ${order.id}`} size="sm"
        subtitle=${`${order.airline_name} · ${itemsSummary(order)}`}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Button} busy=${busy} onClick=${async () => { setBusy(true); await onSave({ filled, note: note.trim(), sellerNote: sellerNote.trim() }); setBusy(false); }}>Save<//>`}>
        <div className="space-y-5">
            <div>
                <p className="field-label">Aircraft delivered in-game (total so far)</p>
                <div className="flex items-center gap-2">
                    <button className="stepper" aria-label="One less" onClick=${() => set(filled - 1)}><${Icon} name="minus" /></button>
                    <input type="number" value=${filled} min="0" max=${max} onChange=${(e) => set(e.target.value)} className="input !w-24 text-center font-bold" />
                    <button className="stepper" aria-label="One more" onClick=${() => set(filled + 1)}><${Icon} name="plus" /></button>
                    <span className="text-sm text-slate-400">of ${max}</span>
                    <button onClick=${() => set(max)} className="ml-auto px-3 py-2 rounded-xl text-xs font-bold bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20">All delivered</button>
                </div>
                <div className="mt-3"><${ProgressBar} value=${filled} max=${max} /></div>
                <p className="text-xs text-slate-400 mt-2">New status: <b className="text-slate-200">${STATUS[next].label}</b></p>
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
    return html`<${Modal} open=${true} onClose=${onClose} title=${`Flag ${order.id}`} size="sm" subtitle="Only sellers can see flags. The buyer is not notified."
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
