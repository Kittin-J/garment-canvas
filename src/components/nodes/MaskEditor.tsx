import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

interface MaskEditorProps {
  source: string;
  initialMask?: string;
  onSave: (mask: string) => void;
  onClose: () => void;
}

type BrushMode = "edit" | "preserve";
const MAX_MASK_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY = 12;

export function MaskEditor({ source, initialMask, onSave, onClose }: MaskEditorProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<BrushMode>("edit");
  const [brushSize, setBrushSize] = useState(80);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const renderOverlay = () => {
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!mask || !overlay) return;
    const context = overlay.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, overlay.width, overlay.height);
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(239, 68, 68, 0.48)";
    context.fillRect(0, 0, overlay.width, overlay.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = "source-over";
  };

  const loadMaskSnapshot = (snapshot: string) => {
    const mask = maskRef.current;
    if (!mask) return;
    const image = new Image();
    image.onload = () => {
      const context = mask.getContext("2d");
      if (!context) return;
      context.globalCompositeOperation = "source-over";
      context.clearRect(0, 0, mask.width, mask.height);
      context.drawImage(image, 0, 0, mask.width, mask.height);
      renderOverlay();
    };
    image.src = snapshot;
  };

  const captureMask = () => maskRef.current?.toDataURL("image/png") ?? "";

  const pushUndo = () => {
    const snapshot = captureMask();
    if (!snapshot) return;
    setUndoStack((current) => [...current.slice(-(MAX_HISTORY - 1)), snapshot]);
    setRedoStack([]);
  };

  const initializeCanvases = () => {
    const image = imageRef.current;
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!image || !mask || !overlay || !image.naturalWidth || !image.naturalHeight) return;
    mask.width = image.naturalWidth;
    mask.height = image.naturalHeight;
    overlay.width = image.naturalWidth;
    overlay.height = image.naturalHeight;
    const context = mask.getContext("2d");
    if (!context) return;
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, mask.width, mask.height);
    if (initialMask) {
      const existing = new Image();
      existing.onload = () => {
        if (existing.naturalWidth !== mask.width || existing.naturalHeight !== mask.height) {
          setError("已保存蒙版与当前原图尺寸不一致，请重新绘制");
          renderOverlay();
          setReady(true);
          return;
        }
        context.clearRect(0, 0, mask.width, mask.height);
        context.drawImage(existing, 0, 0);
        renderOverlay();
        setReady(true);
      };
      existing.onerror = () => {
        setError("无法读取已保存蒙版，请重新绘制");
        renderOverlay();
        setReady(true);
      };
      existing.src = initialMask;
      return;
    }
    renderOverlay();
    setReady(true);
  };

  const pointForEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const drawSegment = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const mask = maskRef.current;
    const overlay = overlayRef.current;
    if (!mask || !overlay) return;
    const maskContext = mask.getContext("2d");
    const overlayContext = overlay.getContext("2d");
    if (!maskContext || !overlayContext) return;
    for (const [context, target] of [[maskContext, "mask"], [overlayContext, "overlay"]] as const) {
      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = brushSize;
      context.globalCompositeOperation = mode === "edit"
        ? target === "mask" ? "destination-out" : "source-over"
        : target === "mask" ? "source-over" : "destination-out";
      context.strokeStyle = target === "mask" ? "rgba(255,255,255,1)" : "rgba(239,68,68,0.48)";
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      context.restore();
    }
  };

  const startDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    pushUndo();
    drawingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointForEvent(event);
    lastPointRef.current = point;
    drawSegment(point, point);
  };

  const continueDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !lastPointRef.current) return;
    const point = pointForEvent(event);
    drawSegment(lastPointRef.current, point);
    lastPointRef.current = point;
  };

  const stopDrawing = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
  };

  const clearMask = () => {
    const mask = maskRef.current;
    if (!mask) return;
    pushUndo();
    const context = mask.getContext("2d");
    if (!context) return;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, mask.width, mask.height);
    renderOverlay();
  };

  const invertMask = () => {
    const mask = maskRef.current;
    if (!mask) return;
    pushUndo();
    const temporary = document.createElement("canvas");
    temporary.width = mask.width;
    temporary.height = mask.height;
    temporary.getContext("2d")?.drawImage(mask, 0, 0);
    const context = mask.getContext("2d");
    if (!context) return;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(255,255,255,1)";
    context.fillRect(0, 0, mask.width, mask.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(temporary, 0, 0);
    context.globalCompositeOperation = "source-over";
    renderOverlay();
  };

  const undo = () => {
    const snapshot = undoStack.at(-1);
    if (!snapshot) return;
    const current = captureMask();
    setUndoStack((stack) => stack.slice(0, -1));
    if (current) setRedoStack((stack) => [...stack.slice(-(MAX_HISTORY - 1)), current]);
    loadMaskSnapshot(snapshot);
  };

  const redo = () => {
    const snapshot = redoStack.at(-1);
    if (!snapshot) return;
    const current = captureMask();
    setRedoStack((stack) => stack.slice(0, -1));
    if (current) setUndoStack((stack) => [...stack.slice(-(MAX_HISTORY - 1)), current]);
    loadMaskSnapshot(snapshot);
  };

  const save = async () => {
    const mask = maskRef.current;
    if (!mask) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        mask.toBlob((value) => value ? resolve(value) : reject(new Error("蒙版编码失败")), "image/png");
      });
      if (blob.size > MAX_MASK_BYTES) throw new Error("蒙版 PNG 超过 4MB，请减少画布尺寸后重试");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("蒙版读取失败"));
        reader.readAsDataURL(blob);
      });
      onSave(dataUrl);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-[#0b0b0b]">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#262626] px-4">
        <strong className="text-sm font-medium text-neutral-100">蒙版局部重绘</strong>
        <span className="text-[10px] text-neutral-500">GPT Image 2</span>
        <div className="ml-auto flex items-center gap-1.5">
          <ToolbarButton label="撤销" disabled={!undoStack.length} onClick={undo} />
          <ToolbarButton label="重做" disabled={!redoStack.length} onClick={redo} />
          <ToolbarButton label="清空" onClick={clearMask} />
          <ToolbarButton label="反选" onClick={invertMask} />
          <button type="button" onClick={onClose} className="ml-2 rounded-md border border-[#333] px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500">
            关闭
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#101010] p-4">
        <div className="relative inline-flex max-h-full max-w-full shadow-2xl shadow-black">
          <img
            ref={imageRef}
            src={source}
            alt="局部重绘原图"
            onLoad={initializeCanvases}
            onError={() => setError("无法读取原图")}
            className="block max-h-[calc(100vh-132px)] max-w-[calc(100vw-32px)] select-none object-contain"
            draggable={false}
          />
          <canvas
            ref={overlayRef}
            onPointerDown={startDrawing}
            onPointerMove={continueDrawing}
            onPointerUp={stopDrawing}
            onPointerCancel={stopDrawing}
            className={`absolute inset-0 h-full w-full touch-none ${ready ? "cursor-crosshair" : "cursor-wait"}`}
          />
          <canvas ref={maskRef} className="hidden" />
        </div>
      </main>

      <footer className="flex min-h-16 shrink-0 items-center gap-4 border-t border-[#262626] px-4 py-2">
        <div className="flex rounded-md border border-[#333] p-0.5">
          <ModeButton active={mode === "edit"} label="涂抹修改区" onClick={() => setMode("edit")} />
          <ModeButton active={mode === "preserve"} label="恢复保留区" onClick={() => setMode("preserve")} />
        </div>
        <label className="flex min-w-56 items-center gap-2 text-[10px] text-neutral-500">
          笔刷 {brushSize}px
          <input
            type="range" min={8} max={300} step={4} value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            className="accent-[#C9A66B]"
          />
        </label>
        {error && <p className="min-w-0 flex-1 truncate text-[10px] text-red-400" title={error}>{error}</p>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!ready || saving}
          className="ml-auto rounded-md bg-gold px-4 py-2 text-xs font-medium text-ink disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存蒙版"}
        </button>
      </footer>
    </div>,
    document.body,
  );
}

function ToolbarButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="rounded-md border border-[#333] px-2.5 py-1.5 text-[10px] text-neutral-400 hover:border-gold/50 hover:text-gold disabled:opacity-30">
      {label}
    </button>
  );
}

function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`rounded px-3 py-1.5 text-[10px] ${active ? "bg-gold text-ink" : "text-neutral-400 hover:text-neutral-200"}`}>
      {label}
    </button>
  );
}
