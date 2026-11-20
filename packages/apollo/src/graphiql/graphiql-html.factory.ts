import type { GraphiQLOptions } from "./graphiql-options.interface";

function escapeJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\u003c");
}

export class GraphiQLHTMLFactory {
  create(options: GraphiQLOptions): string {
    const shouldPersistHeaders = options.shouldPersistHeaders ?? true;
    const isHeadersEditorEnabled = options.isHeadersEditorEnabled ?? true;
    const inputValueDeprecation = options.inputValueDeprecation ?? false;
    const headers = options.headers ?? {};
    const url = escapeJsString(options.url ?? "/graphql");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>GraphiQL</title>
    <style>
      body {
        height: 100%;
        margin: 0;
        width: 100%;
        overflow: hidden;
      }

      #graphiql {
        height: 100vh;
      }
    </style>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <link rel="stylesheet" href="https://unpkg.com/graphiql@3.8.3/graphiql.min.css" />
  </head>

  <body>
    <div id="graphiql">Loading...</div>
    <script
      src="https://unpkg.com/graphiql@3.8.3/graphiql.min.js"
      type="application/javascript"
    ></script>
    <script>
      const fetcher = GraphiQL.createFetcher({
        url: '${url}',
        subscriptionUrl: '${url}',
        headers: ${JSON.stringify(headers).replace(/</g, "\\u003c")},
      });
      ReactDOM.render(
        React.createElement(GraphiQL, {
          fetcher,
          defaultEditorToolsVisibility: true,
          shouldPersistHeaders: ${shouldPersistHeaders ? "true" : "false"},
          isHeadersEditorEnabled: ${isHeadersEditorEnabled ? "true" : "false"},
          inputValueDeprecation: ${inputValueDeprecation ? "true" : "false"},
        }),
        document.getElementById('graphiql'),
      );
    </script>
  </body>
</html>
`;
  }
}
