import "../../../../../../../packages/core/src";
import {
  getMetadataStorage,
  type MetadataStorage,
} from "../../../../../../../packages/validation/src/validator";

export function getValidationMetadataByTarget(target: Function) {
  const metadataStorage: MetadataStorage = getMetadataStorage();
  return metadataStorage.getTargetValidationMetadatas(target, "", false, false);
}
