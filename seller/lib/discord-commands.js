// The Echo Market bot's slash commands, as registered in the Echo Alliances server
// (seller/api/admin/discord-commands.js). They are answered by the buyer site: buyer/api/discord/interactions.js.
const SUB = 1, STRING = 3, INTEGER = 4, USER = 6;
const GUILD_ONLY = { contexts: [0] };
const user = { type: USER, name: 'user', description: 'Who', required: true };

export const COMMANDS = [
    {
        name: 'market', description: 'Echo Market moderation (Market Admins only)', ...GUILD_ONLY,
        // "0" = hidden from everyone until allowed in Server Settings → Integrations → Echo Market (Market Admin).
        default_member_permissions: '0',
        options: [
            { type: SUB, name: 'ban', description: 'Ban someone from Echo Market', options: [
                user,
                { type: STRING, name: 'length', description: 'How long', required: true, choices: [
                    { name: '1 week', value: 'week' }, { name: '1 month', value: 'month' }, { name: 'Permanent', value: 'permanent' }] },
                { type: STRING, name: 'reason', description: 'Why (they will see it)', required: true, max_length: 500 }] },
            { type: SUB, name: 'unban', description: "Lift someone's market ban", options: [
                user, { type: STRING, name: 'note', description: 'Note for them (optional)', required: false, max_length: 300 }] },
            { type: SUB, name: 'warn', description: 'Send someone a formal market warning', options: [
                user, { type: STRING, name: 'message', description: 'The warning (they will see it)', required: true, max_length: 1500 }] },
            { type: SUB, name: 'message', description: 'Send someone an information message', options: [
                user, { type: STRING, name: 'message', description: 'The message', required: true, max_length: 1500 }] },
            { type: SUB, name: 'info', description: "Someone's bans, warnings and recent orders", options: [user] }
        ]
    },
    {
        name: 'airline', description: 'Your Echo Market airline profiles', ...GUILD_ONLY,
        options: [
            { type: SUB, name: 'create', description: 'Create an airline profile (up to 20)', options: [
                { type: STRING, name: 'name', description: 'Airline name', required: true, min_length: 2, max_length: 60 },
                { type: STRING, name: 'alliance', description: 'Alliance', required: true, autocomplete: true }] },
            { type: SUB, name: 'list', description: 'List your airline profiles' }
        ]
    },
    {
        name: 'order', description: 'Order aircraft on Echo Market', ...GUILD_ONLY,
        options: [
            { type: STRING, name: 'airline', description: 'Your airline to deliver to', required: true, autocomplete: true },
            { type: INTEGER, name: 'price', description: 'Price level: % of the in-game list price you pay', required: true,
                choices: [90, 80, 70, 60, 50].map((p) => ({ name: `${p}% (${100 - p}% off)`, value: p })) },
            { type: STRING, name: 'aircraft', description: 'Aircraft model (start typing its name)', required: true, autocomplete: true },
            { type: INTEGER, name: 'quantity', description: 'How many (1-500)', required: true, min_value: 1, max_value: 500 },
            { type: STRING, name: 'airline2', description: 'Also OK to deliver to (optional)', required: false, autocomplete: true },
            { type: STRING, name: 'airline3', description: 'Also OK to deliver to (optional)', required: false, autocomplete: true },
            { type: STRING, name: 'note', description: 'Note for the seller (optional)', required: false, max_length: 200 }
        ]
    }
];
