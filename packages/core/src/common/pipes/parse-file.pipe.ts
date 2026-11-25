import { METADATA_KEYS } from "../constants/metadata-keys";
import { HttpStatus, Scope } from "../enums/scope.enum";
import { HttpException } from "../exceptions/http.exception";
import type {
  ArgumentMetadata,
  PipeTransform,
  UploadedFileInfo,
} from "../interfaces/http.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";
import {
  FileTypeValidator,
  MaxFileSizeValidator,
  type FileTypeValidatorOptions,
  type FileValidator,
  type MaxFileSizeValidatorOptions,
} from "./file-validators";
import {
  createStatusHttpException,
  getHttpReasonPhrase,
} from "./validation-http.util";

export interface ParseFileOptions {
  /**
   * File validators executed sequentially against each uploaded file.
   */
  validators?: readonly FileValidator<object>[];
  /**
   * HTTP status code used when throwing the default `HttpException` (defaults to `400 Bad Request`).
   */
  errorHttpStatusCode?: number;
  /**
   * Custom exception factory invoked with the validator's error message.
   */
  exceptionFactory?: (error: string) => unknown;
  /**
   * Whether at least one file must be present (defaults to `true`).
   */
  fileIsRequired?: boolean;
}

function createParseFileException(
  message: string,
  options?: ParseFileOptions,
): unknown {
  if (options?.exceptionFactory) {
    return options.exceptionFactory(message);
  }
  const status = options?.errorHttpStatusCode ?? HttpStatus.BAD_REQUEST;
  const label = getHttpReasonPhrase(status);
  return createStatusHttpException(
    HttpException.createBody(message, label, status),
    status,
  );
}

function isUploadedFileInfo(value: unknown): value is UploadedFileInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "fieldname" in value &&
    "originalname" in value &&
    "mimetype" in value
  );
}

/**
 * Validates single (`@UploadedFile()`) or multiple (`@UploadedFiles()`) uploaded files
 * against a list of `FileValidator` instances (e.g. `MaxFileSizeValidator`, `FileTypeValidator`).
 */
export class ParseFilePipe implements PipeTransform<
  | UploadedFileInfo
  | UploadedFileInfo[]
  | Record<string, UploadedFileInfo[]>
  | undefined,
  | UploadedFileInfo
  | UploadedFileInfo[]
  | Record<string, UploadedFileInfo[]>
  | undefined
> {
  private readonly validators: readonly FileValidator<object>[];
  private readonly fileIsRequired: boolean;
  protected exceptionFactory: (error: string) => unknown;

  constructor(private readonly options: ParseFileOptions = {}) {
    this.validators = options.validators ? [...options.validators] : [];
    this.fileIsRequired = options.fileIsRequired ?? true;
    this.exceptionFactory = (error: string) =>
      createParseFileException(error, this.options);
  }

  async transform<
    T extends
      | UploadedFileInfo
      | UploadedFileInfo[]
      | Record<string, UploadedFileInfo[]>
      | undefined,
  >(value: T, _metadata?: ArgumentMetadata): Promise<T> {
    if (value === undefined || value === null) {
      if (!this.fileIsRequired) {
        return value;
      }
      throw this.exceptionFactory("File is required");
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        if (!this.fileIsRequired) {
          return value;
        }
        throw this.exceptionFactory("File is required");
      }
      for (const file of value) {
        await this.validate(file);
      }
      return value;
    }

    if (isUploadedFileInfo(value)) {
      await this.validate(value);
      return value;
    }

    if (typeof value === "object") {
      const entries = Object.values(value as Record<string, unknown>);
      if (entries.length === 0) {
        if (!this.fileIsRequired) {
          return value;
        }
        throw this.exceptionFactory("File is required");
      }
      const isFieldMap = entries.every(
        (entry) => Array.isArray(entry) || isUploadedFileInfo(entry),
      );
      if (isFieldMap) {
        const files: UploadedFileInfo[] = [];
        for (const entry of entries) {
          if (Array.isArray(entry)) {
            for (const item of entry) {
              if (item && typeof item === "object") {
                files.push(item as UploadedFileInfo);
              }
            }
          } else if (isUploadedFileInfo(entry)) {
            files.push(entry);
          }
        }
        if (files.length === 0) {
          if (!this.fileIsRequired) {
            return value;
          }
          throw this.exceptionFactory("File is required");
        }
        for (const file of files) {
          await this.validate(file);
        }
        return value;
      }
      // Minimal single file object (e.g. `{ path: "some-path" }`)
      await this.validate(value);
      return value;
    }

    throw this.exceptionFactory(
      "Validation failed (uploaded file is expected)",
    );
  }

  getValidators(): readonly FileValidator<object>[] {
    return this.validators;
  }

  protected async validate(file: unknown): Promise<unknown> {
    const uploadedFile = file as UploadedFileInfo;
    for (const validator of this.validators) {
      const valid = await validator.isValid(uploadedFile);
      if (!valid) {
        throw this.exceptionFactory(validator.buildErrorMessage(uploadedFile));
      }
    }
    return file;
  }
}

MetadataRegistry.define(
  METADATA_KEYS.INJECTABLE,
  { scope: Scope.SINGLETON },
  ParseFilePipe,
);

/**
 * Fluent builder for constructing a configured `ParseFilePipe`
 * (NestJS `ParseFilePipeBuilder` parity).
 */
export class ParseFilePipeBuilder {
  private readonly validators: FileValidator<any, any>[] = [];

  addMaxSizeValidator(options: MaxFileSizeValidatorOptions): this {
    this.validators.push(new MaxFileSizeValidator(options));
    return this;
  }

  addFileTypeValidator(options: FileTypeValidatorOptions): this {
    this.validators.push(new FileTypeValidator(options));
    return this;
  }

  addValidator(validator: FileValidator<any, any>): this {
    this.validators.push(validator);
    return this;
  }

  build(options: Omit<ParseFileOptions, "validators"> = {}): ParseFilePipe {
    return new ParseFilePipe({
      ...options,
      validators: [...this.validators],
    });
  }
}
