import { useId, useState } from "react";
import { X } from "lucide-react";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

export function addTag(tags: string[], text: string, history: string[], exactMatch = false) {
  const name = exactMatch ? text.trim() : normalize(text);
  const key = exactMatch ? name : name.toLowerCase();
  const match = (tag: string) => (exactMatch ? tag : tag.toLowerCase()) === key;
  if (!name || tags.some(match)) return tags;
  return [...tags, history.find(match) ?? name];
}

export function TagInput({ tags, onTags, draft, onDraft, history, readOnly, id: inputId, label,
  suggestOnEmpty = false, exactMatch = false, placeholder = "输入并按回车", itemLabel = "标签" }: {
  tags: string[];
  onTags(tags: string[]): void;
  draft: string;
  onDraft(value: string): void;
  history: string[];
  readOnly: boolean;
  id?: string;
  label: string;
  suggestOnEmpty?: boolean;
  exactMatch?: boolean;
  placeholder?: string;
  itemLabel?: string;
}) {
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const [active, setActive] = useState(-1);
  const [suggest, setSuggest] = useState(false);
  const query = (exactMatch ? draft.trim() : normalize(draft)).toLowerCase();
  const matches = !readOnly && suggest && (query || suggestOnEmpty)
    ? history.filter(tag => tag.toLowerCase().includes(query) && !tags.includes(tag)).slice(0, suggestOnEmpty ? 50 : undefined) : [];

  function commit(text: string) {
    onTags(addTag(tags, text, history, exactMatch));
    onDraft("");
    setActive(-1);
    setSuggest(suggestOnEmpty);
  }

  return <div className="tag-picker">
    <div className="tag-field">
      {tags.map(tag => <span className="tag-chip" key={tag}>
        <span>{tag}</span>
        {!readOnly && <button type="button" aria-label={`移除${itemLabel} ${tag}`} onClick={() => onTags(tags.filter(value => value !== tag))}><X size={12} /></button>}
      </span>)}
      {!readOnly && <input id={id} aria-label={label} value={draft} placeholder={placeholder} autoComplete="off"
        role="combobox" aria-expanded={matches.length > 0} aria-autocomplete="list"
        aria-controls={matches.length ? `${id}-suggestions` : undefined}
        aria-activedescendant={matches[active] ? `${id}-${active}` : undefined}
        onFocus={() => { setSuggest(true); setActive(-1); }} onBlur={() => setSuggest(false)}
        onChange={event => { onDraft(event.target.value); setSuggest(true); setActive(-1); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            commit(matches[active] ?? draft);
          } else if (matches.length && event.key === "Escape") {
            event.preventDefault();
            setSuggest(false);
            setActive(-1);
          } else if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const index = event.key === "ArrowDown" ? (active + 1) % matches.length : active <= 0 ? matches.length - 1 : active - 1;
            setActive(index);
            document.getElementById(`${id}-${index}`)!.scrollIntoView({ block: "nearest" });
          }
        }} />}
    </div>
    {matches.length > 0 && <ul className="tag-suggestions" id={`${id}-suggestions`} role="listbox" aria-label={suggestOnEmpty ? `${itemLabel}候选` : "历史标签"}>
      {matches.map((tag, index) => <li role="option" id={`${id}-${index}`} key={tag} aria-selected={index === active}
        onMouseDown={event => event.preventDefault()} onClick={() => commit(tag)}>{tag}</li>)}
    </ul>}
  </div>;
}
