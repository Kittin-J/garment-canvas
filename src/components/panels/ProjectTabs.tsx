import { useFlowStore, type ProjectTab } from "@/store/flowStore";
import { isNodeRunActive } from "@/types/workflow";

function hasRunningNode(tab: ProjectTab): boolean {
  return tab.nodes.some((node) => isNodeRunActive(node.data.status));
}

export function ProjectTabs() {
  const tabs = useFlowStore((state) => state.tabs);
  const activeTabId = useFlowStore((state) => state.activeTabId);
  const switchTab = useFlowStore((state) => state.switchTab);
  const closeTab = useFlowStore((state) => state.closeTab);
  const createBlankTab = useFlowStore((state) => state.createBlankTab);

  const requestClose = (tab: ProjectTab) => {
    const warnings: string[] = [];
    if (hasRunningNode(tab)) {
      window.alert("生成任务运行中，请等待任务完成后再关闭项目页签；结果会继续写回当前画布。");
      return;
    }
    if (tab.dirty) warnings.push("有未保存修改");
    if (
      warnings.length > 0 &&
      !window.confirm(`${tab.projectName}：${warnings.join("，")}。确定关闭这个项目页签吗？`)
    ) {
      return;
    }
    closeTab(tab.id);
  };

  return (
    <nav
      aria-label="项目画布页签"
      className="gc-panel flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-[#262626] bg-[#101010] px-2 pt-1"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const running = hasRunningNode(tab);
        return (
          <div
            key={tab.id}
            className={`group flex h-8 min-w-[148px] max-w-[240px] items-center rounded-t-md border border-b-0 px-2 transition-colors ${
              active
                ? "border-[#343434] bg-[#1a1a1a] text-neutral-100"
                : "border-transparent bg-[#141414] text-neutral-500 hover:bg-[#191919] hover:text-neutral-300"
            }`}
          >
            <button
              type="button"
              onClick={() => switchTab(tab.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={tab.projectName}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  running
                    ? "animate-pulse bg-blue-400"
                    : tab.dirty
                      ? "bg-gold"
                      : "bg-neutral-700"
                }`}
              />
              <span className="truncate text-[11px]">{tab.projectName}</span>
            </button>
            <button
              type="button"
              onClick={() => requestClose(tab)}
              aria-label={`关闭 ${tab.projectName}`}
              title="关闭页签"
              className="ml-1 rounded px-1 text-[13px] leading-5 text-neutral-600 hover:bg-white/5 hover:text-neutral-300"
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={createBlankTab}
        aria-label="新建空白项目页签"
        title="新建空白项目"
        className="mb-1 flex h-7 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-lg text-neutral-500 hover:border-[#333] hover:bg-[#191919] hover:text-gold"
      >
        +
      </button>
    </nav>
  );
}
