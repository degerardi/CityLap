// elevation.js
// ---------------------------------------------------------------------------
// The Overpass/OSM highway data has no elevation — nodes are just lat/lon — so
// we look it up separately from free, key-less, CORS-enabled elevation APIs.
//
// For robustness we try more than one provider and fall back on failure:
//   1. Open-Meteo  (https://open-meteo.com/en/docs/elevation-api) — reliable,
//      browser-CORS, up to 100 coordinates per request, no key.
//   2. OpenTopoData (https://www.opentopodata.org/) global `mapzen` terrain —
//      backup if Open-Meteo is unreachable.
//
// Public limits are ~100 locations/request, so we sample each loop to <=100
// points. Elevations are in meters. Errors are thrown (with a readable message)
// so the caller can report them rather than failing silently.
// ---------------------------------------------------------------------------

const MAX_POINTS = 100;
const TIMEOUT_MS = 12000;

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

// fetch with a hard timeout so a hung request can't stall the UI.
async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("timed out");
    throw new Error("network error"); // usually a CORS/offline failure
  } finally {
    clearTimeout(timer);
  }
}

// --- providers: each takes sampled points and returns an array of meters -----

async function fromOpenMeteo(pts) {
  const lat = pts.map((p) => p[0].toFixed(6)).join(",");
  const lon = pts.map((p) => p[1].toFixed(6)).join(",");
  const url =
    "https://api.open-meteo.com/v1/elevation" +
    `?latitude=${lat}&longitude=${lon}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Open-Meteo HTTP " + res.status);
  const data = await res.json();
  if (!Array.isArray(data.elevation)) throw new Error("Open-Meteo: no data");
  return data.elevation;
}

async function fromOpenTopoData(pts) {
  const locs = pts.map((p) => `${p[0]},${p[1]}`).join("|");
  const url =
    "https://api.opentopodata.org/v1/mapzen" +
    `?locations=${encodeURIComponent(locs)}`;
  const res = await fetchWithTimeout(url);
  if (res.status === 429) throw new Error("OpenTopoData: rate-limited");
  if (!res.ok) throw new Error("OpenTopoData HTTP " + res.status);
  const data = await res.json();
  if (data.status !== "OK" || !Array.isArray(data.results)) {
    throw new Error("OpenTopoData: no data");
  }
  return data.results.map((r) => r.elevation);
}

const PROVIDERS = [fromOpenMeteo, fromOpenTopoData];

// --- public API ------------------------------------------------------------

// Look up a loop's elevation and summarise the climb along it.
// Returns { gainM, lossM, minM, maxM, rangeM, source }. Throws with a readable
// message (listing what each provider reported) if none succeed.
export async function loopElevation(latlngs) {
  const pts = sample(latlngs);
  const problems = [];

  for (const provider of PROVIDERS) {
    let eles;
    try {
      eles = await provider(pts);
    } catch (e) {
      problems.push(e.message || String(e));
      continue;
    }
    const clean = eles.filter((e) => typeof e === "number" && isFinite(e));
    if (clean.length < 2) {
      problems.push(provider.name + ": incomplete data");
      continue;
    }
    return summarise(clean, provider === fromOpenMeteo ? "Open-Meteo" : "OpenTopoData");
  }

  throw new Error(problems.join("; ") || "no elevation provider available");
}

// Walk the closed loop, summing ups and downs.
function summarise(eles, source) {
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
  return { gainM, lossM, minM, maxM, rangeM: maxM - minM, source };
}

export function metersToFeet(m) {
  return m * 3.28084;
}
