import { useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";
import { desktop, type CanvasWebPage } from "../desktop";
import type { CanvasPreviewCache } from "./CanvasPreviewCache";

let nativeWrites = Promise.resolve();
let nextSession = 0;

export function pastedWebUrl(text: string): string | undefined {
  const value = text.trim();
  if (!/^https?:\/\/[^/\\]/i.test(value) || /\s/.test(value)) return;
  try { if (new URL(value).hostname) return value; } catch { return undefined; }
}

function writePreview(operation: () => Promise<void>) {
  const write = nativeWrites.then(operation);
  nativeWrites = write.catch(() => {});
  return write;
}

function afterPaint() {
  return new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
}

function visibleBounds(rect: DOMRect, canvas: HTMLElement, layoutWidth: number) {
  const region = canvas.getBoundingClientRect();
  const x = Math.ceil(Math.max(rect.left, region.left, 0));
  const y = Math.ceil(Math.max(rect.top, region.top, 0));
  const right = Math.floor(Math.min(rect.right, region.right, window.innerWidth));
  const bottom = Math.floor(Math.min(rect.bottom, region.bottom, window.innerHeight));
  if (right <= x || bottom <= y) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, layoutWidth,
    clip: { x: x - rect.x, y: y - rect.y, width: right - x, height: bottom - y } };
}

type Bounds = ReturnType<typeof visibleBounds>;

function samePageSize(left: Bounds, right: Bounds) {
  return left?.width === right?.width && left?.height === right?.height && left?.layoutWidth === right?.layoutWidth;
}

function sameBounds(left: Bounds, right: Bounds) {
  return samePageSize(left, right) && left?.x === right?.x && left?.y === right?.y
    && left?.clip.x === right?.clip.x && left?.clip.y === right?.clip.y
    && left?.clip.width === right?.clip.width && left?.clip.height === right?.clip.height;
}

export function useCanvasWebPreview(area: RefObject<HTMLDivElement | null>, slot: HTMLDivElement | null,
  card: { id: string; url: string } | undefined, hidden: boolean, getZoom: () => number, reveal: () => void,
  onTitle: (id: string, title: string) => void, onError: (error: unknown) => void,
  prepareZoom: RefObject<(() => Promise<void> | undefined) | undefined>, cache: CanvasPreviewCache, onEscape: () => void) {
  const { id, url } = card ?? {};
  const pages = useRef(new Map<string, CanvasWebPage>());
  const update = useRef<() => void>(undefined);
  const isHidden = useEffectEvent(() => hidden);
  const canvasZoom = useEffectEvent(getZoom);
  const revealCard = useEffectEvent(reveal);
  const updateTitle = useEffectEvent(onTitle);
  const report = useEffectEvent(onError);
  const escape = useEffectEvent(onEscape);

  useLayoutEffect(() => {
    const canvas = area.current;
    if (!id || !url || !canvas || !slot) return;
    const previewSlot = slot;
    const session = ++nextSession;
    const key = { collectionId: cache.collectionId, nodeId: id, url };
    const pageKey = JSON.stringify([id, url]);
    const stopListening: (() => void)[] = [];
    const hasOverlay = () => Boolean(document.querySelector('[role="menu"][data-state="open"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'));
    let current = true, opened = false, supportsSnapshot = false, front = false, revealing = false;
    let loaded = false, painted = false, shown = false;
    let navigation = 0, paintedAt: Bounds = null;
    let transition: AbortController | undefined;
    let pageToRestore: CanvasWebPage | undefined;
    let restoreAttempts = 0;
    let queued = false, failed = false, centered = false, overlay = hasOverlay();
    let lastBounds: Bounds = null, lastZoom = 0, attempts = 0;
    let frame: number | undefined, paintRetry: number | undefined, restoreTimer: number | undefined;
    let freezing: Promise<void> | undefined, restoring: Promise<void> | undefined;
    let frozen = false, pendingScroll = false, motion = 0;

    function measure() {
      return isHidden() || overlay ? null : visibleBounds(slot!.getBoundingClientRect(), canvas!, slot!.clientWidth);
    }

    function schedule() {
      if (!current || frozen || frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; sync(); });
    }

    function retryPaint(delay: number) {
      window.clearTimeout(paintRetry);
      paintRetry = window.setTimeout(schedule, delay);
    }

    async function cover(rememberScroll = false) {
      if (!front) return;
      await desktop.canvasWebview({ action: "cover", ...(rememberScroll ? { rememberScroll } : {}) });
      front = false;
      if (rememberScroll) pendingScroll = true;
    }

    async function revealView() {
      revealing = true;
      try {
        await desktop.canvasWebview({ action: "reveal" });
        front = shown = true;
      } finally {
        revealing = false;
      }
    }

    function sync() {
      if (!current || queued || failed || frozen) return;
      queued = true;
      void writePreview(async () => {
        queued = false;
        if (!current || failed || frozen) return;
        let bounds = measure();
        let zoom = canvasZoom();
        if (!opened) {
          const rect = previewSlot.getBoundingClientRect();
          if (!isHidden() && !overlay && !centered && rect.width > 0 && (!bounds
            || bounds.clip.width < Math.floor(rect.right) - Math.ceil(rect.left)
            || bounds.clip.height < Math.floor(rect.bottom) - Math.ceil(rect.top))) {
            centered = true;
            revealCard();
          }
          if (!bounds) return;
          if (!stopListening.length) {
            const stopTitle = await desktop.onCanvasWebTitle((source, title) => {
              if (current && source === session && title.trim()) updateTitle(key.nodeId, title.trim());
            });
            if (!current) { stopTitle(); return; }
            stopListening.push(stopTitle);
            const stopState = await desktop.onCanvasWebState(event => {
              if (!current) return;
              if (event === "escape") { escape(); return; }
              if (event === "loading") {
                if (!shown) {
                  navigation++;
                  loaded = painted = false;
                  transition?.abort();
                }
                return;
              }
              loaded = true;
              attempts = 0;
              schedule();
            }, session);
            if (!current) { stopState(); return; }
            stopListening.push(stopState);
          }
          if (frozen) return;
          bounds = measure();
          zoom = canvasZoom();
          if (!bounds) return;
          pageToRestore = pages.current.get(pageKey);
          supportsSnapshot = await desktop.canvasWebview({ action: "open", url: pageToRestore?.url ?? key.url, session, bounds, zoom });
          opened = true;
          front = !supportsSnapshot;
        } else if (!bounds) {
          if (supportsSnapshot) await cover();
          else if (lastBounds) {
            await desktop.canvasWebview({ action: "bounds", bounds: null, zoom, resume: false });
            front = false;
          }
        } else if (pendingScroll || !sameBounds(bounds, lastBounds) || zoom !== lastZoom) {
          await desktop.canvasWebview({ action: "bounds", bounds, zoom, resume: !supportsSnapshot && !front,
            ...(pendingScroll ? { restoreScroll: true } : {}) });
          pendingScroll = false;
          if (!supportsSnapshot) front = true;
        }
        lastBounds = bounds;
        lastZoom = zoom;
        if (!current || frozen || !bounds || front || !supportsSnapshot || !loaded) return;
        if (!shown && painted && !samePageSize(paintedAt, bounds)) painted = false;
        if (!painted) {
          const loadingPage = navigation;
          let waitForScroll = false;
          if (pageToRestore) {
            const target = pageToRestore;
            const position = await desktop.canvasWebviewPage(session, target).catch(error => {
              console.warn("恢复网页位置失败", error);
              return null;
            });
            if (!current || frozen || loadingPage !== navigation) return;
            waitForScroll = restoreAttempts < 2 && position?.url === target.url
              && (Math.abs(position.x - target.x) > 2 || Math.abs(position.y - target.y) > 2);
            await afterPaint();
            if (!current || frozen || loadingPage !== navigation) return;
          }
          attempts++;
          let bytes: ArrayBuffer;
          try {
            bytes = await desktop.canvasWebviewSnapshot(false, waitForScroll ? undefined : key);
          } catch (error) {
            if (current && attempts === 6) report(error);
            bytes = new ArrayBuffer(0);
          }
          if (!current || frozen || loadingPage !== navigation) return;
          if (!samePageSize(bounds, measure()) || zoom !== canvasZoom()) { schedule(); return; }
          if (waitForScroll && bytes.byteLength) {
            restoreAttempts++;
            retryPaint(60);
            return;
          }
          const handoff = new AbortController();
          transition = handoff;
          const accepted = await cache.capture(key.nodeId, key.url, bytes, handoff.signal);
          transition = undefined;
          if (!current || frozen) return;
          if (handoff.signal.aborted) { schedule(); return; }
          if (!accepted) {
            // Busy client-rendered pages may paint after the fast retry window.
            retryPaint(attempts < 6 ? 60 : 1000);
            return;
          }
          pageToRestore = undefined;
          painted = true;
          paintedAt = bounds;
          // Give the committed image a frame in the main WebView before raising the child HWND.
          await afterPaint();
        }
        if (current && !frozen && loaded && painted && sameBounds(bounds, measure()) && zoom === canvasZoom()) {
          await revealView();
        } else schedule();
      }).catch(error => {
        failed = true;
        if (current) report(error);
      });
    }

    function restore(ticket: number, retries = 0) {
      restoring = writePreview(async () => {
        if (!current || ticket !== motion) return;
        const bounds = measure();
        const zoom = canvasZoom();
        if (opened && painted && bounds) {
          await desktop.canvasWebview({ action: "bounds", bounds, zoom, resume: false, restoreScroll: pendingScroll });
          pendingScroll = false;
          const paintedFrame = await desktop.canvasWebviewSnapshot(false);
          if (!current || ticket !== motion) return;
          if (!sameBounds(bounds, measure()) || zoom !== canvasZoom()) {
            restoreTimer = window.setTimeout(() => restore(ticket, retries), 60);
            return;
          }
          if (paintedFrame.byteLength) {
            await revealView();
            if (!current || ticket !== motion) return;
          } else if (retries < 3) {
            restoreTimer = window.setTimeout(() => restore(ticket, retries + 1), 60);
            return;
          } else {
            painted = false;
            attempts = 0;
          }
          lastBounds = bounds;
          lastZoom = zoom;
        }
        frozen = false;
        schedule();
      }).catch(error => {
        if (!current || ticket !== motion) return;
        frozen = false;
        painted = false;
        attempts = 0;
        schedule();
        report(error);
      }).finally(() => { restoring = undefined; });
    }

    function prepare() {
      if (!current || (opened && !supportsSnapshot)) return;
      const ticket = ++motion;
      window.clearTimeout(restoreTimer);
      frozen = true;
      transition?.abort();
      if (!freezing && (front || revealing || restoring)) {
        freezing = writePreview(async () => {
          if (!current || !opened || !front || !supportsSnapshot) return;
          await cover(true);
        }).catch(error => {
          if (current) report(error);
        }).finally(() => { freezing = undefined; });
      }
      const armRestore = () => {
        if (current && ticket === motion) restoreTimer = window.setTimeout(() => restore(ticket), 350);
      };
      if (freezing) void freezing.then(armRestore);
      else armRestore();
      return freezing;
    }
    prepareZoom.current = prepare;

    update.current = () => { if (isHidden()) sync(); else schedule(); };
    const geometry = new ResizeObserver(() => {
      if (transition && !samePageSize(lastBounds, measure())) transition.abort();
      schedule();
    });
    geometry.observe(slot);
    geometry.observe(canvas);
    const transforms = new MutationObserver(schedule);
    for (const selector of [".react-flow__viewport", ".react-flow__node"]) {
      const element = slot.closest(selector);
      if (element) transforms.observe(element, { attributes: true, attributeFilter: ["style"] });
    }
    const menus = new MutationObserver(() => {
      const next = hasOverlay();
      if (overlay === next) return;
      overlay = next;
      if (next) sync(); else schedule();
    });
    menus.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      current = false;
      transition?.abort();
      if (prepareZoom.current === prepare) prepareZoom.current = undefined;
      window.clearTimeout(restoreTimer);
      window.clearTimeout(paintRetry);
      stopListening.forEach(stop => stop());
      update.current = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      geometry.disconnect();
      transforms.disconnect();
      menus.disconnect();
      window.removeEventListener("resize", schedule);
      void writePreview(async () => {
        if (!opened) return;
        try {
          if (supportsSnapshot) {
            await cover();
            if (shown) {
              const page = await desktop.canvasWebviewPage(session).catch(error => {
                console.warn("读取网页位置失败", error);
                return null;
              });
              if (page) pages.current.set(pageKey, page);
              const still = await desktop.canvasWebviewSnapshot(false, key);
              void cache.capture(id, url, still);
            }
          }
        } finally {
          await desktop.canvasWebview({ action: "close" });
        }
      }).catch(error => console.warn("关闭网页预览失败", error));
    };
  }, [area, slot, id, url, prepareZoom, cache]);

  useLayoutEffect(() => { update.current?.(); }, [hidden]);
}
