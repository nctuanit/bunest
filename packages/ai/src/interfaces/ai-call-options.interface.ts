import type { AiSchema } from "./ai-schema.interface";
import type { AiCaller, AiToolSelection } from "./ai-tool.interface";
import type { AiUsageEvent } from "./ai-usage.interface";
import type { AiBudget, AiCallSettings } from "./ai-module-options.interface";
import type { LanguageModel, ModelMessage } from "./ai-types.interface";

export type AiToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      toolName: string;
    };

/** A model: its name in `forRoot({ models })`, or a `LanguageModel`. */
export type AiModelReference = string | Exclude<LanguageModel, string>;

/** The options of `generateText()` and `streamText()`. */
export interface AiCallOptions extends AiCallSettings {
  /** Default `'default'`. */
  model?: AiModelReference;
  /** The system prompt. */
  instructions?: string;
  /** The user's message; or `messages`, a whole conversation. */
  prompt?: string;
  messages?: ModelMessage[];
  /** The agent functions the model may call, by name or by provider class. */
  tools?: AiToolSelection;
  /** Who the call acts for. */
  caller?: AiCaller;
  toolChoice?: AiToolChoice;
  /** Model calls this call may make. Default 10. */
  maxSteps?: number;
  /** Models tried when the model fails. */
  fallback?: AiModelReference | ReadonlyArray<AiModelReference> | false;
  /** Which failures move on to the next model. */
  fallbackIf?: (error: unknown) => boolean;
  budget?: AiBudget;
  /** Cancels the call. */
  abortSignal?: AbortSignal;
  /** Names the call in usage events. */
  label?: string;
  /** Called after every model call of this call that answered. */
  onUsage?: (event: AiUsageEvent) => void | Promise<void>;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
}

/** The options of `generateObject()`. */
export interface AiObjectCallOptions<
  S extends AiSchema = AiSchema,
> extends AiCallOptions {
  /** What the answer must be. */
  schema: S;
  /** A name and a description of the object. */
  schemaName?: string;
  schemaDescription?: string;
}
