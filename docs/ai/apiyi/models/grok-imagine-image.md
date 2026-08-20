# grok-imagine-image（Grok Imagine 2）

产品范围：普通图片生成节点，支持文生图和 1 到 4 张参考图编辑。产品代号为 Grok Imagine 2，调用模型 ID 仍固定为 grok-imagine-image。

## 文生图

- 端点：POST /v1/images/generations，application/json。
- model 固定为 grok-imagine-image。
- aspect_ratio 仅允许 1:1、16:9、9:16、4:3、3:4。
- resolution 仅允许小写 1k 或 2k。
- n 支持 1 到 10，但项目执行器必须按真实 data 数组处理，不能只读取第一项。
- response_format 仅允许 url 或 b64_json。
- 禁止发送 image、image_url 或 images；上游会静默忽略这些字段、正常计费并返回无关新图。

## 参考图编辑

- 端点：POST /v1/images/edits，multipart/form-data。
- 单图使用 image；多图使用重复的 image[]，共 1 到 4 张，顺序对应提示词中的图 1 到图 4。
- 第一张参考图决定输出尺寸。
- resolution 和 aspect_ratio 在编辑端点无效，禁止发送。
- 不支持 mask、seed、size、quality 或 style。

## 防静默降级

该模型对多个非法参数会静默回退。所有枚举必须在本地拒绝：非法 aspect_ratio、resolution、response_format，以及 n 小于 1 或大于 10。resolution=4k 返回 503，但属于确定性参数错误，不得重试。

## 响应

- data[] 每项只包含 url 或 b64_json 之一。
- b64_json 为不带前缀的纯 Base64。
- usage.prompt_tokens 是占位值，不能用于成本核算。
- 建议调用超时 360 秒。
