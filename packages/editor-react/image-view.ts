import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, type Transaction } from "@milkdown/kit/prose/state";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";

export const imagePattern = /^(?:https?:\/\/|asset:\/\/)/i;

export interface ImageContext {
  kind: "image";
  src: string;
  available: boolean;
  feedbackTarget: HTMLElement;
  isCurrent(): boolean;
  isUploading(): boolean;
  setUploading(uploading: boolean, background?: boolean): void;
  replaceSource(url: string): boolean;
  remove(): void;
}

const imageContexts = new WeakMap<Element, () => ImageContext>();
const replacements = new WeakMap<ImageContext, (view: EditorView, url: string) => Transaction | null>();

export function imageReplacement(view: EditorView, context: ImageContext, url: string) {
  return replacements.get(context)?.(view, url) ?? null;
}

export function imageContext(target: Node | null) {
  return target instanceof Element ? imageContexts.get(target)?.() ?? null : null;
}

export function prepareImageContext(view: EditorView, event: MouseEvent): ImageContext | null {
  const { selection } = view.state;
  if (event.button === 2 || event.ctrlKey) {
    return event.target instanceof Element ? imageContext(event.target.closest(".rich-image-frame")?.parentElement ?? null) : null;
  }
  return selection instanceof NodeSelection ? imageContext(view.nodeDOM(selection.from)) : null;
}

export interface EditorImages {
  resolveImage?(url: string, retry?: boolean): Promise<{ src: string; width?: number; height?: number; dispose(): void }>;
  imageErrorMessage?(error: unknown): string;
  onImageZoom?(image: { src: string; alt: string }, trigger: HTMLButtonElement): void;
  onError?(error: unknown): void;
}

const iconPaths = {
  zoom: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16m10 18-4.35-4.35M11 8v6m-3-3h6",
  source: "m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16",
  plus: "M12 4v16M4 12h16",
  grip: "M8.5 5h.01M8.5 12h.01M8.5 19h.01M15.5 5h.01M15.5 12h.01M15.5 19h.01",
};

export function editorIconButton(label: string, icon: keyof typeof iconPaths) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "plain-button chrome-icon";
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", iconPaths[icon]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", icon === "grip" ? "3.6" : icon === "plus" ? "2.2" : "1.8");
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
  const uploadStatus = document.createElement("span");
  uploadStatus.className = "rich-image-upload rich-progress";
  uploadStatus.setAttribute("role", "status");
  uploadStatus.setAttribute("aria-label", "正在上传到图床");
  uploadStatus.hidden = true;
  let foregroundUploading = false;
  let backgroundUploading = false;
  function currentPosition() {
    if (view.isDestroyed || !view.editable) return;
    const pos = getPos();
    if (pos !== undefined && view.state.doc.nodeAt(pos) === node) return pos;
  }
  imageContexts.set(dom, () => {
    const original = node;
    const context: ImageContext = {
    kind: "image", src: node.attrs.src, available: media.firstElementChild instanceof HTMLImageElement, feedbackTarget: frame,
    isCurrent: () => node === original && currentPosition() !== undefined,
    isUploading: () => !uploadStatus.hidden,
    setUploading: (uploading, background = false) => {
      if (background) backgroundUploading = uploading;
      else foregroundUploading = uploading;
      uploadStatus.hidden = !foregroundUploading && !backgroundUploading;
    },
    replaceSource(url) {
      const pos = currentPosition();
      if (pos === undefined || url === node.attrs.src) return false;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "src", url));
      return true;
    },
    remove() {
      const pos = getPos();
      if (pos === undefined || !view.editable) return;
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
      view.focus();
    },
    };
    replacements.set(context, (expectedView, url) => {
      const pos = currentPosition();
      if (view !== expectedView || pos === undefined || node !== original || node.attrs.src !== context.src) return null;
      return view.state.tr.setNodeAttribute(pos, "src", url);
    });
    return context;
  });
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
  const zoom = editorIconButton("放大图片", "zoom");
  zoom.disabled = true;
  const source = editorIconButton("图片源码", "source");
  source.classList.add("rich-image-source-toggle");
  source.setAttribute("aria-expanded", "false");
  controls.append(zoom, source);
  frame.append(media, uploadStatus, controls);
  const caption = document.createElement("span");
  caption.className = "rich-image-caption";
  caption.textContent = alt;
  caption.hidden = true;
  dom.append(frame, caption);

  const sourcePanel = document.createElement("span");
  sourcePanel.className = "rich-image-source-editor";
  sourcePanel.hidden = true;
  const field = document.createElement("textarea");
  field.setAttribute("aria-label", "图片 Markdown 源码");
  field.rows = 1;
  field.spellcheck = false;
  sourcePanel.append(field);
  dom.prepend(sourcePanel);

  function closeSource() {
    sourcePanel.hidden = true;
    source.setAttribute("aria-expanded", "false");
  }

  source.onclick = () => {
    if (!view.editable) return;
    const schema = view.state.schema;
    if (sourcePanel.hidden) {
      field.value = serialize(schema.topNodeType.create(null, schema.nodes.paragraph.create(null, node))).trim();
    }
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
    closeSource();
    const pos = getPos();
    if (pos !== undefined) {
      if (parsed.childCount === 1 && paragraph?.type === view.state.schema.nodes.paragraph
        && paragraph.childCount === 1 && image?.type === node.type && imagePattern.test(image.attrs.src)) {
        if (!node.sameMarkup(image.mark(node.marks))) view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, image.attrs));
      } else {
        const text = field.value;
        const tr = view.state.tr;
        if (text) tr.replaceWith(pos, pos + node.nodeSize, view.state.schema.text(text, node.marks));
        else tr.delete(pos, pos + node.nodeSize);
        view.dispatch(tr);
      }
    }
    if (!blur) view.focus();
  }

  field.onblur = () => finishSource(true);
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
  let feedbackTimer: number | undefined;
  if (resolveImage && imagePattern.test(node.attrs.src)) {
    const load = (manual = false) => {
      if (manual && retryButton.hasAttribute("aria-disabled")) return;
      window.clearTimeout(feedbackTimer);
      failedImages.delete(load);
      caption.hidden = true;
      retryButton.setAttribute("aria-disabled", "true");
      retryButton.setAttribute("aria-busy", "true");
      retryButton.dataset.feedbackState = "pending";
      retryButton.textContent = "加载中";
      message.classList.remove("inline-error");
      message.setAttribute("role", "status");
      message.textContent = "正在加载图片…";
      status.classList.add("rich-progress");
      const request = manual ? resolveImage(node.attrs.src, true) : resolveImage(node.attrs.src);
      void request.then(image => {
        if (destroyed) { image.dispose(); return; }
        dispose = image.dispose;
        const img = document.createElement("img");
        img.alt = alt;
        img.title = node.attrs.title ?? "";
        if (image.width !== undefined) img.width = image.width;
        if (image.height !== undefined) img.height = image.height;
        img.src = image.src;
        const restoreFocus = document.activeElement === retryButton;
        media.replaceChildren(img);
        caption.hidden = !alt.trim();
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
        status.classList.remove("rich-progress");
        if (node.attrs.src.startsWith("asset://")) failedImages.add(load);
        message.textContent = [alt, getOptions().imageErrorMessage?.(failure) ?? "图片无法显示"].filter(Boolean).join(" — ");
        message.classList.add("inline-error");
        message.setAttribute("role", "alert");
        message.tabIndex = 0;
        retryButton.hidden = false;
        retryButton.removeAttribute("aria-busy");
        if (manual) {
          retryButton.dataset.feedbackState = "error";
          retryButton.textContent = "重试失败";
          feedbackTimer = window.setTimeout(() => {
            retryButton.removeAttribute("aria-disabled");
            delete retryButton.dataset.feedbackState;
            retryButton.textContent = "重试";
          }, 1000);
        } else {
          retryButton.removeAttribute("aria-disabled");
          delete retryButton.dataset.feedbackState;
          retryButton.textContent = "重试";
        }
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
      window.clearTimeout(feedbackTimer);
      imageContexts.delete(dom);
      if (retry) failedImages.delete(retry);
      dispose?.();
    },
  };
}
