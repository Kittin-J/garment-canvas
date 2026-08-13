import type { NodeTypes } from "@xyflow/react";
import { ImageInputNode } from "./ImageInputNode";
import { SketchToRenderNode } from "./SketchToRenderNode";
import { AiModifyNode } from "./AiModifyNode";
import { FabricRecolorNode } from "./FabricRecolorNode";
import { UpscaleNode } from "./UpscaleNode";
import { PrintExtractNode } from "./PrintExtractNode";
import { PrintMutateNode } from "./PrintMutateNode";
import { ResultNode } from "./ResultNode";

export const nodeTypes: NodeTypes = {
  "image-input": ImageInputNode,
  "sketch-to-render": SketchToRenderNode,
  "ai-modify": AiModifyNode,
  "fabric-recolor": FabricRecolorNode,
  upscale: UpscaleNode,
  "print-extract": PrintExtractNode,
  "print-mutate": PrintMutateNode,
  result: ResultNode,
};

export { ImageInputNode } from "./ImageInputNode";
export { SketchToRenderNode } from "./SketchToRenderNode";
export { AiModifyNode } from "./AiModifyNode";
export { FabricRecolorNode } from "./FabricRecolorNode";
export { UpscaleNode } from "./UpscaleNode";
export { PrintExtractNode } from "./PrintExtractNode";
export { ResultNode } from "./ResultNode";
