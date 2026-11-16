import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode, type RefAttributes, type RefObject } from "react";
import { Theme } from "@radix-ui/themes";
import {
  arrow, autoUpdate, flip, FloatingArrow, FloatingDelayGroup, FloatingPortal, offset, shift, useDelayGroup, useDismiss,
  useFloating, useFocus, useHover, useInteractions, useMergeRefs, useRole,
} from "@floating-ui/react";
import "./tooltip.css";

const arrowHeight = 5;
const tooltipGap = 8;
const padding = 8;
const hoverDelay = 400;

type TooltipAnchor = { element: HTMLElement; content: string; x?: number };

function pointerReference(element: Element, x: number) {
  return {
    contextElement: element,
    getBoundingClientRect: () => {
      const { top, height } = element.getBoundingClientRect();
      return new DOMRect(x, top, 0, height);
    },
  };
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <FloatingDelayGroup delay={hoverDelay} timeoutMs={300}>{children}</FloatingDelayGroup>;
}

type TooltipProps = {
  children: ReactElement<HTMLAttributes<HTMLElement> & RefAttributes<HTMLElement>>;
  content: string;
  anchor?: never;
  onDismiss?: never;
} | { anchor: TooltipAnchor; onDismiss: () => void; children?: never; content?: never };

export function Tooltip({ children, content, anchor, onDismiss }: TooltipProps) {
  const [opened, setOpen] = useState(false);
  const open = Boolean(anchor) || opened;
  const arrowRef = useRef<SVGSVGElement>(null);
  const pointerX = useRef<number | null>(null);
  const { context, refs, floatingStyles, isPositioned, placement } = useFloating({
    open, placement: "top", strategy: "fixed", whileElementsMounted: autoUpdate,
    onOpenChange(next, event, reason) {
      if (anchor) {
        if (!next) onDismiss();
        return;
      }
      const reference = refs.domReference.current;
      if (next && reason === "hover" && event instanceof MouseEvent && reference) {
        refs.setPositionReference(pointerReference(reference, pointerX.current ?? event.clientX));
      } else if (next) refs.setPositionReference(reference);
      pointerX.current = null;
      setOpen(next);
    },
    middleware: [offset(arrowHeight + tooltipGap), flip({ padding }), shift({ padding }), arrow({ element: arrowRef, padding: 4 })],
  });
  const { setReference, setPositionReference } = refs;
  useLayoutEffect(() => {
    if (!anchor) return;
    const { element, x } = anchor;
    setReference(element);
    setPositionReference(x === undefined ? element : pointerReference(element, x));
  }, [anchor, setReference, setPositionReference]);
  const { delay } = useDelayGroup(context, { enabled: !anchor });
  const hover = useHover(context, { enabled: !anchor, delay, mouseOnly: true, move: false });
  const point = { reference: { onPointerMove(event: React.PointerEvent) {
    if (!open && event.pointerType === "mouse") pointerX.current = event.clientX;
  } } };
  const focus = useFocus(context, { enabled: !anchor });
  const dismiss = useDismiss(context, { referencePress: true, ancestorScroll: true, bubbles: { escapeKey: true } });
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, point, focus, dismiss, role]);
  const trigger = useMergeRefs([setReference, children?.props.ref]);

  return <>
    {children && cloneElement(children, { ...getReferenceProps(children.props), ref: trigger })}
    {open && <FloatingPortal><Theme asChild>
      <div {...getFloatingProps()} ref={refs.setFloating} className="workspace-tooltip" data-placement={placement}
        style={{ ...floatingStyles, visibility: isPositioned ? undefined : "hidden" }}>
        {anchor?.content ?? content}
        <FloatingArrow ref={arrowRef} context={context} width={10} height={arrowHeight} fill="var(--tooltip-bg)" />
      </div>
    </Theme></FloatingPortal>}
  </>;
}

function tooltipControl(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
}

export function DomTooltips({ root }: { root: RefObject<HTMLElement | null> }) {
  const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);

  useEffect(() => {
    const host = root.current!;
    const events = new AbortController();
    const options = { signal: events.signal };
    let timer: number | undefined;
    let pointerX = 0;
    const close = () => {
      window.clearTimeout(timer);
      setAnchor(null);
    };
    host.addEventListener("pointerover", event => {
      const element = tooltipControl(event.target);
      if (!element || event.pointerType !== "mouse" || event.buttons ||
        element.contains(event.relatedTarget as Node | null)) return;
      close();
      pointerX = event.clientX;
      timer = window.setTimeout(() => {
        if (element.isConnected && element.getClientRects().length) {
          setAnchor({ element, content: element.dataset.tooltip!, x: pointerX });
        }
      }, hoverDelay);
    }, options);
    host.addEventListener("pointermove", event => { pointerX = event.clientX; }, options);
    host.addEventListener("pointerout", event => {
      const element = tooltipControl(event.target);
      if (element && !element.contains(event.relatedTarget as Node | null)) close();
    }, options);
    host.addEventListener("pointerdown", close, options);
    host.addEventListener("focusin", event => {
      const element = tooltipControl(event.target);
      if (!element?.matches(":focus-visible")) return;
      close();
      setAnchor({ element, content: element.dataset.tooltip! });
    }, options);
    host.addEventListener("focusout", event => {
      if (tooltipControl(event.target)) close();
    }, options);
    return () => {
      events.abort();
      window.clearTimeout(timer);
    };
  }, [root]);

  return anchor ? <Tooltip anchor={anchor} onDismiss={() => setAnchor(null)} /> : null;
}
