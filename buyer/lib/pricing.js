// Server-side pricing. Prices sent by the browser are ignored — everything is
// recalculated here from aircraft_pricelist.json so nobody can edit their own price.
import { readFileSync } from 'fs';
import { HttpError } from './server.js';

// Price levels the alliance allows (percent of list price). 100% is intentionally not offered.
export const PRICE_LEVELS = [90, 80, 70, 60, 50];
export const DAILY_LIMIT_USD = 10_000_000_000;
export const MAX_LINES = 20;
export const MAX_QTY_PER_LINE = 500;

const PRICELIST = JSON.parse(readFileSync(new URL('../aircraft_pricelist.json', import.meta.url), 'utf8'));
// ICAO codes repeat across variants (A321neo/LR/XLR are all A21N), so the model name is the key.
const BY_MODEL = new Map(PRICELIST.map((a) => [a.model, a]));

export function priceItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, 'Your order is empty.');
    if (rawItems.length > MAX_LINES) throw new HttpError(400, `An order can contain at most ${MAX_LINES} lines.`);

    const items = rawItems.map((raw) => {
        const aircraft = BY_MODEL.get(raw?.model);
        if (!aircraft) throw new HttpError(400, `Unknown aircraft: ${raw?.model}`);
        const qty = Number(raw.qty);
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
            throw new HttpError(400, `Quantity for ${aircraft.model} must be between 1 and ${MAX_QTY_PER_LINE}.`);
        }
        const pricePercent = Number(raw.pricePercent);
        if (!PRICE_LEVELS.includes(pricePercent)) {
            throw new HttpError(400, `Price level must be one of ${PRICE_LEVELS.join('%, ')}%.`);
        }
        const pricePerUnitUSD = Math.round(aircraft.price * pricePercent / 100);
        return {
            model: aircraft.model,
            code: aircraft.code,
            family: aircraft.family,
            category: aircraft.category,
            listPriceUSD: aircraft.price,
            qty,
            pricePercent,
            pricePerUnitUSD,
            totalUSD: pricePerUnitUSD * qty,
            note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : ''
        };
    });

    return {
        items,
        totalQty: items.reduce((s, it) => s + it.qty, 0),
        totalUSD: items.reduce((s, it) => s + it.totalUSD, 0)
    };
}
