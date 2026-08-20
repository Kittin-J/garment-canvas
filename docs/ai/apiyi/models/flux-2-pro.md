# flux-2-pro

产品范围：普通图片生成节点，支持文生图和最多 8 张参考图编辑或融合。

## 请求

- 统一端点：POST /v1/images/generations，application/json。
- 没有参考图时为文生图；传 input_image 后进入编辑模式。
- 参考图依次使用 input_image、input_image_2 到 input_image_8；值为公网 URL 或 data URI。
- 单张参考图不超过 20MB 或 20MP，格式为 PNG、JPEG 或 WebP。
- 尺寸使用 size，或使用 width 与 height；两套方式二选一。
- width 和 height 均必须是 16 的倍数，至少 64，且总像素不超过约 4MP。
- n 固定为 1。
- output_format 仅允许 jpeg 或 png。
- seed 可选；相同 seed 与相同参数用于可复现结果。
- 编辑时不传 aspect_ratio 则输出跟随第一张参考图。
- 建议调用超时 120 秒。

## 响应

- 只读取 data[0].url，不期待 b64_json。
- URL 通常约 10 分钟失效且可能无 CORS，Worker 必须立即下载并转存。
- 转存失败时任务不得标记成功。
