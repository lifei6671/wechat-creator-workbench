import type { ClipboardAction, ClipboardIO } from "../../../../packages/editor-react";
import { desktop } from "../desktop";

type HandleEditorClipboard = (action: ClipboardAction, target: EventTarget | null, plainText?: boolean) => boolean;

async function clipboardImage(url: string) {
  let blob: Blob;
  if (url.startsWith("asset://")) {
    const bytes = await desktop.assetRead(url);
    const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12));
    const signature = String.fromCharCode(...header);
    const type = signature.startsWith("\x89PNG\r\n\x1a\n") ? "image/png"
      : header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? "image/jpeg"
      : /^GIF8[79]a/.test(signature) ? "image/gif"
      : signature.startsWith("RIFF") && signature.slice(8) === "WEBP" ? "image/webp" : null;
    if (!type) throw new Error("无法识别剪贴板图片格式");
    blob = new Blob([bytes], { type });
  } else {
    blob = await (await fetch(url)).blob();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function writeClipboard(text: string, html?: string) {
  if (!html) return desktop.copyText(text);
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const placeholder of template.content.querySelectorAll<HTMLElement>("span[data-workbench-src]")) {
    const image = document.createElement("img");
    image.src = placeholder.dataset.workbenchSrc!;
    image.dataset.workbenchSrc = placeholder.dataset.workbenchSrc!;
    image.alt = placeholder.dataset.workbenchAlt ?? "";
    image.title = placeholder.title;
    placeholder.replaceWith(image);
  }
  const images = new Map<string, Promise<string>>();
  await Promise.all([...template.content.querySelectorAll("img[src]")].map(async image => {
    const url = image.getAttribute("src")!;
    if (!url.startsWith("asset://") && !url.startsWith("blob:")) return;
    const data = images.get(url) ?? clipboardImage(url);
    images.set(url, data);
    image.setAttribute("src", await data);
  }));
  return desktop.copyHtml(template.innerHTML, text);
}

export async function editClipboardField(field: HTMLInputElement | HTMLTextAreaElement, action: ClipboardAction) {
  const { selectionStart, selectionEnd, value } = field;
  if (selectionStart === null || selectionEnd === null) return;
  const sameSelection = () => document.activeElement === field && field.value === value
    && field.selectionStart === selectionStart && field.selectionEnd === selectionEnd;
  const editable = !field.readOnly && !field.disabled;
  if (action === "paste" && editable) {
    const result = await desktop.readClipboard(false);
    if (result?.kind === "text" && result.text && sameSelection()) document.execCommand("insertText", false, result.text);
  } else if (action !== "paste" && selectionStart !== selectionEnd) {
    await desktop.copyText(value.slice(selectionStart, selectionEnd));
    if (action === "cut" && editable && sameSelection()) document.execCommand("delete");
  }
}

export function attachClipboard(editor: HandleEditorClipboard, onError: ClipboardIO["onError"]) {
  function handle(action: ClipboardAction, event: Event, plainText?: boolean) {
    event.preventDefault();
    event.stopPropagation();
    if (editor(action, event.target, plainText)) return;

    const field = event.target;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
      && field.selectionStart !== null && field.selectionEnd !== null) {
      void editClipboardField(field, action).catch(onError);
    } else if (action === "copy") {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return;
      const content = document.createElement("div");
      for (let index = 0; index < selection.rangeCount; index++) {
        const range = selection.getRangeAt(index);
        let fragment: Node = range.cloneContents();
        let ancestor = range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
        // A range within bold/link text omits its ancestors from cloneContents().
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
          const wrapper = ancestor.cloneNode(false);
          wrapper.appendChild(fragment);
          fragment = wrapper;
          if (!ancestor.matches("a, strong, b, em, i, u, s, del, mark, code, span, sub, sup")) break;
          ancestor = ancestor.parentElement;
        }
        content.append(fragment);
      }
      void writeClipboard(selection.toString(), content.innerHTML).catch(onError);
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || event.altKey) return;
    const modified = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if ((modified && key === "v") || (event.shiftKey && !modified && key === "insert")) {
      handle("paste", event, modified && event.shiftKey);
    }
    else if ((modified && !event.shiftKey && key === "c") || (event.ctrlKey && key === "insert")) handle("copy", event);
    else if ((modified && !event.shiftKey && key === "x") || (event.shiftKey && !modified && key === "delete")) handle("cut", event);
  }

  const actions = ["copy", "cut", "paste"] as const;
  const listeners = actions.map(action => (event: Event) => handle(action, event));
  document.addEventListener("keydown", keydown, true);
  actions.forEach((action, index) => document.addEventListener(action, listeners[index], true));
  return () => {
    document.removeEventListener("keydown", keydown, true);
    actions.forEach((action, index) => document.removeEventListener(action, listeners[index], true));
  };
}
