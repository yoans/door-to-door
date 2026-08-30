# Wagon Popcorn

Phone-friendly map for door-to-door popcorn in **Timberview & Blooming Heights**, Norwalk, Iowa. Tap a lot, color it, keep wagon stock. Everything stays in this browser’s local storage.

**Live:** https://yoans.github.io/door-to-door/

## Run it locally

Needs a tiny local server so the lot file can load:

```bash
python -m http.server 8765
```

Then open `http://localhost:8765` on the computer, or `http://YOUR-LAN-IP:8765` on a phone on the same Wi‑Fi. Add to the home screen if you want it to feel like an app.

## On the route

- **Open** — not visited yet
- **Answered** — someone came to the door; maybe later
- **Bought** — sale; optional +/− pulls from wagon stock
- **No** — not interested
- **Not home** — come back
- Notes stick to the lot
- ◎ follows your GPS
- Filters: still out, come back, bought, no
- ⋯ menu can download a JSON backup or reset the map

## Another neighborhood later

Lot lines are a snapshot of public Warren County parcels (same source Beacon uses). To swap areas:

```bash
python scripts/fetch-parcels.py --bbox WEST,SOUTH,EAST,NORTH --name my-neighborhood
```

Then update `NEIGHBORHOOD.center` in `app.js` if the new area is far from Norwalk.
