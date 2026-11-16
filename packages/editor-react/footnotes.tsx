import { useState } from "react";
import { Button, Popover, TextArea } from "@radix-ui/themes";
import type { Fragment, Node as ProseNode } from "@milkdown/kit/prose/model";
import { Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

export function footnoteLabels(...sources: (ProseNode | Fragment)[]) {
  const labels = new Set<string>();
  for (const source of sources) source.descendants(node => {
    if (node.type.name === "footnote_reference" || node.type.name === "footnote_definition") labels.add(node.attrs.label);
  });
  let index = 1;
  return () => {
    while (labels.has(String(index))) index++;
    return String(index++);
  };
}

export function footnoteDraft(view: EditorView, pos: number, parse: (source: string) => ProseNode,
  serialize: (doc: ProseNode) => string, existingLabel?: string) {
  const { doc, schema } = view.state;
  const { footnote_reference, footnote_definition } = schema.nodes;
  const $pos = doc.resolve(pos);
  if (!existingLabel && !$pos.parent.canReplaceWith($pos.index(), $pos.index(), footnote_reference)) return null;
  const label = existingLabel ?? footnoteLabels(doc)();
  const normalizedLabel = label.toLowerCase().toUpperCase();
  let definition: { node: ProseNode; pos: number } | undefined;
  doc.forEach((node, offset) => {
    if (node.type === footnote_definition && !definition && node.attrs.label.toLowerCase().toUpperCase() === normalizedLabel) {
      definition = { node, pos: offset };
    }
  });
  const source = definition ? serialize(doc.copy(definition.node.content)).trimEnd() : "";
  const anchor = view.coordsAtPos(pos);
  const definitionLabel = definition?.node.attrs.label ?? label;
  return { label: definitionLabel, source, anchor, existing: existingLabel !== undefined,
    save(value: string) {
      if (view.isDestroyed || !view.editable || view.state.doc !== doc) return false;
      const note = footnote_definition.create({ label: definitionLabel }, parse(value).content);
      const tr = view.state.tr;
      if (!existingLabel) tr.insert(pos, footnote_reference.create({ label }));
      if (definition) tr.replaceWith(definition.pos, definition.pos + definition.node.nodeSize, note);
      else tr.insert(tr.doc.content.size, note);
      const caret = tr.mapping.map(pos, 1) + (existingLabel ? 1 : 0);
      view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(caret))));
      return true;
    },
    focus() { if (!view.isDestroyed) view.focus(); },
  };
}

type FootnoteDraft = NonNullable<ReturnType<typeof footnoteDraft>>;

export function FootnotePopover({ draft, onClose }: { draft: FootnoteDraft; onClose(): void }) {
  const [value, setValue] = useState(draft.source);
  const [changed, setChanged] = useState(false);
  const title = draft.existing ? "编辑脚注" : "插入脚注";
  function close() { onClose(); draft.focus(); }
  return <Popover.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Popover.Anchor aria-hidden="true" className="rich-footnote-anchor" style={{
      left: draft.anchor.left, top: draft.anchor.top, height: draft.anchor.bottom - draft.anchor.top,
    }} />
    <Popover.Content aria-label={title} align="start" size="1" className="rich-footnote-popover"
      onCloseAutoFocus={event => event.preventDefault()} onEscapeKeyDown={event => { event.preventDefault(); close(); }}>
      <form onSubmit={event => {
        event.preventDefault();
        if (!value.trim()) return;
        if (draft.save(value)) close();
        else setChanged(true);
      }}>
        <code>{`[^${draft.label}]:`}</code>
        <TextArea aria-label="脚注内容" value={value} onChange={event => setValue(event.target.value)} rows={3} />
        {changed && <span className="inline-error" role="alert">文稿已更新，请重新打开脚注。</span>}
        <div className="rich-footnote-actions">
          <Button type="button" size="1" color="gray" variant="soft" onClick={close}>取消</Button>
          <Button type="submit" size="1" disabled={!value.trim() || changed}>{draft.existing ? "保存" : "插入"}</Button>
        </div>
      </form>
    </Popover.Content>
  </Popover.Root>;
}
