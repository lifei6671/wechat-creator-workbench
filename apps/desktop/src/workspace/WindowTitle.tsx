import { useEffect, useState, type MouseEvent } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { macTitleBar, nativeWindow, windowsTitleBar } from "../desktop";
import { Tooltip } from "../ui";

export function WindowDragRegion({ onError }: { onError(error: unknown): void }) {
  function drag(event: MouseEvent<HTMLElement>) {
    if (!(windowsTitleBar || macTitleBar) || event.button !== 0) return;
    if (event.detail === 2) void nativeWindow().toggleMaximize().catch(onError);
    else void nativeWindow().startDragging().catch(onError);
  }
  return <div className="window-drag" aria-hidden="true" onMouseDown={drag} />;
}

export function WindowControls({ onError }: { onError(error: unknown): void }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const window = nativeWindow();
    const update = () => { void window.isMaximized().then(setMaximized, onError); };
    update();
    const listen = window.onResized(update);
    void listen.catch(onError);
    return () => { void listen.then(unlisten => unlisten(), () => {}); };
  }, [onError]);

  const toggleLabel = maximized ? "还原" : "最大化";
  return <div className="window-controls" role="group" aria-label="窗口控制">
    <Tooltip content="最小化">
      <button type="button" aria-label="最小化" onClick={() => void nativeWindow().minimize().catch(onError)}><Minus size={15} /></button>
    </Tooltip>
    <Tooltip content={toggleLabel}>
      <button type="button" aria-label={toggleLabel} onClick={() => void nativeWindow().toggleMaximize().catch(onError)}>
        {maximized ? <Copy size={13} /> : <Square size={13} />}
      </button>
    </Tooltip>
    <Tooltip content="关闭窗口">
      <button type="button" className="window-close" aria-label="关闭窗口" onClick={() => void nativeWindow().close().catch(onError)}><X size={16} /></button>
    </Tooltip>
  </div>;
}
