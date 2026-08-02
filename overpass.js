// overpass.js
// ---------------------------------------------------------------------------
// Network access: OpenStreetMap geocoding (Nominatim) and the highway network
// (Overpass). Both support CORS from the browser, so no backend is needed.
// ---------------------------------------------------------------------------

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// --- Nominatim ------------------------------------------------------------
// Usage policy: at most 1 request/second and a meaningful query. We serialise
// requests and space them out to stay under the limit.
let lastGeocodeAt = 0;
function throttle() {
  const wait = Math.max(0, 1000 - (Date.now() - lastGeocodeAt));
  return new Promise((r) => setTimeout(r, wait));
}

// Geocode a free-text address/place to { lat, lon, label }.
export async function geocode(query) {
  const q = query.trim();
  if (!q) throw new Error("Enter an address to search for.");
  await throttle();
  lastGeocodeAt = Date.now();

  const url =
    NOMINATIM_URL +
    "?format=json&limit=1&addressdetails=0&q=" +
    encodeURIComponent(q);

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Geocoding failed (" + res.status + ").");
  const data = await res.json();
  if (!data.length) throw new Error("No match found for that address.");
  const hit = data[0];
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    label: hit.display_name,
  };
}

// --- Overpass -------------------------------------------------------------
// Fetch every `highway` way (and its nodes) within `radius` meters of a point.
//   way["highway"](around:R,lat,lon);  -> matching ways
//   (._;>;);                           -> recurse down to the ways' nodes
//   out body;                          -> emit ways + nodes with coordinates
export async function fetchNetwork(lat, lon, radius) {
  const query = `[out:json][timeout:60];
way["highway"](around:${radius},${lat},${lon});
(._;>;);
out body;`;

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });

  if (res.status === 429 || res.status === 504) {
    throw new Error("Overpass is busy right now — please try again in a moment.");
  }
  if (!res.ok) throw new Error("Overpass request failed (" + res.status + ").");

  const data = await res.json();
  if (!data.elements || !data.elements.length) {
    throw new Error("No streets found here — try a larger radius.");
  }
  return data.elements;
}
