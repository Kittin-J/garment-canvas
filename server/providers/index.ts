/** Provider 工厂。模型清单与 docs/ai/apiyi/model-contracts.json 保持一致。 */
import type { AIProvider } from "../../src/types/workflow";
import { apiyiProviders } from "./apiyi";
import { ProviderError } from "./base";

const providers: Record<string, AIProvider> = { ...apiyiProviders };

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
