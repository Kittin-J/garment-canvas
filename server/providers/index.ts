/**
 * Provider 工厂。id: "nanobanana" | "gpt-image-2" | "comfyui-local"(预留)
 */
import type { AIProvider } from "../../src/types/workflow";
import { nanobananaProvider } from "./nanobanana";
import { image2Provider } from "./image2";
import { NotImplementedError, ProviderError } from "./base";

/** comfyui-local 预留 stub：结构就位，调用抛 NotImplemented */
const comfyuiStub: AIProvider = {
  id: "comfyui-local",
  generate() {
    throw new NotImplementedError("comfyui-local provider (reserved for P1)");
  },
  edit() {
    throw new NotImplementedError("comfyui-local provider (reserved for P1)");
  },
};

const providers: Record<string, AIProvider> = {
  nanobanana: nanobananaProvider,
  "gpt-image-2": image2Provider,
  "comfyui-local": comfyuiStub,
};

export function getProvider(id: string): AIProvider {
  const p = providers[id];
  if (!p) {
    throw new ProviderError(`Unknown provider id: ${id}`, 400);
  }
  return p;
}

export function listProviderIds(): string[] {
  return Object.keys(providers);
}

export * from "./base";
