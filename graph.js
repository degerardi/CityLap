// graph.js
// ---------------------------------------------------------------------------
// Turns a raw Overpass response (highway ways + their nodes) into a planar
// graph, then extracts the graph's minimal cycles ("faces" — the city blocks).
//
// The pipeline has two clearly separated steps so the logic stays reusable:
//
//   buildGraph(elements)  -> { nodes, neighbors, edgeClasses, ... }
//   extractFaces(graph)   -> [ { nodeIds, edgeKeys, latlngs, perimeter, ... } ]
//
// All distances are in meters. Angles/areas are computed in a local
// equirectangular projection (meters) so the planar-embedding math is metric.
// ---------------------------------------------------------------------------

const EARTH_R = 6371000; // mean Earth radius, meters
const DEG = Math.PI / 180;

// Great-circle (geodesic) distance between two {lat, lon} points, in meters.
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Undirected edge key: order-independent so (a,b) and (b,a) collide.
export function edgeKey(a, b) {
  return a < b ? a + "_" + b : b + "_" + a;
}

// ---------------------------------------------------------------------------
// Step 1 — build the planar graph.
//
// Vertices are OSM nodes. Edges connect consecutive nodes within a highway way.
// Because OSM shares a single node id where two streets meet, ways that cross
// automatically become connected at that shared vertex — that is what makes
// the resulting graph planar and gives us real intersections.
// ---------------------------------------------------------------------------
export function buildGraph(elements) {
  const nodes = new Map(); // id -> { id, lat, lon, xm, ym }
  for (const el of elements) {
    if (el.type === "node") {
      nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon, xm: 0, ym: 0 });
    }
  }

  // Local equirectangular projection to meters, anchored at the mean latitude.
  // Only used for angle sorting and signed-area (orientation) tests.
  let latSum = 0;
  for (const n of nodes.values()) latSum += n.lat;
  const refLat = nodes.size ? latSum / nodes.size : 0;
  const cosLat = Math.cos(refLat * DEG);
  for (const n of nodes.values()) {
    n.xm = n.lon * DEG * EARTH_R * cosLat;
    n.ym = n.lat * DEG * EARTH_R;
  }

  const neighbors = new Map(); // id -> Set(neighborId)
  const edgeClasses = new Map(); // edgeKey -> Set(highwayClass)

  const link = (a, b) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a).add(b);
  };

  for (const el of elements) {
    if (el.type !== "way" || !el.tags || !el.tags.highway) continue;
    const klass = el.tags.highway;
    const ns = el.nodes || [];
    for (let i = 0; i + 1 < ns.length; i++) {
      const a = ns[i];
      const b = ns[i + 1];
      if (a === b) continue; // skip degenerate self-edges
      if (!nodes.has(a) || !nodes.has(b)) continue; // node fell outside bbox
      link(a, b);
      link(b, a);
      const key = edgeKey(a, b);
      if (!edgeClasses.has(key)) edgeClasses.set(key, new Set());
      edgeClasses.get(key).add(klass);
    }
  }

  // Pre-sort each vertex's neighbors counter-clockwise by outgoing angle, and
  // remember each neighbor's index. Face traversal (below) leans on this order.
  const sortedNeighbors = new Map(); // id -> [neighborId, ...] (ccw)
  const neighborIndex = new Map(); // id -> Map(neighborId -> index)
  for (const [id, set] of neighbors) {
    const self = nodes.get(id);
    const arr = [...set].sort((p, q) => {
      const np = nodes.get(p);
      const nq = nodes.get(q);
      const ap = Math.atan2(np.ym - self.ym, np.xm - self.xm);
      const aq = Math.atan2(nq.ym - self.ym, nq.xm - self.xm);
      return ap - aq;
    });
    sortedNeighbors.set(id, arr);
    const idx = new Map();
    arr.forEach((nb, i) => idx.set(nb, i));
    neighborIndex.set(id, idx);
  }

  return { nodes, neighbors, edgeClasses, sortedNeighbors, neighborIndex };
}

// ---------------------------------------------------------------------------
// Step 2 — extract minimal cycles (faces) of the planar graph.
//
// We use the standard planar half-edge ("next around the face") traversal.
// Every undirected edge is split into two directed half-edges. Starting from a
// half-edge a->b, the next half-edge of the same face is found by arriving at b
// and taking the neighbor immediately counter-clockwise after a in b's sorted
// order. Repeating this always turns the "same way" and so walks the boundary
// of one face; each half-edge belongs to exactly one face, so we visit each
// once. With the ccw ordering, bounded blocks come out ccw (positive signed
// area) and the single unbounded outer face comes out cw (negative) — we keep
// only the bounded faces, which are the real city blocks. With a uniform ccw
// rotation system and this "next" rule, every bounded face is traced clockwise
// (negative signed area) and the single unbounded outer face of each connected
// component is traced counter-clockwise (positive) — so we keep the negatives.
// ---------------------------------------------------------------------------
export function extractFaces(graph) {
  const { nodes, sortedNeighbors, neighborIndex } = graph;
  const visited = new Set(); // "a->b" half-edges already assigned to a face
  const faces = [];

  for (const [start, arr] of sortedNeighbors) {
    for (const first of arr) {
      if (visited.has(start + ">" + first)) continue;

      const nodeIds = [start];
      let a = start;
      let b = first;
      let guard = 0;

      while (guard++ < 200000) {
        visited.add(a + ">" + b);
        nodeIds.push(b);
        // Turn onto the next half-edge of this face.
        const nbrs = sortedNeighbors.get(b);
        const idx = neighborIndex.get(b).get(a);
        const c = nbrs[(idx + 1) % nbrs.length];
        a = b;
        b = c;
        if (a === start && b === first) break; // closed the loop
      }

      // nodeIds is a closed ring [start, ..., start]. Measure it. Bounded
      // blocks are clockwise (negative); the outer face is positive. Drop the
      // outer face and any near-zero degenerate slivers (dead-end out-and-backs).
      const signed = signedAreaMeters(nodeIds, nodes);
      if (signed >= -50) continue;
      const area = -signed;

      const edgeKeys = [];
      let perimeter = 0;
      for (let i = 0; i + 1 < nodeIds.length; i++) {
        edgeKeys.push(edgeKey(nodeIds[i], nodeIds[i + 1]));
        perimeter += haversine(nodes.get(nodeIds[i]), nodes.get(nodeIds[i + 1]));
      }
      const latlngs = nodeIds.map((id) => {
        const n = nodes.get(id);
        return [n.lat, n.lon];
      });

      faces.push({ nodeIds, edgeKeys, latlngs, perimeter, area });
    }
  }

  return faces;
}

// Shoelace signed area (m^2) using the projected coordinates. Positive == ccw.
function signedAreaMeters(ring, nodes) {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const p = nodes.get(ring[i]);
    const q = nodes.get(ring[i + 1]);
    sum += p.xm * q.ym - q.xm * p.ym;
  }
  return sum / 2;
}
