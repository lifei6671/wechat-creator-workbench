import { useId, useState } from "react";
import { X } from "lucide-react";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");

export function addTag(tags: string[], text: string, history: string[]) {
  const name = normalize(text);
  const key = name.toLowerCase();
  if (!name || tags.some(tag => tag.toLowerCase() === key)) return tags;
  return [...tags, history.find(tag => tag.toLowerCase() === key) ?? name];
}

export function TagInput({ tags, onTags, draft, onDraft, history, readOnly }: {
  tags: string[];
  onTags(tags: string[]): void;
  draft: string;
  onDraft(value: string): void;
  history: string[];
  readOnly: boolean;
}) {
  const id = useId();
  const [active, setActive] = useState(-1);
  const [suggest, setSuggest] = useState(false);
  const query = normalize(draft).toLowerCase();
  const matches = suggest && query ? history.filter(tag => tag.toLowerCase().includes(query) && !tags.includes(tag)) : [];

  function commit(text: string) {
    onTags(addTag(tags, text, history));
    onDraft("");
    setActive(-1);
    setSuggest(false);
  }

  return <div className="properties-field">
    <label htmlFor={readOnly ? undefined : id}>标签</label>
    <div className="tag-picker">
      <div className="tag-field">
        {tags.map(tag => <span className="tag-chip" key={tag}>
          <span>{tag}</span>
          {!readOnly && <button type="button" aria-label={`移除标签 ${tag}`} onClick={() => onTags(tags.filter(value => value !== tag))}><X size={12} /></button>}
        </span>)}
        {!readOnly && <input id={id} value={draft} placeholder={tags.length ? undefined : "输入并按回车"} autoComplete="off"
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
      {matches.length > 0 && <ul className="tag-suggestions" id={`${id}-suggestions`} role="listbox" aria-label="历史标签">
        {matches.map((tag, index) => <li role="option" id={`${id}-${index}`} key={tag} aria-selected={index === active}
          onMouseDown={event => event.preventDefault()} onClick={() => commit(tag)}>{tag}</li>)}
      </ul>}
    </div>
  </div>;
}
