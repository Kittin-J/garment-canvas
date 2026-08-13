import { useEffect, useRef } from "react";
import { useViewport } from "@xyflow/react";

/**
 * 画布点阵背景 · 波浪呼吸动效
 * 金色圆点沿对角线方向做正弦波呼吸（大小 + 透明度起伏），
 * 跟随画布平移/缩放，视觉上是附着在画布上的。
 */
export function DotWaveBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewport = useViewport();
  // 用 ref 透传视口，避免平移/缩放时重建动画循环
  const vpRef = useRef(viewport);
  useEffect(() => {
    vpRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const GAP = 24; // 点间距（与原 Background 一致）
    const SPEED = 2.4; // 波速
    const FREQ = 0.008; // 波的空间频率（径向，中心向外）
    let raf = 0;
    let last = 0;
    const start = performance.now();

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // 限帧到 ~30fps，足够顺滑且省电
      if (now - last < 33) return;
      last = now;
      if (document.hidden) return;

      const t = (now - start) / 1000;
      const { x: vx, y: vy, zoom } = vpRef.current;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const gap = GAP * zoom * dpr;
      if (gap < 8) return; // 缩得太小就不画，避免糊成一片

      const ox = (((vx * dpr) % gap) + gap) % gap;
      const oy = (((vy * dpr) % gap) + gap) % gap;
      const sizeScale = Math.min(zoom, 1.2) * dpr;
      // 波纹从画布中心向外扩散
      const centerX = w / 2;
      const centerY = h / 2;

      for (let cy = oy; cy < h + gap; cy += gap) {
        for (let cx = ox; cx < w + gap; cx += gap) {
          const dist = Math.hypot(cx - centerX, cy - centerY);
          const s = (Math.sin(t * SPEED - dist * FREQ) + 1) / 2; // 0..1 呼吸相位
          const r = (0.7 + s * 1.0) * sizeScale;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(201, 166, 107, ${(0.08 + s * 0.2).toFixed(3)})`;
          ctx.fill();
        }
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
