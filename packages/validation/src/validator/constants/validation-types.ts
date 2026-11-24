export class ValidationTypes {
  static readonly CUSTOM_VALIDATION = "customValidation";
  static readonly NESTED_VALIDATION = "nestedValidation";
  static readonly PROMISE_VALIDATION = "promiseValidation";
  static readonly CONDITIONAL_VALIDATION = "conditionalValidation";
  static readonly WHITELIST = "whitelistValidation";
  static readonly IS_DEFINED = "isDefined";

  static isValid(type: string): boolean {
    return (
      type === ValidationTypes.CUSTOM_VALIDATION ||
      type === ValidationTypes.NESTED_VALIDATION ||
      type === ValidationTypes.PROMISE_VALIDATION ||
      type === ValidationTypes.CONDITIONAL_VALIDATION ||
      type === ValidationTypes.WHITELIST ||
      type === ValidationTypes.IS_DEFINED
    );
  }
}
