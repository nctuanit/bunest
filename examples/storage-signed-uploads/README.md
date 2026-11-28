# Production Storage & Signed URLs (`storage-signed-uploads`)

Production file storage recipe powered by zero-dependency `@bunest/storage`:

- **Multi-Disk Storage (`StorageModule.forRoot`)**: Configurable `InMemoryDisk` / `LocalDisk` / native WebCrypto SigV4 `S3Disk` (for AWS S3, Cloudflare R2, MinIO)
- **Pre-Signed Direct Uploads (`POST /storage/presign-upload` → `PUT /storage/signed-upload`)**: Issues HMAC-signed upload URLs with enforced `contentType` & `contentLength` via `disk.signedUpload()` and `receiveSignedUpload()`
- **Pre-Signed Downloads (`POST /storage/presign-download` → `GET /storage/signed-download`)**: Serves files via `serveSignedUrl()` with `X-Content-Type-Options: nosniff`, HTTP Range `206`, and ETag `304`
- **Image Inspection (`inspectImage`)**: Reads PNG/JPEG/GIF/WebP dimensions natively with zero native binaries

## Run

```bash
bun run --cwd examples/storage-signed-uploads dev
bun run --cwd examples/storage-signed-uploads test
```
