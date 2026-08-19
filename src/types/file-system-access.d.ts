// File System Access API 中，本 TS DOM lib 尚未包含的部分（Chromium 专有权限方法 + 目录选择器）。
// 其余（FileSystemDirectoryHandle / getFileHandle / createWritable）由内置 lib.dom 提供。

interface FileSystemDirectoryHandle {
  queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker?(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
}
