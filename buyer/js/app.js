// Echo Market — buyer app.
// Data lives in Supabase. Reads go straight to Supabase (protected by Row Level
// Security); anything that needs validation or Discord (placing / cancelling an
// order) goes through our Vercel API in /api.
import {
    html, useState, useEffect, useMemo, useCallback, sb, isConfigured, CONFIG, api, dbError, store,
    signInWithDiscord, fmtUSD, fmtUSDShort, fmtDate, timeAgo, plural, STATUS, ACTIVE_STATUSES, CLOSED_STATUSES,
    StatusBadge, OrderStepper, ProgressBar, Icon, Toasts, toast, Modal, DialogHost, ask, Button, DiscordLogo,
    Spinner, Avatar, EmptyState, NotConfigured, notifyBrowser, displayStatus, orderListValue, orderLines, ItemProgress,
    pushSupported, needsHomeScreen, pushSubscription, enablePush, disablePush, orderRef, OrderCode, greetingFor,
    orderAirlines, airlineNames, orderAlliances, deliverableTo
} from './ui.js';

// Keep in sync with lib/pricing.js (the server re-checks everything).
const PRICE_LEVELS = [90, 80, 70, 60, 50];
const MAX_AIRLINES = 20;
const MAX_QTY = 500;
const DAILY_LIMIT_USD = 10_000_000_000;

const LS_CART = 'echo_cart_v2';
const LS_DEFAULT_AIRLINE = 'echo_default_airline_v2';
const LS_PRICE_LEVEL = 'echo_price_level_v2';
const LS_TOUR = 'echo_tour_done_v1:';   // + user id

const VIEWS = [
    { id: 'home', label: 'Home', icon: 'house' },
    { id: 'shop', label: 'Shop', icon: 'plane' },
    { id: 'orders', label: 'Orders', icon: 'package' },
    { id: 'airlines', label: 'Airlines', icon: 'building-2' }
];
const viewFromHash = () => {
    const h = window.location.hash.replace('#', '').split('/')[0];
    return VIEWS.some((v) => v.id === h) ? h : 'home';
};
// Home lives at the plain address (no "#home"); other views use #shop, #orders, #airlines.
const homeUrl = () => window.location.pathname + window.location.search;
const go = (view) => {
    if (view !== 'home') { window.location.hash = view; return; }
    if (window.location.hash) {
        history.pushState(null, '', homeUrl());
        window.dispatchEvent(new HashChangeEvent('hashchange'));   // tell the app the view changed
    }
};
// Click handler for links to a view: Home is switched in place instead of following href="/".
const navTo = (view) => (e) => {
    if (view !== 'home' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go('home');
};
const viewHref = (view) => (view === 'home' ? '/' : '#' + view);
// ECH- code → "#42", kept up to date from the loaded orders (notifications only know the code).
let SERIALS = {};
const refFor = (orderId) => (SERIALS[orderId] ? `#${SERIALS[orderId]}` : orderId);

// =========================================================================
function App() {
    const [authReady, setAuthReady] = useState(false);
    const [session, setSession] = useState(null);
    const [account, setAccount] = useState(null);
    const [isSeller, setIsSeller] = useState(false);
    const [airlines, setAirlines] = useState([]);
    const [alliances, setAlliances] = useState([]);
    const [orders, setOrders] = useState([]);
    const [events, setEvents] = useState([]);
    const [dataReady, setDataReady] = useState(false);
    const [pricelist, setPricelist] = useState([]);

    const [view, setView] = useState(viewFromHash);
    const [cart, setCart] = useState(() => store.get(LS_CART, []));
    const [defaultAirlineId, setDefaultAirlineId] = useState(() => store.get(LS_DEFAULT_AIRLINE, null));
    const [priceLevel, setPriceLevel] = useState(() => store.get(LS_PRICE_LEVEL, 90));

    const [cartOpen, setCartOpen] = useState(false);
    const [notifOpen, setNotifOpen] = useState(false);
    const [sheetModel, setSheetModel] = useState(null);
    const [airlineForm, setAirlineForm] = useState(null); // { airline? }
    const [highlightOrder, setHighlightOrder] = useState(null);
    const [tourOpen, setTourOpen] = useState(false);

    const userId = session?.user?.id;

    // ---------------- boot
    useEffect(() => {
        // Service worker for phone / browser alerts (also needed to show alerts on Android).
        try { navigator.serviceWorker?.register('/sw.js').catch(() => {}); } catch { /* unsupported */ }
        fetch('aircraft_pricelist.json').then((r) => r.json()).then(setPricelist)
            .catch(() => toast('Could not load the aircraft catalog. Refresh the page.', 'error'));
        if (window.location.hash === '#home') history.replaceState(null, '', homeUrl());
        const onHash = () => {
            if (window.location.hash === '#home') history.replaceState(null, '', homeUrl());
            setView(viewFromHash());
        };
        window.addEventListener('hashchange', onHash);
        window.addEventListener('popstate', onHash);

        sb.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
        const { data: sub } = sb.auth.onAuthStateChange((_event, s) => setSession(s));
        return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); sub.subscription.unsubscribe(); };
    }, []);

    useEffect(() => store.set(LS_CART, cart), [cart]);
    useEffect(() => store.set(LS_PRICE_LEVEL, priceLevel), [priceLevel]);
    useEffect(() => { if (defaultAirlineId) store.set(LS_DEFAULT_AIRLINE, defaultAirlineId); }, [defaultAirlineId]);

    // ---------------- load account data
    const loadAll = useCallback(async () => {
        if (!userId) return;
        const [acc, sel, air, all, ord, ev] = await Promise.all([
            sb.from('accounts').select('*').eq('id', userId).maybeSingle(),
            sb.from('sellers').select('active').eq('user_id', userId).maybeSingle(),
            sb.from('airlines').select('*').eq('owner_id', userId).order('created_at'),
            sb.from('alliances').select('name').order('sort_order'),
            sb.from('orders').select('*').eq('buyer_id', userId).order('created_at', { ascending: false }).limit(300),
            sb.from('order_events').select('*').eq('buyer_id', userId).order('created_at', { ascending: false }).limit(200)
        ]);
        const failed = [acc, air, all, ord, ev].find((r) => r.error);
        if (failed) toast('Could not load your data: ' + failed.error.message, 'error');
        setAccount(acc.data || null);
        setIsSeller(Boolean(sel.data?.active));
        setAirlines(air.data || []);
        setAlliances((all.data || []).map((a) => a.name));
        setOrders(ord.data || []);
        setEvents(ev.data || []);
        setDataReady(true);
    }, [userId]);

    useEffect(() => {
        if (!userId) { setDataReady(false); setAccount(null); setAirlines([]); setOrders([]); setEvents([]); return; }
        loadAll();
    }, [userId, loadAll]);

    // ---------------- live updates
    useEffect(() => {
        if (!userId) return;
        const channel = sb.channel('buyer-' + userId)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `buyer_id=eq.${userId}` }, (p) => {
                if (p.eventType === 'DELETE') setOrders((list) => list.filter((o) => o.id !== p.old.id));
                else setOrders((list) => [p.new, ...list.filter((o) => o.id !== p.new.id)]
                    .sort((a, b) => b.created_at.localeCompare(a.created_at)));
            })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_events', filter: `buyer_id=eq.${userId}` }, (p) => {
                const ev = p.new;
                setEvents((list) => [ev, ...list.filter((e) => e.id !== ev.id)]);
                if (ev.actor_id !== userId) {
                    const text = describeEvent(ev);
                    toast(text, ev.kind === 'DECLINED' ? 'error' : 'success');
                    notifyBrowser(`Order ${refFor(ev.order_id)}`, text, ev.order_id);
                }
            })
            .subscribe();
        // Catch up on anything missed while the tab was asleep.
        const onVisible = () => { if (document.visibilityState === 'visible') loadAll(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { sb.removeChannel(channel); document.removeEventListener('visibilitychange', onVisible); };
    }, [userId, loadAll]);

    // ---------------- first-time walkthrough
    // Shown once to new buyers: account under 7 days old, no orders yet, not finished/skipped on this device.
    useEffect(() => {
        if (!dataReady || !account || !userId) return;
        if (store.get(LS_TOUR + userId, false)) return;
        const isNew = Date.now() - new Date(account.created_at).getTime() < 7 * 864e5;
        if (isNew && orders.length === 0) setTourOpen(true);
    }, [dataReady, account?.id, userId]);
    const endTour = () => { setTourOpen(false); store.set(LS_TOUR + userId, true); };

    // ---------------- derived
    SERIALS = Object.fromEntries(orders.filter((o) => o.serial).map((o) => [o.id, o.serial]));
    const defaultAirline = airlines.find((a) => a.id === defaultAirlineId) || airlines[0] || null;
    const cartCount = cart.reduce((s, it) => s + it.qty, 0);
    const lastSeen = account?.notifications_seen_at || new Date(0).toISOString();
    const inbox = events.filter((e) => e.actor_id !== userId);
    const unread = inbox.filter((e) => e.created_at > lastSeen).length;
    const activeOrders = orders.filter((o) => ACTIVE_STATUSES.includes(o.status));
    const spent24h = orders
        .filter((o) => !CLOSED_STATUSES.includes(o.status) && Date.now() - new Date(o.created_at).getTime() < 864e5)
        .reduce((s, o) => s + orderListValue(o), 0);   // 24h limit counts list price

    // ---------------- actions
    const requireAirline = () => {
        if (!session) { signInWithDiscord(); return false; }
        if (!airlines.length) { setAirlineForm({}); toast('Create an airline profile first — orders are placed for an airline.'); return false; }
        return true;
    };
    const addToCart = (line) => {
        setCart((c) => {
            const i = c.findIndex((x) => x.model === line.model && x.pricePercent === line.pricePercent && (x.note || '') === (line.note || ''));
            if (i === -1) return [...c, line];
            const next = [...c];
            next[i] = { ...next[i], qty: Math.min(MAX_QTY, next[i].qty + line.qty) };
            return next;
        });
        toast(`Added ${line.qty}× ${line.model} to your order.`, 'success');
    };
    const markNotificationsSeen = async () => {
        const now = new Date().toISOString();
        setAccount((a) => a && { ...a, notifications_seen_at: now });
        await sb.from('accounts').update({ notifications_seen_at: now }).eq('id', userId);
    };
    const signOut = async () => { await sb.auth.signOut(); go('home'); };

    if (!authReady) return html`<${FullPageSpinner} />`;

    const shared = { session, account, airlines, alliances, orders, events, pricelist, cart, priceLevel, dataReady };

    return html`<div className="min-h-screen pb-28 md:pb-12">
        <${Header} ...${shared} view=${view} cartCount=${cartCount} unread=${unread} isSeller=${isSeller}
            defaultAirline=${defaultAirline} activeCount=${activeOrders.length}
            onCart=${() => setCartOpen(true)} onBell=${() => setNotifOpen(true)} onSignOut=${signOut} onTour=${() => setTourOpen(true)} />

        <main className="max-w-6xl mx-auto px-4 md:px-6 pt-4 md:pt-8 space-y-6">
            ${view !== 'home' && html`<${NextStep} ...${shared} view=${view} activeOrders=${activeOrders}
                onCreateAirline=${() => setAirlineForm({})} onOpenCart=${() => setCartOpen(true)} />`}

            ${view === 'home' && html`<${HomeView} ...${shared} activeOrders=${activeOrders} inbox=${inbox}
                spent24h=${spent24h} cartCount=${cartCount} onOpenCart=${() => setCartOpen(true)}
                onOpenOrder=${(id) => { setHighlightOrder(id); go('orders'); }}
                guide=${html`<${NextStep} ...${shared} view=${view} activeOrders=${activeOrders}
                    onCreateAirline=${() => setAirlineForm({})} onOpenCart=${() => setCartOpen(true)} />`} />`}

            ${view === 'shop' && html`<${ShopView} ...${shared} setPriceLevel=${setPriceLevel}
                onPick=${(model) => (requireAirline() ? setSheetModel(model) : null)} />`}
            ${view === 'orders' && html`<${OrdersView} ...${shared} highlight=${highlightOrder}
                onOrderChanged=${(o) => setOrders((list) => list.map((x) => (x.id === o.id ? o : x)))} />`}
            ${view === 'airlines' && html`<${AirlinesView} ...${shared}
                defaultAirline=${defaultAirline} setDefaultAirlineId=${setDefaultAirlineId}
                onCreate=${() => setAirlineForm({})} onEdit=${(a) => setAirlineForm({ airline: a })}
                setAirlines=${setAirlines} />`}
        </main>

        <${BottomNav} view=${view} cartCount=${cartCount} activeCount=${activeOrders.length} onCart=${() => setCartOpen(true)} />

        <${AircraftSheet} aircraft=${pricelist.find((a) => a.model === sheetModel)} priceLevel=${priceLevel}
            inCart=${cart.filter((c) => c.model === sheetModel).reduce((s, c) => s + c.qty, 0)}
            onClose=${() => setSheetModel(null)}
            onAdd=${(line) => { addToCart(line); setSheetModel(null); }} />

        <${CartDrawer} open=${cartOpen} onClose=${() => setCartOpen(false)} cart=${cart} setCart=${setCart}
            pricelist=${pricelist} airlines=${airlines} defaultAirline=${defaultAirline} spent24h=${spent24h}
            session=${session} onCreateAirline=${() => setAirlineForm({})}
            onPlaced=${(order) => {
                setCart([]); setCartOpen(false);
                setOrders((list) => [order, ...list.filter((o) => o.id !== order.id)]);
                setHighlightOrder(order.id); go('orders'); loadAll();
                toast(`Order ${orderRef(order)} sent! Sellers have been notified — you'll see here when one takes it.`, 'success');
            }} />

        <${NotificationsPanel} open=${notifOpen} inbox=${inbox} lastSeen=${lastSeen} account=${account} setAccount=${setAccount}
            onClose=${() => { setNotifOpen(false); if (unread) markNotificationsSeen(); }}
            onOpenOrder=${(id) => { setNotifOpen(false); setHighlightOrder(id); go('orders'); if (unread) markNotificationsSeen(); }} />

        <${AirlineForm} state=${airlineForm} alliances=${alliances} count=${airlines.length} userId=${userId}
            onClose=${() => setAirlineForm(null)}
            onSaved=${(a, isNew) => {
                setAirlines((list) => isNew ? [...list, a] : list.map((x) => (x.id === a.id ? a : x)));
                if (isNew && airlines.length === 0) setDefaultAirlineId(a.id);
                setAirlineForm(null);
                toast(isNew ? `${a.name} is ready. Now pick some aircraft!` : `${a.name} updated.`, 'success');
                if (isNew && airlines.length === 0) go('shop');
            }} />

        ${tourOpen && html`<${Tour} name=${account?.display_name || account?.discord_username || ''} hasAirline=${airlines.length > 0}
            onDone=${(createAirline) => { endTour(); if (createAirline) { go('airlines'); setAirlineForm({}); } }} />`}

        <${Toasts} />
        <${DialogHost} />
    </div>`;
}

// =========================================================================
//  First-time walkthrough: spotlights the real buttons, one short step each.
// =========================================================================
const TOUR_STEPS = [
    { target: null, icon: 'plane-takeoff', title: (n) => `Welcome to Echo Market${n ? `, ${n}` : ''}!`,
      text: 'A 30-second tour of how ordering works. You can skip it any time.' },
    { target: 'airlines', icon: 'building-2', title: () => '1 · Create your airline',
      text: 'Orders are placed on behalf of an airline. Make one here (up to 20), each with its alliance.' },
    { target: 'shop', icon: 'plane', title: () => '2 · Pick aircraft',
      text: 'Choose a model, how many, and a price level: the % of the in-game list price you pay.' },
    { target: 'cart', icon: 'shopping-cart', title: () => '3 · Review and send',
      text: 'Your picks collect here. Pick which of your airlines can receive them (one or more), then send the order.' },
    { target: 'bell', icon: 'bell', title: () => '4 · Follow your order',
      text: "A seller takes it and sells you the aircraft in-game. Updates land here; turn on Discord DMs to get them even when you're away." }
];

// The visible element for a tour anchor (desktop top bar or phone bottom bar).
function tourTarget(key) {
    if (!key) return null;
    return [...document.querySelectorAll(`[data-tour="${key}"]`)].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }) || null;
}

function Tour({ name, hasAirline, onDone }) {
    const [i, setI] = useState(0);
    const [rect, setRect] = useState(null);
    const step = TOUR_STEPS[i];
    const last = i === TOUR_STEPS.length - 1;

    useEffect(() => {
        const measure = () => {
            const el = tourTarget(step.target);
            setRect(el ? el.getBoundingClientRect() : null);
        };
        measure();
        // Re-measure on resize, rotation and layout changes (the target moves between top and bottom bars).
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        ro?.observe(document.documentElement);
        window.addEventListener('resize', measure);
        window.addEventListener('scroll', measure, true);
        return () => { ro?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
    }, [i]);
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onDone(false);
            if (e.key === 'ArrowRight' && !last) setI(i + 1);
            if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [i]);

    // Card goes below the target, or above it when the target is near the bottom (phone nav bar).
    const pad = 8, vw = window.innerWidth, vh = window.innerHeight, cardW = Math.min(340, vw - 32);
    let cardStyle = { width: cardW + 'px' };
    if (rect) {
        const left = Math.max(16, Math.min(vw - cardW - 16, rect.left + rect.width / 2 - cardW / 2));
        cardStyle = rect.top > vh / 2
            ? { ...cardStyle, left: left + 'px', bottom: (vh - rect.top + pad + 10) + 'px' }
            : { ...cardStyle, left: left + 'px', top: (rect.bottom + pad + 10) + 'px' };
    }

    return html`<div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="Echo Market tour">
        ${rect ? html`<div className="absolute rounded-2xl ring-2 ring-sky-300 transition-all duration-300 pointer-events-none"
            style=${{ left: rect.left - pad + 'px', top: rect.top - pad + 'px', width: rect.width + pad * 2 + 'px', height: rect.height + pad * 2 + 'px',
                boxShadow: '0 0 0 9999px rgba(3, 6, 20, 0.72)' }}></div>`
            : html`<div className="absolute inset-0 bg-[rgba(3,6,20,0.72)]"></div>`}
        <div className=${`absolute card !bg-slate-900 p-5 shadow-2xl animate-pop ${rect ? '' : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'}`} style=${cardStyle}>
            <div className="flex items-start gap-3">
                <span className="w-10 h-10 shrink-0 rounded-xl bg-sky-400/15 text-sky-300 flex items-center justify-center"><${Icon} name=${step.icon} className="w-5 h-5" /></span>
                <div className="min-w-0">
                    <h2 className="font-extrabold text-white leading-snug">${step.title(name)}</h2>
                    <p className="text-sm text-slate-300 mt-1 leading-relaxed">${step.text}</p>
                </div>
            </div>
            <div className="flex items-center gap-2 mt-4">
                <div className="flex gap-1 mr-auto" aria-label=${`Step ${i + 1} of ${TOUR_STEPS.length}`}>
                    ${TOUR_STEPS.map((_, j) => html`<span key=${j} className=${`h-1.5 rounded-full transition-all ${j === i ? 'w-5 bg-sky-400' : 'w-1.5 bg-slate-700'}`}></span>`)}
                </div>
                ${!last && html`<${Button} variant="ghost" size="sm" onClick=${() => onDone(false)}>Skip<//>`}
                ${i > 0 && html`<${Button} variant="secondary" size="sm" onClick=${() => setI(i - 1)}>Back<//>`}
                ${last
                    ? html`<${Button} size="sm" icon=${hasAirline ? 'check' : 'plus'} onClick=${() => onDone(!hasAirline)}>${hasAirline ? 'Done' : 'Create my airline'}<//>`
                    : html`<${Button} size="sm" onClick=${() => setI(i + 1)}>${i === 0 ? 'Show me' : 'Next'}<//>`}
            </div>
        </div>
    </div>`;
}

function describeEvent(ev) {
    const ev2 = { ...ev, order_id: refFor(ev.order_id) };
    return describe(ev2);
}
function describe(ev) {
    switch (ev.kind) {
        case 'CLAIMED': return `${ev.order_id}: ${ev.message || 'A seller took your order.'}`;
        case 'RELEASED': return `${ev.order_id}: the seller released it — waiting for another seller.`;
        case 'HANDOFF': return `${ev.order_id}: ${ev.message || 'the seller passed on the rest — waiting for a new seller.'}`;
        case 'PROGRESS': return `${ev.order_id}: ${ev.filled} delivered. ${ev.message || ''}`.trim();
        case 'FULFILLED': return `${ev.order_id} is fully delivered! ${ev.message || ''}`.trim();
        case 'DECLINED': return `${ev.order_id} was declined: ${ev.message || ''}`;
        case 'NOTE': return `${ev.order_id}: new note from the seller — "${ev.message}"`;
        case 'CANCELLED': return `${ev.order_id} was cancelled.`;
        default: return `${ev.order_id}: ${ev.message || 'updated'}`;
    }
}

// =========================================================================
//  Layout
// =========================================================================
function FullPageSpinner() {
    return html`<div className="min-h-screen flex items-center justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`;
}

function Header({ session, account, view, cartCount, unread, isSeller, activeCount, onCart, onBell, onSignOut, onTour }) {
    const [menu, setMenu] = useState(false);
    return html`<header className="sticky top-0 z-40 bg-page/85 backdrop-blur border-b border-slate-800/80">
        <div className="max-w-6xl mx-auto px-4 md:px-6 h-14 md:h-16 flex items-center gap-3">
            <a href="/" onClick=${navTo('home')} className="flex items-center gap-2.5 shrink-0">
                <img src="echo_logo.png" alt="" className="w-8 h-8 rounded-lg" />
                <span className="font-extrabold tracking-tight text-white">Echo Market</span>
            </a>
            <nav className="hidden md:flex items-center gap-1 ml-6">
                ${VIEWS.map((v) => html`<a key=${v.id} href=${viewHref(v.id)} onClick=${navTo(v.id)} data-tour=${v.id}
                    className=${`px-3.5 py-2 rounded-full text-sm font-bold flex items-center gap-2 transition-colors ${view === v.id ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'}`}>
                    ${v.label}
                    ${v.id === 'orders' && activeCount > 0 && html`<span className="text-[10px] px-1.5 rounded-full bg-sky-400 text-slate-950">${activeCount}</span>`}
                </a>`)}
            </nav>
            <div className="flex-1"></div>
            ${session ? html`
                <button onClick=${onCart} className="hidden md:flex relative items-center justify-center w-10 h-10 rounded-full hover:bg-slate-800 text-slate-300" aria-label="Open your order" data-tour="cart">
                    <${Icon} name="shopping-cart" className="w-5 h-5" />
                    ${cartCount > 0 && html`<span className="absolute -top-0.5 -right-0.5 min-w-5 h-5 px-1 rounded-full bg-sky-400 text-slate-950 text-[10px] font-black flex items-center justify-center">${cartCount}</span>`}
                </button>
                <button onClick=${onBell} className="relative flex items-center justify-center w-10 h-10 rounded-full hover:bg-slate-800 text-slate-300" aria-label="Notifications" data-tour="bell">
                    <${Icon} name="bell" className="w-5 h-5" />
                    ${unread > 0 && html`<span className="absolute -top-0.5 -right-0.5 min-w-5 h-5 px-1 rounded-full bg-rose-500 text-white text-[10px] font-black flex items-center justify-center">${unread}</span>`}
                </button>
                <div className="relative">
                    <button onClick=${() => setMenu(!menu)} aria-label="Account menu" className="flex items-center gap-1.5 h-10 pl-1 pr-2 rounded-full hover:bg-slate-800">
                        <${Avatar} account=${account} />
                        <${Icon} name="chevron-down" className="w-4 h-4 text-slate-500" />
                    </button>
                    ${menu && html`<div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-2 z-50" onClick=${() => setMenu(false)}>
                        <div className="px-3 py-2.5 border-b border-slate-800 mb-1">
                            <p className="font-bold text-sm text-white truncate">${account?.display_name || account?.discord_username || 'Signed in'}</p>
                            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5"><${DiscordLogo} className="w-3.5 h-3.5" /> ${account?.discord_username || 'Discord'}</p>
                        </div>
                        <a href="#airlines" className="menu-item"><${Icon} name="building-2" /> My airlines</a>
                        <a href="#orders" className="menu-item"><${Icon} name="package" /> My orders</a>
                        <button onClick=${onTour} className="menu-item w-full"><${Icon} name="compass" /> Show me around</button>
                        ${isSeller && CONFIG.SELLER_URL && html`<a href=${CONFIG.SELLER_URL} className="menu-item"><${Icon} name="store" /> Seller dashboard</a>`}
                        <button onClick=${onSignOut} className="menu-item w-full text-rose-300"><${Icon} name="log-out" /> Sign out</button>
                    </div>`}
                </div>
            ` : html`<${Button} variant="discord" size="md" onClick=${signInWithDiscord}><${DiscordLogo} className="w-4 h-4" /> Sign in<//>`}
        </div>
    </header>`;
}

function BottomNav({ view, cartCount, activeCount, onCart }) {
    const item = (active) => `flex-1 flex flex-col items-center gap-1 py-2 text-[10px] font-bold ${active ? 'text-white' : 'text-slate-500'}`;
    return html`<nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-page/95 backdrop-blur border-t border-slate-800 flex px-2 pb-[env(safe-area-inset-bottom)]">
        ${VIEWS.map((v) => html`<a key=${v.id} href=${viewHref(v.id)} onClick=${navTo(v.id)} data-tour=${v.id} className=${item(view === v.id)}>
            <span className="relative"><${Icon} name=${v.icon} className="w-5 h-5" />
                ${v.id === 'orders' && activeCount > 0 && html`<span className="absolute -top-1 -right-2 w-4 h-4 rounded-full bg-sky-400 text-slate-950 text-[9px] flex items-center justify-center">${activeCount}</span>`}
            </span>${v.label}
        </a>`)}
        <button onClick=${onCart} className=${item(false)} aria-label="Buy: open your order" data-tour="cart">
            <span className="relative"><${Icon} name="shopping-cart" className="w-5 h-5" />
                ${cartCount > 0 && html`<span className="absolute -top-1 -right-2 min-w-4 h-4 px-0.5 rounded-full bg-sky-400 text-slate-950 text-[9px] flex items-center justify-center">${cartCount}</span>`}
            </span>Buy
        </button>
    </nav>`;
}

// The "where do I start?" guide. Always tells the user the single next thing to do.
function NextStep({ session, airlines, cart, orders, activeOrders, view, dataReady, onCreateAirline, onOpenCart }) {
    if (!session) {
        return html`<section className="rounded-3xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-6 md:p-10">
            <p className="label text-sky-300">Echo UA Airliner Market</p>
            <h1 className="text-3xl md:text-5xl font-black tracking-tight text-white mt-3 leading-[1.05]">Order aircraft for your airline<br className="hidden md:block" /> <span className="text-slate-500">in three steps.</span></h1>
            <ol className="grid md:grid-cols-3 gap-3 mt-7">
                ${[
                    ['1', 'Sign in with Discord', 'One market account per Discord user. Everything is saved to it.'],
                    ['2', 'Create your airline', 'Up to 20 airline profiles, each with its alliance.'],
                    ['3', 'Pick aircraft & send', 'A seller takes your order and delivers in-game. You can follow every step here.']
                ].map(([n, t, d]) => html`<li key=${n} className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
                    <span className="w-7 h-7 rounded-full bg-slate-800 text-sky-300 text-sm font-black flex items-center justify-center">${n}</span>
                    <p className="font-bold text-white mt-3">${t}</p>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">${d}</p>
                </li>`)}
            </ol>
            <div className="mt-7 flex flex-wrap items-center gap-3">
                <${Button} variant="discord" size="lg" onClick=${signInWithDiscord}><${DiscordLogo} /> Sign in with Discord<//>
                <span className="text-xs text-slate-500">Browsing the catalog doesn't need an account.</span>
            </div>
        </section>`;
    }
    if (!dataReady) return null;

    let step = null;
    if (!airlines.length) {
        step = { n: 2, title: 'Create your first airline profile', text: 'Orders are placed on behalf of an airline. It takes 10 seconds.', action: html`<${Button} icon="plus" onClick=${onCreateAirline}>Create airline<//>` };
    } else if (cart.length) {
        step = { n: 3, title: `Review and send your order (${plural(cart.reduce((s, c) => s + c.qty, 0), 'aircraft')})`, text: 'Nothing is sent to sellers until you press "Send order".', action: html`<${Button} icon="arrow-right" onClick=${onOpenCart}>Review order<//>` };
    } else if (!orders.length && view !== 'shop') {
        step = { n: 3, title: 'Pick aircraft from the catalog', text: 'Choose a model, quantity and price level, then send the order.', action: html`<${Button} icon="plane" onClick=${() => go('shop')}>Open catalog<//>` };
    } else if (!orders.length) {
        step = { n: 3, title: 'Pick aircraft below', text: 'Tap "Add" on any aircraft. When you are done, review and send your order.' };
    } else if (activeOrders.length && view !== 'orders' && view !== 'home') {
        step = { n: null, title: `${plural(activeOrders.length, 'order')} in progress`, text: 'See which seller took them and how many aircraft were delivered.', action: html`<${Button} variant="secondary" icon="package" onClick=${() => go('orders')}>Track orders<//>` };
    }
    if (!step) return null;

    return html`<section className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 md:p-5 rounded-3xl border border-sky-500/25 bg-sky-500/[0.06]">
        <div className="flex items-start gap-3.5 flex-1 min-w-0">
            ${step.n ? html`<div className="shrink-0">
                <p className="label text-sky-300">Step ${step.n} of 3</p>
                <div className="flex gap-1 mt-1.5">${[1, 2, 3].map((i) => html`<span key=${i} className=${`h-1.5 w-5 rounded-full ${i <= step.n ? 'bg-sky-400' : 'bg-slate-700'}`}></span>`)}</div>
            </div>` : html`<${Icon} name="radar" className="w-6 h-6 text-sky-300 mt-0.5" />`}
            <div className="min-w-0">
                <p className="font-extrabold text-white">${step.title}</p>
                <p className="text-sm text-slate-400">${step.text}</p>
            </div>
        </div>
        ${step.action && html`<div className="shrink-0">${step.action}</div>`}
    </section>`;
}

// =========================================================================
//  Home
// =========================================================================
function HomeView({ session, account, orders, airlines, activeOrders, inbox, spent24h, cart, cartCount, dataReady, guide, onOpenCart, onOpenOrder }) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30000);
        return () => clearInterval(t);
    }, []);

    if (!session) {
        return html`<section className="space-y-4">
            ${guide}
            <div className="flex flex-wrap gap-2">
                <${Button} variant="secondary" icon="plane" onClick=${() => go('shop')}>Browse the catalog<//>
            </div>
        </section>`;
    }

    const g = greetingFor(now);
    const name = account?.display_name || account?.discord_username || '';
    const clock = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

    const waiting = activeOrders.filter((o) => o.status === 'PENDING').length;  // includes partly delivered orders needing a new seller
    const inDelivery = activeOrders.length - waiting;
    const fulfilled = orders.filter((o) => o.status === 'FULFILLED');
    const received = orders.filter((o) => !CLOSED_STATUSES.includes(o.status)).reduce((s, o) => s + o.filled, 0);
    const activeQty = activeOrders.reduce((s, o) => s + o.total_qty, 0);
    const activeFilled = activeOrders.reduce((s, o) => s + o.filled, 0);
    const activePct = activeQty ? Math.round((activeFilled / activeQty) * 100) : 0;
    const budgetPct = Math.min(100, Math.round((spent24h / DAILY_LIMIT_USD) * 100));

    const tile = (icon, label, value, sub, extra) => html`<div className="card p-4 md:p-5 flex flex-col gap-1 min-w-0">
        <div className="flex items-center justify-between text-slate-400">
            <span className="text-xs font-bold">${label}</span><${Icon} name=${icon} className="w-4 h-4" />
        </div>
        <p className="text-3xl font-black text-white tabular-nums">${value}</p>
        <p className="text-xs text-slate-400 leading-snug">${sub}</p>
        ${extra}
    </div>`;

    return html`<section className="space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div className="min-w-0">
                <p className="label text-sky-300 flex items-center gap-2"><${Icon} name=${g.icon} className="w-4 h-4" />${date} · ${clock}</p>
                <h1 className="text-2xl md:text-4xl font-black tracking-tight text-white mt-1.5 md:mt-2 truncate">${g.text}${name ? `, ${name}` : ''}.</h1>
                <p className="text-sm text-slate-400 mt-1">${!dataReady ? 'Loading your fleet…'
                    : activeOrders.length ? `You have ${plural(activeOrders.length, 'order')} in progress.`
                    : orders.length ? 'No orders in progress right now.' : 'Welcome to Echo Market.'}</p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
                ${cartCount > 0 && html`<${Button} icon="shopping-cart" onClick=${onOpenCart}>Review order (${cartCount})<//>`}
                <${Button} variant=${cartCount > 0 ? 'secondary' : 'primary'} icon="plane" onClick=${() => go('shop')}>Buy aircraft<//>
            </div>
        </header>

        ${guide}

        ${dataReady && orders.length > 0 && html`<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            ${tile('package', 'Active orders', activeOrders.length, `${waiting} waiting · ${inDelivery} with a seller`)}
            ${tile('circle-check', 'Delivered orders', fulfilled.length, `${plural(received, 'aircraft')} received in total`)}
            ${tile('plane-landing', 'Active progress', activeQty ? `${activePct}%` : '–',
                activeQty ? `${activeFilled} of ${plural(activeQty, 'aircraft')} delivered` : 'nothing in delivery',
                activeQty > 0 && html`<div className="mt-2"><${ProgressBar} value=${activeFilled} max=${activeQty} /></div>`)}
            ${tile('wallet', '24-hour limit', `${budgetPct}%`, `${fmtUSDShort(spent24h)} of ${fmtUSDShort(DAILY_LIMIT_USD)} used, at list price`,
                html`<div className="mt-2"><${ProgressBar} value=${Math.min(spent24h, DAILY_LIMIT_USD)} max=${DAILY_LIMIT_USD} usage=${true} /></div>`)}
        </div>`}

        ${dataReady && orders.length > 0 && html`<div className="grid lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3 space-y-3 min-w-0">
                <div className="flex items-center justify-between">
                    <h2 className="font-extrabold text-white">Orders in progress</h2>
                    <a href="#orders" className="text-xs font-bold text-slate-400 hover:text-white">All orders →</a>
                </div>
                ${!activeOrders.length ? html`<div className="card p-5 text-sm text-slate-400">Nothing in progress. Your delivered orders are under <a href="#orders" className="underline">Orders</a>.</div>`
                : activeOrders.slice(0, 4).map((o) => html`<button key=${o.id} onClick=${() => onOpenOrder(o.id)}
                    className="card w-full text-left p-4 hover:border-slate-600 space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="font-bold text-white truncate">${airlineNames(o)}</p>
                            <${OrderCode} order=${o} className="text-[11px]" />
                            <p className="text-xs text-slate-400 truncate">${o.seller_airline_name ? `Seller: ${o.seller_airline_name}`
                                : o.filled > 0 ? 'Partly delivered · waiting for a new seller' : 'Waiting for a seller to take it'} · ${plural(o.total_qty, 'aircraft')}</p>
                        </div>
                        <${StatusBadge} status=${displayStatus(o)} />
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex-1"><${ProgressBar} value=${o.filled} max=${o.total_qty} /></div>
                        <span className="text-xs font-bold text-slate-300 tabular-nums">${o.filled}/${o.total_qty}</span>
                    </div>
                    ${orderLines(o).length > 1 && html`<${ItemProgress} order=${o} compact=${true} />`}
                </button>`)}
                ${activeOrders.length > 4 && html`<a href="#orders" className="block text-center text-xs font-bold text-slate-400 hover:text-white">+ ${activeOrders.length - 4} more in progress</a>`}
            </div>
            <div className="lg:col-span-2 space-y-3 min-w-0">
                <h2 className="font-extrabold text-white">Latest updates</h2>
                <div className="card p-2">
                    ${!inbox.length ? html`<p className="text-sm text-slate-400 p-3">No updates yet. You'll see here when a seller takes or delivers your order.</p>`
                    : html`<ul className="divide-y divide-slate-800">${inbox.slice(0, 5).map((e) => html`<li key=${e.id}>
                        <button onClick=${() => onOpenOrder(e.order_id)} className="w-full text-left p-3 rounded-xl hover:bg-slate-800/40">
                            <span className="block text-sm text-slate-200">${describeEvent(e)}</span>
                            <span className="block text-[11px] text-slate-500 mt-0.5">${timeAgo(e.created_at)}</span>
                        </button>
                    </li>`)}</ul>`}
                </div>
                <a href="#airlines" className="card flex items-center gap-3 p-4 hover:border-slate-600">
                    <span className="w-9 h-9 rounded-xl bg-sky-400/10 text-sky-300 flex items-center justify-center"><${Icon} name="building-2" /></span>
                    <span className="flex-1 min-w-0">
                        <span className="block font-bold text-white text-sm">Your airlines</span>
                        <span className="block text-xs text-slate-400 truncate">${airlines.length ? airlines.map((a) => a.name).join(', ') : 'None yet'}</span>
                    </span>
                    <span className="text-xs font-bold text-slate-400 tabular-nums">${airlines.length}/${MAX_AIRLINES}</span>
                </a>
            </div>
        </div>`}
    </section>`;
}

// =========================================================================
//  Shop
// =========================================================================
function ShopView({ pricelist, priceLevel, setPriceLevel, cart, onPick }) {
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('ALL');
    const [sort, setSort] = useState('family');
    const categories = useMemo(() => ['ALL', ...new Set(pricelist.map((a) => a.category))], [pricelist]);
    const inCart = useMemo(() => cart.reduce((m, c) => ({ ...m, [c.model]: (m[c.model] || 0) + c.qty }), {}), [cart]);

    const list = useMemo(() => {
        const q = query.trim().toLowerCase();
        const filtered = pricelist.filter((a) =>
            (category === 'ALL' || a.category === category) &&
            (!q || `${a.model} ${a.family} ${a.code}`.toLowerCase().includes(q)));
        const sorters = {
            family: () => 0,
            'price-asc': (a, b) => a.price - b.price,
            'price-desc': (a, b) => b.price - a.price,
            seats: (a, b) => b.seats - a.seats,
            range: (a, b) => b.range - a.range
        };
        return [...filtered].sort(sorters[sort]);
    }, [pricelist, query, category, sort]);

    return html`<section className="space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end gap-4 justify-between">
            <div>
                <h2 className="text-2xl font-black tracking-tight text-white">Aircraft catalog</h2>
                <p className="text-sm text-slate-400">${pricelist.length} models. The <b className="text-slate-200">price level</b> is the % of the in-game list price you offer: a seller sells you the aircraft in-game at that price. Lower is cheaper, but sellers might be slower to accept it.</p>
            </div>
            <div>
                <p className="label text-slate-500 mb-1.5">Price level · % of list price you pay</p>
                <div className="inline-flex p-1 rounded-full bg-slate-900 border border-slate-800">
                    ${PRICE_LEVELS.map((p) => html`<button key=${p} onClick=${() => setPriceLevel(p)}
                        className=${`px-3.5 py-1.5 rounded-full text-xs font-black transition-colors ${priceLevel === p ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}>${p}%</button>`)}
                </div>
            </div>
        </div>

        <div className="flex flex-col md:flex-row gap-2">
            <label className="relative flex-1">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"><${Icon} name="search" /></span>
                <input value=${query} onChange=${(e) => setQuery(e.target.value)} placeholder="Search model, family or ICAO code…" className="input pl-10" />
            </label>
            <select value=${sort} onChange=${(e) => setSort(e.target.value)} className="input md:!w-52">
                <option value="family">Sort: manufacturer</option>
                <option value="price-asc">Price: low to high</option>
                <option value="price-desc">Price: high to low</option>
                <option value="seats">Most seats</option>
                <option value="range">Longest range</option>
            </select>
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
            ${categories.map((c) => html`<button key=${c} onClick=${() => setCategory(c)}
                className=${`shrink-0 px-3.5 py-1.5 rounded-full border text-xs font-bold ${category === c ? 'bg-slate-100 text-slate-950 border-slate-100' : 'border-slate-800 text-slate-400 hover:text-white'}`}>
                ${c === 'ALL' ? 'All makers' : c}</button>`)}
        </div>

        ${!pricelist.length ? html`<div className="py-16 flex justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`
        : !list.length ? html`<${EmptyState} icon="search-x" title="No aircraft match" text="Try a different search or maker." />`
        : html`<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${list.map((a) => html`<article key=${a.model} className="card p-4 flex flex-col">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="label text-slate-500">${a.category} · ${a.code}</p>
                        <h3 className="font-extrabold text-white mt-1 leading-tight">${a.model}</h3>
                    </div>
                    ${inCart[a.model] && html`<span className="shrink-0 text-[10px] font-black px-2 py-1 rounded-full bg-sky-400/15 text-sky-300">${inCart[a.model]} in order</span>`}
                </div>
                <div className="flex gap-4 mt-3 text-xs text-slate-400">
                    <span className="flex items-center gap-1.5"><${Icon} name="users" className="w-3.5 h-3.5" />${a.seats} seats</span>
                    <span className="flex items-center gap-1.5"><${Icon} name="route" className="w-3.5 h-3.5" />${a.range.toLocaleString()} km</span>
                </div>
                <div className="flex items-end justify-between mt-4 pt-3 border-t border-slate-800">
                    <div>
                        <p className="text-lg font-black text-white">${fmtUSDShort(a.price * priceLevel / 100)}</p>
                        <p className="text-[11px] text-slate-500">list ${fmtUSDShort(a.price)} · ${priceLevel}%</p>
                    </div>
                    <${Button} size="sm" icon="plus" onClick=${() => onPick(a.model)}>Add<//>
                </div>
            </article>`)}
        </div>`}
    </section>`;
}

function AircraftSheet({ aircraft, priceLevel, inCart, onClose, onAdd }) {
    const [qty, setQty] = useState(1);
    const [level, setLevel] = useState(priceLevel);
    const [note, setNote] = useState('');
    useEffect(() => { if (aircraft) { setQty(1); setLevel(priceLevel); setNote(''); } }, [aircraft?.model]);
    if (!aircraft) return null;
    const unit = Math.round(aircraft.price * level / 100);
    const setQ = (v) => setQty(Math.max(1, Math.min(MAX_QTY, Math.floor(Number(v) || 1))));

    return html`<${Modal} open=${true} onClose=${onClose} title=${aircraft.model}
        subtitle=${`${aircraft.family} · ${aircraft.code} · ${aircraft.seats} seats · ${aircraft.range.toLocaleString()} km`}
        footer=${html`<div className="flex-1 text-left">
                <p className="text-xs text-slate-400">${qty} × ${fmtUSD(unit)}</p>
                <p className="text-lg font-black text-white">${fmtUSD(unit * qty)}</p>
            </div>
            <${Button} icon="plus" onClick=${() => onAdd({ model: aircraft.model, qty, pricePercent: level, note: note.trim() })}>Add to order<//>`}>
        <div className="space-y-5">
            <div>
                <p className="field-label">Quantity</p>
                <div className="flex items-center gap-2">
                    <button className="stepper" onClick=${() => setQ(qty - 1)} aria-label="Less"><${Icon} name="minus" /></button>
                    <input type="number" min="1" max=${MAX_QTY} value=${qty} onChange=${(e) => setQ(e.target.value)} className="input !w-24 text-center font-bold" />
                    <button className="stepper" onClick=${() => setQ(qty + 1)} aria-label="More"><${Icon} name="plus" /></button>
                    ${[5, 10, 25].map((n) => html`<button key=${n} onClick=${() => setQ(n)} className="px-3 py-2 rounded-xl text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-800">${n}</button>`)}
                </div>
                ${inCart > 0 && html`<p className="text-xs text-sky-300 mt-2">You already have ${inCart} of these in your order.</p>`}
            </div>
            <div>
                <p className="field-label">Price level <span className="font-medium text-slate-500">· you pay this % of the in-game list price</span></p>
                <div className="grid grid-cols-5 gap-1.5">
                    ${PRICE_LEVELS.map((p) => html`<button key=${p} aria-label=${p + "% of list price"} aria-pressed=${level === p} onClick=${() => setLevel(p)}
                        className=${`py-2.5 rounded-xl border text-center ${level === p ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                        <span className="block text-sm font-black">${p}%</span>
                        <span className="block text-[10px] opacity-70">${fmtUSDShort(aircraft.price * p / 100)}</span>
                    </button>`)}
                </div>
            </div>
            <label className="block">
                <span className="field-label">Note for the seller (optional)</span>
                <input value=${note} maxLength="200" onChange=${(e) => setNote(e.target.value)} placeholder="e.g. livery, delivery hub…" className="input" />
            </label>
        </div>
    <//>`;
}

// =========================================================================
//  Cart / checkout
// =========================================================================
function CartDrawer({ open, onClose, cart, setCart, pricelist, airlines, defaultAirline, spent24h, session, onCreateAirline, onPlaced }) {
    const [airlineIds, setAirlineIds] = useState([]);   // every airline the aircraft may be delivered to
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!open) return;
        setAirlineIds((ids) => {
            const kept = ids.filter((id) => airlines.some((a) => a.id === id));
            return kept.length ? kept : defaultAirline ? [defaultAirline.id] : [];
        });
    }, [open, airlines, defaultAirline]);
    const toggleAirline = (id) => setAirlineIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    if (!open) return null;

    const byModel = Object.fromEntries(pricelist.map((a) => [a.model, a]));
    const lines = cart.map((c, i) => {
        const a = byModel[c.model];
        const unit = a ? Math.round(a.price * c.pricePercent / 100) : 0;
        return { ...c, i, aircraft: a, unit, total: unit * c.qty };
    });
    const total = lines.reduce((s, l) => s + l.total, 0);
    // The 24h limit counts aircraft at 100% list price, whatever price level is chosen.
    const listTotal = lines.reduce((s, l) => s + (l.aircraft ? l.aircraft.price * l.qty : 0), 0);
    const left = Math.max(0, DAILY_LIMIT_USD - spent24h);
    const overLimit = listTotal > left;
    const update = (i, patch) => setCart((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    const remove = (i) => setCart((c) => c.filter((_, j) => j !== i));

    const problems = [];
    if (!session) problems.push('Sign in to send orders.');
    else if (!airlines.length) problems.push('Create an airline profile first.');
    else if (!airlineIds.length) problems.push('Choose at least one airline to receive the aircraft.');
    if (!cart.length) problems.push('Your order is empty.');
    if (overLimit) problems.push(`Over your 24-hour limit: this order is ${fmtUSDShort(listTotal)} at list price, and ${fmtUSDShort(left)} of your limit is left today.`);

    const submit = async () => {
        setBusy(true);
        try {
            const { order } = await api('/api/orders', {
                // In the order the airlines are listed, so the main (first) airline is predictable.
                airlineIds: airlines.filter((a) => airlineIds.includes(a.id)).map((a) => a.id),
                buyerNote: note.trim(),
                items: cart.map(({ model, qty, pricePercent, note }) => ({ model, qty, pricePercent, note }))
            });
            setNote('');
            onPlaced(order);
        } catch (err) {
            toast('Order not sent: ' + err.message, 'error');
        } finally {
            setBusy(false);
        }
    };

    return html`<div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade" onClick=${onClose}></div>
        <aside className="relative w-full md:max-w-md h-full bg-slate-950 border-l border-slate-800 flex flex-col animate-slide-in">
            <div className="flex items-center justify-between p-5 border-b border-slate-800">
                <div>
                    <h2 className="text-lg font-extrabold text-white">Your order</h2>
                    <p className="text-xs text-slate-400">Review, pick which of your airlines can receive it, then send it to the sellers.</p>
                </div>
                <button onClick=${onClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close"><${Icon} name="x" className="w-5 h-5" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
                ${!cart.length ? html`<${EmptyState} icon="shopping-cart" title="Nothing here yet" text="Add aircraft from the catalog."
                    action=${html`<${Button} variant="secondary" onClick=${() => { onClose(); go('shop'); }}>Browse catalog<//>`} />`
                : html`<ul className="space-y-2">
                    ${lines.map((l) => html`<li key=${l.i} className="p-3.5 rounded-2xl bg-slate-900 border border-slate-800">
                        <div className="flex justify-between gap-3">
                            <div className="min-w-0">
                                <p className="font-bold text-sm text-white truncate">${l.model}</p>
                                <p className="text-xs text-slate-400">${fmtUSD(l.unit)} each${l.note ? ` · “${l.note}”` : ''}</p>
                                ${!l.aircraft && html`<p className="text-xs text-rose-300">No longer in the catalog — remove it.</p>`}
                            </div>
                            <button onClick=${() => remove(l.i)} className="p-1.5 -m-1 h-fit rounded-lg text-slate-500 hover:text-rose-300" aria-label="Remove"><${Icon} name="trash-2" /></button>
                        </div>
                        <div className="flex items-center gap-2 mt-3">
                            <button className="stepper !w-8 !h-8" onClick=${() => update(l.i, { qty: Math.max(1, l.qty - 1) })}><${Icon} name="minus" className="w-3.5 h-3.5" /></button>
                            <input type="number" value=${l.qty} min="1" max=${MAX_QTY} className="input !py-1.5 !w-16 text-center text-sm font-bold"
                                onChange=${(e) => update(l.i, { qty: Math.max(1, Math.min(MAX_QTY, Math.floor(Number(e.target.value) || 1))) })} />
                            <button className="stepper !w-8 !h-8" onClick=${() => update(l.i, { qty: Math.min(MAX_QTY, l.qty + 1) })}><${Icon} name="plus" className="w-3.5 h-3.5" /></button>
                            <select value=${l.pricePercent} onChange=${(e) => update(l.i, { pricePercent: Number(e.target.value) })} className="input !py-1.5 !w-auto text-sm">
                                ${PRICE_LEVELS.map((p) => html`<option key=${p} value=${p}>${p}%</option>`)}
                            </select>
                            <span className="ml-auto font-bold text-sm text-white">${fmtUSDShort(l.total)}</span>
                        </div>
                    </li>`)}
                </ul>`}

                ${session && html`<div>
                    <p className="field-label">Deliver to <span className="font-medium text-slate-500">· pick one or more of your airlines</span></p>
                    ${airlines.length ? html`<div className="grid grid-cols-2 gap-1.5">
                        ${airlines.map((a) => {
                            const on = airlineIds.includes(a.id);
                            return html`<button type="button" key=${a.id} onClick=${() => toggleAirline(a.id)} aria-pressed=${on}
                                className=${`relative py-2.5 pl-3 pr-7 rounded-xl border text-left ${on ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                                <span className="block text-sm font-bold truncate">${a.name}</span>
                                <span className=${`block text-[11px] ${on ? 'text-slate-600' : 'text-slate-500'}`}>${a.alliance}</span>
                                ${on && html`<span className="absolute right-2 top-1/2 -translate-y-1/2"><${Icon} name="check" className="w-4 h-4" /></span>`}
                            </button>`;
                        })}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-2">${airlineIds.length > 1
                        ? `Any seller in ${[...new Set(airlines.filter((a) => airlineIds.includes(a.id)).map((a) => a.alliance))].join(', ')} can deliver. The number of aircraft stays the same.`
                        : 'Pick more airlines to let sellers from more alliances deliver. The number of aircraft stays the same.'}</p>`
                    : html`<${Button} variant="secondary" icon="plus" className="w-full" onClick=${onCreateAirline}>Create an airline profile<//>`}
                </div>`}

                ${cart.length > 0 && html`<label className="block">
                    <span className="field-label">Note for the sellers (optional)</span>
                    <textarea value=${note} maxLength="1000" rows="2" onChange=${(e) => setNote(e.target.value)} className="input" placeholder="Anything the seller should know"></textarea>
                </label>`}
            </div>

            <div className="p-5 border-t border-slate-800 space-y-3 bg-slate-950">
                <div className="flex justify-between items-end">
                    <span className="text-sm text-slate-400">Total · ${plural(cart.reduce((s, c) => s + c.qty, 0), 'aircraft')}</span>
                    <span className="text-2xl font-black text-white">${fmtUSD(total)}</span>
                </div>
                ${session && html`<div>
                    <div className="flex justify-between text-[11px] text-slate-500 mb-1"><span>24-hour limit, at list price</span><span>${fmtUSDShort(spent24h + listTotal)} / ${fmtUSDShort(DAILY_LIMIT_USD)}</span></div>
                    <${ProgressBar} value=${Math.min(DAILY_LIMIT_USD, spent24h + listTotal)} max=${DAILY_LIMIT_USD} usage=${true} />
                </div>`}
                ${problems.length > 0 && cart.length > 0 && html`<p className="text-xs text-amber-300 flex gap-1.5"><${Icon} name="info" className="w-3.5 h-3.5 mt-px" />${problems[0]}</p>`}
                ${!session ? html`<${Button} variant="discord" size="lg" className="w-full" onClick=${signInWithDiscord}><${DiscordLogo} /> Sign in to send<//>`
                : html`<${Button} size="lg" className="w-full" icon="send" busy=${busy} disabled=${problems.length > 0} onClick=${submit}>Send order to sellers<//>`}
            </div>
        </aside>
    </div>`;
}

// =========================================================================
//  Orders
// =========================================================================
function OrdersView({ session, orders, events, airlines, highlight, dataReady, onOrderChanged }) {
    const [tab, setTab] = useState('active');
    const [airlineFilter, setAirlineFilter] = useState('ALL');
    useEffect(() => {
        if (!highlight) return;
        const o = orders.find((x) => x.id === highlight);
        if (o) setTab(ACTIVE_STATUSES.includes(o.status) ? 'active' : 'all');
        setTimeout(() => document.getElementById('order-' + highlight)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    }, [highlight]);

    if (!session) return html`<${SignInPrompt} what="see your orders" />`;
    if (!dataReady) return html`<div className="py-16 flex justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`;

    const tabs = {
        active: (o) => ACTIVE_STATUSES.includes(o.status),
        done: (o) => o.status === 'FULFILLED',
        closed: (o) => CLOSED_STATUSES.includes(o.status),
        all: () => true
    };
    const allNames = [...new Set(orders.flatMap((o) => orderAirlines(o).map((a) => a.name)))];
    const list = orders.filter((o) => tabs[tab](o) && (airlineFilter === 'ALL' || orderAirlines(o).some((a) => a.name === airlineFilter)));
    const counts = Object.fromEntries(Object.entries(tabs).map(([k, f]) => [k, orders.filter(f).length]));

    return html`<section className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-3">
            <div>
                <h2 className="text-2xl font-black tracking-tight text-white">Your orders</h2>
                <p className="text-sm text-slate-400">Updates appear here live as sellers work on them.</p>
            </div>
            ${allNames.length > 1 && html`<select value=${airlineFilter} onChange=${(e) => setAirlineFilter(e.target.value)} className="input md:!w-60">
                <option value="ALL">All airlines</option>
                ${allNames.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
            </select>`}
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            ${[['active', 'In progress'], ['done', 'Delivered'], ['closed', 'Cancelled / declined'], ['all', 'All']].map(([k, label]) => html`
                <button key=${k} onClick=${() => setTab(k)} className=${`shrink-0 px-3.5 py-1.5 rounded-full border text-xs font-bold ${tab === k ? 'bg-slate-100 text-slate-950 border-slate-100' : 'border-slate-800 text-slate-400 hover:text-white'}`}>
                    ${label} <span className="opacity-60">${counts[k]}</span>
                </button>`)}
        </div>
        ${!list.length ? html`<${EmptyState} icon="package" title=${orders.length ? 'Nothing in this list' : 'No orders yet'}
            text=${orders.length ? 'Try another tab.' : airlines.length ? 'Pick aircraft from the catalog and send your first order.' : 'Create an airline profile, then pick aircraft from the catalog.'}
            action=${!orders.length && html`<${Button} icon="plane" onClick=${() => go('shop')}>Open catalog<//>`} />`
        : html`<div className="space-y-3">${list.map((o) => html`<${OrderCard} key=${o.id} order=${o} highlight=${o.id === highlight}
            events=${events.filter((e) => e.order_id === o.id)} onChanged=${onOrderChanged} />`)}</div>`}
    </section>`;
}

function OrderCard({ order, events, highlight, onChanged }) {
    const [open, setOpen] = useState(highlight);
    const [busy, setBusy] = useState(false);
    const items = orderLines(order);
    const closed = CLOSED_STATUSES.includes(order.status);
    const handoff = order.status === 'PENDING' && order.filled > 0;
    const previous = Array.isArray(order.previous_sellers) ? order.previous_sellers : [];

    const cancel = async () => {
        const ok = await ask({ title: `Cancel order ${orderRef(order)}?`, message: 'Sellers will no longer see this order. You can only cancel while no seller has taken it.', confirmLabel: 'Cancel order', danger: true });
        if (!ok) return;
        setBusy(true);
        try {
            const { order: updated } = await api(`/api/orders/${order.id}`, { action: 'cancel' });
            onChanged(updated);
            toast(`Order ${orderRef(order)} cancelled.`);
        } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
    };

    return html`<article id=${'order-' + order.id} className=${`card p-4 md:p-5 space-y-3 md:space-y-4 ${highlight ? 'ring-2 ring-sky-400/60' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500"><${OrderCode} order=${order} /><span>${fmtDate(order.created_at)}</span></p>
                <h3 className="font-extrabold text-white mt-0.5">${orderAirlines(order).map((a, i) => html`<span key=${i}>${i ? html`<span className="text-slate-600"> / </span>` : ''}${a.name} <span className="text-slate-500 font-semibold text-sm">· ${a.alliance}</span></span>`)}</h3>
                <p className="text-sm text-slate-400">${plural(order.total_qty, 'aircraft')} · ${fmtUSD(order.total_usd)}</p>
            </div>
            <${StatusBadge} status=${displayStatus(order)} />
        </div>

        ${!closed && html`<${OrderStepper} order=${order} />`}

        ${handoff && html`<div className="flex items-center gap-3 p-3 rounded-2xl bg-amber-500/5 border border-amber-500/20 text-sm text-amber-100">
            <${Icon} name="repeat" className="w-4 h-4 text-amber-300" />
            <span className="flex-1">${order.filled} of ${plural(order.total_qty, 'aircraft')} are already delivered. Your seller couldn't finish, so the remaining ${order.total_qty - order.filled} went back to the seller team. Waiting for a new seller.</span>
        </div>`}

        ${order.status === 'PENDING' && !handoff && html`<div className="flex items-center gap-3 p-3 rounded-2xl bg-amber-500/5 border border-amber-500/20 text-sm text-amber-100">
            <${Icon} name="hourglass" className="w-4 h-4 text-amber-300" />
            <span className="flex-1">Sent to the seller team. Waiting for one of them to take it.</span>
            <${Button} variant="ghost" size="sm" busy=${busy} onClick=${cancel}>Cancel<//>
        </div>`}

        ${order.seller_airline_name && !closed && html`<div className="flex items-center gap-3 p-3 rounded-2xl bg-slate-950 border border-slate-800">
            <div className="w-9 h-9 rounded-xl bg-sky-400/10 text-sky-300 flex items-center justify-center"><${Icon} name="store" /></div>
            <div className="min-w-0 flex-1">
                <p className="label text-slate-500">Your seller</p>
                <p className="font-bold text-white truncate">${order.seller_airline_name} <span className="text-slate-400 font-medium text-sm">${order.seller_alliance ? `· ${order.seller_alliance}` : ''}</span></p>
                <p className="text-xs text-slate-400 flex items-center gap-1"><${DiscordLogo} className="w-3 h-3" /> ${order.seller_name}</p>
                ${orderAirlines(order).length > 1 && deliverableTo(order, order.seller_alliance).length > 0 && html`<p className="text-xs text-sky-300 mt-0.5">Delivers to ${deliverableTo(order, order.seller_alliance).map((a) => a.name).join(' or ')} (same alliance)</p>`}
            </div>
        </div>`}

        ${previous.length > 0 && !closed && html`<p className="text-xs text-slate-400 flex items-start gap-1.5">
            <${Icon} name="history" className="w-3.5 h-3.5 mt-px" />
            <span>Earlier: ${previous.map((p) => `${p.seller_airline_name} delivered ${p.delivered}`).join(' · ')}</span>
        </p>`}

        ${(['CLAIMED', 'PARTIAL', 'FULFILLED'].includes(order.status) || handoff) && html`<div className="space-y-3">
            <div>
                <div className="flex justify-between text-xs mb-1.5"><span className="text-slate-400">Delivered in-game</span><span className="font-bold text-white">${order.filled} / ${order.total_qty}</span></div>
                <${ProgressBar} value=${order.filled} max=${order.total_qty} />
            </div>
            ${items.length > 1 && html`<div className="pl-3 border-l-2 border-slate-800"><${ItemProgress} order=${order} /></div>`}
        </div>`}

        ${closed && html`<div className=${`p-3 rounded-2xl border text-sm ${order.status === 'DECLINED' ? 'bg-rose-500/5 border-rose-500/20 text-rose-100' : 'bg-slate-900 border-slate-800 text-slate-300'}`}>
            <p className="font-bold">${order.status === 'DECLINED' ? 'Declined by the seller team' : 'You cancelled this order'}</p>
            ${order.closed_reason && html`<p className="text-xs mt-0.5 opacity-80">${order.closed_reason}</p>`}
        </div>`}

        ${order.seller_note && html`<div className="p-3 rounded-2xl bg-slate-950 border border-slate-800">
            <p className="label text-slate-500 mb-1">Note from seller</p><p className="text-sm text-slate-200">${order.seller_note}</p>
        </div>`}

        <button onClick=${() => setOpen(!open)} className="w-full flex items-center justify-between text-xs font-bold text-slate-400 hover:text-white">
            <span>${open ? 'Hide details' : `Show details · ${plural(items.length, 'line')}`}</span>
            <${Icon} name=${open ? 'chevron-up' : 'chevron-down'} />
        </button>
        ${open && html`<div className="grid md:grid-cols-2 gap-4 pt-1">
            <div>
                <p className="label text-slate-500 mb-2">Aircraft</p>
                <ul className="space-y-1.5 text-sm">
                    ${items.map((it, i) => html`<li key=${i} className="flex justify-between gap-3">
                        <span className="text-slate-200 min-w-0"><b>${it.qty}×</b> ${it.model} <span className="text-slate-500">@ ${it.pricePercent}% · ${it.filled}/${it.qty} delivered</span>
                            ${it.note && html`<span className="block text-xs text-slate-500">“${it.note}”</span>`}</span>
                        <span className="text-slate-400 shrink-0">${fmtUSDShort(it.totalUSD)}</span>
                    </li>`)}
                </ul>
                ${order.buyer_note && html`<p className="text-xs text-slate-400 mt-3"><span className="text-slate-500">Your note:</span> ${order.buyer_note}</p>`}
            </div>
            <div>
                <p className="label text-slate-500 mb-2">Timeline</p>
                <ol className="space-y-2.5 border-l border-slate-800 pl-4">
                    ${[...events].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((e) => html`<li key=${e.id} className="relative">
                        <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-slate-600"></span>
                        <p className="text-sm text-slate-200">${e.message || e.kind}</p>
                        <p className="text-[11px] text-slate-500">${e.actor_name} · ${timeAgo(e.created_at)}</p>
                    </li>`)}
                    ${!events.length && html`<li className="text-xs text-slate-500">No updates yet.</li>`}
                </ol>
            </div>
        </div>`}
    </article>`;
}

// =========================================================================
//  Airlines
// =========================================================================
function AirlinesView({ session, airlines, orders, dataReady, defaultAirline, setDefaultAirlineId, onCreate, onEdit, setAirlines, alliances }) {
    if (!session) return html`<${SignInPrompt} what="create and manage your airline profiles" />`;
    if (!dataReady) return html`<div className="py-16 flex justify-center text-slate-500"><${Spinner} className="w-6 h-6" /></div>`;
    const full = airlines.length >= MAX_AIRLINES;

    const remove = async (a) => {
        const used = orders.filter((o) => o.airline_id === a.id).length;
        const ok = await ask({
            title: `Delete ${a.name}?`,
            message: used ? `Its ${plural(used, 'order')} will stay in your order history.` : 'This airline has no orders.',
            confirmLabel: 'Delete airline', danger: true
        });
        if (!ok) return;
        const { error } = await sb.from('airlines').delete().eq('id', a.id);
        if (error) return toast(dbError(error), 'error');
        setAirlines((list) => list.filter((x) => x.id !== a.id));
        toast(`${a.name} deleted.`);
    };

    return html`<section className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
            <div>
                <h2 className="text-2xl font-black tracking-tight text-white">Your airlines</h2>
                <p className="text-sm text-slate-400">Saved to your account, so they're on every device you sign in from. ${airlines.length} of ${MAX_AIRLINES} used.</p>
            </div>
            <${Button} icon="plus" disabled=${full} onClick=${onCreate}>${full ? 'Limit reached' : 'New airline'}<//>
        </div>

        ${!airlines.length ? html`<${EmptyState} icon="building-2" title="No airline profiles yet"
            text="Create one for each airline you run in the game. You'll pick which one an order is for at checkout."
            action=${html`<${Button} icon="plus" onClick=${onCreate}>Create your first airline<//>`} />`
        : html`<div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${airlines.map((a) => {
                const count = orders.filter((o) => o.airline_id === a.id).length;
                const isDefault = defaultAirline?.id === a.id;
                return html`<article key=${a.id} className=${`card p-4 ${isDefault ? 'border-sky-500/40' : ''}`}>
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <h3 className="font-extrabold text-white truncate">${a.name}</h3>
                            <p className="text-sm text-slate-400">${a.alliance} alliance · ${plural(count, 'order')}</p>
                        </div>
                        ${isDefault && html`<span className="shrink-0 text-[10px] font-black px-2 py-1 rounded-full bg-sky-400/15 text-sky-300">DEFAULT</span>`}
                    </div>
                    <div className="flex gap-1 mt-4">
                        ${!isDefault && html`<${Button} size="sm" variant="secondary" onClick=${() => { setDefaultAirlineId(a.id); toast(`${a.name} is now your default airline.`); }}>Make default<//>`}
                        <${Button} size="sm" variant="ghost" icon="pencil" onClick=${() => onEdit(a)}>Edit<//>
                        <${Button} size="sm" variant="ghost" icon="trash-2" className="ml-auto !text-slate-500 hover:!text-rose-300" onClick=${() => remove(a)} aria-label=${'Delete ' + a.name} />
                    </div>
                </article>`;
            })}
        </div>`}
    </section>`;
}

function AirlineForm({ state, alliances, count, userId, onClose, onSaved }) {
    const editing = state?.airline;
    const [name, setName] = useState('');
    const [alliance, setAlliance] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => { if (state) { setName(editing?.name || ''); setAlliance(editing?.alliance || ''); } }, [state]);
    if (!state) return null;

    const valid = name.trim().length >= 2 && alliance;
    const save = async (e) => {
        e?.preventDefault();
        if (!valid) return;
        setBusy(true);
        const row = { name: name.trim(), alliance };
        const res = editing
            ? await sb.from('airlines').update(row).eq('id', editing.id).select().single()
            : await sb.from('airlines').insert({ ...row, owner_id: userId }).select().single();
        setBusy(false);
        if (res.error) return toast(dbError(res.error), 'error');
        onSaved(res.data, !editing);
    };

    return html`<${Modal} open=${true} onClose=${onClose} title=${editing ? 'Edit airline' : 'New airline profile'} size="sm"
        subtitle=${editing ? null : `${count} of ${MAX_AIRLINES} used`}
        footer=${html`<${Button} variant="ghost" onClick=${onClose}>Cancel<//><${Button} busy=${busy} disabled=${!valid} onClick=${save}>${editing ? 'Save' : 'Create airline'}<//>`}>
        <form onSubmit=${save} className="space-y-4">
            <label className="block">
                <span className="field-label">Airline name</span>
                <input autoFocus value=${name} maxLength="60" onChange=${(e) => setName(e.target.value)} placeholder="e.g. Garuda Echo" className="input" />
            </label>
            <div>
                <p className="field-label">Alliance</p>
                <div className="grid grid-cols-3 gap-1.5">
                    ${alliances.map((al) => html`<button type="button" key=${al} onClick=${() => setAlliance(al)}
                        className=${`py-2.5 rounded-xl border text-sm font-bold ${alliance === al ? 'bg-white text-slate-950 border-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>${al}</button>`)}
                </div>
            </div>
        </form>
    <//>`;
}

// =========================================================================
//  Notifications
// =========================================================================
function NotificationsPanel({ open, inbox, lastSeen, account, setAccount, onClose, onOpenOrder }) {
    const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
    const [testing, setTesting] = useState(false);
    const [pushOn, setPushOn] = useState(false);
    const [pushBusy, setPushBusy] = useState(false);
    useEffect(() => { if (open) pushSubscription().then((sub) => setPushOn(Boolean(sub))).catch(() => {}); }, [open]);
    if (!open) return null;
    const togglePush = async () => {
        setPushBusy(true);
        try {
            if (pushOn) { await disablePush(); setPushOn(false); toast('Alerts turned off on this device.'); }
            else { await enablePush(); setPushOn(true); setPerm('granted'); toast("Alerts are on for this device. You'll get one when an order is fully delivered.", 'success'); }
        } catch (err) { toast(err.message, 'error'); } finally { setPushBusy(false); }
    };
    const testPush = async () => {
        setPushBusy(true);
        try { const r = await api('/api/push', { action: 'test' }); toast(r.message, 'success'); }
        catch (err) { toast(err.message, 'error'); } finally { setPushBusy(false); }
    };
    const enable = async () => { try { setPerm(await Notification.requestPermission()); } catch { /* ignore */ } };
    const dmOn = account?.dm_enabled !== false;
    const toggleDM = async () => {
        const next = !dmOn;
        setAccount((a) => a && { ...a, dm_enabled: next });
        const { error } = await sb.from('accounts').update({ dm_enabled: next }).eq('id', account.id);
        if (error) { setAccount((a) => a && { ...a, dm_enabled: !next }); toast(dbError(error), 'error'); }
    };
    const testDM = async () => {
        setTesting(true);
        try {
            const r = await api('/api/test-dm');
            setAccount((a) => a && { ...a, dm_status: 'ok' });
            toast(r.message, 'success');
        } catch (err) {
            if (/wouldn't let/.test(err.message)) setAccount((a) => a && { ...a, dm_status: 'blocked' });
            toast(err.message, 'error');
        } finally { setTesting(false); }
    };
    return html`<${Modal} open=${true} onClose=${onClose} title="Notifications" subtitle="Updates from sellers on your orders">
        ${CONFIG.DM_AVAILABLE && account && html`<div className="p-3 mb-3 rounded-2xl bg-slate-950 border border-slate-800 text-sm space-y-3">
            <div className="flex items-center gap-3">
                <span className="text-[#8b93ff]"><${DiscordLogo} /></span>
                <span className="flex-1 text-slate-300"><b className="text-white">Discord DMs</b><br />A DM from the Echo Market bot when your order is taken, delivered or declined.</span>
                <button role="switch" aria-checked=${dmOn} aria-label="Discord DMs" onClick=${toggleDM}
                    className=${`w-11 h-6 shrink-0 rounded-full relative transition-colors ${dmOn ? 'bg-sky-400' : 'bg-slate-700'}`}>
                    <span className=${`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${dmOn ? 'left-[22px]' : 'left-0.5'}`}></span>
                </button>
            </div>
            ${dmOn && account.dm_status === 'blocked' && html`<p className="text-xs text-amber-300 flex gap-1.5"><${Icon} name="triangle-alert" className="w-3.5 h-3.5 mt-px" />
                The bot couldn't DM you last time. Join the Echo Discord server and allow Direct Messages from that server (Server menu → Privacy Settings).</p>`}
            ${dmOn && html`<${Button} size="sm" variant="secondary" busy=${testing} onClick=${testDM}>Send me a test DM<//>`}
        </div>`}
        ${CONFIG.PUSH_AVAILABLE && html`<div className="p-3 mb-3 rounded-2xl bg-slate-950 border border-slate-800 text-sm space-y-3">
            <div className="flex items-center gap-3">
                <span className="text-sky-300"><${Icon} name="smartphone" className="w-5 h-5" /></span>
                <span className="flex-1 text-slate-300"><b className="text-white">Phone & browser alerts</b><br />An alert on this device when an order is fully delivered, even with Echo Market closed.</span>
                <button role="switch" aria-checked=${pushOn} aria-label="Phone and browser alerts" onClick=${togglePush} disabled=${pushBusy}
                    className=${`w-11 h-6 shrink-0 rounded-full relative transition-colors disabled:opacity-50 ${pushOn ? 'bg-sky-400' : 'bg-slate-700'}`}>
                    <span className=${`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${pushOn ? 'left-[22px]' : 'left-0.5'}`}></span>
                </button>
            </div>
            ${!pushSupported() && needsHomeScreen() && html`<p className="text-xs text-amber-300">On iPhone: tap Share → <b>Add to Home Screen</b>, open Echo Market from your Home Screen, then turn this on there.</p>`}
            ${perm === 'denied' && html`<p className="text-xs text-amber-300">Notifications are blocked for this site. Allow them in your browser's site settings, then turn this on.</p>`}
            ${pushOn && html`<${Button} size="sm" variant="secondary" busy=${pushBusy} onClick=${testPush}>Send me a test alert<//>`}
        </div>`}
        ${!CONFIG.PUSH_AVAILABLE && perm === 'default' && html`<div className="flex items-center gap-3 p-3 mb-4 rounded-2xl bg-slate-950 border border-slate-800 text-sm">
            <${Icon} name="bell-ring" className="w-5 h-5 text-sky-300" />
            <span className="flex-1 text-slate-300">Get a browser alert when a seller updates your order (while Echo Market is open in a tab).</span>
            <${Button} size="sm" onClick=${enable}>Enable<//>
        </div>`}
        ${!inbox.length ? html`<p className="text-sm text-slate-400 text-center py-8">No updates yet. You'll be notified here when a seller takes or delivers your order.</p>`
        : html`<ul className="divide-y divide-slate-800 -my-2">
            ${inbox.slice(0, 50).map((e) => html`<li key=${e.id}>
                <button onClick=${() => onOpenOrder(e.order_id)} className="w-full text-left py-3 flex gap-3 hover:bg-slate-800/40 rounded-xl px-2">
                    <span className=${`mt-1.5 w-2 h-2 rounded-full shrink-0 ${e.created_at > lastSeen ? 'bg-sky-400' : 'bg-transparent'}`}></span>
                    <span className="min-w-0">
                        <span className="block text-sm text-slate-200">${describeEvent(e)}</span>
                        <span className="block text-[11px] text-slate-500 mt-0.5">${e.actor_name} · ${timeAgo(e.created_at)}</span>
                    </span>
                </button>
            </li>`)}
        </ul>`}
    <//>`;
}

function SignInPrompt({ what }) {
    return html`<${EmptyState} icon="lock" title="Sign in to continue" text=${`Sign in with Discord to ${what}.`}
        action=${html`<${Button} variant="discord" onClick=${signInWithDiscord}><${DiscordLogo} className="w-4 h-4" /> Sign in with Discord<//>`} />`;
}

// =========================================================================
ReactDOM.createRoot(document.getElementById('root')).render(isConfigured ? html`<${App} />` : html`<${NotConfigured} />`);
