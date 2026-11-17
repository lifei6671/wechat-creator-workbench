import { useCallback, useRef, useState, type PointerEvent } from "react";

function translateGhost(element: HTMLDivElement, x: number, y: number) {
  element.style.translate = `${x}px ${y}px`;
}

export function usePointerDrag<Item extends { id: string; title: string }, Target extends { id: string | null; placement: string }>(
  itemAt: (element: Element) => Item | null,
  targetAt: (event: PointerEvent<HTMLElement>, item: Item) => Target | null,
  onDrop: (item: Item, target: Target) => void,
  positionGhost = translateGhost,
) {
  const source = useRef<{ item: Item; pointer: number; x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const ghostNode = useRef<HTMLDivElement>(null);
  const point = useRef({ x: 0, y: 0 });
  const ghostElement = useCallback((element: HTMLDivElement | null) => {
    ghostNode.current = element;
    if (element) positionGhost(element, point.current.x, point.current.y);
  }, [positionGhost]);
  const [ghost, setGhost] = useState<(Item & { x: number; y: number }) | null>(null);
  const [hint, setHint] = useState<Target | null>(null);

  function reset() {
    source.current = null;
    setGhost(null);
    setHint(null);
  }

  return { ghost, ghostElement, hint, events: {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || !event.isPrimary) return;
      suppressClick.current = false;
      const item = itemAt(event.target as Element);
      source.current = item && { item, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const drag = source.current;
      if (!drag || event.pointerId !== drag.pointer || !(event.buttons & 1)) return;
      const { clientX: x, clientY: y } = event;
      point.current.x = x;
      point.current.y = y;
      if (!drag.active) {
        if (Math.hypot(x - drag.x, y - drag.y) < 5) return;
        drag.active = true;
        suppressClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setGhost({ ...drag.item, x, y });
      } else if (ghostNode.current) positionGhost(ghostNode.current, x, y);
      const next = targetAt(event, drag.item);
      setHint(current => current?.id === next?.id && current?.placement === next?.placement ? current : next);
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const drag = source.current;
      if (!drag || event.pointerId !== drag.pointer) return;
      const next = drag.active ? targetAt(event, drag.item) : null;
      reset();
      if (next) onDrop(drag.item, next);
    },
    onPointerCancel: reset,
    onLostPointerCapture: reset,
    onClickCapture(event: React.MouseEvent<HTMLElement>) {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.stopPropagation();
    },
  } };
}
