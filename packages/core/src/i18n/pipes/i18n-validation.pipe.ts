import {
  Injectable,
  Optional,
  ValidationPipe,
  type ValidationError,
  type ValidationPipeOptions,
  type ValidatorOptions,
} from "../../common/index";
import {
  isTranslatedConstraint,
  propagateTranslatedConstraints,
  translateValidationErrors,
  withoutTargets,
  withoutValues,
} from "../validation/validation-messages";

/**
 * `ValidationPipe` that localizes messages before the (default or custom)
 * `exceptionFactory` runs, so `errorFormat` (`"bunest"`, `"list"`, `"grouped"`),
 * `exceptionFactory` etc. keep working unchanged. Translated messages of nested
 * objects aren't prefixed with the parent path (put `{path}` in the message if
 * you want it); untranslated ones keep Nest's `parent.message` format.
 */
@Injectable()
export class I18nValidationPipe extends ValidationPipe {
  private readonly namespace?: string;

  constructor(
    @Optional()
    options?: ValidationPipeOptions & {
      /** Namespace for default constraint messages. Default `'validation'`. */
      namespace?: string;
    },
  ) {
    const { namespace, ...rest } = options ?? {};
    super(rest);
    this.namespace = namespace;
  }

  protected override async validate(
    object: object,
    validatorOptions?: ValidatorOptions,
  ): Promise<ValidationError[]> {
    // The decorators are found through `error.target` and `{value}` / duplicate
    // decorator disambiguation use `error.value`, so validate with both enabled
    // and strip them afterwards when disabled (matching Bunest ADR-009 defaults).
    const keepTarget = validatorOptions?.validationError?.target !== false;
    const keepValue = validatorOptions?.validationError?.value !== false;

    const errors = await super.validate(object, {
      ...validatorOptions,
      validationError: {
        ...validatorOptions?.validationError,
        target: true,
        value: true,
      },
    });

    translateValidationErrors(errors, {
      namespace: this.namespace,
      groups: validatorOptions?.groups,
      always: validatorOptions?.always,
      strictGroups: validatorOptions?.strictGroups,
      dismissDefaultMessages: validatorOptions?.dismissDefaultMessages,
    });

    if (!keepTarget) {
      withoutTargets(errors);
    }
    if (!keepValue) {
      withoutValues(errors);
    }
    return errors;
  }

  protected override limitValidationErrors(
    validationErrors: ValidationError[],
    budget: { remaining: number; isExceeded: boolean },
    parentPathLength = 0,
  ): ValidationError[] {
    const limited = super.limitValidationErrors(
      validationErrors,
      budget,
      parentPathLength,
    );
    propagateTranslatedConstraints(validationErrors, limited);
    return limited;
  }

  protected override prependConstraintsWithParentProp(
    parentPath: string,
    error: ValidationError,
  ): ValidationError {
    const constraints: Record<string, string> = {};
    for (const [name, message] of Object.entries(error.constraints ?? {})) {
      constraints[name] = isTranslatedConstraint(error, name)
        ? message
        : `${parentPath}.${message}`;
    }
    return { ...error, constraints };
  }
}
