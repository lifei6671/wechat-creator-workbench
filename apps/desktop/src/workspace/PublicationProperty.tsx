import { useEffect, useId, useState } from "react";
import { DropdownMenu } from "@radix-ui/themes";
import { ChevronDown, Send, Trash2 } from "lucide-react";
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from "@floating-ui/react";
import type { PublicationPlatform } from "../../../../packages/shared-types";

const platforms = ["微信公众号", "知乎", "掘金", "CSDN", "简书", "今日头条", "小红书", "个人博客"];

export function PublicationProperty({ id, value, readOnly, error, onChange, onCommit, onRemove }: {
  id: number;
  value: PublicationPlatform;
  readOnly: boolean;
  error?: string;
  onChange(value: PublicationPlatform): void;
  onCommit(): void;
  onRemove(): void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const expanded = open && !readOnly;
  useEffect(() => { if (readOnly) setOpen(false); }, [readOnly]);
  const { refs, floatingStyles } = useFloating({
    open: expanded, placement: "bottom-start", strategy: "fixed", whileElementsMounted: autoUpdate,
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const matches = platforms.filter(platform => platform.toLowerCase().includes(query.trim().toLowerCase()));
  const custom = query.trim();
  const choices = custom && !platforms.some(platform => platform.toLowerCase() === custom.toLowerCase()) ? [...matches, custom] : matches;
  const errorId = `publication-error-${id}`;
  function choose(platform: string) {
    if (readOnly) return;
    onChange({ ...value, platform });
    setOpen(false);
    onCommit();
    document.getElementById(`publication-url-${id}`)!.focus();
  }
  return <div className="property-row publication-property" data-property-scope={`publication:${id}`}>
    {readOnly ? <span className="property-icon"><Send size={16} /></span> : <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger><button type="button" className="property-icon" aria-label={`发布平台属性菜单 ${id + 1}`}><Send size={16} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Content size="1" align="start"><DropdownMenu.Item color="red" onSelect={onRemove}><Trash2 size={14} />移除属性</DropdownMenu.Item></DropdownMenu.Content>
    </DropdownMenu.Root>}
    <div className="publication-name">
      <input ref={refs.setReference} id={`publication-platform-${id}`} className="property-name property-key" role="combobox" autoComplete="off"
        aria-label={`发布平台 ${id + 1}`} aria-expanded={expanded} aria-autocomplete="list"
        aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={Boolean(error) || undefined} aria-describedby={error ? errorId : undefined}
        placeholder="选择平台" readOnly={readOnly} value={value.platform}
        onFocus={() => { if (!readOnly) { setOpen(true); setQuery(""); setActive(-1); } }}
        onBlur={() => setOpen(false)}
        onChange={event => { onChange({ ...value, platform: event.target.value }); setQuery(event.target.value); setOpen(true); setActive(-1); }}
        onKeyDown={event => {
          if (readOnly || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); choose(choices[active] ?? value.platform.trim()); }
          else if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
          else if (choices.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault(); setOpen(true);
            const index = event.key === "ArrowDown" ? (active + 1) % choices.length : active <= 0 ? choices.length - 1 : active - 1;
            setActive(index);
            requestAnimationFrame(() => document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" }));
          }
        }} />
      {!readOnly && <button type="button" className="plain-button publication-choose" aria-label={`选择平台 ${id + 1}`}
        onMouseDown={event => event.preventDefault()} onClick={() => { document.getElementById(`publication-platform-${id}`)!.focus(); setOpen(!open); setQuery(""); setActive(-1); }}><ChevronDown size={12} /></button>}
      {expanded && <FloatingPortal root={refs.domReference.current?.closest<HTMLElement>(".properties-panel, .properties-sidebar")}>
        <ul ref={refs.setFloating} style={floatingStyles} className="tag-suggestions publication-options" id={listId} role="listbox" aria-label="发布平台选项">
        {choices.map((platform, index) => <li key={platform} id={`${listId}-${index}`} role="option" aria-selected={active === index}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(platform)}>
          {platform === custom && !platforms.includes(platform) ? `使用「${platform}」` : platform}
        </li>)}
        </ul>
      </FloatingPortal>}
    </div>
    <input id={`publication-url-${id}`} className="property-value" type="url" aria-label={`发布链接 ${id + 1}`}
      placeholder="发布链接" readOnly={readOnly} disabled={!value.platform.trim()} value={value.url}
      aria-invalid={Boolean(error) || undefined} aria-describedby={error ? errorId : undefined}
      onChange={event => onChange({ ...value, url: event.target.value })} />
  </div>;
}
