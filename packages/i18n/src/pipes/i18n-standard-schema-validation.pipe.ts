import {
  Injectable,
  Optional,
  StandardSchemaValidationPipe,
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Result,
  type StandardSchemaValidationPipeOptions,
} from "@bunest/common";
import type { TranslateIssuesOptions } from "../interfaces/validation-options.interface";
import {
  isTranslatedIssue,
  translateStandardSchemaIssues,
} from "../validation/standard-schema-messages";

/**
 * `StandardSchemaValidationPipe` with localized issues. Translation happens
 * in `validate()`, so both Bunest's default ADR-009 `ValidationErrorResponse`
 * and custom `exceptionFactory` receive translated issues. Translated messages
 * are not prefixed with `path: ` (put `{path}` in the message if you want it);
 * untranslated ones keep the default format.
 */
@Injectable()
export class I18nStandardSchemaValidationPipe<
  TInput = unknown,
  TOutput = TInput,
> extends StandardSchemaValidationPipe<TInput, TOutput> {
  private readonly i18nOptions: TranslateIssuesOptions;

  constructor(
    options?: StandardSchemaValidationPipeOptions & TranslateIssuesOptions,
  );
  constructor(
    schema: StandardSchemaV1<TInput, TOutput>,
    options?: StandardSchemaValidationPipeOptions & TranslateIssuesOptions,
  );
  constructor(
    @Optional()
    schemaOrOptions?:
      | StandardSchemaV1<TInput, TOutput>
      | (StandardSchemaValidationPipeOptions & TranslateIssuesOptions),
    @Optional()
    maybeOptions?: StandardSchemaValidationPipeOptions & TranslateIssuesOptions,
  ) {
    if (isStandardSchema<TInput, TOutput>(schemaOrOptions)) {
      const { namespace, issueKeys, ...rest } = maybeOptions ?? {};
      super(schemaOrOptions, rest);
      this.i18nOptions = { namespace, issueKeys };
    } else {
      const { namespace, issueKeys, ...rest } = schemaOrOptions ?? {};
      super(rest);
      this.i18nOptions = { namespace, issueKeys };
    }
  }

  protected override async validate<T = unknown>(
    value: unknown,
    schema: StandardSchemaV1,
    options?: Record<string, unknown>,
  ): Promise<StandardSchemaV1Result<T>> {
    const result = await super.validate<T>(value, schema, options);
    if (!result.issues) {
      return result;
    }
    return {
      issues: translateStandardSchemaIssues(result.issues, this.i18nOptions),
    };
  }

  protected override formatIssueMessages(
    issues: readonly StandardSchemaV1Issue[],
  ): string[] {
    return issues.map((issue) =>
      isTranslatedIssue(issue)
        ? issue.message
        : (super.formatIssueMessages([issue])[0] ?? issue.message),
    );
  }
}
