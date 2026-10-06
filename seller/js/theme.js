// Seller theme: black and white, with pink as the accent. Redefines "slate" (surfaces/text, greys)
// and "sky" (accent, pink) so the shared components change without touching the JS.
// The stars and the faint pink aurora behind the content are in the <style> block of seller.html.
window.ECHO_THEME = {
    page: '#000000',
    slate: { 50: '#FAFAFA', 100: '#F4F4F5', 200: '#E4E4E7', 300: '#D4D4D8', 400: '#A1A1AA', 500: '#71717A',
             600: '#52525B', 700: '#3F3F46', 800: '#27272A', 900: '#18181B', 950: '#0A0A0B' },
    sky:   { 50: '#FDF2F8', 100: '#FCE7F3', 200: '#FBCFE8', 300: '#F9A8D4', 400: '#F472B6', 500: '#EC4899',
             600: '#DB2777', 700: '#BE185D', 800: '#9D174D', 900: '#831843', 950: '#500724' }
};
