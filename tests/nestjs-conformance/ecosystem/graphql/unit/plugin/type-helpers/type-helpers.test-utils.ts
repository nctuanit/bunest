import "reflect-metadata";
import { getMetadataStorage, type MetadataStorage } from "class-validator";

export function getValidationMetadataByTarget(target: Function) {
  const metadataStorage: MetadataStorage = getMetadataStorage();
  return metadataStorage.getTargetValidationMetadatas(
    target,
    "",
    false,
    false,
  );
}
