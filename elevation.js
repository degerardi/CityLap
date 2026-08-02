// elevation.js
// ---------------------------------------------------------------------------
// The Overpass/OSM highway data has no elevation — nodes are just lat/lon — so
// we look elevation up separately from a free, key-less, CORS-enabled service
// (OpenTopoData, global `mapzen` terrain). Public limits: 100 locations per
// request, 1 request/second, 1000/day, so we sample each loop to <=100 points
// and throttle. Elevations are returned in meters.
// ---------------------------------------------------------------------------

const API = "https://api.opentopodata.org/v1/mapzen";
const MAX_POINTS = 100;

let lastCall = 0;
async function throttle() {
  const wait = Math.max(0, 1000 - (Date.now() - lastCall));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

// Evenly sample down to MAX_POINTS points (dropping a repeated closing vertex).
function sample(latlngs) {
  const pts = latlngs.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
  if (pts.length <= MAX_POINTS) return pts;
  const out = [];
  const step = pts.length / MAX_POINTS;
  for (let i = 0; i < MAX_POINTS; i++) out.push(pts[Math.floor(i * step)]);
  return out;
}

// Fetch elevations for a loop and summarise the climb along it.
// Returns { gainM, lossM, minM, maxM, rangeM } in meters.
export async function loopElevation(latlngs) {
  const pts = sample(latlngs);
  await throttle();

  const locs = pts.map((p) => `${p[0]},${p[1]}`).join("|");
  // Fail fast if the service hangs, so the UI doesn't wait forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    res = await fetch(`${API}?locations=${encodeURIComponent(locs)}`, {
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new Error("Elevation service is rate-limited.");
  if (!res.ok) throw new Error("Elevation lookup failed (" + res.status + ").");

  const data = await res.json();
  if (data.status !== "OK" || !data.results) {
    throw new Error("Elevation unavailable here.");
  }
  const eles = data.results.map((r) => r.elevation).filter((e) => e != null);
  if (eles.length < 2) throw new Error("No elevation data here.");

  // Walk the closed loop, summing ups and downs.
  const seq = eles.concat(eles[0]);
  let gainM = 0;
  let lossM = 0;
  let minM = Infinity;
  let maxM = -Infinity;
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    if (e < minM) minM = e;
    if (e > maxM) maxM = e;
    if (i > 0) {
      const d = seq[i] - seq[i - 1];
      if (d > 0) gainM += d;
      else lossM -= d;
    }
  }
  return { gainM, lossM, minM, maxM, rangeM: maxM - minM };
}

export function metersToFeet(m) {
  return m * 3.28084;
}
