import type { EntrypointDecorator } from "../interfaces/entrypoint-options.interface";
import { PRESET_METADATA } from "../resilience.constants";
import { withResilienceAspect } from "./resilience-decorator.util";

/**
 * Applies a preset from `ResilienceModule.forRoot({ presets })`, stage by
 * stage. Decorators on the handler or service method refine the preset's stages;
 * the preset's breaker, bulkhead and outbound rate limit are shared by everything using it.
 */
export const Resilience = (preset: string): EntrypointDecorator =>
  withResilienceAspect(PRESET_METADATA, preset);
