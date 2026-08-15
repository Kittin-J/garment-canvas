import assert from "node:assert/strict";
import {
  AUTH_CHANGE_STORAGE_KEY,
  authChangeFromStorageEvent,
  bindWorkspaceToAuthenticatedUser,
  broadcastAuthChange,
  clearLocalWorkspace,
  clearSessionEndNotice,
  isCurrentSessionRefresh,
  prepareWorkspaceForLogin,
  readSessionEndNotice,
  readWorkspaceOwner,
  rememberSessionEndNotice,
  sessionEndReasonFromCode,
  sessionRefreshFailureAction,
} from "../src/auth/session";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    has: (key: string) => values.has(key),
  };
}

console.log("客户端会话失效体验回归测试");

assert.equal(sessionEndReasonFromCode("SESSION_REPLACED"), "replaced");
assert.equal(sessionEndReasonFromCode("UNAUTHENTICATED"), null);
assert.equal(sessionEndReasonFromCode(undefined), null);
console.log("  ✓ 仅新设备替换会话触发专用退出页面");

assert.equal(sessionRefreshFailureAction(500, "SESSION_REPLACED"), "retain-user");
assert.equal(sessionRefreshFailureAction(401, "UNAUTHENTICATED"), "clear-user");
assert.equal(sessionRefreshFailureAction(401, "SESSION_REPLACED"), "end-replaced");
assert.equal(isCurrentSessionRefresh(2, 2, false), true);
assert.equal(isCurrentSessionRefresh(1, 2, false), false);
assert.equal(isCurrentSessionRefresh(2, 2, true), false);
console.log("  ✓ 5xx 保留当前用户，旧 replaced 响应不能覆盖较新的成功响应");

const noticeValues = new Map<string, string>();
noticeValues.set("garment-canvas-project-tabs", "unsaved-draft");
const noticeStorage = {
  getItem: (key: string) => noticeValues.get(key) ?? null,
  setItem: (key: string, value: string) => noticeValues.set(key, value),
  removeItem: (key: string) => { noticeValues.delete(key); },
};
assert.equal(readSessionEndNotice(noticeStorage), null);
rememberSessionEndNotice(noticeStorage, "replaced");
assert.equal(readSessionEndNotice(noticeStorage), "replaced");
assert.equal(noticeValues.get("garment-canvas-project-tabs"), "unsaved-draft");
clearSessionEndNotice(noticeStorage);
assert.equal(readSessionEndNotice(noticeStorage), null);
assert.equal(noticeValues.get("garment-canvas-project-tabs"), "unsaved-draft");
console.log("  ✓ 强制退出只记录原因，不删除未保存画布");

const removed: string[] = [];
clearLocalWorkspace(
  { removeItem: (key) => removed.push(`session:${key}`) },
  { removeItem: (key) => removed.push(`local:${key}`) },
);
assert.deepEqual(removed, [
  "session:garment-canvas-project-tabs",
  "local:garment-canvas-recent-results",
]);
console.log("  ✓ 需要切换账号时可定向清理项目页签与本地记录");

const sameAccountSession = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a",
});
const sameAccountLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
assert.equal(
  prepareWorkspaceForLogin(sameAccountSession, sameAccountLocal, "user-a"),
  "preserved",
);
assert.equal(sameAccountSession.getItem("garment-canvas-project-tabs"), "draft-a");
assert.equal(sameAccountLocal.getItem("garment-canvas-recent-results"), "history-a");
console.log("  ✓ 同一账号重新登录保留未保存画布");

const switchedSession = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a",
});
const switchedLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
assert.equal(prepareWorkspaceForLogin(switchedSession, switchedLocal, "user-b"), "cleared");
assert.equal(switchedSession.has("garment-canvas-project-tabs"), false);
assert.equal(switchedLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(switchedSession), "user-b");
console.log("  ✓ 切换到不同账号时清除旧画布并更新归属");

const unownedLoginSession = memoryStorage({ "garment-canvas-project-tabs": "unknown-owner-draft" });
const unownedLoginLocal = memoryStorage({ "garment-canvas-recent-results": "unknown-owner-history" });
assert.equal(
  prepareWorkspaceForLogin(unownedLoginSession, unownedLoginLocal, "user-a"),
  "cleared",
);
assert.equal(unownedLoginSession.has("garment-canvas-project-tabs"), false);
assert.equal(unownedLoginLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(unownedLoginSession), "user-a");
console.log("  ✓ 显式登录不会暴露无法证明归属的旧草稿");

const legacySession = memoryStorage({ "garment-canvas-project-tabs": "legacy-draft" });
const legacyLocal = memoryStorage({ "garment-canvas-recent-results": "legacy-history" });
assert.equal(
  bindWorkspaceToAuthenticatedUser(legacySession, legacyLocal, "user-a"),
  "cleared",
);
assert.equal(legacySession.has("garment-canvas-project-tabs"), false);
assert.equal(legacyLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(legacySession), "user-a");
console.log("  ✓ 无 owner 的旧缓存按不可信数据清理后再绑定当前账号");

const sameAccountOtherTab = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a-other-tab",
});
const sameAccountSharedLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
broadcastAuthChange(sameAccountSharedLocal, "login", "user-a");
const sameAccountEvent = authChangeFromStorageEvent(
  AUTH_CHANGE_STORAGE_KEY,
  sameAccountSharedLocal.getItem(AUTH_CHANGE_STORAGE_KEY),
);
assert.equal(sameAccountEvent?.type, "login");
assert.equal(sameAccountEvent?.userId, "user-a");
assert.equal(
  bindWorkspaceToAuthenticatedUser(sameAccountOtherTab, sameAccountSharedLocal, sameAccountEvent?.userId ?? ""),
  "preserved",
);
assert.equal(sameAccountOtherTab.getItem("garment-canvas-project-tabs"), "draft-a-other-tab");
console.log("  ✓ 其他页签收到同账号登录事件后重载仍保留该账号草稿");

const switchedOtherTab = memoryStorage({
  "garment-canvas-workspace-owner-id": "user-a",
  "garment-canvas-project-tabs": "draft-a-other-tab",
});
const switchedSharedLocal = memoryStorage({ "garment-canvas-recent-results": "history-a" });
broadcastAuthChange(switchedSharedLocal, "login", "user-b");
const switchedEvent = authChangeFromStorageEvent(
  AUTH_CHANGE_STORAGE_KEY,
  switchedSharedLocal.getItem(AUTH_CHANGE_STORAGE_KEY),
);
assert.equal(switchedEvent?.userId, "user-b");
assert.equal(
  bindWorkspaceToAuthenticatedUser(switchedOtherTab, switchedSharedLocal, switchedEvent?.userId ?? ""),
  "cleared",
);
assert.equal(switchedOtherTab.has("garment-canvas-project-tabs"), false);
assert.equal(switchedSharedLocal.has("garment-canvas-recent-results"), false);
assert.equal(readWorkspaceOwner(switchedOtherTab), "user-b");
assert.equal(authChangeFromStorageEvent("unrelated", switchedSharedLocal.getItem(AUTH_CHANGE_STORAGE_KEY)), null);
assert.equal(authChangeFromStorageEvent(AUTH_CHANGE_STORAGE_KEY, "not-json"), null);
console.log("  ✓ 其他页签收到跨账号事件后重载并按 owner 隔离旧草稿");

const terminalEventStorage = memoryStorage();
broadcastAuthChange(terminalEventStorage, "auth-changed");
assert.equal(
  authChangeFromStorageEvent(
    AUTH_CHANGE_STORAGE_KEY,
    terminalEventStorage.getItem(AUTH_CHANGE_STORAGE_KEY),
  )?.type,
  "auth-changed",
);
broadcastAuthChange(terminalEventStorage, "logout");
assert.equal(
  authChangeFromStorageEvent(
    AUTH_CHANGE_STORAGE_KEY,
    terminalEventStorage.getItem(AUTH_CHANGE_STORAGE_KEY),
  )?.type,
  "logout",
);
console.log("  ✓ 会话替换和退出事件同样可通知其他页签立即终止工作区");

const unavailableSessionStorage = {
  getItem: (_key: string): string | null => { throw new Error("storage disabled"); },
  setItem: (_key: string, _value: string): void => { throw new Error("storage disabled"); },
  removeItem: (_key: string): void => { throw new Error("storage disabled"); },
};
const unavailableLocalStorage = {
  getItem: (_key: string): string | null => { throw new Error("storage disabled"); },
  removeItem: (_key: string): void => { throw new Error("storage disabled"); },
};
assert.equal(
  bindWorkspaceToAuthenticatedUser(unavailableSessionStorage, unavailableLocalStorage, "user-a"),
  "unavailable",
);
console.log("  ✓ 浏览器存储不可用时不会返回 cleared 触发无限重载");
