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
- Cloud icon → Firebase **Spark (no-cost)** live sync. Do not add billing or upgrade to Blaze. If a free cap is hit, sync stops; this phone still works.
- ⋯ **Copy share link** is a one-time snapshot if you are not using cloud

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
