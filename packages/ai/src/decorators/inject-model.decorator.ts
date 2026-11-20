import { Inject } from '@bunest/common';
import { DEFAULT_MODEL_NAME, getModelToken } from '../ai.constants';
import { recordModelRequest } from '../models/model-requests';

/**
 * Injects the configured `LanguageModel` called `name` (default `'default'`).
 */
export function InjectModel(
  name: string = DEFAULT_MODEL_NAME,
): PropertyDecorator & ParameterDecorator {
  recordModelRequest(name);
  return Inject(getModelToken(name));
}
