import { noRepositoryInControllerRule } from "@bunest/cli";
import { defineBunestConfig } from "@bunest/core";
import { Auditable } from "./src/magic/custom-macros";
import { iContainsOperator } from "./src/magic/orm-operators";

export default defineBunestConfig({
  macros: {
    defaults: {
      builder: {
        toBuilder: true,
      },
    },
    presets: {
      DomainEntity: ["Data", "Builder", "FieldNameConstants"],
    },
    plugins: [Auditable.macroDefinition],
  },
  orm: {
    queryOperators: [iContainsOperator],
  },
  diagnostics: {
    rules: [noRepositoryInControllerRule],
  },
});
