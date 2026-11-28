# File Upload & Storage (`29-file-upload`)

Bunest counterpart of NestJS's [`sample/29-file-upload`](https://github.com/nestjs/nest/tree/master/sample/29-file-upload), combining native multipart parsing with `@bunest/storage`:

- **Single file upload (`POST /files/upload`)**: `FileInterceptor("file")`, `@UploadedFile()`, and `ParseFilePipeBuilder` (max size + PNG magic-byte verification!) alongside multipart form fields
- **Multi-file upload (`POST /files/uploads`)**: `FilesInterceptor("files", 5)` and `@UploadedFiles()`
- **Storage & Streaming (`GET /files`, `GET /files/:key`)**: Persists uploaded bytes into `@bunest/storage` (`StorageModule.forRoot`) and streams downloads via `serveFile()` with ETag & Range support

## Run

```bash
bun run --cwd examples/file-upload dev
bun run --cwd examples/file-upload test
```
