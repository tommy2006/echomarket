// Tailwind settings for building buyer/css/app.css and seller/css/app.css (scripts/build-css.mjs).
// One source of truth with the browser: the shared settings come from shared/js/tailwind-config.js and each
// app's colours from its js/theme.js (window.ECHO_THEME), read here in a small sandbox.
// Run from the repo root: content paths are relative to it.
const { readFileSync } = require('fs');
const { join } = require('path');
const vm = require('vm');

const ROOT = join(__dirname, '..');

function run(file, extra = {}) {
    const style = { setProperty() {} };
    const ctx = {
        tailwind: {},
        localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: { style, dataset: {} } },
        ...extra
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync(join(ROOT, file), 'utf8'), ctx);
    return ctx;
}

module.exports = function configFor(app) {
    const theme = run(`${app}/js/theme.js`).ECHO_THEME;
    const shared = run('shared/js/tailwind-config.js', { ECHO_THEME: theme }).tailwind.config;
    return {
        ...shared,
        content: [`${app}/${app === 'buyer' ? 'index' : 'seller'}.html`, `${app}/js/**/*.js`, 'shared/js/**/*.js']
    };
};
