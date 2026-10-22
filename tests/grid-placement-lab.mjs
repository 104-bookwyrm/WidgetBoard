import assert from "node:assert/strict";
import test from "node:test";

let engine;
try {
  engine = await import("../ui/dev/grid-placement-engine.js");
} catch (error) {
  assert.fail(`grid placement engine is unavailable: ${error.message}`);
}

const byId = (layout) => Object.fromEntries(layout.map((rect) => [rect.id, rect]));

test("free placement moves no neighbour", () => {
  const widgets = [
    { id: "mover", x: 9, y: 0, w: 1, h: 1 },
    { id: "D", x: 4, y: 0, w: 1, h: 1 },
  ];

  const result = engine.solveFacePlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 3, y: 0, w: 1, h: 1 },
    bounds: { cols: 10, rows: 10 },
    intent: { kind: "free" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "accepted");
  assert.deepEqual(byId(result.layout), {
    D: { id: "D", x: 4, y: 0, w: 1, h: 1 },
    mover: { id: "mover", x: 3, y: 0, w: 1, h: 1 },
  });
  assert.deepEqual(result.movedIds, ["mover"]);
});

test("left-face insertion pushes a collision chain right", () => {
  const widgets = [
    { id: "mover", x: 9, y: 0, w: 1, h: 1 },
    { id: "D", x: 4, y: 0, w: 1, h: 1 },
    { id: "E", x: 5, y: 0, w: 1, h: 1 },
  ];

  const result = engine.solveFacePlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 4, y: 0, w: 1, h: 1 },
    bounds: { cols: 10, rows: 10 },
    intent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "accepted");
  assert.deepEqual(byId(result.layout), {
    D: { id: "D", x: 5, y: 0, w: 1, h: 1 },
    E: { id: "E", x: 6, y: 0, w: 1, h: 1 },
    mover: { id: "mover", x: 4, y: 0, w: 1, h: 1 },
  });
  assert.deepEqual(result.movedIds, ["D", "E", "mover"]);
  assert.deepEqual(result.facts, {
    direction: "right",
    movedNeighborCount: 2,
    totalNeighborTravel: 2,
    maximumNeighborTravel: 1,
  });
});

test("a blocked insertion rejects without changing the layout", () => {
  const widgets = [
    { id: "mover", x: 0, y: 1, w: 1, h: 1 },
    { id: "D", x: 1, y: 1, w: 1, h: 1 },
    { id: "E", x: 2, y: 1, w: 1, h: 1 },
  ];

  const result = engine.solveFacePlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 1, y: 1, w: 1, h: 1 },
    bounds: { cols: 3, rows: 3 },
    intent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "locked");
  assert.equal(result.reason, "blocked-boundary");
  assert.deepEqual(result.layout, widgets);
  assert.deepEqual(result.movedIds, []);
  const provisional = result.trace.filter((step) => step.kind === "push");
  assert.ok(provisional.length > 0);
  assert.equal(provisional.every((step) => step.provisional === true), true);
  assert.equal(provisional.every((step) => step.title.includes("would move")), true);
});

test("malformed insertion intent is rejected instead of locked", () => {
  const widgets = [
    { id: "mover", x: 2, y: 0, w: 1, h: 1 },
    { id: "D", x: 0, y: 0, w: 1, h: 1 },
  ];

  const result = engine.solveFacePlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 0, y: 0, w: 1, h: 1 },
    bounds: { cols: 3, rows: 2 },
    intent: { kind: "insert", targetId: "D", face: "left", vector: { x: 0, y: 0 } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "invalid-intent");
  assert.deepEqual(result.layout, widgets);
});

test("continuous contact selects the target left face", () => {
  const widgets = [
    { id: "mover", x: 9, y: 0, w: 1, h: 1 },
    { id: "D", x: 4, y: 0, w: 1, h: 1 },
  ];

  const intent = engine.classifyFaceIntent({
    widgets,
    moverId: "mover",
    rawRect: { x: 3.8, y: 0, w: 1, h: 1 },
    candidate: { x: 4, y: 0, w: 1, h: 1 },
    pointer: { x: 4.1, y: 0.5 },
    priorIntent: null,
  });

  assert.equal(intent.kind, "insert");
  assert.equal(intent.targetId, "D");
  assert.equal(intent.face, "left");
  assert.deepEqual(intent.vector, { x: 1, y: 0 });
  assert.ok(intent.score > 0.5);
});

test("an occupied former dead zone selects its nearest top face", () => {
  const widgets = [
    { id: "mover", x: 5, y: 0, w: 1, h: 1 },
    { id: "C", x: 1, y: 1, w: 2, h: 1 },
  ];

  const intent = engine.classifyFaceIntent({
    widgets,
    moverId: "mover",
    rawRect: { x: 2, y: 1, w: 1, h: 1 },
    candidate: { x: 2, y: 1, w: 1, h: 1 },
    pointer: { x: 2.2, y: 1.4 },
    priorIntent: null,
    bounds: { cols: 6, rows: 5 },
  });

  assert.equal(intent.kind, "insert");
  assert.equal(intent.targetId, "C");
  assert.equal(intent.face, "top");
  assert.deepEqual(intent.vector, { x: 0, y: 1 });
  assert.ok(Math.abs(intent.distance - 0.4) < 1e-9);
});

test("face distance uses the finite face segment", () => {
  const distance = engine.distanceToFaceSegment(
    { x: 4, y: 0 },
    { id: "C", x: 1, y: 1, w: 2, h: 2 },
    "top",
  );

  assert.equal(distance, Math.sqrt(2));
});

test("an exact center tie uses the explicit clockwise face priority", () => {
  const widgets = [
    { id: "mover", x: 4, y: 4, w: 1, h: 1 },
    { id: "D", x: 2, y: 2, w: 1, h: 1 },
  ];

  const intent = engine.classifyFaceIntent({
    widgets,
    moverId: "mover",
    rawRect: { x: 2, y: 2, w: 1, h: 1 },
    candidate: { x: 2, y: 2, w: 1, h: 1 },
    pointer: { x: 2.5, y: 2.5 },
    priorIntent: null,
    bounds: { cols: 6, rows: 6 },
  });

  assert.equal(intent.face, "top");
  assert.equal(intent.selectionReason, "explicit-tie-priority");
});

test("a four-face center tie searches every tied face before locking", () => {
  const widgets = [
    { id: "mover", x: 1, y: 0, w: 1, h: 1 },
    { id: "D", x: 0, y: 1, w: 1, h: 1 },
    { id: "E", x: 0, y: 2, w: 1, h: 1 },
  ];

  const intent = engine.classifyFaceIntent({
    widgets,
    moverId: "mover",
    rawRect: { x: 0, y: 1, w: 1, h: 1 },
    candidate: { x: 0, y: 1, w: 1, h: 1 },
    pointer: { x: 0.5, y: 1.5 },
    priorIntent: null,
    bounds: { cols: 2, rows: 3 },
  });

  assert.equal(intent.face, "bottom");
  assert.equal(intent.selectionReason, "feasible-tie");
  const result = engine.solveFacePlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 0, y: 1, w: 1, h: 1 },
    bounds: { cols: 2, rows: 3 },
    intent,
  });
  assert.equal(result.status, "accepted");
});

test("a corner tie chooses the direction whose displacement is feasible", () => {
  const widgets = [
    { id: "mover", x: 3, y: 1, w: 1, h: 1 },
    { id: "D", x: 5, y: 0, w: 2, h: 2 },
  ];

  const intent = engine.classifyFaceIntent({
    widgets,
    moverId: "mover",
    rawRect: { x: 6, y: 1, w: 1, h: 1 },
    candidate: { x: 6, y: 1, w: 1, h: 1 },
    pointer: { x: 6.8, y: 1.8 },
    priorIntent: { kind: "insert", targetId: "D", face: "bottom", vector: { x: 0, y: -1 } },
    bounds: { cols: 8, rows: 5 },
  });

  assert.equal(intent.face, "right");
  assert.deepEqual(intent.vector, { x: -1, y: 0 });
  assert.equal(intent.selectionReason, "feasible-tie");
});

test("face hysteresis retains the prior face near a corner", () => {
  const widgets = [
    { id: "mover", x: 8, y: 0, w: 2, h: 2 },
    { id: "D", x: 4, y: 0, w: 2, h: 2 },
  ];

  const intent = engine.classifyFaceIntent({
    widgets,
    moverId: "mover",
    rawRect: { x: 3.8, y: -0.1, w: 2, h: 2 },
    candidate: { x: 4, y: 0, w: 2, h: 2 },
    pointer: { x: 4.25, y: 0.1 },
    priorIntent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
  });

  assert.equal(intent.targetId, "D");
  assert.equal(intent.face, "left");
  assert.equal(intent.retained, true);
});

test("legacy resolver preserves its clear-destination preference", () => {
  const widgets = [
    { id: "mover", x: 3, y: 0, w: 1, h: 1 },
    { id: "D", x: 1, y: 0, w: 1, h: 1 },
    { id: "E", x: 2, y: 0, w: 1, h: 1 },
  ];

  const result = engine.resolveLegacy({
    widgets,
    moverId: "mover",
    candidate: { x: 1, y: 0, w: 1, h: 1 },
    bounds: { cols: 4, rows: 3 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(byId(result.layout), {
    D: { id: "D", x: 1, y: 1, w: 1, h: 1 },
    E: { id: "E", x: 2, y: 0, w: 1, h: 1 },
    mover: { id: "mover", x: 1, y: 0, w: 1, h: 1 },
  });
  assert.equal(result.trace.some((step) => step.direction === "down"), true);
});

test("a reserved rectangle blocks a directional chain", () => {
  const widgets = [
    { id: "mover", x: 5, y: 0, w: 1, h: 1 },
    { id: "D", x: 1, y: 0, w: 1, h: 1 },
    { id: "hidden", x: 2, y: 0, w: 1, h: 1, hidden: true },
  ];

  const result = engine.solveFacePlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 1, y: 0, w: 1, h: 1 },
    bounds: { cols: 6, rows: 3 },
    intent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "locked");
  assert.equal(result.reason, "fixed-obstacle");
  assert.deepEqual(result.layout, widgets);
});

test("directional placement ignores widget array order", () => {
  const first = [
    { id: "mover", x: 4, y: 0, w: 2, h: 1 },
    { id: "A", x: 1, y: 0, w: 1, h: 1 },
    { id: "B", x: 2, y: 0, w: 1, h: 1 },
  ];
  const second = [first[2], first[0], first[1]];
  const solve = (widgets) =>
    engine.solveFacePlacement({
      widgets,
      moverId: "mover",
      candidate: { x: 1, y: 0, w: 2, h: 1 },
      bounds: { cols: 6, rows: 3 },
      intent: { kind: "insert", targetId: "A", face: "left", vector: { x: 1, y: 0 } },
    });

  const expected = {
    A: { id: "A", x: 3, y: 0, w: 1, h: 1 },
    B: { id: "B", x: 4, y: 0, w: 1, h: 1 },
    mover: { id: "mover", x: 1, y: 0, w: 2, h: 1 },
  };
  assert.deepEqual(byId(solve(first).layout), expected);
  assert.deepEqual(byId(solve(second).layout), expected);
});

test("a mixed-size chain moves only its collision closure", () => {
  const widgets = [
    { id: "mover", x: 8, y: 5, w: 2, h: 2 },
    { id: "A", x: 3, y: 2, w: 2, h: 2 },
    { id: "B", x: 5, y: 2, w: 1, h: 1 },
    { id: "unrelated", x: 0, y: 1, w: 2, h: 2 },
  ];
  const result = engine.solveFacePlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 3, y: 2, w: 2, h: 2 },
    bounds: { cols: 10, rows: 7 },
    intent: { kind: "insert", targetId: "A", face: "left", vector: { x: 1, y: 0 } },
  });

  assert.equal(result.status, "accepted");
  assert.deepEqual(byId(result.layout), {
    A: { id: "A", x: 5, y: 2, w: 2, h: 2 },
    B: { id: "B", x: 7, y: 2, w: 1, h: 1 },
    mover: { id: "mover", x: 3, y: 2, w: 2, h: 2 },
    unrelated: { id: "unrelated", x: 0, y: 1, w: 2, h: 2 },
  });
  assert.deepEqual(result.movedIds, ["A", "B", "mover"]);
});

test("scenario import rejects invalid dimensions and duplicate ids", () => {
  assert.throws(
    () =>
      engine.normalizeScenario({
        bounds: { cols: 0, rows: 4 },
        widgets: [{ id: "A", x: 0, y: 0, w: 1, h: 1 }],
      }),
    /columns/i,
  );
  assert.throws(
    () =>
      engine.normalizeScenario({
        bounds: { cols: 4, rows: 4 },
        widgets: [
          { id: "A", x: 0, y: 0, w: 1, h: 1 },
          { id: "A", x: 1, y: 0, w: 1, h: 1 },
        ],
      }),
    /duplicate/i,
  );
});
