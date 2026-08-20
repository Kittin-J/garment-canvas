# gpt-image-2-vip

产品范围：普通图片生成节点，支持文生图和参考图编辑。API易文档将该模型标为 Codex 官逆线路；产品文案不得把它误标为 OpenAI 官转。

## 端点

- 文生图：POST /v1/images/generations，application/json。
- 参考图编辑：POST /v1/images/edits，multipart/form-data。
- 建议调用超时 300 秒。

## 参数

- model 固定为 gpt-image-2-vip。
- size 为 auto 或文档列出的 30 档之一，格式必须使用半角小写 x。
- 不得发送 quality、n 或 aspect_ratio。
- 单次固定返回 1 张。
- 默认响应为 b64_json；本项目不发送 response_format，并兼容历史 data URI、纯 Base64 和意外返回的 url。
- 编辑模式始终重复发送 image 字段，不使用 image[]；顺序对应提示词中的图 1、图 2。
- 不支持 mask。

30 档 size：

- 1K：1280x1280、848x1280、1280x848、960x1280、1280x960、1024x1280、1280x1024、720x1280、1280x720、1280x544。
- 2K：2048x2048、1360x2048、2048x1360、1536x2048、2048x1536、1632x2048、2048x1632、1152x2048、2048x1152、2048x864。
- 4K：2880x2880、2336x3520、3520x2336、2480x3312、3312x2480、2560x3216、3216x2560、2160x3840、3840x2160、3840x1632。

## 响应

- data[0] 只包含 url 或 b64_json 之一。
- b64_json 通常为不带前缀的纯 Base64；解析器兼容历史 data URI 形态。
- URL 视为临时地址，必须立即转存。
