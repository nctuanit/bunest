import "reflect-metadata";
// Ensure class-transformer metadata cloning hook (@Type, @Expose, @Exclude, @Transform) is active
import "@bunest/validation";

export {
  CompositionType,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  applyIsOptionalDecorator,
  applyValidateIfDefinedDecorator,
  inheritPropertyInitializers,
  inheritTransformationMetadata,
  inheritValidationMetadata,
  registerMappedTypeMetadataHook,
  type MappedType,
  type MappedTypeMetadataHook,
  type MappedTypeOperation,
  type RemoveFieldsWithType,
} from "@bunest/common";
