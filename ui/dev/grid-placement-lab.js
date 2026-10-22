import {
  classifyFaceIntent,
  normalizeScenario,
  resolveLegacy,
  solveFacePlacement,
} from "./grid-placement-engine.js";
import { AUDIT_CASES, runNaturalnessAudit } from "./grid-placement-audit.js";

const $ = (selector) => document.querySelector(selector);
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const clone = (value) => structuredClone(value);
const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const SCENARIOS = {
  divergence: {
    name: "Clear exit versus chosen face",
    note: "Drag M onto A from its left edge. The current resolver prefers empty space below. The face resolver pushes the row right.",
    bounds: { cols: 8, rows: 5 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 7, y: 0, w: 1, h: 1 },
      { id: "A", x: 2, y: 1, w: 1, h: 1 },
      { id: "B", x: 3, y: 1, w: 1, h: 1 },
      { id: "C", x: 5, y: 3, w: 2, h: 1 },
    ],
  },
  empty: {
    name: "Empty cell versus insertion",
    note: "Drop M in the cell beside D for a free move. Enter D's inner edge to request an insertion.",
    bounds: { cols: 10, rows: 6 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 8, y: 4, w: 1, h: 1 },
      { id: "D", x: 4, y: 2, w: 1, h: 1 },
      { id: "A", x: 1, y: 0, w: 2, h: 2 },
      { id: "B", x: 7, y: 1, w: 2, h: 1 },
    ],
  },
  top: {
    name: "Top-edge insertion",
    note: "B touches the board's top edge. Its nearest top face pushes B downward.",
    bounds: { cols: 10, rows: 6 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 8, y: 4, w: 1, h: 1 },
      { id: "B", x: 2, y: 0, w: 2, h: 2 },
      { id: "C", x: 5, y: 2, w: 2, h: 1 },
    ],
  },
  blocked: {
    name: "Blocked directional chain",
    note: "Insert M into D's left face. The face-directed chain reaches the right boundary and locks the whole move.",
    bounds: { cols: 6, rows: 6 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 0, y: 4, w: 1, h: 1 },
      { id: "D", x: 2, y: 2, w: 1, h: 1 },
      { id: "E", x: 3, y: 2, w: 1, h: 1 },
      { id: "F", x: 4, y: 2, w: 1, h: 1 },
      { id: "G", x: 5, y: 2, w: 1, h: 1 },
    ],
  },
  large: {
    name: "Large mover with several contacts",
    note: "M can cover several rectangles. The pointer and contact geometry choose one face. Every downstream push uses that direction.",
    bounds: { cols: 12, rows: 8 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 9, y: 5, w: 2, h: 2 },
      { id: "A", x: 3, y: 2, w: 2, h: 2 },
      { id: "B", x: 5, y: 2, w: 2, h: 1 },
      { id: "C", x: 5, y: 3, w: 1, h: 1 },
      { id: "D", x: 7, y: 2, w: 2, h: 2 },
    ],
  },
  hidden: {
    name: "Hidden reservation",
    note: "H reserves a cell. The current resolver can move it. The face-directed resolver treats it as a fixed obstacle.",
    bounds: { cols: 9, rows: 6 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 7, y: 4, w: 1, h: 1 },
      { id: "D", x: 2, y: 2, w: 1, h: 1 },
      { id: "H", x: 3, y: 2, w: 1, h: 1, hidden: true },
      { id: "A", x: 6, y: 1, w: 2, h: 2 },
    ],
  },
  branch: {
    name: "Branched collision chain",
    note: "A wide contact can start more than one branch. Canonical ID order keeps the face result stable across input order.",
    bounds: { cols: 11, rows: 7 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 8, y: 5, w: 2, h: 2 },
      { id: "A", x: 3, y: 2, w: 1, h: 2 },
      { id: "B", x: 4, y: 2, w: 1, h: 1 },
      { id: "C", x: 4, y: 3, w: 2, h: 1 },
      { id: "D", x: 5, y: 2, w: 1, h: 1 },
    ],
  },
  corner: {
    name: "Corner hysteresis",
    note: "Move M around D's top-left corner. The active face resists small score changes and switches after a clear challenge.",
    bounds: { cols: 10, rows: 7 },
    selectedId: "M",
    widgets: [
      { id: "M", x: 7, y: 4, w: 2, h: 2 },
      { id: "D", x: 3, y: 1, w: 2, h: 2 },
      { id: "A", x: 6, y: 1, w: 2, h: 2 },
    ],
  },
};

const state = {
  scenarioKey: "divergence",
  bounds: { cols: 8, rows: 5 },
  widgets: [],
  selectedId: "M",
  phase: "idle",
  rawRect: null,
  candidate: null,
  pointer: null,
  intent: null,
  legacy: null,
  face: null,
  drag: null,
  audit: null,
  auditCaseNote: null,
};

function selected() {
  return state.widgets.find((rect) => rect.id === state.selectedId) ?? state.widgets[0];
}

function removeAuditScenarioOption() {
  $("#scenario option[value='audit']")?.remove();
}

function loadScenario(key) {
  removeAuditScenarioOption();
  const scenario = normalizeScenario(clone(SCENARIOS[key]));
  state.scenarioKey = key;
  state.bounds = scenario.bounds;
  state.widgets = scenario.widgets;
  state.selectedId = scenario.selectedId;
  state.auditCaseNote = null;
  clearComparison();
  render();
}

function clearComparison() {
  state.phase = "idle";
  state.rawRect = null;
  state.candidate = null;
  state.pointer = null;
  state.intent = null;
  state.legacy = null;
  state.face = null;
  state.drag = null;
}

function evaluate() {
  state.intent = classifyFaceIntent({
    widgets: state.widgets,
    moverId: state.selectedId,
    rawRect: state.rawRect,
    candidate: state.candidate,
    pointer: state.pointer,
    priorIntent: state.intent,
    bounds: state.bounds,
  });
  state.legacy = resolveLegacy({
    widgets: state.widgets,
    moverId: state.selectedId,
    candidate: state.candidate,
    bounds: state.bounds,
  });
  state.face = solveFacePlacement({
    widgets: state.widgets,
    moverId: state.selectedId,
    candidate: state.candidate,
    bounds: state.bounds,
    intent: state.intent,
  });
}

function pointOnBoard(event, board) {
  const box = board.getBoundingClientRect();
  return {
    x: clamp(((event.clientX - box.left) / box.width) * state.bounds.cols, 0, state.bounds.cols),
    y: clamp(((event.clientY - box.top) / box.height) * state.bounds.rows, 0, state.bounds.rows),
  };
}

function startDrag(event) {
  const rectElement = event.target.closest(".rect");
  if (!rectElement || event.button !== 0) return;
  if (state.phase === "frozen") {
    setSession("rejected", "Comparison frozen", "Choose a baseline or clear the comparison first.");
    return;
  }
  const board = event.currentTarget;
  const id = rectElement.dataset.id;
  state.selectedId = id;
  const rect = selected();
  const point = pointOnBoard(event, board);
  state.drag = {
    pointerId: event.pointerId,
    board,
    offsetX: point.x - rect.x,
    offsetY: point.y - rect.y,
  };
  state.phase = "dragging";
  state.rawRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  state.candidate = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  state.pointer = point;
  state.intent = null;
  board.setPointerCapture?.(event.pointerId);
  evaluate();
  render();
  event.preventDefault();
}

function moveDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  const rect = selected();
  const point = pointOnBoard(event, state.drag.board);
  const rawX = clamp(point.x - state.drag.offsetX, 0, state.bounds.cols - rect.w);
  const rawY = clamp(point.y - state.drag.offsetY, 0, state.bounds.rows - rect.h);
  state.pointer = point;
  state.rawRect = { x: rawX, y: rawY, w: rect.w, h: rect.h };
  state.candidate = {
    x: clamp(Math.round(rawX), 0, state.bounds.cols - rect.w),
    y: clamp(Math.round(rawY), 0, state.bounds.rows - rect.h),
    w: rect.w,
    h: rect.h,
  };
  evaluate();
  render();
}

function finishDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  state.drag.board.releasePointerCapture?.(event.pointerId);
  state.drag = null;
  state.phase = "frozen";
  render();
}

function cancelDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  clearComparison();
  render();
}

function layoutFor(engine) {
  const result = engine === "legacy" ? state.legacy : state.face;
  return result?.ok ? result.layout : state.widgets;
}

function rectHtml(rect, result) {
  const moved = new Set(result?.movedIds ?? []);
  const classes = [
    "rect",
    rect.id === state.selectedId ? "selected" : "",
    moved.has(rect.id) ? "moved" : "",
    rect.hidden ? "hidden-reservation" : "",
    rect.fixed ? "fixed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${classes}" tabindex="0" data-id="${esc(rect.id)}" style="--x:${rect.x};--y:${rect.y};--w:${rect.w};--h:${rect.h}">
    <strong>${esc(rect.id)}</strong><small>${rect.x},${rect.y} · ${rect.w}×${rect.h}</small>
  </div>`;
}

function arrowHtml(start, end, markerId) {
  const x1 = start.x + start.w / 2;
  const y1 = start.y + start.h / 2;
  const x2 = end.x + end.w / 2;
  const y2 = end.y + end.h / 2;
  if (x1 === x2 && y1 === y2) return "";
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${markerId})" />`;
}

function renderBoard(board, engine) {
  const result = engine === "legacy" ? state.legacy : state.face;
  const layout = layoutFor(engine);
  board.style.setProperty("--cols", state.bounds.cols);
  board.style.setProperty("--rows", state.bounds.rows);
  const startById = new Map(state.widgets.map((rect) => [rect.id, rect]));
  const markerId = `${engine}-arrow-head`;
  const arrows = result?.ok
    ? layout.map((rect) => arrowHtml(startById.get(rect.id), rect, markerId)).join("")
    : "";
  const candidate = state.candidate
    ? `<div class="candidate" style="--x:${state.candidate.x};--y:${state.candidate.y};--w:${state.candidate.w};--h:${state.candidate.h}"></div>`
    : "";
  const raw = state.rawRect
    ? `<div class="raw-rect" style="--x:${state.rawRect.x};--y:${state.rawRect.y};--w:${state.rawRect.w};--h:${state.rawRect.h}"></div>`
    : "";
  const pointer = state.pointer
    ? `<div class="pointer-dot" style="--x:${state.pointer.x};--y:${state.pointer.y}"></div>`
    : "";
  let face = "";
  if (engine === "face" && state.intent?.kind === "insert") {
    const target = state.widgets.find((rect) => rect.id === state.intent.targetId);
    if (target) {
      face = `<div class="face-indicator" data-face="${state.intent.face}" style="--x:${target.x};--y:${target.y};--w:${target.w};--h:${target.h}"></div>`;
    }
  }
  board.innerHTML = `
    ${layout.map((rect) => rectHtml(rect, result)).join("")}
    <svg class="board-arrows" viewBox="0 0 ${state.bounds.cols} ${state.bounds.rows}" preserveAspectRatio="none" aria-hidden="true">
      <defs><marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path></marker></defs>
      ${arrows}
    </svg>
    ${candidate}${raw}${face}${pointer}`;
}

const REASONS = {
  "free-placement": "Accepted as an empty destination.",
  inserted: "Accepted with a face-directed push.",
  resolved: "Accepted by the current recursive search.",
  occupied: "Rejected because occupied space received free-placement intent.",
  "blocked-boundary": "Locked because the chosen direction crosses the board edge.",
  "fixed-obstacle": "Locked because a hidden or fixed rectangle blocks the chain.",
  "target-not-occupied": "Rejected because the snapped candidate does not occupy the selected target.",
  "no-layout": "Rejected because the current search found no layout.",
  "fixed-cycle": "Rejected because the current search met a fixed recursive branch.",
  "search-limit": "Rejected because the current search used its step budget.",
  "depth-limit": "Rejected because the current search reached its depth limit.",
};

function renderResult(engine) {
  const result = engine === "legacy" ? state.legacy : state.face;
  const chip = $(`#${engine}-status`);
  const summary = $(`#${engine}-summary`);
  chip.className = "result-chip";
  if (!result) {
    chip.textContent = "Idle";
    chip.dataset.status = "idle";
    summary.textContent = "No gesture has been evaluated.";
    return;
  }
  const status = engine === "face" ? result.status : result.ok ? "accepted" : "rejected";
  chip.textContent = status[0].toUpperCase() + status.slice(1);
  chip.dataset.status = status;
  chip.classList.add(status);
  const movement = result.movedIds?.length ? ` Changed: ${result.movedIds.join(", ")}.` : " No rectangle changed.";
  const explanation = REASONS[result.reason] ?? `${result.reason}.`;
  summary.textContent = `${explanation}${movement}`;
}

function traceItem(step) {
  return `<li data-kind="${esc(step.kind ?? "info")}"><strong>${esc(step.title)}</strong><span>${esc(step.detail ?? "")}</span></li>`;
}

function renderTrace(engine) {
  const list = $(`#${engine}-trace`);
  const result = engine === "legacy" ? state.legacy : state.face;
  if (!result) {
    list.innerHTML = `<li class="empty-trace">Drag a rectangle to produce a trace.</li>`;
    return;
  }
  const steps = [];
  if (engine === "face") {
    if (state.intent?.kind === "insert") {
      const ranked = state.intent.candidates
        .slice(0, 4)
        .map((entry) => `${entry.targetId}.${entry.face} ${entry.distance.toFixed(2)} cells`)
        .join("; ");
      steps.push({
        kind: "intent",
        title: `${state.intent.retained ? "Retain" : "Select"} ${state.intent.targetId}.${state.intent.face}`,
        detail: ranked
          ? `Nearest faces: ${ranked}. Selection: ${state.intent.selectionReason}.`
          : "The target face has the shortest cursor distance.",
      });
    } else {
      steps.push({
        kind: "intent",
        title: "Free placement intent",
        detail: "The snapped candidate occupies no existing rectangle.",
      });
    }
  }
  steps.push(...(result.trace ?? []));
  if (!steps.length) {
    steps.push({ kind: result.ok ? "accept" : "reject", title: result.ok ? "Accepted" : "Rejected", detail: REASONS[result.reason] ?? result.reason });
  }
  list.innerHTML = steps.map(traceItem).join("");
}

function renderInspector() {
  const rect = selected();
  if (!rect) return;
  $("#selected-name").textContent = `${rect.id} is the next dragged rectangle.`;
  for (const key of ["x", "y", "w", "h"]) $(`#rect-${key}`).value = rect[key];
  $("#rect-hidden").checked = !!rect.hidden;
  $("#rect-fixed").checked = !!rect.fixed;
  $("#board-cols").value = state.bounds.cols;
  $("#board-rows").value = state.bounds.rows;
  $("#remove-rect").disabled = state.widgets.length < 2;
  const data = state.intent?.kind === "insert"
    ? [
        ["kind", "insertion"],
        ["target", state.intent.targetId],
        ["face", state.intent.face],
        ["vector", `${state.intent.vector.x}, ${state.intent.vector.y}`],
        ["distance", state.intent.distance.toFixed(3)],
        ["selected by", state.intent.selectionReason],
        ["retained", state.intent.retained ? "yes" : "no"],
      ]
    : [["kind", state.intent?.kind ?? "none"]];
  const intentData = $("#intent-data");
  intentData.dataset.face = state.intent?.face ?? "none";
  intentData.innerHTML = data.map(([term, value]) => `<dt>${esc(term)}</dt><dd>${esc(value)}</dd>`).join("");
  renderMovementFacts();
}

function renderMovementFacts() {
  const output = $("#movement-facts");
  const result = state.face;
  const facts = result?.facts;
  output.dataset.neighbours = String(facts?.movedNeighborCount ?? 0);
  if (!result) {
    output.innerHTML = `<dt>status</dt><dd>idle</dd>`;
    return;
  }
  const rows = [
    ["status", result.status],
    ["direction", facts?.direction ?? "none"],
    ["neighbours", facts?.movedNeighborCount ?? 0],
    ["total travel", facts?.totalNeighborTravel ?? 0],
    ["longest travel", facts?.maximumNeighborTravel ?? 0],
  ];
  if (result.status === "locked") rows.push(["locked by", REASONS[result.reason] ?? result.reason]);
  if ((facts?.movedNeighborCount ?? 0) >= 4) rows.push(["review", "Broad reorganization"]);
  output.innerHTML = rows.map(([term, value]) => `<dt>${esc(term)}</dt><dd>${esc(value)}</dd>`).join("");
}

function setSession(status, title, detail) {
  $("#status-light").dataset.state = status;
  $("#gesture-state").textContent = title;
  $("#gesture-detail").textContent = detail;
}

function renderSession() {
  if (state.phase === "dragging") {
    const face = state.intent?.kind === "insert" ? `${state.intent.targetId}.${state.intent.face}` : "free placement";
    setSession("dragging", `Evaluating ${face}`, `Snapped cell ${state.candidate.x},${state.candidate.y}.`);
  } else if (state.phase === "frozen") {
    const status = state.face?.status === "locked" ? "locked" : !state.legacy?.ok || !state.face?.ok ? "rejected" : "ready";
    const title = status === "locked" ? "Movement locked" : "Comparison frozen";
    setSession(status, title, "Inspect the traces or choose the next baseline.");
  } else {
    setSession("ready", "Ready to drag", "Choose a rectangle and drag it on either board.");
  }
}

function render() {
  const scenario = SCENARIOS[state.scenarioKey];
  $("#scenario").value = state.scenarioKey;
  $("#scenario-note").textContent = state.auditCaseNote ?? scenario?.note ?? "Imported or generated scenario.";
  renderBoard($("#legacy-board"), "legacy");
  renderBoard($("#face-board"), "face");
  renderResult("legacy");
  renderResult("face");
  renderTrace("legacy");
  renderTrace("face");
  renderInspector();
  renderSession();
  $("#frozen-actions").hidden = state.phase !== "frozen";
  $("#adopt-legacy").disabled = !state.legacy?.ok;
  $("#adopt-face").disabled = !state.face?.ok;
}

function adopt(engine) {
  const result = engine === "legacy" ? state.legacy : state.face;
  if (!result?.ok) return;
  state.widgets = result.layout.map((rect) => ({ ...rect }));
  clearComparison();
  render();
}

function updateSelected(key, value) {
  const rect = selected();
  if (!rect || !Number.isInteger(value)) return;
  if (key === "w") rect.w = clamp(value, 1, state.bounds.cols - rect.x);
  if (key === "h") rect.h = clamp(value, 1, state.bounds.rows - rect.y);
  if (key === "x") rect.x = clamp(value, 0, state.bounds.cols - rect.w);
  if (key === "y") rect.y = clamp(value, 0, state.bounds.rows - rect.h);
  clearComparison();
  render();
}

function updateBounds() {
  const cols = clamp(Number($("#board-cols").value) || state.bounds.cols, 2, 24);
  const rows = clamp(Number($("#board-rows").value) || state.bounds.rows, 2, 24);
  state.bounds = { cols, rows };
  for (const rect of state.widgets) {
    rect.w = clamp(rect.w, 1, cols);
    rect.h = clamp(rect.h, 1, rows);
    rect.x = clamp(rect.x, 0, cols - rect.w);
    rect.y = clamp(rect.y, 0, rows - rect.h);
  }
  clearComparison();
  render();
}

function nextId() {
  let index = 1;
  while (state.widgets.some((rect) => rect.id === `R${index}`)) index++;
  return `R${index}`;
}

function addRectangle() {
  for (let y = 0; y < state.bounds.rows; y++) {
    for (let x = 0; x < state.bounds.cols; x++) {
      const rect = { id: nextId(), x, y, w: 1, h: 1 };
      if (state.widgets.some((other) => overlaps(rect, other))) continue;
      state.widgets.push(rect);
      state.selectedId = rect.id;
      clearComparison();
      render();
      return;
    }
  }
  setSession("rejected", "No empty cell", "Resize the board or remove a rectangle.");
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function generateLayout() {
  removeAuditScenarioOption();
  const random = seededRandom(Number($("#seed").value) || 17);
  const widgets = [];
  for (let index = 0; index < 8; index++) {
    const w = random() > 0.65 ? 2 : 1;
    const h = random() > 0.72 ? 2 : 1;
    let placed = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      const rect = {
        id: index === 0 ? "M" : String.fromCharCode(64 + index),
        x: Math.floor(random() * (state.bounds.cols - w + 1)),
        y: Math.floor(random() * (state.bounds.rows - h + 1)),
        w,
        h,
      };
      if (!widgets.some((other) => overlaps(rect, other))) {
        placed = rect;
        break;
      }
    }
    if (placed) widgets.push(placed);
  }
  if (!widgets.length) return;
  state.scenarioKey = "generated";
  state.auditCaseNote = null;
  state.widgets = widgets;
  state.selectedId = widgets[0].id;
  clearComparison();
  render();
}

function exportJson() {
  $("#scenario-json").value = JSON.stringify(
    { bounds: state.bounds, selectedId: state.selectedId, widgets: state.widgets },
    null,
    2,
  );
  $("#json-message").textContent = "Current baseline exported.";
}

function importJson() {
  try {
    const scenario = normalizeScenario(JSON.parse($("#scenario-json").value));
    removeAuditScenarioOption();
    state.scenarioKey = "imported";
    state.auditCaseNote = null;
    state.bounds = scenario.bounds;
    state.widgets = scenario.widgets;
    state.selectedId = scenario.selectedId;
    clearComparison();
    $("#json-message").textContent = "Scenario imported.";
    render();
  } catch (error) {
    $("#json-message").textContent = error.message;
  }
}

function renderAudit() {
  if (!state.audit) return;
  const panel = $("#audit-panel");
  const { summary, cases } = state.audit;
  Object.assign(panel.dataset, {
    total: String(summary.total),
    pass: String(summary.pass),
    review: String(summary.review),
    fail: String(summary.fail),
  });
  $("#audit-total").textContent = summary.total;
  $("#audit-pass").textContent = summary.pass;
  $("#audit-review").textContent = summary.review;
  $("#audit-fail").textContent = summary.fail;
  $("#run-audit").textContent = `Run ${summary.total} checks`;
  const curatedIds = new Set(AUDIT_CASES.map((entry) => entry.id));
  const curated = cases.filter((entry) => curatedIds.has(entry.id));
  const generated = cases.filter((entry) => !curatedIds.has(entry.id));
  const row = (entry) => {
    const findingText = entry.findings.map((item) => item.message).join(" ");
    return `<article class="audit-case" data-severity="${entry.severity}">
      <span class="audit-mark">${entry.severity}</span>
      <div><strong>${esc(entry.name)}</strong><p>${esc(entry.expectation)}</p><small>${esc(findingText)}</small></div>
      <div class="audit-observed"><span>${esc(entry.observed.face ?? "free")}</span><span>${esc(entry.observed.status)}</span></div>
      <button type="button" data-audit-id="${esc(entry.id)}">Inspect</button>
    </article>`;
  };
  const generatedFailures = generated.filter((entry) => entry.severity === "fail").length;
  const matrix = `<article class="audit-case audit-matrix" data-severity="${generatedFailures ? "fail" : "pass"}">
    <span class="audit-mark">${generatedFailures ? "fail" : "pass"}</span>
    <div><strong>3 × 3 face matrix</strong><p>Every cell is tested against top, right, bottom, and left contact.</p><small>${generated.length} cases · ${generatedFailures} invariant failures</small></div>
    <div class="audit-observed"><span>4 faces</span><span>${generated.length} checks</span></div>
  </article>`;
  const results = $("#audit-results");
  results.innerHTML = curated.map(row).join("") + matrix;
  results.scrollTop = 0;
}

function runAudit() {
  state.audit = runNaturalnessAudit();
  renderAudit();
}

function inspectAuditCase(id) {
  const entry = state.audit?.cases.find((candidate) => candidate.id === id);
  if (!entry) return;
  clearComparison();
  let option = $("#scenario option[value='audit']");
  if (!option) {
    option = document.createElement("option");
    option.value = "audit";
    option.disabled = true;
    $("#scenario").append(option);
  }
  option.textContent = `Audit: ${entry.name}`;
  state.scenarioKey = "audit";
  state.bounds = clone(entry.scenario.bounds);
  state.widgets = clone(entry.scenario.widgets);
  state.selectedId = entry.scenario.selectedId;
  state.auditCaseNote = `Audit case: ${entry.name}. ${entry.expectation}`;
  state.rawRect = clone(entry.candidate);
  state.candidate = clone(entry.candidate);
  state.pointer = clone(entry.pointer);
  state.intent = entry.priorIntent ? clone(entry.priorIntent) : null;
  evaluate();
  state.phase = "frozen";
  render();
}

for (const [key, scenario] of Object.entries(SCENARIOS)) {
  $("#scenario").insertAdjacentHTML("beforeend", `<option value="${key}">${esc(scenario.name)}</option>`);
}

for (const board of document.querySelectorAll(".board")) {
  board.addEventListener("pointerdown", startDrag);
}
addEventListener("pointermove", moveDrag);
addEventListener("pointerup", finishDrag);
addEventListener("pointercancel", cancelDrag);

$("#scenario").addEventListener("change", (event) => loadScenario(event.target.value));
$("#reset").addEventListener("click", () => loadScenario(state.scenarioKey in SCENARIOS ? state.scenarioKey : "divergence"));
$("#randomize").addEventListener("click", generateLayout);
$("#adopt-legacy").addEventListener("click", () => adopt("legacy"));
$("#adopt-face").addEventListener("click", () => adopt("face"));
$("#clear-preview").addEventListener("click", () => (clearComparison(), render()));
for (const key of ["x", "y", "w", "h"]) {
  $(`#rect-${key}`).addEventListener("change", (event) => updateSelected(key, Number(event.target.value)));
}
$("#rect-hidden").addEventListener("change", (event) => {
  const rect = selected();
  if (event.target.checked) rect.hidden = true;
  else delete rect.hidden;
  clearComparison();
  render();
});
$("#rect-fixed").addEventListener("change", (event) => {
  const rect = selected();
  if (event.target.checked) rect.fixed = true;
  else delete rect.fixed;
  clearComparison();
  render();
});
$("#board-cols").addEventListener("change", updateBounds);
$("#board-rows").addEventListener("change", updateBounds);
$("#add-rect").addEventListener("click", addRectangle);
$("#remove-rect").addEventListener("click", () => {
  if (state.widgets.length < 2) return;
  state.widgets = state.widgets.filter((rect) => rect.id !== state.selectedId);
  state.selectedId = state.widgets[0].id;
  clearComparison();
  render();
});
$("#export-json").addEventListener("click", exportJson);
$("#import-json").addEventListener("click", importJson);
$("#run-audit").addEventListener("click", runAudit);
$("#audit-results").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-audit-id]");
  if (button) inspectAuditCase(button.dataset.auditId);
});

loadScenario("divergence");
runAudit();
