# 灵眸 GPT Image 2 接口基准

来源：https://docs.lmuai.com/docs/api/gpt-image
最后核对：2026-08-15（上游文档标注最后更新 2026-07-26）

本文是 garment-canvas 的本地接入基准，只记录项目实现所需的接口约束，不包含 API Key、用户提示词或图片内容。修改 `gpt-image-2` Provider 时应先核对本文与上游原文。

## 固定接口

- Base URL：`https://api.lmuai.com/v1`
- 文生图：`POST /images/generations`，`application/json`
- 图片编辑：`POST /images/edits`，`multipart/form-data`
- 鉴权：服务端发送 `Authorization: Bearer <API_KEY>`
- 当前没有 GPT 图片批量任务端点；多张结果由客户端逐次同步请求并控制并发/RPM。

## 文生图请求

推荐字段：

- `model=gpt-image-2`
- `prompt`
- `n`（是否可用及上限取决于当前渠道能力）
- `size`，例如 `1024x1024`
- `quality=low`
- `output_format=png`

## 图片编辑请求

官方示例使用以下 multipart 字段：

- `model=gpt-image-2`
- `prompt`
- 单数 `image` 文件字段
- `size=1024x1024`
- `quality=low`
- `output_format=png`
- 可选 `mask`

上游文档没有承诺 `image[]` 多文件契约。项目需要 2–8 张参考图时，服务端必须按用户连线顺序将参考图合并为一张编号参考板，再通过单数 `image` 字段上传；不得依赖未记录的网关扩展。

项目中的 `image2` 与当前 `nanobanana` 独立图片分组都配置为 `gpt-image-2`，因此两条适配路径必须遵守同一份单数 `image` 契约。

## 输出与尺寸

- 同时兼容 `data[].b64_json` 和 `data[].url`。
- 成功必须同时满足：HTTP 2xx、`data` 非空、至少一个非空图片字段。
- `size` 不是强制裁切或像素保证。不同上游可能映射或归一化尺寸。
- 用户要求固定画幅时，服务端读取实际输出尺寸并在业务侧无拉伸地调整到目标比例。
- “高清放大”2K/4K 由业务侧保持宽高比，将长边分别处理为 2048/4096 像素；不能把 GPT Image 的 `size` 当成 2K/4K 保证。

## 错误处理

- `400`：请求体、图片格式、字段或模型错误；不自动重试，应修正请求契约。
- `401/403`：Key 或分组权限错误；不重试。
- `429`：降低并发/RPM并做有限退避。
- `5xx`、网络错误、超时：允许有限次数重试。
- 诊断只记录状态、分类、上游请求 ID 等白名单字段；不得记录 API Key、提示词、图片、data URL 或完整响应体。

## 项目回归要求

- 单参考图编辑只发送一个 `image`，并发送 `quality=low`、`output_format=png`。
- 2–8 张参考图合并后仍只发送一个 `image`，顺序可识别；第 9 张在外部请求前拒绝。
- 用户选择的五种画幅最终像素比例必须准确。
- 高清放大最终长边必须准确为 2048 或 4096，保持原比例且输出不超过项目图片体积上限。
- 400 不重放；429/5xx 的重试次数保持有界。
