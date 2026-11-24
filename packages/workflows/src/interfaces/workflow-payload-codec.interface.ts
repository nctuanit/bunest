import type {
  PayloadCodec,
  PayloadContext,
} from "../core/interfaces/payload-codec.interface";

/**
 * Where a payload is stored, which the codec receives with it, the same to encode and to decode: a codec that
 * authenticates it (`AesGcmPayloadCodec` does) refuses a payload moved to another instance, entry or field.
 */
export interface WorkflowPayloadContext extends PayloadContext {
  /**
   * The field that holds it: of an instance (`input`, `output`, `error`, `customStatus`, `cancelReason`), of one of
   * its journal entries (`result`, `progress`, `error`, `data`), of a signal (`payload`), or of a schedule (`input`).
   */
  field:
    | "input"
    | "output"
    | "error"
    | "customStatus"
    | "cancelReason"
    | "result"
    | "progress"
    | "data"
    | "payload";
  /** The instance, for an instance's or a journal entry's payload. */
  instanceId?: string;
  /** The journal entry's name, for an entry's payload. */
  entry?: string;
  /** The signal's name, for a signal's payload. */
  signal?: string;
  /** The schedule's id, for a schedule's input. */
  schedule?: string;
}

/**
 * Encodes what workflows store for you before the store sees it, and decodes it on the way back: to encrypt it, or
 * compress it.
 */
export interface WorkflowPayloadCodec extends PayloadCodec<WorkflowPayloadContext> {}
