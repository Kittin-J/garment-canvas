# API易 gpt-image-2-all 接入基准

本文只记录 Garment Canvas 的实现约束，不包含 API Key、用户提示词或图片内容。上游依据：

- https://docs.apiyi.com/api-capabilities/gpt-image-2-all/overview
- https://docs.apiyi.com/api-capabilities/gpt-image-2-all/text-to-image
- https://docs.apiyi.com/api-capabilities/gpt-image-2-all/image-edit

## 配置

- `APIYI_BASE_URL=https://api.apiyi.com/v1`
- `APIYI_API_KEY` 只放私有 `.env`
- `APIYI_IMAGE_MODEL=gpt-image-2-all`
- `APIYI_MAX_REFERENCE_IMAGES=8`

旧 `CHANGE2PRO_*`、`IMAGE2_MODEL` 只用于升级回退。

## 文生图

`POST /v1/images/generations`，JSON 只发送：

- `model`
- `prompt`（画幅前缀放在最前）
- `response_format=b64_json`

禁止发送 `n`、`size`、`quality`、`aspect_ratio`、`output_format`。模型单次只返回一张，批量数量由现有任务层逐次补足。

## 图片编辑

`POST /v1/images/edits`，使用 `multipart/form-data`：

- `model`
- `prompt`
- `response_format=b64_json`
- 每张参考图重复一个同名 `image` 字段，顺序对应提示词中的图1、图2……

该模型不支持蒙版编辑。参考图片限制为 PNG/JPEG/WebP，生产端最多八张。

## 响应与持久化

响应读取 `data[].b64_json`，同时兼容历史上偶尔出现的 `data:` 前缀。结果必须立即进入 Garment Canvas 自有文件存储，再写入生图历史；不长期依赖第三方临时 URL。

接口是同步长连接。现有 Run/SSE/数据库记录继续作为产品侧异步外壳；不得假设 API易提供任务 ID 或轮询接口。
