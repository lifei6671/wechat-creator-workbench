import { useLayoutEffect, useRef, type ComponentProps } from "react";

export function CollectionEditorScope({ onLeave, className, ...props }: Omit<ComponentProps<"div">, "onBlur" | "onFocus" | "onContextMenu"> & {
  onLeave?(): void;
}) {
  const blur = useRef(0);
  useLayoutEffect(() => () => cancelAnimationFrame(blur.current), []);
  return <div {...props} className={`collection-inline-editor nodrag nopan nowheel ${className ?? ""}`}
    onFocus={() => cancelAnimationFrame(blur.current)} onBlur={event => {
      if (!onLeave || event.currentTarget.contains(event.relatedTarget)) return;
      cancelAnimationFrame(blur.current);
      // Menus and editor popovers can move focus into a portal in the same frame.
      blur.current = requestAnimationFrame(onLeave);
    }} onContextMenu={event => {
      event.preventDefault();
      event.stopPropagation();
    }} />;
}
