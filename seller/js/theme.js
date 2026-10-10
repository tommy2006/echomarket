// Seller theme: black and white, with a pink accent whose tint depends on the signed-in seller's rank:
//   Lead Ambassador → bright pink · Ambassador → softer pink · Verified Seller → light pink-purple (orchid)
//   Admin (added by hand, no seller role on Discord) → black and white, with a soft white aurora
// "slate" (surfaces/text, greys) is fixed; "sky" (the accent the shared components use) points at CSS
// variables, which window.setSellerTint(rank) switches at runtime. The stars and the faint aurora behind
// the content are in the <style> block of seller.html and follow the same variables.
(function () {
    const hexes = {
        lead:       ['#FDF2F8', '#FCE7F3', '#FBCFE8', '#F9A8D4', '#F472B6', '#EC4899', '#DB2777', '#BE185D', '#9D174D', '#831843', '#500724'],
        ambassador: ['#FDF4F8', '#FBE8F1', '#F7D0E3', '#F1B3D0', '#E996BD', '#DB78A6', '#C25C8C', '#A04772', '#7F395B', '#642F49', '#3B1729'],
        verified:   ['#FBF5FE', '#F6E9FC', '#EDD3F8', '#E1B4F2', '#D28FE8', '#BE6BD9', '#A24FBE', '#853F9C', '#6C357E', '#592E66', '#391540'],
        admin:      ['#FFFFFF', '#FFFFFF', '#FAFAFA', '#F4F4F5', '#E4E4E7', '#D4D4D8', '#A1A1AA', '#71717A', '#52525B', '#3F3F46', '#27272A']
    };
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
    // Exposed for the leaderboard: each rank's own colour, whoever is looking.
    window.ECHO_RANK_COLORS = Object.fromEntries(Object.entries(hexes).map(([r, h]) => [r, { text: h[3], bar: h[4], soft: h[5] }]));

    window.setSellerTint = function (rank) {
        const palette = hexes[rank] || hexes.lead;
        const root = document.documentElement;
        steps.forEach((step, i) => root.style.setProperty(`--sky-${step}`, rgb(palette[i])));
        root.dataset.rank = hexes[rank] ? rank : 'lead';
        try { localStorage.setItem('echo_seller_tint', root.dataset.rank); } catch { /* private mode */ }
    };
    // Start with the last tint used on this device, so the page doesn't flash another colour.
    let last = null;
    try { last = localStorage.getItem('echo_seller_tint'); } catch { /* private mode */ }
    window.setSellerTint(last || 'lead');

    window.ECHO_THEME = {
        page: '#000000',
        slate: { 50: '#FAFAFA', 100: '#F4F4F5', 200: '#E4E4E7', 300: '#D4D4D8', 400: '#A1A1AA', 500: '#71717A',
                 600: '#52525B', 700: '#3F3F46', 800: '#27272A', 900: '#18181B', 950: '#0A0A0B' },
        sky: Object.fromEntries(steps.map((step) => [step, `rgb(var(--sky-${step}) / <alpha-value>)`]))
    };
})();
