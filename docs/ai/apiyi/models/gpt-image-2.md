# gpt-image-2

产品范围：仅蒙版局部重绘节点，不得出现在普通图片生成节点的模型列表中。

## 请求

- Base URL：https://api.apiyi.com
- 端点：POST /v1/images/edits
- Content-Type：multipart/form-data
- 必填：model、prompt、第一张 image[]、mask
- model 固定为 gpt-image-2
- image[] 可为 PNG、JPEG 或 WebP；即使只有一张也使用 image[] 字段。单张小于 50MB，项目仍执行自身更严格的上传和引用图限制。
- mask 必须为带 Alpha 通道的 PNG、小于 4MB，并与第一张 image 的像素尺寸完全一致。
- Alpha 0 表示允许编辑；Alpha 255 表示尽量保留；半透明仅是软过渡。
- mask 只作用于第一张 image。
- 单次固定返回 1 张；请求不发送 n。
- 不得发送 input_fidelity。
- 不得发送 response_format。
- background 不得为 transparent。

可发送 size、quality、output_format 和 output_compression，但必须使用文档枚举。quality 仅允许 auto、low、medium、high；output_format 仅允许 png、jpeg、webp。

## 响应

- 图片位于 data[0].b64_json，为不带 data URI 前缀的纯 Base64。
- 解析器可兼容意外带前缀的历史形态，但请求侧不得依赖该形态。
- 建议调用超时 360 秒。

## 本地校验

- 原图与蒙版尺寸差 1 像素也必须在调用前拒绝。
- 蒙版没有 Alpha 通道、完全不透明或完全透明时给出明确提示；前两项分别意味着无有效编辑区或整图重绘风险。
- 蒙版节点至少提供画笔、橡皮擦、撤销、重做、清空和反选，并把画布坐标精确映射到原图像素。
- 为严格保留蒙版外像素，可在模型输出后使用原图与蒙版做像素合成；不得向用户承诺模型自身会保持边界外逐像素不变。
