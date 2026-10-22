import { classifyFaceIntent, solveFacePlacement } from "./grid-placement-engine.js";

const clone = (value) => structuredClone(value);
const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inBounds = (rect, bounds) =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= bounds.cols && rect.y + rect.h <= bounds.rows;
const sameLayout = (first, second) => {
  if (first.length !== second.length) return false;
  const secondById = new Map(second.map((rect) => [rect.id, rect]));
  return first.every((rect) => {
    const match = secondById.get(rect.id);
    return match && JSON.stringify(rect) === JSON.stringify(match);
  });
};

const scenario = (bounds, widgets, selectedId = "mover") => ({ bounds, widgets, selectedId });

export const AUDIT_CASES = [
  {
    id: "former-dead-zone",
    name: "Former center dead zone",
    expectation: "C.top is selected and C moves down.",
    scenario: scenario(
      { cols: 6, rows: 5 },
      [
        { id: "mover", x: 5, y: 0, w: 1, h: 1 },
        { id: "C", x: 1, y: 1, w: 2, h: 1 },
      ],
    ),
    candidate: { x: 2, y: 1, w: 1, h: 1 },
    pointer: { x: 2.2, y: 1.4 },
    expected: { face: "top", status: "accepted" },
  },
  {
    id: "feasible-corner",
    name: "Feasible corner tie",
    expectation: "D.right wins because D.bottom would leave the board.",
    scenario: scenario(
      { cols: 8, rows: 5 },
      [
        { id: "mover", x: 3, y: 1, w: 1, h: 1 },
        { id: "D", x: 5, y: 0, w: 2, h: 2 },
      ],
    ),
    candidate: { x: 6, y: 1, w: 1, h: 1 },
    pointer: { x: 6.8, y: 1.8 },
    priorIntent: { kind: "insert", targetId: "D", face: "bottom", vector: { x: 0, y: -1 } },
    expected: { face: "right", status: "accepted" },
  },
  ...[
    ["top", { x: 2.5, y: 2.05 }],
    ["right", { x: 2.95, y: 2.5 }],
    ["bottom", { x: 2.5, y: 2.95 }],
    ["left", { x: 2.05, y: 2.5 }],
  ].map(([face, pointer]) => ({
    id: `${face}-face`,
    name: `${face} face displacement`,
    expectation: `D.${face} is selected and the placement is accepted.`,
    scenario: scenario(
      { cols: 5, rows: 5 },
      [
        { id: "mover", x: 4, y: 4, w: 1, h: 1 },
        { id: "D", x: 2, y: 2, w: 1, h: 1 },
      ],
    ),
    candidate: { x: 2, y: 2, w: 1, h: 1 },
    pointer,
    expected: { face, status: "accepted" },
  })),
  {
    id: "locked-chain",
    name: "Boundary-locked chain",
    expectation: "The row cannot make room and remains unchanged.",
    scenario: scenario(
      { cols: 3, rows: 3 },
      [
        { id: "mover", x: 0, y: 2, w: 1, h: 1 },
        { id: "D", x: 0, y: 1, w: 1, h: 1 },
        { id: "E", x: 1, y: 1, w: 1, h: 1 },
        { id: "F", x: 2, y: 1, w: 1, h: 1 },
      ],
    ),
    candidate: { x: 0, y: 1, w: 1, h: 1 },
    pointer: { x: 0.05, y: 1.5 },
    expected: { face: "left", status: "locked" },
  },
  {
    id: "hidden-lock",
    name: "Hidden reservation lock",
    expectation: "The hidden reservation stops the chain without partial movement.",
    scenario: scenario(
      { cols: 4, rows: 3 },
      [
        { id: "mover", x: 3, y: 2, w: 1, h: 1 },
        { id: "D", x: 1, y: 1, w: 1, h: 1 },
        { id: "H", x: 2, y: 1, w: 1, h: 1, hidden: true },
      ],
    ),
    candidate: { x: 1, y: 1, w: 1, h: 1 },
    pointer: { x: 1.05, y: 1.5 },
    expected: { face: "left", status: "locked" },
  },
  {
    id: "hysteresis-corner",
    name: "Corner hysteresis",
    expectation: "D.left remains selected through small pointer noise near the top-left corner.",
    scenario: scenario(
      { cols: 10, rows: 4 },
      [
        { id: "mover", x: 8, y: 0, w: 2, h: 2 },
        { id: "D", x: 4, y: 0, w: 2, h: 2 },
      ],
    ),
    candidate: { x: 4, y: 0, w: 2, h: 2 },
    pointer: { x: 4.25, y: 0.1 },
    priorIntent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
    expected: { face: "left", status: "accepted" },
  },
  {
    id: "mixed-size-closure",
    name: "Mixed-size contact closure",
    expectation: "A and B move right while the unrelated rectangle remains still.",
    scenario: scenario(
      { cols: 10, rows: 7 },
      [
        { id: "mover", x: 8, y: 5, w: 2, h: 2 },
        { id: "A", x: 3, y: 2, w: 2, h: 2 },
        { id: "B", x: 5, y: 2, w: 1, h: 1 },
        { id: "unrelated", x: 0, y: 1, w: 2, h: 2 },
      ],
    ),
    candidate: { x: 3, y: 2, w: 2, h: 2 },
    pointer: { x: 3.05, y: 3 },
    expected: { face: "left", status: "accepted" },
  },
  {
    id: "branching-closure",
    name: "Branching contact closure",
    expectation: "A pushes both contacted rectangles right without moving the distant rectangle.",
    scenario: scenario(
      { cols: 6, rows: 5 },
      [
        { id: "mover", x: 5, y: 0, w: 1, h: 2 },
        { id: "A", x: 2, y: 1, w: 1, h: 2 },
        { id: "B", x: 3, y: 1, w: 1, h: 1 },
        { id: "C", x: 3, y: 2, w: 1, h: 1 },
        { id: "distant", x: 0, y: 4, w: 1, h: 1 },
      ],
    ),
    candidate: { x: 2, y: 1, w: 1, h: 2 },
    pointer: { x: 2.05, y: 2 },
    expected: { face: "left", status: "accepted" },
  },
  {
    id: "permuted-input",
    name: "Permuted input order",
    expectation: "A then B form the same rightward chain despite shuffled source order.",
    scenario: scenario(
      { cols: 6, rows: 3 },
      [
        { id: "B", x: 2, y: 0, w: 1, h: 1 },
        { id: "mover", x: 4, y: 0, w: 2, h: 1 },
        { id: "A", x: 1, y: 0, w: 1, h: 1 },
      ],
    ),
    candidate: { x: 1, y: 0, w: 2, h: 1 },
    pointer: { x: 1.05, y: 0.5 },
    expected: { face: "left", status: "accepted" },
  },
  {
    id: "broad-chain",
    name: "Broad row reorganization",
    expectation: "Four neighbours move right and the audit requests human review.",
    scenario: scenario(
      { cols: 7, rows: 3 },
      [
        { id: "mover", x: 6, y: 2, w: 1, h: 1 },
        { id: "A", x: 1, y: 1, w: 1, h: 1 },
        { id: "B", x: 2, y: 1, w: 1, h: 1 },
        { id: "C", x: 3, y: 1, w: 1, h: 1 },
        { id: "D", x: 4, y: 1, w: 1, h: 1 },
      ],
    ),
    candidate: { x: 1, y: 1, w: 1, h: 1 },
    pointer: { x: 1.05, y: 1.5 },
    expected: { face: "left", status: "accepted" },
  },
];

const finding = (severity, code, message) => ({ severity, code, message });

const severityFor = (findings) => {
  if (findings.some((entry) => entry.severity === "fail")) return "fail";
  if (findings.some((entry) => entry.severity === "review")) return "review";
  return "pass";
};

export function auditPlacement({ widgets, moverId, candidate, intent, result, bounds }) {
  const findings = [];
  const occupied = widgets.some((rect) => rect.id !== moverId && overlaps(candidate, rect));
  if (occupied && intent.kind === "free") {
    findings.push(finding("fail", "occupied-free-intent", "Occupied space was classified as a free placement."));
  }

  const before = new Map(widgets.map((rect) => [rect.id, rect]));
  const after = result.layout ?? [];
  if (result.status === "accepted") {
    const afterIds = new Set(after.map((rect) => rect.id));
    if (after.length !== widgets.length || afterIds.size !== widgets.length || widgets.some((rect) => !afterIds.has(rect.id))) {
      findings.push(finding("fail", "layout-membership", "The accepted layout changed the rectangle set."));
    }
    for (const rect of after) {
      if (!inBounds(rect, bounds)) findings.push(finding("fail", "out-of-bounds", `${rect.id} leaves the board.`));
      const start = before.get(rect.id);
      if (!start || start.w !== rect.w || start.h !== rect.h) {
        findings.push(finding("fail", "size-changed", `${rect.id} changed size.`));
      }
    }
    for (let first = 0; first < after.length; first++) {
      for (let second = first + 1; second < after.length; second++) {
        if (overlaps(after[first], after[second])) {
          findings.push(finding("fail", "accepted-overlap", `${after[first].id} still overlaps ${after[second].id}.`));
        }
      }
    }
    const placedMover = after.find((rect) => rect.id === moverId);
    if (
      !placedMover ||
      placedMover.x !== candidate.x ||
      placedMover.y !== candidate.y ||
      placedMover.w !== candidate.w ||
      placedMover.h !== candidate.h
    ) {
      findings.push(finding("fail", "mover-missed-candidate", "The mover did not remain at its requested candidate."));
    }
    const pushedIds = new Set(
      (result.trace ?? [])
        .filter((step) => step.kind === "push")
        .flatMap((step) => step.widgetIds?.slice(-1) ?? []),
    );
    for (const rect of after) {
      if (rect.id === moverId) continue;
      const start = before.get(rect.id);
      const dx = rect.x - start.x;
      const dy = rect.y - start.y;
      if (!dx && !dy) continue;
      const offAxis = intent.vector?.x ? dy !== 0 || Math.sign(dx) !== intent.vector.x : dx !== 0 || Math.sign(dy) !== intent.vector?.y;
      if (offAxis) findings.push(finding("fail", "off-axis-movement", `${rect.id} moved outside the selected direction.`));
      if (!pushedIds.has(rect.id)) findings.push(finding("fail", "disconnected-movement", `${rect.id} moved without collision provenance.`));
    }
  } else {
    if (!sameLayout(after, widgets)) {
      const code = result.status === "locked" ? "partial-locked-layout" : "partial-rejected-layout";
      findings.push(finding("fail", code, `A ${result.status} placement retained partial movement.`));
    }
  }

  if ((result.facts?.movedNeighborCount ?? 0) >= 4) {
    findings.push(
      finding(
        "review",
        "broad-reorganization",
        `${result.facts.movedNeighborCount} neighbours move and should receive human review.`,
      ),
    );
  }
  if (!findings.length) findings.push(finding("pass", "invariants-hold", "Movement stays within the contact model."));
  return { severity: severityFor(findings), findings };
}

const runCase = (definition) => {
  const scenarioValue = clone(definition.scenario);
  const moverId = scenarioValue.selectedId;
  const intent = classifyFaceIntent({
    widgets: scenarioValue.widgets,
    moverId,
    rawRect: definition.candidate,
    candidate: definition.candidate,
    pointer: definition.pointer,
    priorIntent: definition.priorIntent ?? null,
    bounds: scenarioValue.bounds,
  });
  const result = solveFacePlacement({
    widgets: scenarioValue.widgets,
    moverId,
    candidate: definition.candidate,
    bounds: scenarioValue.bounds,
    intent,
  });
  const report = auditPlacement({
    widgets: scenarioValue.widgets,
    moverId,
    candidate: definition.candidate,
    intent,
    result,
    bounds: scenarioValue.bounds,
  });
  const findings = [...report.findings];
  if (definition.expected?.face && intent.face !== definition.expected.face) {
    findings.push(finding("fail", "unexpected-face", `Expected ${definition.expected.face}; observed ${intent.face ?? "free"}.`));
  }
  if (definition.expected?.status && result.status !== definition.expected.status) {
    findings.push(finding("fail", "unexpected-status", `Expected ${definition.expected.status}; observed ${result.status}.`));
  }
  return {
    id: definition.id,
    name: definition.name,
    expectation: definition.expectation,
    severity: severityFor(findings),
    findings,
    observed: {
      targetId: intent.targetId ?? null,
      face: intent.face ?? null,
      selectionReason: intent.selectionReason ?? "free-placement",
      status: result.status,
      reason: result.reason,
      facts: result.facts,
    },
    scenario: scenarioValue,
    candidate: clone(definition.candidate),
    pointer: clone(definition.pointer),
    priorIntent: definition.priorIntent ? clone(definition.priorIntent) : null,
  };
};

const summarize = (cases) => ({
  total: cases.length,
  pass: cases.filter((entry) => entry.severity === "pass").length,
  review: cases.filter((entry) => entry.severity === "review").length,
  fail: cases.filter((entry) => entry.severity === "fail").length,
});

export function runGeneratedNaturalnessAudit() {
  const faces = [
    ["top", { x: 0.5, y: 0.05 }],
    ["right", { x: 0.95, y: 0.5 }],
    ["bottom", { x: 0.5, y: 0.95 }],
    ["left", { x: 0.05, y: 0.5 }],
  ];
  const cases = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      for (const [face, offset] of faces) {
        const moverStart = x === 0 && y === 0 ? { x: 2, y: 2 } : { x: 0, y: 0 };
        const definition = {
          id: `matrix-${x}-${y}-${face}`,
          name: `Matrix cell ${x},${y} ${face}`,
          expectation: `The ${face} face is recognized at board cell ${x},${y}.`,
          scenario: scenario(
            { cols: 3, rows: 3 },
            [
              { id: "mover", ...moverStart, w: 1, h: 1 },
              { id: "D", x, y, w: 1, h: 1 },
            ],
          ),
          candidate: { x, y, w: 1, h: 1 },
          pointer: { x: x + offset.x, y: y + offset.y },
          expected: { face },
        };
        cases.push(runCase(definition));
      }
    }
  }
  return { summary: summarize(cases), cases };
}

export function runNaturalnessAudit({ includeGenerated = true } = {}) {
  const curated = AUDIT_CASES.map(runCase);
  const generated = includeGenerated ? runGeneratedNaturalnessAudit().cases : [];
  const cases = [...curated, ...generated];
  return { summary: summarize(cases), cases };
}
