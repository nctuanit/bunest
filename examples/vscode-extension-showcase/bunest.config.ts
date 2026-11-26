import { noRepositoryInControllerRule } from "@bunest/cli";
import { defineBunestConfig } from "@bunest/core";
import { iContainsOperator } from "./src/magic/orm-operators";

export default defineBunestConfig({
  orm: {
    queryOperators: [iContainsOperator],
  },
  diagnostics: {
    rules: [noRepositoryInControllerRule],
  },
});
