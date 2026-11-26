import { registerBunestPlugin } from "../packages/cli/src/plugins/bunest.plugin";
import { registerOrmCircularSafePlugin } from "../packages/orm/src/plugin/circular-safe.plugin";

registerBunestPlugin({
  filter: /(?:^|[/\\])examples[/\\].*\.tsx?$/,
  classMacros: false,
});
registerOrmCircularSafePlugin();
