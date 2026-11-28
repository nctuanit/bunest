import { AspectPhase, defineAspectPipeline } from "@bunest/core";
import { ShowcaseAuditAspect } from "./showcase-audit.aspect";
import { ShowcaseObservabilityAspect } from "./showcase-observability.aspect";

/**
 * Composable AOP Pipeline using semantic `AspectPhase` ordering:
 * Even though `AUDIT` is listed before `OBSERVABILITY` below, Bunest automatically
 * executes `AspectPhase.OBSERVABILITY` (-500) outside `AspectPhase.AUDIT` (200)!
 */
export const AuditedOperation = defineAspectPipeline((label: string) => [
  {
    token: ShowcaseAuditAspect,
    options: { label },
    phase: AspectPhase.AUDIT,
  },
  {
    token: ShowcaseObservabilityAspect,
    options: { label },
    phase: AspectPhase.OBSERVABILITY,
  },
]);
