import type { SchemaDialect } from "../../schema/dialect";
import { quoteSchema } from "../sql/quote-schema";

/** PostgreSQL, as the pieces every dialect shares see it. */
export const POSTGRES: SchemaDialect<"postgres"> = {
  dialect: "postgres",
  executors:
    "fromPg(pool), fromDrizzle(db), fromTypeOrm(dataSource), fromPrisma(prisma) or fromKysely(db)",
  executorNames: "fromPg, fromDrizzle, fromTypeOrm, fromPrisma or fromKysely",
  checkSchema: (schema, store) => {
    quoteSchema(schema, store);
  },
};
