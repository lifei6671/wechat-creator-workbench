import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@radix-ui/themes";
import footnote from "markdown-it-footnote";
import type { PluginSimple } from "markdown-it";
import { MarkdownEditor, type ClipboardIO, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { createMarkdownParser, footnoteId, sanitizeRenderedMarkdown } from "../../../../packages/markdown-core";
import type { Entry } from "../../../../packages/shared-types";
import { desktop, errorMessage } from "../desktop";
import type { SaveQueue } from "../editor/save-queue";
import { CollectionEditorScope } from "./CollectionEditorScope";
import { Confirm } from "./Dialogs";
import { EditorContextMenu } from "./EditorContextMenu";
import { loadLocalImage } from "./Publishing";

const articleMarkdown = createMarkdownParser().use(footnote as unknown as PluginSimple);

export function CollectionArticlePreview({ id, title, source, load, onError }: {
  id: string;
  title: string;
  source: string | null;
  load(id: string): Promise<Entry>;
  onError(error: unknown): void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [body, setBody] = useState<string>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (visible) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(card.current!);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void load(id).then(entry => {
      if (!current) return;
      setBody(entry.contentMd);
      setError("");
    }, failure => { if (current) setError(errorMessage(failure)); });
    return () => { current = false; };
  }, [attempt, id, load, visible]);

  return <div ref={card} className="collection-card-body nowheel">
    <h2 className="collection-card-title">{title}</h2>
    {source && <p className="collection-card-source">{source}</p>}
    {visible && body === undefined && !error && <p className="muted-text" role="status">正在读取正文…</p>}
    {body !== undefined && <ArticleMarkdown body={body} onError={onError} />}
    {error && <div className="collection-article-error" role="alert">
      <span>{error}</span><Button variant="soft" size="1" className="nodrag" onClick={() => setAttempt(value => value + 1)}>重试</Button>
    </div>}
  </div>;
}

function ArticleMarkdown({ body, onError }: { body: string; onError(error: unknown): void }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let current = true;
    const images: Array<() => void> = [];
    const fragment = sanitizeRenderedMarkdown(articleMarkdown.render(body));
    for (const placeholder of fragment.querySelectorAll<HTMLElement>(".preview-image[data-image-url]")) {
      const { imageUrl, imageAlt } = placeholder.dataset;
      void loadLocalImage(imageUrl!).then(image => {
        if (!current) { image.dispose(); return; }
        images.push(image.dispose);
        const element = document.createElement("img");
        element.src = image.src;
        element.alt = imageAlt ?? "";
        element.draggable = false;
        placeholder.replaceWith(element);
      }, () => { /* Keep the Markdown image alternative when the resource is unavailable. */ });
    }
    content.current!.replaceChildren(fragment);
    return () => { current = false; images.forEach(dispose => dispose()); };
  }, [body]);
  return <div className="collection-markdown" ref={content} onClick={event => {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    if (href.startsWith("#") && footnoteId.test(href.slice(1))) {
      content.current?.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({ block: "nearest" });
    } else if (/^(https?:\/\/|mailto:)/i.test(href)) void desktop.openLink(href).catch(onError);
  }} />;
}

export function CollectionArticleEditor({ queue, locked, clipboard, onEditor, onFinish, onDiscard, onError, onImages }: {
  queue: SaveQueue;
  locked: boolean;
  clipboard: ClipboardIO;
  onEditor(handle: MarkdownEditorHandle | null): void;
  onFinish(): void;
  onDiscard(): void;
  onError(error: unknown): void;
  onImages(files: File[]): Promise<string>;
}) {
  const state = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const leave = () => { if (!confirmDiscard) onFinish(); };
  return <CollectionEditorScope className="collection-article-editor" role="group" aria-label="文章正文编辑器" onLeave={leave} onKeyDown={event => {
    if (confirmDiscard) return;
    if (event.nativeEvent.isComposing || event.defaultPrevented || event.keyCode === 229) return;
    if (event.key === "Escape" && (event.target as Element).closest(".ProseMirror")) return;
    if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")) {
      event.preventDefault();
      event.stopPropagation();
      onFinish();
    }
  }}>
    <EditorContextMenu editor={editorRef} clipboard={clipboard} readOnly={locked} onError={onError} onLeave={leave}>
    <MarkdownEditor entryId={queue.entry.id} value={queue.entry.contentMd} readOnly={locked} ref={editor => {
      if (!editor) return;
      editorRef.current = editor;
      const release = queue.bindContentProvider(editor.captureMarkdown);
      onEditor(editor);
      editor.focus();
      return () => { editorRef.current = null; release(); onEditor(null); };
    }} onDocumentChanged={(_id, revision) => queue.markContentDirty(revision)} onBlur={() => {}}
      onEscape={confirmDiscard ? undefined : onFinish}
      onError={onError} onImages={onImages} resolveImage={loadLocalImage} imageErrorMessage={errorMessage} onOpenLink={desktop.openLink} />
    </EditorContextMenu>
    {state.error != null && <div className="collection-article-editor-actions">
      <span className="inline-error" role="alert">{errorMessage(state.error)}</span>
      <Button size="1" color="gray" variant="ghost" onClick={() => setConfirmDiscard(true)}>放弃修改</Button>
    </div>}
    {confirmDiscard && <Confirm title="放弃未保存的修改" text="将重新读取文章正文。" action="放弃修改"
      onClose={() => setConfirmDiscard(false)} onConfirm={async () => onDiscard()} />}
  </CollectionEditorScope>;
}
