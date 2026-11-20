import type {
  ApolloServerPlugin,
  BaseContext,
} from "../server/apollo-server.types";
import { GraphiQLHTMLFactory } from "./graphiql-html.factory";
import type { GraphiQLOptions } from "./graphiql-options.interface";

export class GraphiQLPlaygroundPlugin implements ApolloServerPlugin<BaseContext> {
  private readonly graphiqlHTMLFactory = new GraphiQLHTMLFactory();

  constructor(private readonly options: GraphiQLOptions = {}) {}

  async serverWillStart(): Promise<{
    renderLandingPage(): Promise<{ html: string }>;
  }> {
    const html = this.graphiqlHTMLFactory.create(this.options);
    return {
      async renderLandingPage() {
        return { html };
      },
    };
  }
}
