// GET /api/config — public browser settings, loaded by <script src="/api/config">.
// Only PUBLIC values go here: the publishable key is designed to be public; Row Level Security protects the data.
import { APP, SUPABASE_URL, SUPABASE_PUBLIC_KEY, BUYER_URL, SELLER_URL, DM_AVAILABLE, PUSH_AVAILABLE, VAPID_PUBLIC_KEY } from '../lib/server.js';

export default function handler(req, res) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    // Served from Vercel's edge cache (no function start-up on each page load). Each deployment has its own
    // cache, and env var changes need a redeploy anyway, so it never goes stale.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400');
    const config = { APP, SUPABASE_URL, SUPABASE_ANON_KEY: SUPABASE_PUBLIC_KEY, BUYER_URL, SELLER_URL, DM_AVAILABLE,
        PUSH_AVAILABLE, VAPID_PUBLIC_KEY: PUSH_AVAILABLE ? VAPID_PUBLIC_KEY : '' };
    res.status(200).send(`window.ECHO_CONFIG = ${JSON.stringify(config)};`);
}
