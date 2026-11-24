import { Injectable } from "@bunest/core";
import type { GraphQLSchema } from "./engine";
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
