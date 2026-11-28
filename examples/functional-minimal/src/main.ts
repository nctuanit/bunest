import { createMinimalApp } from "./app";

const app = await createMinimalApp();
const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Functional minimal app listening on http://localhost:${port}`);
console.log(`OpenAPI docs at http://localhost:${port}/docs`);
