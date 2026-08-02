// app.js
// ---------------------------------------------------------------------------
// UI + map orchestration. Wires the controls, talks to Overpass/Nominatim,
// runs the reusable loop-finding pipeline (graph.js + loops.js) and draws the
// candidates on a Leaflet map. No framework, no build step.
// ---------------------------------------------------------------------------

import { fetchNetwork, geocode } from "./overpass.js";
import { buildGraph, extractFaces, haversine } from "./graph.js";
import { findLoops, milesToMeters, metersToMiles, surfaceLabel } from "./loops.js";
import { loopElevation, metersToFeet } from "./elevation.js";

const DEFAULT_VIEW = [40.7128, -74.006]; // fallback map center until located

// --- app state ------------------------------------------------------------
let map;
let resultsLayer;
let startMarker;
let start = null; // { lat, lon, label }
let overpassCache = { key: null, elements: null }; // last network response
let drawn = []; // [{ result, layer }]
let lastLoops = null; // ranked candidates from the most recent search
let lastMeta = null; // { targetMiles, tolMiles } for status text
let elevToken = 0; // invalidates in-flight elevation lookups on re-render

// --- element handles ------------------------------------------------------
const el = (id) => document.getElementById(id);

window.addEventListener("load", init);

function init() {
  map = L.map("map", { zoomControl: true }).setView(DEFAULT_VIEW, 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  resultsLayer = L.layerGroup().addTo(map);

  // Start-point controls
  el("geolocate").addEventListener("click", useMyLocation);
  el("address-form").addEventListener("submit", (e) => {
    e.preventDefault();
    useAddress();
  });

  // Distance presets vs. custom field are mutually exclusive.
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      el("distance-custom").value = "";
    });
  });
  el("distance-custom").addEventListener("input", () => {
    if (el("distance-custom").value.trim() !== "") {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
    }
  });

  el("find-loops").addEventListener("click", runPipeline);

  // Sort order, crossings cap and result count re-render the existing results
  // — no re-query needed.
  el("sort").addEventListener("change", applyAndRender);
  el("max-results").addEventListener("input", applyAndRender);
  el("max-crossings").addEventListener("input", applyAndRender);

  setStatus("Set a start point to begin.", "info");
}

// --- start point ----------------------------------------------------------
function useMyLocation() {
  if (!navigator.geolocation) {
    setStatus("This browser can't share a location — type an address instead.", "error");
    return;
  }
  setStatus("Getting your location…", "loading");
  navigator.geolocation.getCurrentPosition(
    (pos) => setStart(pos.coords.latitude, pos.coords.longitude, "Your location"),
    (err) => {
      const msg =
        err.code === err.PERMISSION_DENIED
          ? "Location permission denied — type an address instead."
          : "Couldn't get your location — type an address instead.";
      setStatus(msg, "error");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

async function useAddress() {
  const q = el("address-input").value;
  setStatus("Looking up address…", "loading");
  try {
    const hit = await geocode(q);
    setStart(hit.lat, hit.lon, hit.label);
  } catch (e) {
    setStatus(e.message || "Address lookup failed.", "error");
  }
}

function setStart(lat, lon, label) {
  start = { lat, lon, label };
  map.setView([lat, lon], 16);
  if (startMarker) startMarker.remove();
  startMarker = L.marker([lat, lon]).addTo(map).bindPopup("Start").openPopup();
  el("start-readout").textContent = label;
  el("find-loops").disabled = false;
  setStatus("Ready — choose a distance and find loops.", "info");
}

// --- pipeline -------------------------------------------------------------
function currentTargetMiles() {
  const custom = parseFloat(el("distance-custom").value);
  if (!Number.isNaN(custom) && custom > 0) return custom;
  const active = document.querySelector(".chip.is-active");
  return active ? parseFloat(active.dataset.miles) : 0.5;
}

async function runPipeline() {
  if (!start) return;

  const targetMiles = currentTargetMiles();
  const tolMiles = Math.max(0.02, parseFloat(el("tolerance").value) || 0.15);
  const radius = parseInt(el("radius").value, 10);
  const maxSurfaceTier = parseInt(el("max-surface").value, 10);
  const targetMeters = milesToMeters(targetMiles);
  const toleranceMeters = milesToMeters(tolMiles);

  el("find-loops").disabled = true;
  clearResults();

  try {
    // Cache the last Overpass response so tweaking distance/tolerance doesn't
    // re-query. The cache is keyed by location + radius only.
    const key = start.lat.toFixed(5) + "," + start.lon.toFixed(5) + "," + radius;
    let elements;
    if (overpassCache.key === key) {
      elements = overpassCache.elements;
    } else {
      setStatus("Querying the street network (Overpass can be slow)…", "loading");
      elements = await fetchNetwork(start.lat, start.lon, radius);
      overpassCache = { key, elements };
    }

    // Let the loading text paint before the synchronous graph work.
    setStatus("Analysing streets and finding loops…", "loading");
    await new Promise((r) => setTimeout(r, 20));

    const graph = buildGraph(elements);
    const faces = extractFaces(graph);
    lastLoops = findLoops(graph, faces, {
      targetMeters,
      toleranceMeters,
      maxSurfaceTier,
    });
    lastMeta = { targetMiles, tolMiles };

    applyAndRender();
  } catch (e) {
    setStatus(e.message || "Something went wrong.", "error");
  } finally {
    el("find-loops").disabled = false;
  }
}

// --- rendering ------------------------------------------------------------
// Applies the current sort + result-count choices to the last search and draws
// it. Re-runnable on its own so changing sort/count doesn't re-query the network.
function applyAndRender() {
  if (!lastLoops) return;
  clearResults();
  elevToken++; // cancel any elevation lookups still running for the old render

  const { targetMiles, tolMiles } = lastMeta;
  if (!lastLoops.length) {
    setStatus(
      `No loops near ${targetMiles} mi (±${tolMiles} mi). Try a wider tolerance or a bigger radius.`,
      "error"
    );
    return;
  }

  // Filter by how many crossings the runner will allow (default 0).
  const maxCross = crossingCap();
  const allowed = lastLoops.filter((l) => l.crossings <= maxCross);
  if (!allowed.length) {
    setStatus(
      `No loops within ${maxCross} crossing${maxCross === 1 ? "" : "s"}. ` +
        `Allow more crossings, widen the tolerance, or ease the street limit.`,
      "error"
    );
    return;
  }

  // Sort: "best" keeps the ranking from loops.js; "near" orders by how close
  // the loop is to the start point (nearest vertex).
  let ordered = allowed;
  if (el("sort").value === "near" && start) {
    ordered = allowed
      .map((l) => ({ l, d: distanceToStart(l) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.l);
  }

  // How many to show — blank/0 means all of them.
  const raw = parseInt(el("max-results").value, 10);
  const limit = Number.isFinite(raw) && raw > 0 ? raw : ordered.length;
  const top = ordered.slice(0, limit);
  const bounds = [];

  top.forEach((result, i) => {
    const color = loopColor(result);
    const layer = L.polyline(result.latlngs, {
      color,
      weight: 5,
      opacity: 0.85,
    }).addTo(resultsLayer);

    layer.bindPopup(popupHtml(result));
    layer.on("click", () => highlight(i));
    bounds.push(...result.latlngs);

    // List row (tapping it focuses the loop on the map).
    const miles = metersToMiles(result.distance).toFixed(2);
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML =
      `<span class="swatch" style="background:${color}"></span>` +
      `<span class="result-main"><strong>${miles} mi</strong>` +
      `<small>${crossingLabel(result)} · ${surfaceLabel(result.surfaceTier)}</small>` +
      `<small class="elev">${elevText(result)}</small></span>`;
    li.addEventListener("click", () => highlight(i));
    el("results").appendChild(li);

    drawn.push({ result, layer, elevSpan: li.querySelector(".elev") });
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });

  const zeros = allowed.filter((l) => l.crossings === 0).length;
  const shown =
    top.length < allowed.length
      ? `Showing ${top.length} of ${allowed.length}`
      : `Showing all ${allowed.length}`;
  setStatus(
    `Found ${allowed.length} loop${allowed.length === 1 ? "" : "s"}` +
      (zeros ? ` — ${zeros} with no crossings` : "") +
      `. ${shown}. Tap one for details.`,
    "info"
  );

  loadElevations(elevToken); // fill in each loop's climb, throttled
}

// Read the crossings cap (0–20), defaulting to 0.
function crossingCap() {
  const v = parseInt(el("max-crossings").value, 10);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(20, v);
}

// Shortest distance (m) from the start point to any vertex of a loop.
function distanceToStart(loop) {
  let best = Infinity;
  for (const [lat, lon] of loop.latlngs) {
    const d = haversine(start, { lat, lon });
    if (d < best) best = d;
  }
  return best;
}

function highlight(index) {
  drawn.forEach(({ layer }, i) => {
    layer.setStyle({ weight: i === index ? 8 : 5, opacity: i === index ? 1 : 0.5 });
    if (i === index) layer.bringToFront();
  });
  const { result, layer } = drawn[index];
  map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  layer.openPopup();
  // Reflect the selection in the list.
  document.querySelectorAll(".result-item").forEach((row, i) => {
    row.classList.toggle("is-active", i === index);
  });
}

function loopColor(result) {
  if (result.crossings === 0) return "#1f9d55"; // green: no crossings
  if (result.crossingCost <= 3) return "#e0a106"; // amber: quiet crossings
  return "#d24317"; // red: busier crossings
}

function crossingLabel(result) {
  if (result.crossings === 0) return "no crossings";
  const n = result.crossings;
  return `${n} crossing${n === 1 ? "" : "s"}`;
}

function popupHtml(result) {
  const miles = metersToMiles(result.distance).toFixed(2);
  const rows = [
    `<strong>${miles} mi</strong> loop`,
    result.crossings === 0
      ? "No street crossings"
      : `${result.crossings} crossing${result.crossings === 1 ? "" : "s"}`,
    `Runs on ${surfaceLabel(result.surfaceTier)}`,
    elevPopupLine(result),
  ];
  if (result.faceCount > 1) rows.push(`${result.faceCount} blocks`);
  return `<div class="popup">${rows.join("<br>")}</div>`;
}

// --- elevation ------------------------------------------------------------
// Short list-row label, e.g. "↑ 42 ft climb".
function elevText(result) {
  if (result.elev) return `↑ ${Math.round(metersToFeet(result.elev.gainM))} ft climb`;
  if (result.elevErr) return "elevation n/a";
  return "elevation…";
}

// Fuller popup line with the high/low range too.
function elevPopupLine(result) {
  if (result.elev) {
    const gain = Math.round(metersToFeet(result.elev.gainM));
    const range = Math.round(metersToFeet(result.elev.rangeM));
    return `↑ ${gain} ft climb (${range} ft between low and high)`;
  }
  if (result.elevErr) return "Elevation unavailable: " + result.elevErr;
  return "Elevation: loading…";
}

// Look up each drawn loop's climb, one at a time. Reports the outcome in the
// elevation note so a failure is visible instead of a silent "n/a". Bails out
// if a newer render supersedes this one.
async function loadElevations(token) {
  const pending = drawn.filter((it) => !it.result.elev && !it.result.elevErr);
  if (!pending.length) {
    updateElevNote(token);
    return;
  }
  setElevNote("Loading elevation…", "loading");

  let lastError = null;
  for (const item of drawn) {
    if (token !== elevToken) return;
    const r = item.result;
    if (!r.elev && !r.elevErr) {
      try {
        r.elev = await loopElevation(r.latlngs);
      } catch (e) {
        // Provider(s) failed — record the reason and mark every remaining loop
        // n/a rather than retrying a service that's clearly unavailable.
        lastError = e.message || String(e);
        if (token !== elevToken) return;
        for (const other of drawn) {
          if (!other.result.elev && !other.result.elevErr) {
            other.result.elevErr = lastError;
            updateElevDisplay(other);
          }
        }
        break;
      }
      if (token !== elevToken) return;
    }
    updateElevDisplay(item);
  }

  if (token !== elevToken) return;
  updateElevNote(token, lastError);
}

// Summarise the elevation outcome across the drawn loops.
function updateElevNote(token, lastError) {
  if (token !== elevToken) return;
  const okCount = drawn.filter((it) => it.result.elev).length;
  const errCount = drawn.filter((it) => it.result.elevErr).length;
  if (errCount && !okCount) {
    setElevNote("Couldn't load elevation: " + (lastError || "service unavailable"), "error");
  } else if (errCount) {
    setElevNote(`Elevation loaded for ${okCount}; ${errCount} unavailable.`, "info");
  } else if (okCount) {
    const src = drawn.find((it) => it.result.elev).result.elev.source;
    setElevNote(`Elevation via ${src}.`, "info");
  } else {
    setElevNote("", "info");
  }
}

function setElevNote(message, kind) {
  const node = el("elev-note");
  node.textContent = message;
  node.className = "readout elev-note-" + (kind || "info");
}

// Refresh a single loop's row + popup once its elevation is known.
function updateElevDisplay(item) {
  if (item.elevSpan) item.elevSpan.textContent = elevText(item.result);
  item.layer.setPopupContent(popupHtml(item.result));
}

function clearResults() {
  resultsLayer.clearLayers();
  drawn = [];
  el("results").innerHTML = "";
  setElevNote("", "info");
}

// --- status ---------------------------------------------------------------
function setStatus(message, kind) {
  const node = el("status");
  node.textContent = message;
  node.className = "status status-" + (kind || "info");
}
