import { cloneElement, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode, type RefAttributes } from "react";
import { Theme } from "@radix-ui/themes";
import {
  arrow, autoUpdate, flip, FloatingArrow, FloatingDelayGroup, FloatingPortal, offset, shift, useDelayGroup, useDismiss,
  useFloating, useFocus, useHover, useInteractions, useMergeRefs, useRole,
} from "@floating-ui/react";
import "./tooltip.css";

const arrowHeight = 5;
const padding = 8;

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <FloatingDelayGroup delay={400} timeoutMs={300}>{children}</FloatingDelayGroup>;
}

export function Tooltip({ children, content }: {
  children: ReactElement<HTMLAttributes<HTMLElement> & RefAttributes<HTMLElement>>;
  content: string;
}) {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const { context, refs, floatingStyles, isPositioned, placement } = useFloating({
    open, placement: "top", strategy: "fixed", whileElementsMounted: autoUpdate,
    onOpenChange(next, event, reason) {
      if (next && reason === "hover" && event instanceof MouseEvent) {
        const { x, y } = pointer.current ?? { x: event.clientX, y: event.clientY };
        refs.setPositionReference({ getBoundingClientRect: () => new DOMRect(x, y) });
      } else if (next) refs.setPositionReference(refs.domReference.current);
      pointer.current = null;
      setOpen(next);
    },
    middleware: [offset(arrowHeight + 5), flip({ padding }), shift({ padding }), arrow({ element: arrowRef, padding: 4 })],
  });
  const { delay } = useDelayGroup(context);
  const hover = useHover(context, { delay, mouseOnly: true, move: false });
  const point = { reference: { onPointerMove(event: React.PointerEvent) {
    if (!open && event.pointerType === "mouse") pointer.current = { x: event.clientX, y: event.clientY };
  } } };
  const focus = useFocus(context);
  const dismiss = useDismiss(context, { referencePress: true, ancestorScroll: true, bubbles: { escapeKey: true } });
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, point, focus, dismiss, role]);
  const trigger = useMergeRefs([refs.setReference, children.props.ref]);

  return <>
    {cloneElement(children, { ...getReferenceProps(children.props), ref: trigger })}
    {open && <FloatingPortal><Theme asChild>
      <div {...getFloatingProps()} ref={refs.setFloating} className="workspace-tooltip" data-placement={placement}
        style={{ ...floatingStyles, visibility: isPositioned ? undefined : "hidden" }}>
        {content}
        <FloatingArrow ref={arrowRef} context={context} width={10} height={arrowHeight} fill="var(--gray-12)" />
      </div>
    </Theme></FloatingPortal>}
  </>;
}
