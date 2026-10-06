// Tailwind settings shared by both apps (colours come from window.ECHO_THEME, set in each app's js/theme.js).
// Source of truth: shared/js/tailwind-config.js. Run "npm run sync" at the repo root after editing.
tailwind.config = {
    theme: {
        extend: {
            colors: window.ECHO_THEME,
            fontFamily: { sans: ['"Plus Jakarta Sans"', 'sans-serif'], mono: ['"JetBrains Mono"', 'monospace'] },
            minWidth: { 4: '1rem', 5: '1.25rem' },
            animation: {
                pop: 'pop .25s cubic-bezier(.175,.885,.32,1.275)',
                fade: 'fade .2s ease-out',
                'slide-in': 'slideIn .35s cubic-bezier(.16,1,.3,1)'
            },
            keyframes: {
                pop: { '0%': { transform: 'scale(.96)', opacity: 0 }, '100%': { transform: 'scale(1)', opacity: 1 } },
                fade: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
                slideIn: { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'translateX(0)' } }
            }
        }
    }
};
