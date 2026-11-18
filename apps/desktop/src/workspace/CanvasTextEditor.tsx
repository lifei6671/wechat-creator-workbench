import { useRef } from "react";
import { MarkdownEditor, type ClipboardIO, type MarkdownEditorHandle } from "../../../../packages/editor-react";
import { desktop, errorMessage } from "../desktop";
import { CollectionEditorScope } from "./CollectionEditorScope";
import { EditorContextMenu } from "./EditorContextMenu";
import { loadLocalImage } from "./Publishing";

export function CanvasTextEditor({ id, markdown, clipboard, locked, register, dirty, save, finish, onImages, onError }: {
  id: string;
  markdown: string;
  clipboard: ClipboardIO;
  locked: boolean;
  register(id: string, handle: MarkdownEditorHandle | null): void;
  dirty(id: string, revision: number): void;
  save(id: string): void;
  finish(id: string): void;
  onImages(files: File[]): Promise<string>;
  onError(error: unknown): void;
}) {
  const initial = useRef(markdown);
  const editor = useRef<MarkdownEditorHandle>(null);
  return <CollectionEditorScope className="collection-text-editor" role="group" aria-label="文本卡片编辑器">
    <EditorContextMenu editor={editor} clipboard={clipboard} readOnly={locked} onError={onError}>
      <MarkdownEditor entryId={`canvas:${id}`} value={initial.current} readOnly={locked} ref={handle => {
        if (!handle) return;
        editor.current = handle;
        register(id, handle);
        handle.focus();
        return () => { editor.current = null; register(id, null); };
      }} onDocumentChanged={(_entryId, revision) => dirty(id, revision)} onBlur={() => save(id)}
        onEscape={() => finish(id)} onImages={onImages} resolveImage={loadLocalImage}
        imageErrorMessage={errorMessage} onOpenLink={desktop.openLink} onError={onError} />
    </EditorContextMenu>
  </CollectionEditorScope>;
}
