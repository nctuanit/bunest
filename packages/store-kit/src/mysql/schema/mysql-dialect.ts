import type { SchemaDialect } from "../../schema/dialect";
import { checkSchema } from "../sql/identifiers";

/** MySQL, as the pieces every dialect shares see it. */
export const MYSQL: SchemaDialect<"mysql"> = {
  dialect: "mysql",
  executors:
    "fromMysql2(pool), fromDrizzle(db), fromTypeOrm(dataSource), fromPrisma(prisma) or fromKysely(db)",
  executorNames:
    "fromMysql2, fromDrizzle, fromTypeOrm, fromPrisma or fromKysely",
  checkSchema: (schema, store) => {
    checkSchema(schema, store);
  },
};
