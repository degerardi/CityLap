// app.js
// ---------------------------------------------------------------------------
// UI + map orchestration. Wires the controls, talks to Overpass/Nominatim,
// runs the reusable loop-finding pipeline (graph.js + loops.js) and draws the
// candidates on a Leaflet map. No framework, no build step.
// ---------------------------------------------------------------------------

import { fetchNetwork, geocode } from "./overpass.js";
import { buildGraph, extractFaces, haversine } from "./graph.js";
import { findLoops, milesToMeters, metersToMiles } from "./loops.js";

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

  // Sort order and result count re-render the existing results — no re-query.
  el("sort").addEventListener("change", applyAndRender);
  el("max-results").addEventListener("input", applyAndRender);

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
    lastLoops = findLoops(graph, faces, { targetMeters, toleranceMeters });
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

  const { targetMiles, tolMiles } = lastMeta;
  if (!lastLoops.length) {
    setStatus(
      `No loops near ${targetMiles} mi (±${tolMiles} mi). Try a wider tolerance or a bigger radius.`,
      "error"
    );
    return;
  }

  // Sort: "best" keeps the ranking from loops.js; "near" orders by how close
  // the loop is to the start point (nearest vertex).
  let ordered = lastLoops;
  if (el("sort").value === "near" && start) {
    ordered = lastLoops
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

    const miles = metersToMiles(result.distance).toFixed(2);
    layer.bindPopup(popupHtml(miles, result));
    layer.on("click", () => highlight(i));
    drawn.push({ result, layer });
    bounds.push(...result.latlngs);

    // List row (tapping it focuses the loop on the map).
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML =
      `<span class="swatch" style="background:${color}"></span>` +
      `<span class="result-main"><strong>${miles} mi</strong>` +
      `<small>${crossingLabel(result)}</small></span>`;
    li.addEventListener("click", () => highlight(i));
    el("results").appendChild(li);
  });

  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });

  const zeros = lastLoops.filter((l) => l.crossings === 0).length;
  const shown =
    top.length < lastLoops.length
      ? `Showing ${top.length} of ${lastLoops.length}`
      : `Showing all ${lastLoops.length}`;
  setStatus(
    `Found ${lastLoops.length} loop${lastLoops.length === 1 ? "" : "s"}` +
      (zeros ? ` — ${zeros} with no crossings` : "") +
      `. ${shown}. Tap one for details.`,
    "info"
  );
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

function popupHtml(miles, result) {
  const rows = [
    `<strong>${miles} mi</strong> loop`,
    result.crossings === 0
      ? "No street crossings"
      : `${result.crossings} crossing${result.crossings === 1 ? "" : "s"}`,
  ];
  if (result.faceCount > 1) rows.push(`${result.faceCount} blocks`);
  return `<div class="popup">${rows.join("<br>")}</div>`;
}

function clearResults() {
  resultsLayer.clearLayers();
  drawn = [];
  el("results").innerHTML = "";
}

// --- status ---------------------------------------------------------------
function setStatus(message, kind) {
  const node = el("status");
  node.textContent = message;
  node.className = "status status-" + (kind || "info");
}
