# Reserve

Restaurant table booking that runs on the guest's own Claude through MCP.

**There is no AI inside this app.** No OpenAI, Anthropic or other AI keys, SDKs or calls exist anywhere in the code.
Claude does the thinking (understanding the request, choosing a table, confirming details).
The app does everything else: saving, editing, checking availability and keeping the floor plan live.

## What it does

| Page | Purpose |
| --- | --- |
| `/` Connect | Guest signs in with name and email, then gets a personal Claude connector link |
| `/book` Find a table | Pick date, time, guests and restaurant, then tap a vacant table. Updates live |
| `/confirmation?ref=XXXXXX` | Booking confirmation with a Cancel button |
| `/manager` Manager | Passcode-protected. Add, rename, resize, remove, block and free tables live, and cancel today's bookings |

A booking holds a table for 90 minutes. The database itself rejects overlapping bookings, so two people can never get the same table at the same time.

## Claude tools (MCP endpoint: `/mcp?key=<personal key>`)

- `search_restaurants` by area, cuisine and minimum rating
- `check_availability` for a date, time and party size
- `book_table` (a chosen table, or the smallest one that fits)
- `list_my_bookings`
- `cancel_booking`

Bookings made by Claude show as "booked by Claude" on the confirmation page, and the table turns grey for everyone instantly.

## Run locally

```
npm install
npm start          # http://localhost:3000
npm test           # 9 tests: 90-minute rule, overlaps, races, manager, MCP
```

## Deploy free on Render

1. Push this folder to a new GitHub repository.
2. On render.com choose New, then Blueprint (or New, then Web Service), and select the repository.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables: `NODE_VERSION=20`, `MANAGER_PASSCODE=manager123` (change it before sharing widely), `SESSION_SECRET` (any long random text)
3. When it is live, open your Render URL. That URL is the app reviewers use.

Notes for the free plan:
- The service sleeps when idle, so the first visit can take about 30 seconds. Open it once before sharing the link.
- The database is a file that resets when the service restarts or redeploys. The four demo restaurants and their tables are recreated automatically, but bookings and guests are cleared. Guests who saved an old connector link need to sign in again.

## Connect Claude (for the demo and for reviewers)

1. Open your live URL and sign in with a name and email.
2. Copy the connector link shown on the page.
3. In Claude, open Settings, then Connectors, then Add custom connector. Name it Reserve and paste the link.
4. In a new chat, turn the connector on and ask: "Find a table for 4 at a South Indian restaurant tomorrow at 8 pm and book it."
5. Watch the table turn grey on `/book`, and open the confirmation link Claude returns.

Custom connectors depend on your Claude plan, so check Settings, then Connectors on your account.

## Manager

Open `/manager` and enter the passcode (default `manager123`, set with `MANAGER_PASSCODE`). The passcode is checked on the server and is never sent to the browser.

## Files

- `server.js`: database, booking rules, REST API, live updates, MCP endpoint
- `public/`: the four pages and their scripts and styles
- `test/booking.test.js`: automated tests
