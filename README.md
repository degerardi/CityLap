# CityLap

Find short running/walking **loops** of a target distance near you — right in
the browser. No backend, no database, no build step: plain HTML, CSS, and
vanilla JavaScript modules with [Leaflet](https://leafletjs.com/) and free
OpenStreetMap tiles.

## How it works

1. **Start point** — share your location (Geolocation API) or type an address,
   geocoded with [Nominatim](https://nominatim.openstreetmap.org/) (throttled to
   1 request/second per their usage policy).
2. **Controls** — target loop distance (0.25 / 0.5 / 1.0 mi presets or a custom
   value), a ± tolerance, a 1- or 2-mile search radius, how the results are
   sorted (best match / closest to the start), and how many to list.
3. **Street network** — the app queries the [Overpass API](https://overpass-api.de/)
   for `highway` ways (and their nodes) within the radius. The last response is
   cached, so changing distance/tolerance doesn't re-query.
4. **Loop finding** (`graph.js` + `loops.js`):
   - Build a **planar graph**: OSM nodes as vertices, street segments as edges.
   - Extract the graph's **minimal cycles (faces)** — the city blocks — with a
     half-edge face traversal, measuring each perimeter geodesically.
   - Return faces (and simply-connected unions of adjacent faces) whose
     perimeter is within `target ± tolerance`.
   - **Count crossings geometrically:** running the loop on its interior-side
     sidewalk, any street that points into the loop's interior is one you cross.
     A plain empty block scores 0; a block with a street cutting into it, a
     perimeter running straight through an intersection, or a merged loop that
     swallows a dividing street each register the crossing(s). Loops that would
     cross a primary road or bigger are excluded outright.
   - **Rank** them: zero-crossing block loops first, then by fewest crossings,
     penalising crossings by the OSM highway class of the street crossed
     (residential/living_street cheap; secondary expensive; primary and above
     excluded). Or sort by proximity to the start point.
5. **Map** — candidate loops are drawn as tappable polylines. Tap one for its
   distance and crossing count. Loading and error states are shown throughout
   (Overpass can be slow).

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup and CDN Leaflet |
| `style.css` | Mobile-first styling (works in mobile Safari) |
| `app.js` | UI, map, geolocation, orchestration |
| `overpass.js` | Overpass + Nominatim network calls |
| `graph.js` | Planar graph build + face extraction (reusable) |
| `loops.js` | Loop candidate assembly + ranking (reusable) |

The loop-finding logic (`graph.js`, `loops.js`) has no UI or map dependencies,
so it can be reused on its own.

## Running locally

It's a static site — serve the folder with any static file server (a plain
`file://` open won't allow ES module imports or geolocation):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploying to Render

Deploys as a **Render static site with no build command**. `render.yaml`
publishes the repository root directly; or create a Static Site in the Render
dashboard with an empty build command and `.` as the publish directory.
