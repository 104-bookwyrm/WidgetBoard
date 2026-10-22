const cloneRect = (rect) => ({ ...rect });

const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inBounds = (rect, bounds) =>
  rect.x >= 0 &&
  rect.y >= 0 &&
  rect.x + rect.w <= bounds.cols &&
  rect.y + rect.h <= bounds.rows;

const pushPast = (source, displaced, vector) => {
  if (vector.x === 1) return { ...displaced, x: source.x + source.w };
  if (vector.x === -1) return { ...displaced, x: source.x - displaced.w };
  if (vector.y === 1) return { ...displaced, y: source.y + source.h };
  return { ...displaced, y: source.y - displaced.h };
};

const validVector = (vector) =>
  vector && Math.abs(vector.x ?? 0) + Math.abs(vector.y ?? 0) === 1;

const directionName = (vector) => {
  if (vector?.x === 1) return "right";
  if (vector?.x === -1) return "left";
  if (vector?.y === 1) return "down";
  if (vector?.y === -1) return "up";
  return null;
};

const emptyFacts = (vector = null) => ({
  direction: directionName(vector),
  movedNeighborCount: 0,
  totalNeighborTravel: 0,
  maximumNeighborTravel: 0,
});

const movementFacts = (before, after, moverId, vector) => {
  const beforeById = new Map(before.map((rect) => [rect.id, rect]));
  const travel = after
    .filter((rect) => rect.id !== moverId)
    .map((rect) => {
      const start = beforeById.get(rect.id);
      return Math.abs(rect.x - start.x) + Math.abs(rect.y - start.y);
    })
    .filter((distance) => distance > 0);
  return {
    direction: directionName(vector),
    movedNeighborCount: travel.length,
    totalNeighborTravel: travel.reduce((sum, distance) => sum + distance, 0),
    maximumNeighborTravel: travel.length ? Math.max(...travel) : 0,
  };
};

const provisionalTrace = (trace) =>
  trace.map((step) =>
    step.kind === "push"
      ? {
          ...step,
          provisional: true,
          title: step.title.replace(" moves", " would move"),
          detail: `Provisional only. ${step.detail}`,
        }
      : step,
  );

export function normalizeScenario(value) {
  if (!value || typeof value !== "object") throw new Error("Scenario must be an object.");
  const cols = Number(value.bounds?.cols);
  const rows = Number(value.bounds?.rows);
  if (!Number.isInteger(cols) || cols < 1 || cols > 24) {
    throw new Error("Board columns must be an integer from 1 through 24.");
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 24) {
    throw new Error("Board rows must be an integer from 1 through 24.");
  }
  if (!Array.isArray(value.widgets) || value.widgets.length < 1) {
    throw new Error("Scenario widgets must be a non-empty array.");
  }
  const ids = new Set();
  const widgets = value.widgets.map((input, index) => {
    const id = String(input?.id ?? "").trim();
    if (!id) throw new Error(`Rectangle ${index + 1} needs an id.`);
    if (ids.has(id)) throw new Error(`Duplicate rectangle id: ${id}.`);
    ids.add(id);
    const rect = { id };
    for (const key of ["x", "y", "w", "h"]) {
      const number = Number(input[key]);
      if (!Number.isInteger(number)) throw new Error(`${id}.${key} must be an integer.`);
      rect[key] = number;
    }
    if (rect.w < 1 || rect.h < 1) throw new Error(`${id} must have a positive size.`);
    if (!inBounds(rect, { cols, rows })) throw new Error(`${id} must fit inside the board.`);
    if (input.hidden) rect.hidden = true;
    if (input.fixed) rect.fixed = true;
    return rect;
  });
  const selectedId = ids.has(value.selectedId) ? value.selectedId : widgets[0].id;
  return { bounds: { cols, rows }, widgets, selectedId };
}

const overlapProbe = (a, b) => {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (left >= right || top >= bottom) return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
};

const FACE_TIE_EPSILON = 0.05;
const FACE_SWITCH_MARGIN = 0.15;
const FACE_TIE_PRIORITY = ["top", "right", "bottom", "left"];
const FACE_DEFINITIONS = {
  top: { face: "top", vector: { x: 0, y: 1 } },
  right: { face: "right", vector: { x: -1, y: 0 } },
  bottom: { face: "bottom", vector: { x: 0, y: -1 } },
  left: { face: "left", vector: { x: 1, y: 0 } },
};

const clampNumber = (value, low, high) => Math.min(Math.max(value, low), high);

const pointToSegmentDistance = (point, start, end) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared
    ? clampNumber(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
    : 0;
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
};

export function distanceToFaceSegment(point, target, face) {
  const segments = {
    top: [{ x: target.x, y: target.y }, { x: target.x + target.w, y: target.y }],
    right: [{ x: target.x + target.w, y: target.y }, { x: target.x + target.w, y: target.y + target.h }],
    bottom: [{ x: target.x, y: target.y + target.h }, { x: target.x + target.w, y: target.y + target.h }],
    left: [{ x: target.x, y: target.y }, { x: target.x, y: target.y + target.h }],
  };
  const segment = segments[face];
  if (!segment) return Number.POSITIVE_INFINITY;
  return pointToSegmentDistance(point, segment[0], segment[1]);
}

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const facePriority = (face) => FACE_TIE_PRIORITY.indexOf(face);

const viableIntent = ({ widgets, moverId, candidate, bounds }, intent) => {
  if (!bounds) return true;
  return solveFacePlacement({ widgets, moverId, candidate, bounds, intent }).ok;
};

export function classifyFaceIntent({ widgets, moverId, rawRect, candidate, pointer, priorIntent, bounds }) {
  const candidates = [];
  for (const target of widgets) {
    if (target.id === moverId || target.hidden || target.fixed) continue;
    if (!overlaps(candidate, target)) continue;
    const probe = pointer ?? overlapProbe(rawRect, target) ?? overlapProbe(candidate, target);
    if (!probe) continue;
    for (const face of FACE_TIE_PRIORITY) {
      const definition = FACE_DEFINITIONS[face];
      const distance = distanceToFaceSegment(probe, target, face);
      candidates.push({
        kind: "insert",
        targetId: target.id,
        face: definition.face,
        vector: { ...definition.vector },
        distance,
        score: 1 / (1 + distance),
        overlapArea: overlapArea(candidate, target),
        targetOrder: { x: target.x, y: target.y },
        probe: { ...probe },
      });
    }
  }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      b.overlapArea - a.overlapArea ||
      a.targetOrder.y - b.targetOrder.y ||
      a.targetOrder.x - b.targetOrder.x ||
      facePriority(a.face) - facePriority(b.face) ||
      a.targetId.localeCompare(b.targetId),
  );
  const best = candidates[0];
  if (!best) return { kind: "free", candidates: [] };
  const prior =
    priorIntent?.kind === "insert"
      ? candidates.find(
          (candidateIntent) =>
            candidateIntent.targetId === priorIntent.targetId && candidateIntent.face === priorIntent.face,
        )
      : null;
  const ambiguous = candidates.filter((entry) => entry.distance - best.distance <= FACE_TIE_EPSILON).slice(0, 4);
  const context = { widgets, moverId, candidate, bounds };
  const viableAmbiguous = ambiguous.filter((entry) => viableIntent(context, entry));
  const priorWithinMargin = prior && prior.distance - best.distance <= FACE_SWITCH_MARGIN;
  let selected = best;
  let selectionReason = "nearest-face";
  if (priorWithinMargin && viableIntent(context, prior)) {
    selected = prior;
    selectionReason = "hysteresis";
  } else if (ambiguous.length > 1 && viableAmbiguous.length > 0 && viableAmbiguous.length < ambiguous.length) {
    selected = viableAmbiguous[0];
    selectionReason = "feasible-tie";
  } else if (ambiguous.length > 1) {
    selected = ambiguous[0];
    selectionReason = "explicit-tie-priority";
  }
  return {
    ...selected,
    retained: selected === prior,
    selectionReason,
    candidates: candidates.map(({ targetId, face, score, distance }) => ({ targetId, face, score, distance })),
  };
}

export function resolveLegacy({ widgets, moverId, candidate, bounds }) {
  if (!inBounds(candidate, bounds)) {
    return { ok: false, reason: "out-of-bounds", layout: widgets.map(cloneRect), movedIds: [], trace: [] };
  }
  let pos = new Map(widgets.map((rect) => [rect.id, cloneRect(rect)]));
  pos.set(moverId, { ...pos.get(moverId), ...candidate, id: moverId });
  let fixed = new Set([moverId]);
  let budget = 3000;
  let failure = "no-layout";
  const trace = [];

  function settle(id, depth) {
    for (;;) {
      if (--budget < 0) {
        failure = "search-limit";
        trace.push({ kind: "reject", title: "Search budget exhausted", detail: "The 3,000-step limit was reached." });
        return false;
      }
      if (depth > 20) {
        failure = "depth-limit";
        trace.push({ kind: "reject", title: "Depth limit reached", detail: "The 20-level recursion limit was reached." });
        return false;
      }
      const placed = pos.get(id);
      const overlap = [...pos.values()].find((rect) => rect.id !== id && overlaps(placed, rect));
      if (!overlap) return true;
      trace.push({
        kind: "collision",
        title: `${placed.id} overlaps ${overlap.id}`,
        detail: "The first overlap follows widget array order.",
        widgetIds: [placed.id, overlap.id],
      });
      if (fixed.has(overlap.id)) {
        failure = "fixed-cycle";
        trace.push({
          kind: "backtrack",
          title: `${overlap.id} is already fixed`,
          detail: "This branch cannot move the same widget twice.",
          widgetIds: [overlap.id],
        });
        return false;
      }
      const options = [
        { direction: "right", x: placed.x + placed.w, y: overlap.y, c: placed.x + placed.w - overlap.x },
        { direction: "down", x: overlap.x, y: placed.y + placed.h, c: placed.y + placed.h - overlap.y },
        { direction: "left", x: placed.x - overlap.w, y: overlap.y, c: overlap.x + overlap.w - placed.x },
        { direction: "up", x: overlap.x, y: placed.y - overlap.h, c: overlap.y + overlap.h - placed.y },
      ];
      const occupied = (option) => {
        const next = { ...overlap, x: option.x, y: option.y };
        return [...pos.values()].some((rect) => rect.id !== overlap.id && overlaps(next, rect));
      };
      options.sort((a, b) => Number(occupied(a)) - Number(occupied(b)) || a.c - b.c);
      let settled = false;
      for (const option of options) {
        const next = { ...overlap, x: option.x, y: option.y };
        if (!inBounds(next, bounds)) {
          trace.push({
            kind: "skip",
            title: `${option.direction} leaves the board`,
            detail: `${overlap.id} cannot use this option.`,
            direction: option.direction,
            widgetIds: [overlap.id],
          });
          continue;
        }
        const snapshot = new Map([...pos].map(([key, rect]) => [key, cloneRect(rect)]));
        const fixedSnapshot = new Set(fixed);
        pos.set(overlap.id, next);
        fixed.add(overlap.id);
        trace.push({
          kind: "try",
          title: `Try ${option.direction}`,
          detail: `${overlap.id} moves ${option.c} cell${option.c === 1 ? "" : "s"}.`,
          direction: option.direction,
          widgetIds: [overlap.id],
          from: { x: overlap.x, y: overlap.y },
          to: { x: next.x, y: next.y },
        });
        if (settle(overlap.id, depth + 1)) {
          settled = true;
          break;
        }
        pos = snapshot;
        fixed = fixedSnapshot;
        trace.push({
          kind: "backtrack",
          title: `Undo ${option.direction}`,
          detail: "The recursive branch failed.",
          direction: option.direction,
          widgetIds: [overlap.id],
        });
      }
      if (!settled) return false;
    }
  }

  if (!settle(moverId, 0)) {
    return { ok: false, reason: failure, layout: widgets.map(cloneRect), movedIds: [], trace };
  }
  const layout = widgets.map((rect) => cloneRect(pos.get(rect.id)));
  const movedIds = layout
    .filter((rect) => {
      const start = widgets.find((widget) => widget.id === rect.id);
      return rect.x !== start.x || rect.y !== start.y || rect.w !== start.w || rect.h !== start.h;
    })
    .map((rect) => rect.id)
    .sort();
  trace.push({
    kind: "accept",
    title: "Legacy layout accepted",
    detail: `${movedIds.length} rectangle${movedIds.length === 1 ? "" : "s"} changed.`,
    widgetIds: movedIds,
  });
  return { ok: true, reason: "resolved", layout, movedIds, trace };
}

export function solveFacePlacement({ widgets, moverId, candidate, bounds, intent }) {
  const layout = widgets.map(cloneRect);
  const mover = layout.find((rect) => rect.id === moverId);
  if (!mover) {
    return { ok: false, status: "rejected", reason: "missing-mover", layout: widgets.map(cloneRect), movedIds: [], facts: emptyFacts() };
  }
  if (!inBounds(candidate, bounds)) {
    return { ok: false, status: "rejected", reason: "out-of-bounds", layout: widgets.map(cloneRect), movedIds: [], facts: emptyFacts() };
  }

  Object.assign(mover, candidate);
  const collisions = layout.filter((rect) => rect.id !== moverId && overlaps(mover, rect));
  if (intent.kind === "free" && collisions.length) {
    return { ok: false, status: "rejected", reason: "occupied", layout: widgets.map(cloneRect), movedIds: [], facts: emptyFacts() };
  }
  if (intent.kind === "free") {
    return {
      ok: true,
      status: "accepted",
      reason: "free-placement",
      layout,
      movedIds: [moverId],
      facts: emptyFacts(),
      trace: [{ kind: "accept", title: "Free placement", detail: "The candidate is empty." }],
    };
  }
  if (intent.kind !== "insert" || !validVector(intent.vector)) {
    return { ok: false, status: "rejected", reason: "invalid-intent", layout: widgets.map(cloneRect), movedIds: [], facts: emptyFacts() };
  }
  if (!collisions.some((rect) => rect.id === intent.targetId)) {
    return {
      ok: false,
      status: "rejected",
      reason: "target-not-occupied",
      layout: widgets.map(cloneRect),
      movedIds: [],
      facts: emptyFacts(intent.vector),
    };
  }

  const pos = new Map(layout.map((rect) => [rect.id, rect]));
  const trace = [
    {
      kind: "intent",
      title: `${intent.face} face selected`,
      detail: `${intent.targetId} must move ${intent.vector.x || intent.vector.y} cell units per push step.`,
      widgetIds: [intent.targetId],
    },
  ];
  const queue = [moverId];
  let operations = 0;
  const limit = Math.max(32, widgets.length * (bounds.cols + bounds.rows) * 4);

  while (queue.length) {
    const sourceId = queue.shift();
    const source = pos.get(sourceId);
    const colliders = [...pos.values()]
      .filter((rect) => rect.id !== sourceId && rect.id !== moverId && overlaps(source, rect))
      .sort((a, b) => {
        if (sourceId === moverId && a.id === intent.targetId) return -1;
        if (sourceId === moverId && b.id === intent.targetId) return 1;
        return a.id.localeCompare(b.id);
      });

    for (const displaced of colliders) {
      if (++operations > limit) {
        return {
          ok: false,
          status: "rejected",
          reason: "propagation-limit",
          layout: widgets.map(cloneRect),
          movedIds: [],
          facts: emptyFacts(intent.vector),
          trace: provisionalTrace(trace),
        };
      }
      if (displaced.fixed || displaced.hidden) {
        trace.push({
          kind: "reject",
          title: "Reserved cell blocks the push",
          detail: `${displaced.id} cannot move as a side effect.`,
          widgetIds: [displaced.id],
        });
        return {
          ok: false,
          status: "locked",
          reason: "fixed-obstacle",
          layout: widgets.map(cloneRect),
          movedIds: [],
          facts: emptyFacts(intent.vector),
          trace: provisionalTrace(trace),
        };
      }
      const next = pushPast(source, displaced, intent.vector);
      if (!inBounds(next, bounds)) {
        trace.push({
          kind: "reject",
          title: "Board edge blocks the push",
          detail: `${displaced.id} would leave the board.`,
          widgetIds: [displaced.id],
        });
        return {
          ok: false,
          status: "locked",
          reason: "blocked-boundary",
          layout: widgets.map(cloneRect),
          movedIds: [],
          facts: emptyFacts(intent.vector),
          trace: provisionalTrace(trace),
        };
      }
      pos.set(displaced.id, next);
      queue.push(displaced.id);
      trace.push({
        kind: "push",
        title: `${displaced.id} moves`,
        detail: `It clears ${source.id} along the selected direction.`,
        widgetIds: [source.id, displaced.id],
        from: { x: displaced.x, y: displaced.y },
        to: { x: next.x, y: next.y },
      });
    }
  }

  const resolved = widgets.map((rect) => cloneRect(pos.get(rect.id)));
  const movedIds = resolved
    .filter((rect) => {
      const start = widgets.find((widget) => widget.id === rect.id);
      return rect.x !== start.x || rect.y !== start.y || rect.w !== start.w || rect.h !== start.h;
    })
    .map((rect) => rect.id)
    .sort();
  trace.push({
    kind: "accept",
    title: "Insertion accepted",
    detail: `${movedIds.length - 1} neighbour${movedIds.length === 2 ? "" : "s"} moved.`,
    widgetIds: movedIds,
  });
  return {
    ok: true,
    status: "accepted",
    reason: "inserted",
    layout: resolved,
    movedIds,
    facts: movementFacts(widgets, resolved, moverId, intent.vector),
    trace,
  };
}
