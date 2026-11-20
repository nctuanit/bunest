import { Injectable } from "@bunest/common";
import type { GraphQLSchema } from "graphql";
import { GraphQLService } from "./driver/graphql-http.handler";

/**
 * Injectable host exposing the active compiled `GraphQLSchema` at runtime
 * (matching NestJS `@nestjs/graphql` `GraphQLSchemaHost`).
 */
@Injectable()
export class GraphQLSchemaHost {
  constructor(private readonly graphqlService: GraphQLService) {}

  get schema(): GraphQLSchema {
    return this.graphqlService.getSchema();
  }
}
