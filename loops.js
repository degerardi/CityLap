// loops.js
// ---------------------------------------------------------------------------
// Loop finding + ranking, kept independent of the map/UI so it can be reused.
//
// Two kinds of candidate loops are produced:
//
//   * Single faces      — one city block. You run its perimeter, crossing
//                          nothing, so crossings = 0. These are the ideal loops.
//   * Merged regions     — a simply-connected union of adjacent blocks. Merging
//                          two blocks dissolves the street they shared; that
//                          street now runs through the loop, so each dissolved
//                          interior edge is one "crossing". Crossings are scored
//                          by the OSM highway class of the street crossed.
//
// Public API:
//   findLoops(graph, faces, { targetMeters, toleranceMeters }) -> ranked[]
//   rankLoops(candidates) -> ranked[]
// ---------------------------------------------------------------------------

import { haversine, edgeKey } from "./graph.js";

// Cost of crossing a street, by OSM `highway` class. Quiet streets are cheap;
// bigger roads are expensive; primary and above are excluded (never crossed).
const HIGHWAY_WEIGHTS = {
  path: 1, footway: 1, pedestrian: 1, steps: 1, cycleway: 1, track: 1,
  bridleway: 1, living_street: 1, residential: 1, service: 1,
  unclassified: 1, road: 1,
  tertiary: 3, tertiary_link: 3,
  secondary: 6, secondary_link: 6,
  primary: Infinity, primary_link: Infinity,
  trunk: Infinity, trunk_link: Infinity,
  motorway: Infinity, motorway_link: Infinity,
};

function classWeight(klass) {
  const w = HIGHWAY_WEIGHTS[klass];
  return w === undefined ? 2 : w; // unknown class: mildly discouraged
}

// An edge may carry several classes (overlapping ways). Crossing it costs the
// cheapest of them; Infinity means "do not cross".
function edgeCrossWeight(graph, key) {
  const set = graph.edgeClasses.get(key);
  if (!set) return 2;
  let w = Infinity;
  for (const k of set) w = Math.min(w, classWeight(k));
  return w;
}

// How busy a street is to *run along* (its surface), as a tier:
//   0 quiet (residential, living_street, footway, path, cycleway, service, …)
//   1 tertiary        2 secondary        3 primary / trunk / motorway
const SURFACE_TIER = {
  path: 0, footway: 0, pedestrian: 0, steps: 0, cycleway: 0, track: 0,
  bridleway: 0, living_street: 0, residential: 0, service: 0,
  unclassified: 0, road: 0,
  tertiary: 1, tertiary_link: 1,
  secondary: 2, secondary_link: 2,
  primary: 3, primary_link: 3, trunk: 3, trunk_link: 3,
  motorway: 3, motorway_link: 3,
};
const TIER_LABEL = ["quiet streets", "up to tertiary", "up to secondary", "busy roads"];

// Friendly label for the busiest street a loop runs on.
export function surfaceLabel(tier) {
  return TIER_LABEL[tier] || "mixed streets";
}

function classTier(klass) {
  const t = SURFACE_TIER[klass];
  return t === undefined ? 1 : t;
}

// Busiest tier of an edge, taking the quietest class mapped to that edge (if a
// segment is also a footway, you can run the footway).
function edgeSurfaceTier(graph, key) {
  const set = graph.edgeClasses.get(key);
  if (!set) return 1;
  let t = Infinity;
  for (const k of set) t = Math.min(t, classTier(k));
  return t;
}

// Busiest street the loop runs along — the tier we test against the user's cap.
function ringSurfaceTier(ring, graph) {
  let maxT = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const t = edgeSurfaceTier(graph, edgeKey(ring[i], ring[i + 1]));
    if (t > maxT) maxT = t;
  }
  return maxT;
}

// ---------------------------------------------------------------------------
// loopCrossings — how many streets you actually cross to run this loop.
//
// Model: you run the loop on its interior-side sidewalk (interior on your left,
// so we orient the ring counter-clockwise). At each node you pass, the two loop
// edges are the streets you turn between; any *other* street at that node that
// points into the loop's interior wedge is a street whose mouth you cross.
//
// A plain, empty block has no streets pointing inward -> 0 crossings. A block
// with a spur poking in, a perimeter running straight through an intersection,
// or a merged loop swallowing a dividing street will each register the
// crossing(s). Crossings are priced by the OSM highway class crossed; a
// primary road or bigger marks the whole loop excluded (never crossed).
// ---------------------------------------------------------------------------
export function loopCrossings(ring, graph) {
  const { nodes, neighbors } = graph;
  // Normalise to a simple sequence of distinct nodes (drop a repeated close).
  let seq = ring.slice();
  if (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq = seq.slice(0, -1);
  const n = seq.length;
  if (n < 3) return { crossings: 0, crossingCost: 0, excluded: false };

  // Orient counter-clockwise so the interior is consistently to the left.
  if (ringSignedArea(seq, nodes) < 0) seq.reverse();

  let crossings = 0;
  let crossingCost = 0;
  let excluded = false;

  for (let i = 0; i < n; i++) {
    const P = seq[(i - 1 + n) % n];
    const N = seq[i];
    const Q = seq[(i + 1) % n];
    const cn = nodes.get(N);
    const angP = angleTo(cn, nodes.get(P));
    const angQ = angleTo(cn, nodes.get(Q));
    // Interior wedge = the ccw arc swept from the outgoing edge to the incoming.
    const span = norm(angP - angQ);
    const nbrs = neighbors.get(N);
    if (!nbrs) continue;
    for (const R of nbrs) {
      if (R === P || R === Q) continue; // the loop's own edges
      const d = norm(angleTo(cn, nodes.get(R)) - angQ);
      if (d > 1e-9 && d < span - 1e-9) {
        // This street points into the loop — you cross its mouth here.
        const w = edgeCrossWeight(graph, edgeKey(N, R));
        crossings++;
        if (Number.isFinite(w)) crossingCost += w;
        else excluded = true;
      }
    }
  }

  return { crossings, crossingCost, excluded };
}

// Signed area of a ring using the projected (meter) coordinates. + = ccw.
function ringSignedArea(seq, nodes) {
  let s = 0;
  for (let i = 0; i < seq.length; i++) {
    const p = nodes.get(seq[i]);
    const q = nodes.get(seq[(i + 1) % seq.length]);
    s += p.xm * q.ym - q.xm * p.ym;
  }
  return s / 2;
}

// Angle of the ray from node A to node B in the projected plane.
function angleTo(a, b) {
  return Math.atan2(b.ym - a.ym, b.xm - a.xm);
}

// Normalise an angle to [0, 2π).
function norm(a) {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

const MILES_TO_METERS = 1609.34;
export function milesToMeters(mi) {
  return mi * MILES_TO_METERS;
}
export function metersToMiles(m) {
  return m / MILES_TO_METERS;
}

// ---------------------------------------------------------------------------
// findLoops — assemble candidates within [target - tol, target + tol].
// ---------------------------------------------------------------------------
export function findLoops(
  graph,
  faces,
  { targetMeters, toleranceMeters, maxSurfaceTier = 1 }
) {
  const lo = targetMeters - toleranceMeters;
  const hi = targetMeters + toleranceMeters;
  const out = [];

  // 1) Single-block loops. A plain, empty block has zero crossings — but a
  // block with a street poking into it (a spur, or where the perimeter runs
  // straight through an intersection) forces a crossing, so we measure every
  // loop geometrically rather than assuming zero.
  for (const f of faces) {
    if (f.perimeter < lo || f.perimeter > hi) continue;
    const tier = ringSurfaceTier(f.nodeIds, graph);
    if (tier > maxSurfaceTier) continue; // runs on a street busier than allowed
    const cx = loopCrossings(f.nodeIds, graph);
    if (cx.excluded) continue; // would cross a primary road or bigger — skip
    out.push({
      latlngs: f.latlngs,
      distance: f.perimeter,
      crossings: cx.crossings,
      crossingCost: cx.crossingCost,
      surfaceTier: tier,
      faceCount: 1,
      target: targetMeters,
    });
  }

  // 2) Merged multi-block loops — grown until they reach the target window.
  const seen = new Set();
  for (const r of growRegions(graph, faces, hi)) {
    if (r.perimeter < lo || r.perimeter > hi) continue;
    if (seen.has(r.sig)) continue;
    seen.add(r.sig);
    const tier = ringSurfaceTier(r.ring, graph);
    if (tier > maxSurfaceTier) continue;
    const cx = loopCrossings(r.ring, graph);
    if (cx.excluded) continue;
    out.push({
      latlngs: r.latlngs,
      distance: r.perimeter,
      crossings: cx.crossings,
      crossingCost: cx.crossingCost,
      surfaceTier: tier,
      faceCount: r.faceCount,
      target: targetMeters,
    });
  }

  return rankLoops(out);
}

// ---------------------------------------------------------------------------
// rankLoops — order candidates for the runner.
//
//   1. Fewest crossings first (0-crossing block loops win outright).
//   2. Among equal crossing counts, cheaper crossings (quieter streets) first.
//   3. Then closest to the requested distance.
// ---------------------------------------------------------------------------
export function rankLoops(candidates) {
  return candidates.slice().sort((a, b) => {
    if (a.crossings !== b.crossings) return a.crossings - b.crossings;
    if (a.crossingCost !== b.crossingCost) return a.crossingCost - b.crossingCost;
    return Math.abs(a.distance - a.target) - Math.abs(b.distance - b.target);
  });
}

// ---------------------------------------------------------------------------
// growRegions — bounded search over unions of adjacent faces.
//
// Faces are adjacent when they share an edge we're allowed to cross (weight is
// finite — never a primary road or bigger). Starting from each block we grow
// the region a neighbour at a time, stopping once the perimeter passes the
// upper bound. A budget caps total work so this stays fast on a phone.
// ---------------------------------------------------------------------------
function growRegions(graph, faces, hi) {
  const results = [];
  if (!faces.length) return results;

  // Map every edge to the faces that use it, then build face adjacency across
  // shared, crossable edges only.
  const edgeToFaces = new Map();
  faces.forEach((f, i) => {
    for (const key of f.edgeKeys) {
      if (!edgeToFaces.has(key)) edgeToFaces.set(key, []);
      edgeToFaces.get(key).push(i);
    }
  });
  const adj = faces.map(() => new Set());
  for (const [key, list] of edgeToFaces) {
    if (list.length === 2 && Number.isFinite(edgeCrossWeight(graph, key))) {
      adj[list[0]].add(list[1]);
      adj[list[1]].add(list[0]);
    }
  }

  const MAX_FACES = 12; // largest region we'll assemble
  const BUDGET = 12000; // hard cap on assembled subsets (mobile safety)
  const visited = new Set(); // canonical face-set signatures already queued
  let assembled = 0;

  for (let seed = 0; seed < faces.length; seed++) {
    if (faces[seed].perimeter > hi) continue; // already too big to be useful
    const queue = [[seed]];
    visited.add(String(seed));

    while (queue.length) {
      if (assembled > BUDGET) return results;
      const subset = queue.shift();

      // Single faces are handled elsewhere; only assemble merged regions.
      let region = null;
      if (subset.length >= 2) {
        region = assembleRegion(subset, faces, graph);
        assembled++;
        if (region && region.perimeter <= hi) {
          region.faceCount = subset.length;
          results.push(region);
        }
      }

      // Expand while there's room and we haven't overshot the target window.
      const canGrow =
        subset.length < MAX_FACES &&
        (subset.length === 1 || (region && region.perimeter <= hi));
      if (!canGrow) continue;

      const frontier = new Set();
      for (const fi of subset) for (const nb of adj[fi]) frontier.add(nb);
      const inSubset = new Set(subset);
      for (const nb of frontier) {
        if (inSubset.has(nb)) continue;
        const next = subset.concat(nb).sort((x, y) => x - y);
        const sig = next.join(",");
        if (visited.has(sig)) continue;
        visited.add(sig);
        queue.push(next);
      }
    }
  }

  return results;
}

// Turn a set of faces into one loop: the region boundary. Edges used by exactly
// one member face are boundary; edges shared by two members are interior (they
// become crossings, counted later by loopCrossings). Returns the boundary as a
// node ring, or null unless the boundary is a single simple ring.
function assembleRegion(idxs, faces, graph) {
  const count = new Map();
  for (const fi of idxs) {
    for (const key of faces[fi].edgeKeys) {
      count.set(key, (count.get(key) || 0) + 1);
    }
  }

  const boundary = [];
  for (const [key, c] of count) {
    if (c === 1) boundary.push(key);
  }
  if (boundary.length < 3) return null;

  // Build node-level adjacency from the boundary edges. A single simple loop
  // means every boundary node has exactly degree 2.
  const nadj = new Map();
  const addN = (a, b) => {
    if (!nadj.has(a)) nadj.set(a, []);
    nadj.get(a).push(b);
  };
  for (const key of boundary) {
    const us = key.indexOf("_");
    const a = Number(key.slice(0, us));
    const b = Number(key.slice(us + 1));
    addN(a, b);
    addN(b, a);
  }
  for (const list of nadj.values()) if (list.length !== 2) return null;

  // Walk the ring; if it closes before visiting every node, the boundary was
  // several disjoint cycles (a region with a hole) — reject it.
  const start = Number(boundary[0].slice(0, boundary[0].indexOf("_")));
  const ring = [start];
  let prev = null;
  let cur = start;
  while (ring.length <= nadj.size) {
    const nbrs = nadj.get(cur);
    const next = nbrs[0] !== prev ? nbrs[0] : nbrs[1];
    if (next === start) break;
    ring.push(next);
    prev = cur;
    cur = next;
  }
  if (ring.length !== nadj.size) return null;
  ring.push(start); // close the ring

  let perimeter = 0;
  const latlngs = [];
  for (let i = 0; i < ring.length; i++) {
    const n = graph.nodes.get(ring[i]);
    latlngs.push([n.lat, n.lon]);
    if (i > 0) perimeter += haversine(graph.nodes.get(ring[i - 1]), n);
  }

  return {
    latlngs,
    perimeter,
    ring,
    sig: boundary.slice().sort().join("|"),
  };
}
