import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_CASES,
  auditPlacement,
  runGeneratedNaturalnessAudit,
  runNaturalnessAudit,
} from "../ui/dev/grid-placement-audit.js";

test("the curated naturalness matrix has no failed cases", () => {
  const audit = runNaturalnessAudit({ includeGenerated: false });

  assert.ok(AUDIT_CASES.length >= 8);
  assert.equal(audit.summary.fail, 0);
  assert.ok(audit.cases.some((entry) => entry.id === "former-dead-zone" && entry.severity === "pass"));
  assert.ok(audit.cases.some((entry) => entry.id === "feasible-corner" && entry.observed.face === "right"));
  assert.ok(audit.cases.some((entry) => entry.id === "locked-chain" && entry.observed.status === "locked"));
  assert.ok(audit.cases.some((entry) => entry.id === "hysteresis-corner" && entry.observed.selectionReason === "hysteresis"));
  assert.ok(audit.cases.some((entry) => entry.id === "mixed-size-closure" && entry.observed.facts.movedNeighborCount === 2));
  assert.ok(audit.cases.some((entry) => entry.id === "branching-closure" && entry.observed.facts.movedNeighborCount === 3));
  assert.ok(audit.cases.some((entry) => entry.id === "permuted-input" && entry.severity === "pass"));
  assert.ok(audit.cases.some((entry) => entry.id === "broad-chain" && entry.severity === "review"));
});

test("the audit rejects free intent on occupied space", () => {
  const widgets = [
    { id: "mover", x: 2, y: 0, w: 1, h: 1 },
    { id: "D", x: 0, y: 0, w: 1, h: 1 },
  ];
  const report = auditPlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 0, y: 0, w: 1, h: 1 },
    intent: { kind: "free" },
    result: { ok: false, status: "rejected", reason: "occupied", layout: widgets, movedIds: [], facts: {} },
    bounds: { cols: 3, rows: 2 },
  });

  assert.equal(report.severity, "fail");
  assert.ok(report.findings.some((finding) => finding.code === "occupied-free-intent"));
});

test("the audit catches perpendicular neighbour movement", () => {
  const widgets = [
    { id: "mover", x: 2, y: 0, w: 1, h: 1 },
    { id: "D", x: 0, y: 0, w: 1, h: 1 },
  ];
  const result = {
    ok: true,
    status: "accepted",
    reason: "inserted",
    layout: [
      { id: "mover", x: 0, y: 0, w: 1, h: 1 },
      { id: "D", x: 0, y: 1, w: 1, h: 1 },
    ],
    movedIds: ["D", "mover"],
    facts: { direction: "right", movedNeighborCount: 1, totalNeighborTravel: 1, maximumNeighborTravel: 1 },
    trace: [{ kind: "push", widgetIds: ["mover", "D"] }],
  };
  const report = auditPlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 0, y: 0, w: 1, h: 1 },
    intent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
    result,
    bounds: { cols: 3, rows: 3 },
  });

  assert.equal(report.severity, "fail");
  assert.ok(report.findings.some((finding) => finding.code === "off-axis-movement"));
});

test("the audit rejects partial movement in a rejected result", () => {
  const widgets = [
    { id: "mover", x: 2, y: 0, w: 1, h: 1 },
    { id: "D", x: 0, y: 0, w: 1, h: 1 },
  ];
  const report = auditPlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 0, y: 0, w: 1, h: 1 },
    intent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
    result: {
      ok: false,
      status: "rejected",
      reason: "invalid-input",
      layout: [
        { id: "mover", x: 2, y: 0, w: 1, h: 1 },
        { id: "D", x: 1, y: 0, w: 1, h: 1 },
      ],
      movedIds: ["D"],
      facts: {},
    },
    bounds: { cols: 3, rows: 2 },
  });

  assert.equal(report.severity, "fail");
  assert.ok(report.findings.some((finding) => finding.code === "partial-rejected-layout"));
});

test("the audit catches a missing rectangle in an accepted result", () => {
  const widgets = [
    { id: "mover", x: 2, y: 0, w: 1, h: 1 },
    { id: "D", x: 0, y: 0, w: 1, h: 1 },
  ];
  const report = auditPlacement({
    widgets,
    moverId: "mover",
    candidate: { x: 0, y: 0, w: 1, h: 1 },
    intent: { kind: "insert", targetId: "D", face: "left", vector: { x: 1, y: 0 } },
    result: {
      ok: true,
      status: "accepted",
      reason: "inserted",
      layout: [{ id: "mover", x: 0, y: 0, w: 1, h: 1 }],
      movedIds: ["mover"],
      facts: {},
      trace: [],
    },
    bounds: { cols: 3, rows: 2 },
  });

  assert.equal(report.severity, "fail");
  assert.ok(report.findings.some((finding) => finding.code === "layout-membership"));
});

test("the bounded 3 by 3 matrix checks every cell and face", () => {
  const audit = runGeneratedNaturalnessAudit();

  assert.equal(audit.summary.total, 36);
  assert.equal(audit.summary.fail, 0);
  assert.equal(new Set(audit.cases.map((entry) => entry.observed.face)).size, 4);
});
