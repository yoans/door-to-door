# Wagon Popcorn

Phone-friendly map for door-to-door popcorn in **Timberview & Blooming Heights**, Norwalk, Iowa. Tap a house, color it. Status is saved in this browser.

**Live:** https://yoans.github.io/door-to-door/

## On the route

- **Open** — not visited yet
- **Come back later** — talked, try again later
- **Bought** — sale
- **No** — not interested
- **Not home** — come back
- Notes stick to the house
- ◎ follows your GPS
- Filters: still out, come back, bought, no
- ⋯ **Copy share link** texts the current map to another phone. That phone opens the link and picks up the colors. It is a snapshot, not live two-way sync.

## Run it locally

```bash
python -m http.server 8765
```

Then open `http://localhost:8765`.

## Another neighborhood later

```bash
python scripts/fetch-parcels.py --bbox WEST,SOUTH,EAST,NORTH --name my-neighborhood
```

Then update `NEIGHBORHOOD.center` in `app.js`.
