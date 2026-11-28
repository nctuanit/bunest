# MVC & Server-Side Rendering (`15-mvc` / `17-mvc-handlebars`)

Bunest counterpart of NestJS's [`sample/15-mvc`](https://github.com/nestjs/nest/tree/master/sample/15-mvc) and [`sample/17-mvc-handlebars`](https://github.com/nestjs/nest/tree/master/sample/17-mvc-handlebars):

- **`@Render("index")`**: Controller returns plain view models rendered into HTML via `app.setBaseViewsDir()` and `app.setViewEngine()`
- **Zero-dependency Bun template engine**: Supports `{{key}}` (auto-escaped via `Bun.escapeHTML`) and `{{#each items}}...{{/each}}` blocks
- **Static assets**: CSS served from `public/` via `app.useStaticAssets()`
- **Form POST + `@Redirect`**: Post/Redirect/Get guestbook form

## Run

```bash
bun run --cwd examples/mvc dev
bun run --cwd examples/mvc test
```
