import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";

export const imagePattern = /^(?:https?:\/\/|asset:\/\/)/i;

export interface ImageContext {
  kind: "image";
  src: string;
  available: boolean;
  remove(): void;
}

const imageContexts = new WeakMap<Element, () => ImageContext>();

export function prepareImageContext(view: EditorView, event: MouseEvent): ImageContext | null {
  const { selection } = view.state;
  const target = event.button === 2 || event.ctrlKey
    ? event.target instanceof Element && event.target.closest(".rich-image-frame")?.parentElement
    : selection instanceof NodeSelection ? view.nodeDOM(selection.from) : null;
  return target instanceof Element ? imageContexts.get(target)?.() ?? null : null;
}

export interface EditorImages {
  resolveImage?(url: string, retry?: boolean): Promise<{ src: string; dispose(): void }>;
  imageErrorMessage?(error: unknown): string;
  onImageZoom?(image: { src: string; alt: string }, trigger: HTMLButtonElement): void;
  onError?(error: unknown): void;
}

const iconPaths = {
  zoom: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16m10 18-4.35-4.35M11 8v6m-3-3h6",
  source: "m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16",
};

function iconButton(label: string, icon: keyof typeof iconPaths) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plain-button chrome-icon";
  button.setAttribute("aria-label", label);
  button.title = label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", iconPaths[icon]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  button.append(svg);
  return button;
}

export function imageView(
  node: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
  parse: (markdown: string) => ProseNode,
  serialize: (doc: ProseNode) => string,
  getOptions: () => EditorImages,
  failedImages: Set<() => void>,
): NodeView {
  const dom = document.createElement("span");
  dom.className = "rich-image";
  dom.contentEditable = "false";
  const alt = node.attrs.alt || "";

  const frame = document.createElement("span");
  frame.className = "rich-image-frame";
  const media = document.createElement("span");
  media.className = "rich-image-media";
  imageContexts.set(dom, () => ({
    kind: "image", src: node.attrs.src, available: media.firstElementChild instanceof HTMLImageElement,
    remove() {
      const pos = getPos();
      if (pos === undefined || !view.editable) return;
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
      view.focus();
    },
  }));
  const status = document.createElement("span");
  status.className = "rich-image-status";
  const message = document.createElement("span");
  message.setAttribute("role", "status");
  message.textContent = alt || "图片";
  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "plain-button rich-image-retry";
  retryButton.textContent = "重试";
  retryButton.setAttribute("aria-label", alt ? `重试加载图片：${alt}` : "重试加载图片");
  retryButton.hidden = true;
  status.append(message, retryButton);
  media.append(status);

  const controls = document.createElement("span");
  controls.className = "rich-image-controls";
  const zoom = iconButton("放大图片", "zoom");
  zoom.disabled = true;
  const source = iconButton("图片源码", "source");
  source.classList.add("rich-image-source-toggle");
  source.setAttribute("aria-expanded", "false");
  controls.append(zoom, source);
  frame.append(media, controls);
  dom.append(frame);

  const sourcePanel = document.createElement("span");
  sourcePanel.className = "rich-image-source-editor";
  sourcePanel.hidden = true;
  const field = document.createElement("textarea");
  field.setAttribute("aria-label", "图片 Markdown 源码");
  field.rows = 1;
  field.spellcheck = false;
  const error = document.createElement("span");
  error.className = "inline-error";
  error.setAttribute("role", "alert");
  sourcePanel.append(field, error);
  dom.prepend(sourcePanel);

  function closeSource() {
    sourcePanel.hidden = true;
    source.setAttribute("aria-expanded", "false");
  }

  source.onclick = () => {
    if (!view.editable) return;
    const schema = view.state.schema;
    field.value = serialize(schema.topNodeType.create(null, schema.nodes.paragraph.create(null, node))).trim();
    error.textContent = "";
    sourcePanel.hidden = false;
    source.setAttribute("aria-expanded", "true");
    field.focus();
    field.select();
  };

  function finishSource(blur: boolean) {
    if (sourcePanel.hidden) return;
    if (!view.editable) { closeSource(); return; }
    const parsed = parse(field.value.trim());
    const paragraph = parsed.firstChild;
    const image = paragraph?.firstChild;
    if (parsed.childCount !== 1 || paragraph?.type !== view.state.schema.nodes.paragraph
      || paragraph.childCount !== 1 || image?.type !== node.type || !imagePattern.test(image.attrs.src)) {
      if (blur) closeSource();
      else error.textContent = "请输入一条使用 HTTP、HTTPS 或 asset:// 地址的 Markdown 图片语法";
      return;
    }
    closeSource();
    const pos = getPos();
    if (pos !== undefined && !node.sameMarkup(image.mark(node.marks))) {
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, image.attrs));
    }
    if (!blur) view.focus();
  }

  field.onblur = () => finishSource(true);
  field.oninput = () => { error.textContent = ""; };
  sourcePanel.onkeydown = event => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      if (event.key === "Escape") { closeSource(); view.focus(); }
      else finishSource(false);
    }
  };
  sourcePanel.oncontextmenu = event => {
    event.preventDefault();
    event.stopPropagation();
  };

  const { resolveImage } = getOptions();
  let dispose: (() => void) | undefined;
  let destroyed = false;
  let retry: (() => void) | undefined;
  if (resolveImage && imagePattern.test(node.attrs.src)) {
    const load = (manual = false) => {
      failedImages.delete(load);
      retryButton.setAttribute("aria-disabled", "true");
      message.textContent = "正在加载图片…";
      const request = manual ? resolveImage(node.attrs.src, true) : resolveImage(node.attrs.src);
      void request.then(image => {
        if (destroyed) { image.dispose(); return; }
        dispose = image.dispose;
        const img = document.createElement("img");
        img.alt = alt;
        img.title = node.attrs.title ?? "";
        img.src = image.src;
        const restoreFocus = document.activeElement === retryButton;
        media.replaceChildren(img);
        if (getOptions().onImageZoom) {
          zoom.disabled = false;
          zoom.onclick = () => getOptions().onImageZoom?.({ src: image.src, alt }, zoom);
        }
        if (restoreFocus) {
          if (!zoom.disabled) zoom.focus();
          else view.focus();
        }
      }).catch(failure => {
        if (destroyed) return;
        if (node.attrs.src.startsWith("asset://")) failedImages.add(load);
        message.textContent = [alt, getOptions().imageErrorMessage?.(failure) ?? "图片无法显示"].filter(Boolean).join(" — ");
        retryButton.hidden = false;
        retryButton.removeAttribute("aria-disabled");
      });
    };
    retry = load;
    retryButton.onclick = () => { if (!retryButton.hasAttribute("aria-disabled")) load(true); };
    load();
  } else if (!imagePattern.test(node.attrs.src)) {
    message.textContent = "图片地址无法读取";
  }

  return {
    dom,
    stopEvent: event => event.target instanceof Node && (event.target === retryButton || sourcePanel.contains(event.target) || controls.contains(event.target)),
    ignoreMutation: () => true,
    destroy() {
      destroyed = true;
      imageContexts.delete(dom);
      if (retry) failedImages.delete(retry);
      dispose?.();
    },
  };
}
