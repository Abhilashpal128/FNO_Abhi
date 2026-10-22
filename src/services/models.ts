import { z } from 'zod';
import type { Store } from '../db/store.js';
/** Optional serving contract. Never falls back to a technical-score probability. */
export class ValidatedModelService {
  constructor(
    private store: Store,
    private url: string,
  ) {}
  async predict(
    modelId: string,
    features: Record<string, number | null>,
    asOf: number,
  ): Promise<{ probability: number | null; reason: string; modelVersion: string | null }> {
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
