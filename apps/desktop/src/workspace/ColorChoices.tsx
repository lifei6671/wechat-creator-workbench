import { useEffect, useRef, type CSSProperties, type MouseEvent } from "react";
import { Popover } from "@radix-ui/themes";
import type { CanvasCardColor } from "../../../../packages/shared-types";
import { Tooltip } from "../ui";
import "./color-choices.css";

const colors = [[null, "默认"], ["red", "红色"], ["orange", "橙色"], ["amber", "黄色"], ["green", "绿色"], ["blue", "蓝色"], ["violet", "紫色"]] as const;

export function colorValue(color?: CanvasCardColor | null) {
  return color ? color.startsWith("#") ? color : `var(--${color}-9)` : undefined;
}

export function ColorChoices({ value, onChange, closeOnSelect = false, disabled, onMouseDown, onCustomColorOpen }: {
  value: CanvasCardColor | null;
  onChange(color: CanvasCardColor | null): void;
  closeOnSelect?: boolean;
  disabled?: boolean;
  onMouseDown?(event: MouseEvent<HTMLButtonElement | HTMLInputElement>): void;
  onCustomColorOpen?(): void;
}) {
  const custom = value?.startsWith("#") ? value : undefined;
  const customInput = useRef<HTMLInputElement>(null);
  useEffect(() => { customInput.current!.value = custom ?? "#808080"; }, [custom]);
  useEffect(() => {
    const input = customInput.current!;
    const commit = () => onChange(input.value as CanvasCardColor);
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, [onChange]);
  const style = (color?: CanvasCardColor | null) => ({ "--swatch-color": colorValue(color) }) as CSSProperties;
  return <div className="color-choices" role="group" aria-label="颜色">
    {colors.map(([color, label]) => {
      const button = <button type="button" className="color-swatch" style={style(color)} disabled={disabled}
        aria-label={label} aria-pressed={value === color} onMouseDown={onMouseDown} onClick={() => onChange(color)} />;
      return <Tooltip key={label} content={label}>{closeOnSelect ? <Popover.Close>{button}</Popover.Close> : button}</Tooltip>;
    })}
    <Tooltip content="自定义颜色">
      <input type="color" className="color-swatch custom-color" aria-label="自定义颜色" disabled={disabled}
        data-active={custom ? "" : undefined} style={style(custom)} defaultValue={custom ?? "#808080"}
        onMouseDown={onMouseDown} onClick={onCustomColorOpen}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") onCustomColorOpen?.(); }} ref={customInput} />
    </Tooltip>
  </div>;
}
