// Shared UI helpers used by the buyer app (buyer/js/app.js) and the seller desk (seller/js/seller.js).
// Colours: components use Tailwind's slate (surfaces/text) and sky (accent) names; each app's HTML
// redefines those palettes (buyer: dark navy space, seller: dark pink), so one set of classes serves both looks.
// Source of truth: shared/js/ui.js. Run "npm run sync" at the repo root after editing.
//
// We use React + htm (JSX-like tagged templates) straight from a CDN, so there is
// no build step: edit, push, Vercel deploys. Syntax cheat-sheet:
//   html`<div className="x" onClick=${fn}>${value}</div>`
//   html`<${Component} prop=${value} />`      (components need ${} around the name)
const { useState, useEffect, useMemo, useRef, useCallback } = React;
export { useState, useEffect, useMemo, useRef, useCallback };
export const html = htm.bind(React.createElement);

// ------------------------------------------------------------------ config
export const CONFIG = window.ECHO_CONFIG || {};
export const isConfigured = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
export const sb = isConfigured
    ? supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
    })
    : null;

export function signInWithDiscord() {
    return sb.auth.signInWithOAuth({
        provider: 'discord',
        options: { redirectTo: window.location.origin + window.location.pathname + window.location.hash }
    });
}

// Calls our own Vercel API with the user's Supabase session token.
export async function api(path, payload) {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload || {})
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON error page */ }
    if (!res.ok || !json?.ok) throw new Error(json?.error || `Request failed (HTTP ${res.status})`);
    return json;
}

export function dbError(err) {
    if (!err) return 'Something went wrong.';
    if (err.code === '23505') return 'You already have an airline with that name.';
    if (err.code === '23514') return 'Airline names must be 2–60 characters.';
    if (err.code === 'P0001') return err.message;
    return err.message || String(err);
}

// --------------------------------------------------------------- storage
// localStorage only holds per-device conveniences (cart, default airline).
// Anything important lives in Supabase.
export const store = {
    get(key, fallback) {
        try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
};

// -------------------------------------------------------------- formatting
export const fmtUSD = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
export function fmtUSDShort(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    return fmtUSD(v);
}
export const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
// 45m · 3h 12m · 2d 4h
export function fmtDuration(ms) {
    const m = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
    if (m < 1) return '<1m';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export function timeAgo(iso) {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); if (d < 30) return `${d} d ago`;
    return new Date(iso).toLocaleDateString();
}
export const plural = (n, word) => `${n} ${word}${n === 1 || word === 'aircraft' ? '' : 's'}`;

// ------------------------------------------------------------ order status
export const STATUS = {
    PENDING:   { label: 'Waiting for seller', short: 'Waiting',    tone: 'amber',   icon: 'hourglass' },
    CLAIMED:   { label: 'Seller assigned',    short: 'Taken',      tone: 'cyan',     icon: 'handshake' },
    PARTIAL:   { label: 'Delivering',         short: 'Delivering', tone: 'violet',  icon: 'truck' },
    FULFILLED: { label: 'Delivered',          short: 'Delivered',  tone: 'emerald', icon: 'circle-check' },
    CANCELLED: { label: 'Cancelled',          short: 'Cancelled',  tone: 'slate',   icon: 'circle-x' },
    DECLINED:  { label: 'Declined',           short: 'Declined',   tone: 'rose',    icon: 'ban' },
    // Not stored in the database: an open (PENDING) order with aircraft already delivered,
    // i.e. a seller passed on the rest. See displayStatus().
    HANDOFF:   { label: 'Partly delivered · needs seller', short: 'Needs seller', tone: 'amber', icon: 'repeat' }
};
// What an order counts against the 24h limit: its aircraft at 100% list price (see buyer/lib/pricing.js).
export function orderListValue(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    return items.reduce((s, it) => {
        if (Number(it.listPriceUSD) > 0) return s + Number(it.listPriceUSD) * (Number(it.qty) || 0);
        const pct = Number(it.pricePercent) || 100;
        return s + Math.round((Number(it.totalUSD) || 0) * 100 / pct);
    }, 0);
}
export const displayStatus = (order) => (order.status === 'PENDING' && order.filled > 0 ? 'HANDOFF' : order.status);

// Order lines with per-type delivery (same rules as orderItems() in lib/server.js):
// each line has "filled" and "locked"; older orders only have a total, spread over the lines.
export function orderLines(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const hasPerLine = items.some((it) => typeof it.filled === 'number');
    let rest = hasPerLine ? 0 : Number(order.filled) || 0;
    return items.map((it) => {
        let filled = Number(it.filled);
        if (!hasPerLine) { filled = Math.min(it.qty, rest); rest -= filled; }
        filled = Math.max(0, Math.min(it.qty, Math.floor(filled) || 0));
        return { ...it, filled, locked: Math.max(0, Math.min(filled, Math.floor(Number(it.locked)) || 0)) };
    });
}
export const ACTIVE_STATUSES = ['PENDING', 'CLAIMED', 'PARTIAL'];
export const CLOSED_STATUSES = ['CANCELLED', 'DECLINED'];

const TONES = {
    amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    cyan: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30',
    violet: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
    emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
    slate: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
    rose: 'bg-rose-500/10 text-rose-300 border-rose-500/30'
};
export const toneClass = (tone) => TONES[tone] || TONES.slate;

export function StatusBadge({ status }) {
    const meta = STATUS[status] || STATUS.PENDING;
    return html`<span className=${`inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-bold ${toneClass(meta.tone)}`}>
        <${Icon} name=${meta.icon} className="w-3.5 h-3.5" />${meta.label}
    </span>`;
}

// Sent → Taken → Delivering → Delivered
export function OrderStepper({ order }) {
    const steps = ['Sent', 'Seller assigned', 'Delivering', 'Delivered'];
    const reached = { PENDING: order.filled > 0 ? 2 : 0, CLAIMED: 1, PARTIAL: 2, FULFILLED: 3 }[order.status];
    if (reached === undefined) return null;
    return html`<ol className="flex items-center gap-1 text-[10px] sm:text-[11px] font-semibold">
        ${steps.map((s, i) => html`
            <li key=${s} className="flex items-center gap-1 flex-1 min-w-0">
                <span className=${`w-5 h-5 shrink-0 rounded-full flex items-center justify-center border ${i <= reached ? 'bg-sky-400 border-sky-400 text-slate-950' : 'border-slate-700 text-slate-500'}`}>
                    ${i < reached || order.status === 'FULFILLED' ? html`<${Icon} name="check" className="w-3 h-3" />` : i + 1}
                </span>
                <span className=${`truncate ${i <= reached ? 'text-slate-200' : 'text-slate-500'}`}>${s}</span>
                ${i < steps.length - 1 && html`<span className=${`h-px flex-1 min-w-2 ${i < reached ? 'bg-sky-400' : 'bg-slate-700'}`}></span>`}
            </li>`)}
    </ol>`;
}

// One small delivery bar per aircraft type (only useful when an order has 2+ types).
export function ItemProgress({ order, compact = false }) {
    const lines = orderLines(order);
    if (lines.length < 2) return null;
    return html`<ul className=${compact ? 'space-y-1.5' : 'space-y-2.5'}>
        ${lines.map((it, i) => html`<li key=${i}>
            <div className="flex justify-between gap-3 text-xs mb-1">
                <span className="text-slate-300 truncate">${it.model}</span>
                <span className=${`shrink-0 font-bold tabular-nums ${it.filled >= it.qty ? 'text-emerald-300' : 'text-slate-300'}`}>${it.filled}/${it.qty}</span>
            </div>
            <${ProgressBar} value=${it.filled} max=${it.qty} />
        </li>`)}
    </ul>`;
}

export function ProgressBar({ value, max }) {
    const pct = max ? Math.round((value / max) * 100) : 0;
    return html`<div className="h-2 rounded-full bg-slate-800 overflow-hidden">
        <div className=${`h-full rounded-full transition-all ${pct >= 100 ? 'bg-emerald-400' : 'bg-sky-400'}`} style=${{ width: pct + '%' }}></div>
    </div>`;
}

// ------------------------------------------------------------------- icons
const pascal = (name) => name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
export function Icon({ name, className = 'w-4 h-4' }) {
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current;
        const node = window.lucide?.icons?.[pascal(name)];
        if (!el || !node) return;
        const svg = lucide.createElement(node);
        svg.setAttribute('class', className);
        svg.setAttribute('aria-hidden', 'true');
        el.replaceChildren(svg);
    }, [name, className]);
    return html`<span ref=${ref} className="inline-flex shrink-0 items-center justify-center"></span>`;
}

// ------------------------------------------------------------------ toasts
const toastListeners = new Set();
let toastId = 0;
export function toast(message, kind = 'info') {
    const t = { id: ++toastId, message, kind };
    toastListeners.forEach((fn) => fn(t));
}
export function Toasts() {
    const [items, setItems] = useState([]);
    useEffect(() => {
        const add = (t) => {
            setItems((list) => [...list, t]);
            setTimeout(() => setItems((list) => list.filter((x) => x.id !== t.id)), t.kind === 'error' ? 7000 : 4500);
        };
        toastListeners.add(add);
        return () => toastListeners.delete(add);
    }, []);
    const style = {
        info: 'border-slate-700 bg-slate-900',
        success: 'border-emerald-500/40 bg-emerald-950',
        error: 'border-rose-500/40 bg-rose-950'
    };
    const icon = { info: 'info', success: 'circle-check', error: 'circle-alert' };
    return html`<div className="fixed z-[80] bottom-24 md:bottom-6 right-4 left-4 md:left-auto md:w-96 space-y-2 pointer-events-none" aria-live="polite">
        ${items.map((t) => html`<div key=${t.id} className=${`pointer-events-auto flex gap-3 items-start p-3.5 rounded-2xl border shadow-2xl animate-pop ${style[t.kind]}`}>
            <${Icon} name=${icon[t.kind]} className="w-5 h-5 mt-0.5" />
            <p className="text-sm font-medium leading-snug">${t.message}</p>
        </div>`)}
    </div>`;
}

// ------------------------------------------------------------------- modal
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);
    if (!open) return null;
    const width = { sm: 'md:max-w-md', md: 'md:max-w-lg', lg: 'md:max-w-2xl' }[size];
    return html`<div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center">
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade" onClick=${onClose}></div>
        <div role="dialog" aria-modal="true" className=${`relative w-full ${width} max-h-[92vh] flex flex-col bg-slate-900 border border-slate-800 rounded-t-3xl md:rounded-3xl shadow-2xl animate-pop`}>
            <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-800">
                <div className="min-w-0">
                    <h2 className="text-lg font-extrabold text-white">${title}</h2>
                    ${subtitle && html`<p className="text-xs text-slate-400 mt-0.5">${subtitle}</p>`}
                </div>
                <button onClick=${onClose} className="p-2 -m-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800" aria-label="Close">
                    <${Icon} name="x" className="w-5 h-5" />
                </button>
            </div>
            <div className="p-5 overflow-y-auto">${children}</div>
            ${footer && html`<div className="p-4 border-t border-slate-800 flex flex-wrap justify-end gap-2">${footer}</div>`}
        </div>
    </div>`;
}

// Promise-based confirm / text prompt (replaces window.confirm / prompt).
let dialogSetter = null;
export function ask({ title, message, confirmLabel = 'Confirm', danger = false, input = null }) {
    return new Promise((resolve) => dialogSetter?.({ title, message, confirmLabel, danger, input, resolve }));
}
export function DialogHost() {
    const [d, setD] = useState(null);
    const [text, setText] = useState('');
    useEffect(() => { dialogSetter = (v) => { setText(''); setD(v); }; return () => { dialogSetter = null; }; }, []);
    if (!d) return null;
    const close = (value) => { d.resolve(value); setD(null); };
    const needsText = d.input?.required && !text.trim();
    return html`<${Modal} open=${true} onClose=${() => close(false)} title=${d.title} size="sm"
        footer=${html`
            <${Button} variant="ghost" onClick=${() => close(false)}>Back<//>
            <${Button} variant=${d.danger ? 'danger' : 'primary'} disabled=${needsText}
                onClick=${() => close(d.input ? text.trim() : true)}>${d.confirmLabel}<//>`}>
        <p className="text-sm text-slate-300 leading-relaxed">${d.message}</p>
        ${d.input && html`<textarea autoFocus value=${text} onChange=${(e) => setText(e.target.value)} rows="3"
            placeholder=${d.input.placeholder || ''} className="mt-4 w-full input"></textarea>`}
    <//>`;
}

// ----------------------------------------------------------------- buttons
export function Button({ variant = 'primary', size = 'md', icon, busy, className = '', children, ...props }) {
    const variants = {
        primary: 'bg-sky-400 text-slate-950 hover:bg-sky-300',
        white: 'bg-white text-slate-950 hover:bg-slate-200',
        secondary: 'bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700',
        ghost: 'text-slate-300 hover:text-white hover:bg-slate-800',
        danger: 'bg-rose-500 text-[#fff] hover:bg-rose-400',
        discord: 'bg-[#5865F2] text-[#fff] hover:bg-[#4752C4]'
    };
    const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2.5 text-sm', lg: 'px-6 py-3.5 text-sm' };
    return html`<button ...${props} disabled=${props.disabled || busy}
        className=${`inline-flex items-center justify-center gap-2 rounded-full font-bold transition-all active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`}>
        ${busy ? html`<${Spinner} />` : icon && html`<${Icon} name=${icon} className="w-4 h-4" />`}
        ${children}
    </button>`;
}

export function DiscordLogo({ className = 'w-5 h-5' }) {
    return html`<svg className=${className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`;
}

export function Spinner({ className = 'w-4 h-4' }) {
    return html`<span className=${`${className} inline-block rounded-full border-2 border-current border-r-transparent animate-spin`}></span>`;
}

export function Avatar({ account, size = 'w-8 h-8' }) {
    const name = account?.display_name || account?.discord_username || '?';
    return account?.avatar_url
        ? html`<img src=${account.avatar_url} alt="" className=${`${size} rounded-full object-cover bg-slate-800`} referrerPolicy="no-referrer" />`
        : html`<span className=${`${size} rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold`}>${name[0]?.toUpperCase()}</span>`;
}

export function EmptyState({ icon, title, text, action }) {
    return html`<div className="text-center py-14 px-6 border border-dashed border-slate-800 rounded-3xl">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center mb-4">
            <${Icon} name=${icon} className="w-6 h-6 text-slate-400" />
        </div>
        <h3 className="font-extrabold text-white">${title}</h3>
        ${text && html`<p className="text-sm text-slate-400 mt-1 max-w-sm mx-auto">${text}</p>`}
        ${action && html`<div className="mt-5">${action}</div>`}
    </div>`;
}

export function NotConfigured() {
    return html`<div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
            <${Icon} name="plug-zap" className="w-10 h-10 mx-auto text-amber-300" />
            <h1 className="text-xl font-extrabold">Echo Market isn't connected yet</h1>
            <p className="text-sm text-slate-400">The server is missing its Supabase settings
                (<code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code> in this Vercel project → Settings → Environment Variables).
                Add them and redeploy. <a href="/api/health" className="underline">Open the setup checklist</a> to see what is missing.</p>
        </div>
    </div>`;
}

// Browser notification while a tab is open but in the background. Uses the service worker when
// the page has one (required on Android); "tag" makes a repeat of the same alert replace the old one.
export async function notifyBrowser(title, body, tag) {
    try {
        if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
        const reg = await navigator.serviceWorker?.getRegistration?.();
        if (reg) await reg.showNotification(title, { body, icon: 'echo_logo.png', tag });
        else new Notification(title, { body, icon: 'echo_logo.png', tag });
    } catch { /* some browsers throw */ }
}

// ------------------------------------------------------------ push alerts
// Phone / browser alerts that arrive even when the site is closed (buyer site only).
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// iPhones only allow alerts for sites added to the Home Screen.
export const needsHomeScreen = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;

function base64ToBytes(b64) {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
export async function pushSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
}
// Asks permission, subscribes this device and saves it on the server. Throws a readable error.
export async function enablePush() {
    if (!pushSupported()) throw new Error(needsHomeScreen()
        ? 'On iPhone, first add Echo Market to your Home Screen (Share → Add to Home Screen), then open it from there.'
        : "This browser doesn't support alerts.");
    if (!CONFIG.VAPID_PUBLIC_KEY) throw new Error('Phone alerts are not set up on this site yet.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Alerts are blocked. Allow notifications for this site in your browser settings, then try again.');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(CONFIG.VAPID_PUBLIC_KEY) }));
    await api('/api/push', { action: 'subscribe', subscription: sub.toJSON() });
    return sub;
}
export async function disablePush() {
    const sub = await pushSubscription();
    if (!sub) return;
    await api('/api/push', { action: 'unsubscribe', endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
}
