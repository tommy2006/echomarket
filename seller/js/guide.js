// The seller guide (profile menu → Seller guide): every desk feature, one line each. It stays in English,
// like the market rules; a translated note says so. Keep docs/discord-guides/sellers-features.txt (the same
// guide as Discord posts) in step with this list.
export const GUIDE = [
    { title: 'Your desk', icon: 'user', items: [
        ['Sign-in', 'Discord sign-in; your seller role (Verified Seller, Ambassador, Lead Ambassador) lets you in automatically.'],
        ['Rank colour', "The desk's accent colour follows your rank."],
        ['Selling as', 'Profile picture → pick which of your airlines buyers see when you take an order.'],
        ['Tour & welcome', 'Profile picture → Show me around replays the tour; Seller welcome replays the intro.'],
        ['Seller guide', 'Profile picture → Seller guide opens this list.'],
        ['Language menu', 'Top bar; switches the desk to EN, ID, 中文, 한국어, বাংলা, हिन्दी, Tiếng Việt or Filipino.'],
        ['Greeting bar', 'Shows how many orders are waiting, the longest wait, and orders with new buyer messages (Show these orders).'],
        ['Live alerts', 'New orders, buyer messages and missing-plane reports pop up on the desk and as browser notifications.'],
        ['New-order meow', 'A soft meow plays when a new order comes in while the desk is open; profile picture → Meow for new orders turns it on or off.']
    ] },
    { title: 'Order lists', icon: 'list', items: [
        ['Tabs', 'Open queue, My orders, All orders.'],
        ['Search', 'Find by order number, airline, buyer or aircraft.'],
        ['Sort', 'Longest waiting, newest, or price (high/low).'],
        ['Filters', 'Status, alliance, aircraft types, number of aircraft, list value, only orders I delivered on, only orders with new buyer messages.'],
        ['Wait chips', 'How long an order has waited, been with a seller, or took to finish.'],
        ['Tags', 'SAME ALLIANCE AS BUYER / NO SHARED ALLIANCE, YOU PASSED, 2/5 PASSED, CAN TAKE OVER, NEW MESSAGES, MISSING PLANES REPORTED.'],
        ['Pink tags', 'CAUTION (buyer on the alert list), SUSPICIOUS / BLACKLISTED (flagged order).'],
        ['List value', 'Rough in-game cost of buying the planes new, next to what the buyer pays.']
    ] },
    { title: 'Working an order', icon: 'plane', items: [
        ['Take order', 'Claim an open order; the buyer is told who is delivering.'],
        ['Decline', "A pass for you only; the order stays open for the others (if you're the last seller, you decline it for good with a reason the buyer sees)."],
        ['Update delivery', 'Enter how many of each type you listed in-game; the buyer gets a DM.'],
        ['Seller note', 'A note pinned on the order that the buyer can see (e.g. listed at WIII).'],
        ['Release', 'Nothing delivered yet → back to the open queue.'],
        ['Pass on the rest', 'What you delivered stays counted; the rest goes back to the queue.'],
        ['Take over', '12 h after an order was taken and still unfinished, up to 3 other sellers can join and list part of it.'],
        ['Hand over', "The order's seller passes it to the first seller who took over."],
        ['Stop delivering', 'A seller who took over leaves; their count stays.'],
        ['Remind buyer', 'On completed orders you listed on, nudge the buyer to buy the planes (DM + market notice, optional message, once every 6 h).'],
        ['Flag', "Mark an order with a reason only sellers see; the buyer isn't told."],
        ['Buyer info', "Click the buyer's airline name for their Discord profile, ID, @mention, DM status, warnings/bans and all their orders."],
        ['Messages', 'Buyers can write to the seller team 24 h after ordering; reply from the order (they get a DM).'],
        ['Timeline & status history', 'Every step of the order, with who did what and when.']
    ] },
    { title: 'Missing planes & thefts', icon: 'shield-alert', items: [
        ['Missing-plane report', 'You get a DM when a buyer says planes listed for them were bought by someone else.'],
        ['Theft confirmed / Not a theft', 'Close the report on the order; the buyer sees your note.'],
        ['Warn culprits', 'Add one or more Discord IDs to warn them automatically, or choose Under investigation.'],
        ['Theft reports tab', 'Needs attention, Confirmed thefts, All reports; anyone can Identify & warn culprits later.'],
        ['Clear theft', 'The thief re-listed the planes for the buyer; their warning stays on record.'],
        ['Clear from record', 'Remove a wrong warning (sellers on that order and admins).'],
        ['Close investigation', "The culprit couldn't be identified."]
    ] },
    { title: 'Admins only', icon: 'shield', admin: true,
        note: 'Lead Ambassadors, Market Admins and sellers made admin by hand.', items: [
        ['Decline for all', 'Close any order for the whole team at once (spam, rule breaks); the buyer sees your reason.'],
        ['Delete', 'Remove an order forever.'],
        ['Alert reasons', 'See why a buyer is on the alert list on their CAUTION orders.'],
        ['Sellers tab', 'Leaderboard by orders taken and aircraft delivered (7/30/90 days or all time); click a seller for their orders.'],
        ['Alliances tab', 'Which alliances order the most: rankings, most popular aircraft, orders over time, order outcomes and who supplies whom.'],
        ['Moderation → Market ban', 'Ban a Discord account for 1 week, 1 month or permanently (all their airlines, DM + Market Banned role + log).'],
        ['Moderation → Lift ban', 'End a ban early.'],
        ['Moderation → Send message', 'An Information or Warning message to anyone by Discord ID (market notice + DM; warnings are logged).'],
        ['Moderation → Bot commands', 'Install/update the Discord slash commands and choose the ordering channel(s).'],
        ['Community → Announcements', 'A pop-up for every buyer plus a home banner until you delete it.'],
        ['Community → Alert list', 'Add a Discord ID with a private reason; their orders show CAUTION to sellers.'],
        ['Community → Budget rewards', "Raise a buyer's daily budget to Tier 1 ($25B) or Tier 2 ($40B), with an optional end date (boosters get Tier 3 automatically)."],
        ['/market in Discord', 'ban, unban, warn, message, info without opening the desk.']
    ] }
];
