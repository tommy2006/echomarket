// GET /api/config — public browser settings, loaded by <script src="/api/config">.
// Only PUBLIC values go here: the publishable key is designed to be public; Row Level Security protects the data.
import { APP, SUPABASE_URL, SUPABASE_PUBLIC_KEY, BUYER_URL, SELLER_URL, DM_AVAILABLE } from '../lib/server.js';

export default function handler(req, res) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    const config = { APP, SUPABASE_URL, SUPABASE_ANON_KEY: SUPABASE_PUBLIC_KEY, BUYER_URL, SELLER_URL, DM_AVAILABLE };
    res.status(200).send(`window.ECHO_CONFIG = ${JSON.stringify(config)};`);
}
