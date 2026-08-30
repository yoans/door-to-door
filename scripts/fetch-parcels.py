"""Download Warren County lots for a neighborhood bbox and write data/parcels.geojson.

Default bbox is Timberview & Blooming Heights, Norwalk, north of G14.
To cover a new area, pass --bbox west,south,east,north in WGS84.
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "parcels.geojson"

PARCEL_URL = (
    "https://maps.dsm.city/p2/rest/services/External/"
    "EXTDynamicShowMeMyHouse/MapServer/18/query"
)

DEFAULT_BBOX = (-93.7276, 41.48295, -93.7123, 41.49045)


def geom_area_acres(geom: dict) -> float:
    def to_m(lon: float, lat: float) -> tuple[float, float]:
        return ((lon + 93.72) * 111000 * 0.748, (lat - 41.486) * 111000)

    def poly_area(poly: list) -> float:
        pts = [to_m(x, y) for x, y in poly[0]]
        area = 0.0
        for i in range(len(pts) - 1):
            area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
        return abs(area) / 2

    coords = geom["coordinates"]
    meters = (
        poly_area(coords)
        if geom["type"] == "Polygon"
        else sum(poly_area(poly) for poly in coords)
    )
    return meters / 4046.86


def centroid(geom: dict) -> tuple[float, float]:
    ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
    xs = [c[0] for c in ring]
    ys = [c[1] for c in ring]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def perp_dist(point, start, end) -> float:
    x, y = point
    x1, y1 = start
    x2, y2 = end
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def douglas_peucker(points: list, tolerance: float) -> list:
    if len(points) <= 2:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        farthest, index = -1.0, None
        for k in range(i + 1, j):
            distance = perp_dist(points[k], points[i], points[j])
            if distance > farthest:
                farthest, index = distance, k
        if index is not None and farthest > tolerance:
            keep[index] = True
            stack.append((i, index))
            stack.append((index, j))
    return [point for point, flagged in zip(points, keep) if flagged]


def simplify_ring(ring: list, tolerance: float = 0.000012) -> list:
    if len(ring) <= 4:
        return ring
    closed = ring[0] == ring[-1]
    points = ring[:-1] if closed else ring[:]
    simplified = douglas_peucker(points, tolerance)
    if len(simplified) < 3:
        return ring
    if closed:
        simplified.append(simplified[0])
    return simplified


def simplify_geom(geom: dict) -> dict:
    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": [simplify_ring(ring) for ring in geom["coordinates"]]}
    return {
        "type": "MultiPolygon",
        "coordinates": [[simplify_ring(ring) for ring in poly] for poly in geom["coordinates"]],
    }


def fetch_bbox(west: float, south: float, east: float, north: float) -> dict:
    query = {
        "geometry": f"{west},{south},{east},{north}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "PIN,ParcelId,Hyperlink",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    url = f"{PARCEL_URL}?{urllib.parse.urlencode(query)}"
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def filter_lots(raw: dict, bbox: tuple[float, float, float, float], min_acres: float, max_acres: float) -> list:
    west, south, east, north = bbox
    features = []
    for feature in raw.get("features", []):
        lon, lat = centroid(feature["geometry"])
        acres = geom_area_acres(feature["geometry"])
        if not (west <= lon <= east and south <= lat <= north):
            continue
        if not (min_acres <= acres < max_acres):
            continue
        pin = feature["properties"]["PIN"]
        features.append(
            {
                "type": "Feature",
                "id": pin,
                "properties": {"id": pin, "pin": pin, "acres": round(acres, 3)},
                "geometry": simplify_geom(feature["geometry"]),
            }
        )
    return features


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bbox", default=",".join(str(value) for value in DEFAULT_BBOX), help="west,south,east,north")
    parser.add_argument("--min-acres", type=float, default=0.12)
    parser.add_argument("--max-acres", type=float, default=5.0)
    parser.add_argument("--name", default="timberview-blooming-heights")
    args = parser.parse_args()
    bbox = tuple(float(part) for part in args.bbox.split(","))
    if len(bbox) != 4:
        raise SystemExit("bbox must be west,south,east,north")

    raw = fetch_bbox(*bbox)
    features = filter_lots(raw, bbox, args.min_acres, args.max_acres)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "name": args.name, "features": features}, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(features)} lots to {OUT}")


if __name__ == "__main__":
    main()
