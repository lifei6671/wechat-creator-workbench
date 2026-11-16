import { computePosition, flip, offset, shift, size } from "@floating-ui/react";
import { NodeSelection, Plugin, TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { calloutLabels } from "../markdown-core/callouts";
import type { EditorCommand } from "./commands";
import { editorIconButton } from "./image-view";

type Media = "图片" | "视频" | "音频" | "文件" | "白板";
type Action = { command: EditorCommand; value?: string } | { markdown: string } | { media: Media } | { text: () => string };
type Item = { label: string; icon: string; aliases?: string; shortcut?: string } & ({ action: Action } | { children: Item[] });
type MenuRange = { from: number; to: number; query: string };

const command = (label: string, icon: string, name: EditorCommand, aliases: string, shortcut?: string): Item =>
  ({ label, icon, aliases, shortcut, action: { command: name } });
const markdown = (label: string, icon: string, text: string, aliases: string): Item =>
  ({ label, icon, aliases, action: { markdown: text } });
const media = (label: Media, icon: string, aliases: string): Item => ({ label, icon, aliases, action: { media: label } });
const date = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" });
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const groups: { name: string; items: Item[] }[] = [
  { name: "标题", items: [
    command("标题 1", "H₁", "heading1", "h1 heading 一级标题", "Alt+1"),
    command("标题 2", "H₂", "heading2", "h2 heading 二级标题", "Alt+2"),
    command("标题 3", "H₃", "heading3", "h3 heading 三级标题", "Alt+3"),
  ] },
  { name: "基本块", items: [
    command("引用", "❞", "quote", "quote blockquote"),
    { label: "标注", icon: "▤", aliases: "callout admonition", children: Object.entries(calloutLabels).map(([type, label]) =>
      markdown(label, "▤", `> [!${type.toUpperCase()}]\n> 内容`, type)) },
  ] },
  { name: "基础", items: [
    command("编号列表", "≣", "orderedList", "ol numbered ordered 有序列表", "Alt+7"),
    command("项目符号列表", "≡", "bulletList", "ul bullet unordered 无序列表", "Alt+8"),
    command("检查清单", "☑", "taskList", "todo task checklist 待办"),
    command("段落", "¶", "paragraph", "paragraph 正文", "Alt+0"),
    command("代码块", "‹›", "codeBlock", "code 代码", "Alt+C"),
  ] },
  { name: "基础区块", items: [command("分隔线", "−", "horizontalRule", "hr divider horizontal rule")] },
  { name: "高级功能", items: [command("表格", "▦", "table", "table grid")] },
  { name: "媒体", items: [
    media("图片", "▧", "image photo"), media("视频", "▷", "video"), media("音频", "♫", "audio"), media("文件", "▯", "file attachment"),
    markdown("Mermaid", "◇", "```mermaid\nflowchart TD\n  A[开始] --> B[结束]\n```", "diagram flowchart graph 流程图"),
    command("数学", "π", "mathBlock", "math latex formula 公式"),
    markdown("HTML 块", "‹›", "```html\n<div></div>\n```", "html embed"),
    media("白板", "◇", "whiteboard drawing canvas sketch"),
  ] },
  { name: "副标题", items: [command("标题 4", "H₄", "heading4", "h4 heading 四级标题", "Alt+4")] },
  { name: "其他", items: [
    { label: "表情符号", icon: "☺", aliases: "emoji", children: [
      ["微笑", "🙂"], ["笑脸", "😄"], ["庆祝", "🎉"], ["点赞", "👍"], ["爱心", "❤️"], ["星星", "⭐"],
      ["提示", "💡"], ["火焰", "🔥"], ["完成", "✅"], ["警示", "⚠️"], ["笔记", "📝"], ["书签", "🔖"],
    ].map(([label, icon]) => ({ label, icon, action: { text: () => icon } })) },
    { label: "日期", icon: "▦", aliases: "date today", action: { text: () => date.format(new Date()) } },
    { label: "时间", icon: "◷", aliases: "time clock", action: { text: () => time.format(new Date()) } },
    { label: "日期和时间", icon: "▦", aliases: "datetime timestamp", action: { text: () => {
      const now = new Date();
      return `${date.format(now)} ${time.format(now)}`;
    } } },
  ] },
];

function typedRange(view: EditorView, buttonStart?: number): MenuRange | undefined {
  const { selection } = view.state;
  if (!selection.empty || !(selection instanceof TextSelection)) return;
  const { $from } = selection;
  if ($from.depth !== 1 || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return;
  const text = $from.parent.textBetween(0, $from.parentOffset, "", "\uFFFC");
  const match = buttonStart === $from.start() ? /^([^\/／\n]{0,60})$/.exec(text) : /^[ \t]*[\/／]([^\/／\n]{0,60})$/.exec(text);
  if (match && !match[1].includes("\uFFFC")) return { from: $from.start(), to: $from.pos, query: match[1].trim().toLowerCase() };
}

interface Options {
  canEdit(view: EditorView): boolean;
  command(view: EditorView, command: EditorCommand, value?: string): void;
  insertMarkdown(view: EditorView, source: string): void;
  insertImage(view: EditorView, src: string): void;
  importImages(view: EditorView, files: File[]): void;
  canImportImages(): boolean;
}

export function editorBlockTools(options: Options) {
  let menu: ReturnType<typeof mountTools> | undefined;
  return new Plugin({
    props: {
      handleDOMEvents: {
        keydown: (_view, event) => menu?.isOpen() === true && (event.isComposing || event.keyCode === 229),
      },
      handleKeyDown: (view, event) => menu?.keyDown(view, event) ?? false,
    },
    view(view) {
      menu = mountTools(view, options);
      return {
        update: () => menu?.update(),
        destroy: () => { menu?.destroy(); menu = undefined; },
      };
    },
  });
}

function mountTools(view: EditorView, options: Options) {
  const root = view.dom.parentElement!;
  const scroller = root.closest<HTMLElement>(".editor-scroll")!;
  const menu = document.createElement("div");
  menu.className = "rich-slash-menu";
  menu.setAttribute("aria-label", "插入命令");
  menu.hidden = true;
  root.append(menu);

  const actions = document.createElement("div");
  actions.className = "rich-block-actions";
  actions.dataset.show = "false";
  const plus = editorIconButton("在下方插入区块", "plus");
  const grip = document.createElement("div");
  grip.className = "plain-button chrome-icon";
  grip.setAttribute("role", "img");
  grip.setAttribute("aria-label", "拖动区块");
  grip.dataset.tooltip = "拖动区块";
  grip.append(...editorIconButton("拖动区块", "grip").childNodes);
  actions.append(plus, grip);
  root.append(actions);
  for (const type of ["transitionrun", "transitionend", "transitioncancel"] as const) {
    actions.addEventListener(type, event => {
      if (event.target === actions && event.propertyName === "top") actions.toggleAttribute("data-moving", type === "transitionrun");
    });
  }
  let hovered: { el: HTMLElement; selection: NodeSelection; anchor: HTMLElement } | undefined;

  function hideActions() {
    hovered = undefined;
    actions.dataset.show = "false";
  }

  function hoverBlock(event: PointerEvent) {
    if (drag || !menu.hidden || view.composing || !options.canEdit(view)) return;
    const hit = event.target;
    if (!(hit instanceof Element) || actions.contains(hit)) return;
    if (hovered && event.clientX < hovered.el.getBoundingClientRect().left) {
      const { top, bottom } = hovered.anchor.getBoundingClientRect();
      if (event.clientY >= top && event.clientY <= bottom) return;
    }
    let el = view.dom.contains(hit) ? hit : null;
    while (el && el !== view.dom && el.parentElement !== view.dom && !el.matches("li, .rich-table")) el = el.parentElement;
    if (!(el instanceof HTMLElement) || el === view.dom ||
      el.closest('[data-type="footnote_definition"]')) { hideActions(); return; }
    if (hovered?.el === el && hovered.selection.$from.doc === view.state.doc) return;

    const parent = el.parentElement!;
    const position = view.posAtDOM(parent, Array.from(parent.childNodes).indexOf(el), -1);
    const { doc } = view.state;
    const node = doc.nodeAt(position);
    if (!node || view.nodeDOM(position) !== el || !NodeSelection.isSelectable(node)) { hideActions(); return; }

    const heading = node.type.name === "heading";
    const listItem = node.type.name === "list_item";
    const table = node.type.name === "table";
    const hideInsert = heading || table;
    const anchor = (listItem ? el.firstElementChild as HTMLElement : table ? el.querySelector("tr") : el) ?? el;
    const next = { el, anchor, selection: NodeSelection.create(doc, position) };
    hovered = next;
    actions.toggleAttribute("data-slide", actions.dataset.show === "true" && plus.hidden === hideInsert);
    plus.hidden = hideInsert;
    const lineHeight = table ? anchor.getBoundingClientRect().height : parseFloat(getComputedStyle(anchor).lineHeight);
    void computePosition(anchor, actions, {
      placement: "left-start",
      middleware: [offset({
        mainAxis: heading ? 26 : listItem ? 28 : table ? 12 : 4,
        crossAxis: Number.isFinite(lineHeight) ? (lineHeight - actions.offsetHeight) / 2 : 0,
      })],
    }).then(({ x, y }) => {
      if (hovered !== next) return;
      Object.assign(actions.style, { left: `${x}px`, top: `${y}px` });
      actions.dataset.show = "true";
    });
  }
  const dropLine = document.createElement("div");
  dropLine.className = "rich-block-drop-line";
  dropLine.hidden = true;
  const preview = document.createElement("div");
  preview.className = "rich-block-drag-preview";
  preview.inert = true;
  preview.hidden = true;
  root.append(dropLine, preview);
  let drag: {
    pointerId: number;
    selection: NodeSelection;
    source: HTMLElement;
    x: number;
    y: number;
    moving: boolean;
  } | undefined;

  function blockBoundary(selection: NodeSelection, y: number) {
    const { $from } = selection;
    const start = $from.start();
    if ($from.depth) {
      const parent = view.nodeDOM($from.before()) as HTMLElement;
      const { top, bottom } = parent.getBoundingClientRect();
      if (y < top || y > bottom) return;
    }
    let before: { at: number; y: number; rect: DOMRect } | undefined;
    let last: typeof before;
    $from.parent.forEach((node, offset) => {
      if (before || node.type.name === "footnote_definition") return;
      const at = start + offset;
      const element = view.nodeDOM(at);
      if (!(element instanceof HTMLElement)) return;
      const rect = element.getBoundingClientRect();
      if (!rect.height) return;
      if (y < rect.top + rect.height / 2) before = { at, y: rect.top, rect };
      else last = { at: at + node.nodeSize, y: rect.bottom, rect };
    });
    return before ?? last;
  }

  function dropTarget() {
    if (!drag?.moving || drag.selection.$from.doc !== view.state.doc || !options.canEdit(view)) return;
    const hit = document.elementFromPoint(drag.x, drag.y);
    if (!view.dom.contains(hit) && !actions.contains(hit)) return;
    const target = blockBoundary(drag.selection, drag.y);
    if (!target || target.at === drag.selection.from || target.at === drag.selection.to) return;
    const { $from, node } = drag.selection;
    const index = $from.doc.resolve(target.at).index();
    if ($from.parent.canReplaceWith(index, index, node.type)) return target;
  }

  function updateDropLine() {
    const target = dropTarget();
    const viewport = scroller.getBoundingClientRect();
    dropLine.hidden = !target || target.y < viewport.top || target.y >= viewport.bottom;
    if (target && !dropLine.hidden) {
      Object.assign(dropLine.style, { left: `${target.rect.left}px`, top: `${target.y}px`, width: `${target.rect.width}px` });
    }
  }

  function stopDrag() {
    if (!drag) return;
    const { pointerId, moving } = drag;
    drag = undefined;
    if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId);
    if (moving) hideActions();
    dropLine.hidden = true;
    preview.hidden = true;
    preview.replaceChildren();
  }

  grip.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || drag || !hovered || !options.canEdit(view)) return;
    const { selection, el } = hovered;
    if (selection.$from.doc !== view.state.doc) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, selection, source: el, x: event.clientX, y: event.clientY, moving: false };
    view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
  };
  grip.onpointermove = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { clientX: x, clientY: y } = event;
    if (!drag.moving) {
      if (Math.hypot(x - drag.x, y - drag.y) < 5) return;
      drag.moving = true;
      preview.replaceChildren(drag.source.cloneNode(true));
      preview.hidden = false;
    }
    drag.x = x;
    drag.y = y;
    preview.style.translate = `${x}px ${y}px`;
    updateDropLine();
  };
  grip.onpointerup = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    const target = dropTarget();
    const { selection } = drag;
    stopDrag();
    if (!target) return;
    const tr = view.state.tr.delete(selection.from, selection.to);
    const at = tr.mapping.map(target.at);
    tr.insert(at, selection.node);
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, at)));
    view.focus();
  };
  grip.onpointercancel = grip.onlostpointercapture = event => {
    if (event.pointerId === drag?.pointerId) stopDrag();
  };

  let range: MenuRange | undefined;
  let origin: EditorState | undefined;
  let dismissed: EditorState | undefined;
  let fromButton = false;
  let submenu: Item & { children: Item[] } | undefined;
  let mediaField: Media | undefined;
  let items: Item[] = [];
  let active = 0;
  let positionVersion = 0;

  function close(dismiss = false) {
    if (dismiss) dismissed = view.state;
    range = origin = submenu = mediaField = undefined;
    fromButton = false;
    menu.hidden = true;
    positionVersion++;
  }

  function position() {
    const from = range?.from;
    if (from === undefined || menu.hidden) return;
    const version = ++positionVersion;
    const caret = view.coordsAtPos(from);
    const rect = new DOMRect(caret.left, caret.top, 1, Math.max(1, caret.bottom - caret.top));
    void computePosition({ contextElement: view.dom, getBoundingClientRect: () => rect }, menu, {
      strategy: "fixed", placement: "bottom-start",
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), size({ padding: 8, apply({ availableHeight }) {
        menu.style.maxHeight = `${Math.min(560, availableHeight)}px`;
      } })],
    }).then(({ x, y }) => {
      if (version !== positionVersion || menu.hidden) return;
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      menu.style.visibility = "visible";
    });
  }

  function highlight(scroll = false) {
    const buttons = menu.querySelectorAll<HTMLButtonElement>(".rich-slash-item");
    buttons.forEach((button, i) => { button.dataset.selected = String(i === active); });
    if (scroll) buttons[active]?.scrollIntoView?.({ block: "nearest" });
  }

  function renderItems() {
    const query = submenu ? "" : range?.query ?? "";
    const matches = (item: Item) => `${item.label} ${item.aliases ?? ""}`.toLowerCase().includes(query);
    const visibleGroups = submenu ? [{ name: submenu.label, items: submenu.children }] : groups.map(group => ({
      name: group.name,
      items: group.items.flatMap(item => matches(item) ? [item] : "children" in item ? item.children.filter(matches) : []),
    }));
    menu.replaceChildren();
    items = [];
    active = 0;
    for (const group of visibleGroups) {
      if (!group.items.length) continue;
      const heading = document.createElement(submenu ? "button" : "div");
      heading.className = "rich-slash-group";
      heading.textContent = submenu ? `‹ ${group.name}` : group.name;
      if (heading instanceof HTMLButtonElement) {
        heading.type = "button";
        heading.tabIndex = -1;
        heading.setAttribute("aria-label", `返回命令列表`);
        heading.onmousedown = event => event.preventDefault();
        heading.onclick = () => { submenu = undefined; renderItems(); };
      }
      menu.append(heading);
      for (const item of group.items) {
        const index = items.push(item) - 1;
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.className = "rich-slash-item";
        const icon = document.createElement("span");
        icon.className = "rich-slash-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = item.icon;
        const label = document.createElement("span");
        label.textContent = item.label;
        const hint = document.createElement("span");
        hint.className = "rich-slash-hint";
        hint.setAttribute("aria-hidden", "true");
        hint.textContent = "children" in item ? "›" : item.shortcut
          ? `${/Mac/i.test(navigator.platform) ? "⌘⌥" + item.shortcut.slice(4) : "Ctrl+" + item.shortcut}` : "";
        button.append(icon, label, hint);
        button.onpointermove = () => { if (index !== active) { active = index; highlight(); } };
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => choose(item);
        menu.append(button);
      }
    }
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "rich-slash-group";
      empty.textContent = "没有匹配的命令";
      menu.append(empty);
    }
    menu.scrollTop = 0;
    highlight();
    position();
  }

  function finish(apply: () => void) {
    if (!range || !origin || origin.doc !== view.state.doc || !options.canEdit(view)) { close(); return; }
    const { from, to } = range;
    close();
    let tr = view.state.tr;
    if (from !== to) tr = tr.delete(from, to);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from)));
    view.focus();
    apply();
  }

  function renderMedia(kind: Media) {
    mediaField = kind;
    const form = document.createElement("form");
    form.className = "rich-slash-media";
    const address = document.createElement("input");
    address.type = "url";
    address.required = true;
    address.placeholder = "https://";
    address.setAttribute("aria-label", `${kind}链接`);
    address.oninput = () => address.setCustomValidity("");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "插入链接";
    submit.onmousedown = event => event.preventDefault();
    form.append(address, submit);
    const isImage = kind === "图片" || kind === "白板";
    if (isImage && options.canImportImages()) {
      const file = document.createElement("input");
      file.type = "file";
      file.hidden = true;
      file.accept = "image/*";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.textContent = kind === "白板" ? "选择白板图片" : "选择图片";
      pick.onmousedown = event => event.preventDefault();
      pick.onclick = () => file.click();
      file.onchange = () => {
        const files = Array.from(file.files ?? []);
        if (files.length) finish(() => options.importImages(view, files));
      };
      form.append(pick, file);
    }
    form.onsubmit = event => {
      event.preventDefault();
      const url = URL.canParse(address.value) ? new URL(address.value) : null;
      if (!url || !["https:", "http:"].includes(url.protocol)) {
        address.setCustomValidity("请输入有效的 HTTP 或 HTTPS 地址");
        address.reportValidity();
        return;
      }
      finish(() => {
        if (isImage) { options.insertImage(view, url.href); return; }
        const { schema, tr } = view.state;
        view.dispatch(tr.replaceSelectionWith(schema.text(kind, [schema.marks.link.create({ href: url.href })]), false));
      });
    };
    menu.replaceChildren(form);
    address.focus({ preventScroll: true });
    position();
  }

  function choose(item: Item) {
    if ("children" in item) { submenu = item; renderItems(); return; }
    const action = item.action;
    if ("media" in action) { renderMedia(action.media); return; }
    finish(() => {
      if ("command" in action) options.command(view, action.command, action.value);
      else if ("markdown" in action) options.insertMarkdown(view, action.markdown);
      else view.dispatch(view.state.tr.insertText(action.text()));
    });
  }

  function show(next: MenuRange) {
    range = next;
    origin = view.state;
    hideActions();
    if (menu.hidden) menu.style.visibility = "hidden";
    menu.hidden = false;
    renderItems();
  }

  plus.onmousedown = event => { event.preventDefault(); event.stopPropagation(); };
  plus.ondragstart = event => { event.preventDefault(); event.stopPropagation(); };
  plus.onclick = () => {
    const target = hovered?.selection;
    if (!target || plus.hidden || !options.canEdit(view)) return;
    const { doc, schema, tr } = view.state;
    if (target.$from.doc !== doc) return;
    const after = target.$from.depth ? target.$from.after(1) : target.to;
    const paragraph = schema.nodes.paragraph.create();
    const $after = doc.resolve(after);
    if (!$after.parent.canReplaceWith($after.index(), $after.index(), paragraph.type)) return;
    close();
    view.dispatch(tr.insert(after, paragraph).setSelection(TextSelection.create(tr.doc, after + 1)));
    view.focus();
    hideActions();
    fromButton = true;
    show({ from: after + 1, to: after + 1, query: "" });
  };

  const events = new AbortController();
  root.addEventListener("pointermove", hoverBlock, { signal: events.signal });
  root.addEventListener("pointerleave", () => { if (!drag) hideActions(); }, { signal: events.signal });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && event.target instanceof Node && !menu.contains(event.target)) close(true);
  }, { capture: true, signal: events.signal });
  root.addEventListener("focusout", event => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close();
  }, { signal: events.signal });
  scroller.addEventListener("scroll", () => {
    position();
    if (drag) updateDropLine();
    else hideActions();
  }, { signal: events.signal, passive: true });
  menu.onkeydown = event => {
    if (event.key === "Escape" && mediaField) {
      event.preventDefault();
      event.stopPropagation();
      mediaField = undefined;
      view.focus();
      renderItems();
    }
  };

  return {
    isOpen: () => !menu.hidden,
    update() {
      if (drag && drag.selection.$from.doc !== view.state.doc) stopDrag();
      if (hovered && hovered.selection.$from.doc !== view.state.doc) hideActions();
      if (!options.canEdit(view)) { stopDrag(); close(); hideActions(); return; }
      if (view.composing || mediaField) return;
      if (!view.hasFocus() || (dismissed?.doc === view.state.doc && dismissed.selection.eq(view.state.selection))) return;
      const next = typedRange(view, fromButton ? range?.from : undefined);
      if (!next) { close(); return; }
      if (menu.hidden || range?.from !== next.from || range.query !== next.query || range.to !== next.to) {
        submenu = undefined;
        show(next);
      } else origin = view.state;
    },
    keyDown(current: EditorView, event: KeyboardEvent) {
      if (drag && event.key === "Escape") { stopDrag(); return true; }
      if (menu.hidden || mediaField || current.composing || event.isComposing || event.keyCode === 229) return false;
      if (event.key === "Escape") {
        if (submenu) { submenu = undefined; renderItems(); } else close(true);
        return true;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || !items.length) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        highlight(true);
        return true;
      }
      if (event.key === "ArrowLeft" && submenu) { submenu = undefined; renderItems(); return true; }
      if (event.key === "Enter" || (event.key === "ArrowRight" && "children" in items[active])) {
        choose(items[active]);
        return true;
      }
      return false;
    },
    destroy() {
      stopDrag();
      close();
      events.abort();
      actions.remove();
      menu.remove();
      dropLine.remove();
      preview.remove();
    },
  };
}
