import type {
  ApolloServerPlugin,
  BaseContext,
  GraphQLServerListener,
} from "./apollo-server.types";

/**
 * Disables the landing page HTML when `GET <path>` is requested with `Accept: text/html`.
 */
export function ApolloServerPluginLandingPageDisabled(): ApolloServerPlugin<BaseContext> {
  return {
    async serverWillStart(): Promise<GraphQLServerListener> {
      return {
        renderLandingPage: undefined,
      };
    },
  };
}

export interface ApolloLandingPageLocalDefaultOptions {
  embed?: boolean;
  includeCookies?: boolean;
  footer?: boolean;
  document?: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  title?: string;
}

/**
 * Renders an Apollo Sandbox / GraphQL Explorer local default landing page HTML.
 */
export function ApolloServerPluginLandingPageLocalDefault(
  options: ApolloLandingPageLocalDefaultOptions = {},
): ApolloServerPlugin<BaseContext> {
  const title = options.title ?? "Apollo Sandbox";
  return {
    async serverWillStart(): Promise<GraphQLServerListener> {
      const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>body { margin: 0; height: 100vh; overflow: hidden; }</style>
  </head>
  <body>
    <div id="embeddableSandbox" style="width:100vw;height:100vh;"></div>
    <script src="https://embeddable-sandbox.cdn.apollographql.com/_latest/embeddable-sandbox.umd.production.min.js"></script>
    <script>
      new window.EmbeddedSandbox({
        target: '#embeddableSandbox',
        initialEndpoint: window.location.href,
        includeCookies: ${options.includeCookies ? "true" : "false"},
      });
    </script>
  </body>
</html>`;
      return {
        async renderLandingPage() {
          return { html };
        },
      };
    },
  };
}

/**
 * Drains an HTTP server cleanly during `ApolloServer.stop()`.
 */
export function ApolloServerPluginDrainHttpServer(options: {
  httpServer?: { close?: (cb?: () => void) => unknown; stop?: () => unknown };
}): ApolloServerPlugin<BaseContext> {
  return {
    async serverWillStart(): Promise<GraphQLServerListener> {
      return {
        async drainServer() {
          const srv = options.httpServer;
          if (!srv) return;
          if (typeof srv.stop === "function") {
            await Promise.resolve(srv.stop());
          }
        },
      };
    },
  };
}
