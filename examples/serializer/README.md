# Serialization (`21-serializer`)

Bunest counterpart of NestJS's [`sample/21-serializer`](https://github.com/nestjs/nest/tree/master/sample/21-serializer), powered by zero-dependency `@bunest/validation`:

- **`ClassSerializerInterceptor`**: Automatically serializes returned class instances & arrays
- **`@Exclude()`**: Strips sensitive properties (`password`)
- **`@Expose()`**: Exposes computed getters (`fullName`) and role-gated fields (`groups: ["admin"]`)
- **`@Transform()`**: Flattens nested `RoleEntity` into its role name
- **`@SerializeOptions()`**: Configures per-route `excludePrefixes` (`_internalToken`) and serialization `groups`

## Run

```bash
bun run --cwd examples/serializer dev
bun run --cwd examples/serializer test
```
