import { Component, type ErrorInfo, type ReactNode } from "react";
import { discardActiveTabSession } from "@/store/flowStore";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorId: string;
}

function createErrorId(): string {
  const time = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `GC-${time}-${suffix}`;
}

function buildVersion(): string {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  const match = script?.src.match(/\/assets\/[^/]*-([A-Za-z0-9_-]+)\.js(?:\?|$)/);
  return match?.[1] ?? "development";
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false, errorId: "" };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true, errorId: createErrorId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[garment-canvas:${this.state.errorId}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="flex h-full items-center justify-center bg-[var(--gc-shell)] p-6 text-[var(--gc-text)]">
        <section className="w-full max-w-md rounded-xl border border-[var(--gc-border)] bg-[var(--gc-panel)] p-6 shadow-2xl">
          <div className="text-xs font-medium tracking-[0.2em] text-[var(--gc-accent)]">GARMENT CANVAS</div>
          <h1 className="mt-4 text-lg font-semibold">页面出现异常</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--gc-text-muted)]">
            画布数据仍保留在本机。请先重新加载；如果同一页签持续报错，再仅清除当前损坏页签。
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex-1 rounded-md bg-[var(--gc-accent)] px-4 py-2 text-sm font-medium text-white"
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={() => {
                discardActiveTabSession();
                window.location.reload();
              }}
              className="flex-1 rounded-md border border-[var(--gc-border)] px-4 py-2 text-sm text-[var(--gc-text)]"
            >
              清除当前损坏页签并恢复
            </button>
          </div>
          <dl className="mt-5 space-y-1 border-t border-[var(--gc-border)] pt-4 font-mono text-[10px] text-[var(--gc-text-muted)]">
            <div className="flex justify-between gap-4"><dt>错误编号</dt><dd>{this.state.errorId}</dd></div>
            <div className="flex justify-between gap-4"><dt>构建版本</dt><dd>{buildVersion()}</dd></div>
          </dl>
        </section>
      </main>
    );
  }
}
