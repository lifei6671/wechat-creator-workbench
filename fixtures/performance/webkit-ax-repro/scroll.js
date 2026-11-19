// Run in the Web Inspector console of a macOS debug build with VITE_EDITOR_PERF=1.
const { view } = window.__workbenchEditorPerformance.editors.values().next().value;
const editor = view.dom;
const scroller = editor.closest(".editor-scroll");
scroller.style.width = "660px";
scroller.style.flex = "none";
const code = editor.querySelector(".rich-code-block code");
scroller.style.height = code ? "290px" : "726px";

const marker = document.createElement("div");
const status = marker.appendChild(document.createTextNode("AXTEST ready"));
marker.style.cssText = "position:fixed;top:65px;left:60px;z-index:99999";
document.body.prepend(marker);
editor.focus({ preventScroll: true });
const editDiagram = editor.querySelector(".rich-mermaid .rich-graphic-edit");
if (editDiagram) {
  editDiagram.click();
} else if (code) {
  window.getSelection().collapse(code, 0);
}

let step = 0;
const interval = setInterval(() => {
  const last = scroller.scrollHeight - scroller.clientHeight;
  const y = Math.min(code ? step * 35 : 207, last);
  step++;
  if ((y === last && step > 5) || (!code && step > 14)) {
    clearInterval(interval);
    status.data = "AXTEST done";
    return;
  }
  scroller.scrollTop = y;
  const rect = scroller.getBoundingClientRect();
  const range = document.caretRangeFromPoint(rect.left + 220, rect.top + 65);
  if (range && editor.contains(range.startContainer)) {
    window.getSelection().collapse(range.startContainer, range.startOffset);
  }
  const active = editor.querySelector(".rich-code-active pre")?.dataset.language ?? "";
  status.data = `AXTEST y=${scroller.scrollTop} active=${active}`;
}, 110);
