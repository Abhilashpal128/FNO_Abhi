import { z } from 'zod';
import type { Store } from '../db/store.js';
import type { Config } from '../config.js';
export function aiStatus(config: Pick<Config, 'AI_ENABLED' | 'QWEN_ENABLED' | 'FINBERT_ENABLED' | 'LIGHTGBM_ENABLED'>) {
  const enabled = config.AI_ENABLED;
  return {
    status: enabled ? 'ENABLED' : 'DISABLED',
    qwen: enabled && config.QWEN_ENABLED ? 'ENABLED' : 'DISABLED',
    finbert: enabled && config.FINBERT_ENABLED ? 'ENABLED' : 'DISABLED',
    lightgbm: enabled && config.LIGHTGBM_ENABLED ? 'ENABLED' : 'DISABLED',
    groq: 'DISABLED',
    huggingFaceApi: 'DISABLED',
    openRouter: 'DISABLED',
  } as const;
}
/** Optional serving contract. Never falls back to a technical-score probability. */
export class ValidatedModelService {
  constructor(
    private store: Store,
    private url: string,
    private flags: Pick<Config, 'AI_ENABLED' | 'LIGHTGBM_ENABLED'> = { AI_ENABLED: false, LIGHTGBM_ENABLED: false },
  ) {}
  async predict(
    modelId: string,
    features: Record<string, number | null>,
    asOf: number,
  ): Promise<{ probability: number | null; reason: string; modelVersion: string | null }> {
    if (!this.flags.AI_ENABLED || !this.flags.LIGHTGBM_ENABLED)
      return { probability: null, reason: 'AI_DISABLED', modelVersion: null };
    const model = await this.store.get('model_versions', modelId);
    if (
      !this.url ||
      !model ||
      !model.validated ||
      model.createdAt > asOf ||
      model.details.calibrationValidated !== true ||
      model.details.walkForwardValidated !== true
    )
      return { probability: null, reason: 'VALIDATED_MODEL_UNAVAILABLE', modelVersion: null };
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelVersion: model.version, asOf, features }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error();
      const result = z
        .object({ modelVersion: z.string(), probability: z.number().min(0).max(1) })
        .parse(await response.json());
      if (result.modelVersion !== model.version) throw new Error();
      return {
        probability: result.probability,
        reason: 'VALIDATED_CALIBRATED_MODEL',
        modelVersion: result.modelVersion,
      };
    } catch {
      return { probability: null, reason: 'MODEL_SERVICE_UNAVAILABLE', modelVersion: model.version };
    }
  }
}
