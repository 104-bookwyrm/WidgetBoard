// [key, highlighted element, edit mode the step needs]: render() sets it, so Next and Back never land on a grid step without the grid
const steps = [
  ["tray", "#demo-tray", false], ["edit", "#demo-tray", false], ["grid", "#editbar", true],
  ["move", ".widget:not(.hidden) .w-head", true], ["resize", ".widget:not(.hidden) .w-resize", true],
  ["push", ".widget:not(.hidden)", true], ["menu", ".widget:not(.hidden)", true],
  ["add", "#board", true], ["done", "#edit-done", true], ["end", null, false],
];

const isReturn = (event) => event.key === "Enter" || event.key === "Return";

function startGuide({ t, close, focus }) {
  const target = document.querySelector(`.widget[data-widget="${CSS.escape(focus)}"]`);
  const card = document.createElement("section");
  card.id = "tutorial-card";
  card.setAttribute("role", "region");
  card.setAttribute("aria-labelledby", "tutorial-guide-title");
  card.innerHTML = `<h2 id="tutorial-guide-title"></h2><p id="tutorial-text"></p><div><button id="tutorial-next" type="button"></button></div>`;
  card.querySelector("#tutorial-guide-title").textContent = t(`help.guide.${focus}.title`);
  card.querySelector("#tutorial-text").textContent = t(`help.guide.${focus}.body`);
  card.querySelector("#tutorial-next").textContent = t("tut.finish");
  document.body.append(card);
  target?.classList.add("tutorial-target");
  const finish = () => {
    document.removeEventListener("keydown", onKey);
    target?.classList.remove("tutorial-target");
    card.remove();
    close();
  };
  const onKey = (event) => {
    if (!isReturn(event) || event.repeat || event.target?.closest?.("button, input, textarea, [contenteditable]")) return;
    event.preventDefault();
    finish();
  };
  card.querySelector("#tutorial-next").onclick = finish;
  document.addEventListener("keydown", onKey);
}

export function startTutorial({ t, close, setEdit, focus = null }) {
  if (focus) return startGuide({ t, close, focus });
  let index = 0;
  let target;
  const card = document.createElement("section");
  card.id = "tutorial-card";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", t("tut.title"));
  card.setAttribute("aria-live", "polite");
  card.innerHTML = '<p id="tutorial-count"></p><p id="tutorial-text"></p><div><button id="tutorial-skip" type="button"></button><button id="tutorial-back" type="button"></button><button id="tutorial-next" type="button"></button></div>';
  document.body.append(card);
  const finish = () => {
    document.removeEventListener("tutorial-action", onAction);
    document.removeEventListener("keydown", onKey);
    target?.classList.remove("tutorial-target");
    card.remove();
    close();
  };
  const render = () => {
    target?.classList.remove("tutorial-target");
    const [key, selector, edit] = steps[index];
    setEdit(edit);
    target = selector && document.querySelector(selector);
    target?.classList.add("tutorial-target");
    card.querySelector("#tutorial-count").textContent = `${index + 1} / ${steps.length}`;
    card.querySelector("#tutorial-text").textContent = t(`tut.t1.${key}`);
    card.querySelector("#tutorial-next").textContent = t(index === steps.length - 1 ? "tut.finish" : "tut.next");
    card.querySelector("#tutorial-skip").textContent = t("tut.skip");
    const back = card.querySelector("#tutorial-back");
    back.textContent = t("tut.back");
    back.hidden = index === 0;
  };
  const next = () => { if (index === steps.length - 1) finish(); else { index++; render(); } };
  card.querySelector("#tutorial-next").onclick = next;
  card.querySelector("#tutorial-back").onclick = () => { if (index > 0) { index--; render(); } };
  card.querySelector("#tutorial-skip").onclick = finish;
  const onAction = (event) => {
    if (event.detail === steps[index][0] || (event.detail === "push" && steps[index][0] === "move")) next();
  };
  const onKey = (event) => {
    if (!isReturn(event) || event.repeat || event.target?.closest?.("button, input, textarea, [contenteditable]")) return;
    event.preventDefault();
    next();
  };
  document.addEventListener("tutorial-action", onAction);
  document.addEventListener("keydown", onKey);
  render();
}
