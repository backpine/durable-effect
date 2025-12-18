# Effect Worker

A library that bridges Effect-TS with Cloudflare Workers runtime. It provides effectful, type-safe, and composable patterns for building serverless applications.

## Implementation Status

This implementation is based on the design document at `docs/002-implementation-guide.md` with the following modifications:

- **Database/Drizzle excluded**: No D1 database, Drizzle ORM, or database-related code
- **Simplified naming**: Service implementations use `Live` suffix instead of platform-specific names
  - `KVStoreLive` (instead of `KVStoreCloudflare`)
  - `ObjectStorageLive` (instead of `ObjectStorageR2`)
  - Exception: `CloudflareBindings` keeps its name as it's specifically for Cloudflare env

## Project Structure

```
effect-worker/
├── src/
│   ├── worker.ts              # Main entry point (export default)
│   ├── app.ts                 # Application layer composition
│   ├── runtime.ts             # Runtime factory functions
│   ├── services/              # Service abstractions
│   │   ├── bindings.ts        # CloudflareBindings service
│   │   ├── config.ts          # Config service
│   │   ├── kv.ts              # KV Store service
│   │   ├── storage.ts         # Object Storage (R2) service
│   │   └── index.ts           # Re-exports all services
│   ├── handlers/              # Handler implementations
│   │   ├── fetch.ts           # HTTP request handler
│   │   └── errors.ts          # Error response formatting
│   └── errors/                # Error definitions
│       └── index.ts           # Typed error definitions
├── test/                      # Test files
│   └── fixtures/              # Test fixtures
│       └── mock-services.ts   # Mock service implementations
├── docs/                      # Design documentation
│   ├── 001-system-design.md   # System architecture document
│   └── 002-implementation-guide.md # Implementation guide
├── wrangler.toml              # Cloudflare configuration
├── package.json               # Dependencies
├── tsconfig.json              # TypeScript config
└── vitest.config.ts           # Test configuration
```

## Files Implemented

### Configuration Files
- ✅ `package.json` - Dependencies (without drizzle)
- ✅ `tsconfig.json` - TypeScript config for Workers + Effect
- ✅ `wrangler.toml` - Cloudflare config (without D1 database binding)
- ✅ `vitest.config.ts` - Test configuration

### Source Files
- ✅ `src/services/bindings.ts` - CloudflareBindings service (foundation layer)
- ✅ `src/services/config.ts` - Config service for env vars/secrets
- ✅ `src/services/kv.ts` - KV Store service abstraction
- ✅ `src/services/storage.ts` - Object Storage (R2) service abstraction
- ✅ `src/services/index.ts` - Re-exports all services
- ✅ `src/errors/index.ts` - Error type definitions (excluding DatabaseError)
- ✅ `src/app.ts` - Application layer composition (excluding Database)
- ✅ `src/runtime.ts` - Runtime factory functions
- ✅ `src/handlers/fetch.ts` - HTTP request handler
- ✅ `src/handlers/errors.ts` - Error response formatting
- ✅ `src/worker.ts` - Main entry point

### Test Files
- ✅ `test/fixtures/mock-services.ts` - Mock service implementations for testing

## Key Features

### Services Available

1. **CloudflareBindings** - Foundation layer that provides access to Cloudflare's env and ExecutionContext
2. **Config** - Type-safe configuration management with validation
3. **KVStore** - Key-value storage with JSON support and schema validation
4. **ObjectStorage** - R2 object storage with streaming and JSON support

### Error Types

All errors extend `Data.TaggedError` for type-safe error handling:
- `ConfigError` - Configuration issues
- `KVError` - KV operation failures
- `StorageError` - R2 operation failures
- `ValidationError` - Request validation failures
- `AuthorizationError` - Authorization failures
- `NotFoundError` - Resource not found

### Example API Endpoints

The implemented fetch handler includes example endpoints:

- `GET /health` - Health check
- `GET /api/kv/:key` - Get a KV value
- `POST /api/kv/:key` - Set a KV value
- `GET /api/storage/:key` - Get an R2 object
- `POST /api/storage/:key` - Upload to R2
- `GET /api/config` - Get environment info

## Next Steps

To use this implementation:

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Configure your Cloudflare bindings in `wrangler.toml`

3. Start local development:
   ```bash
   pnpm dev
   ```

4. Run tests:
   ```bash
   pnpm test
   ```

5. Deploy to Cloudflare:
   ```bash
   pnpm deploy
   ```

## Design Documents

See the `docs/` directory for detailed design documentation:
- `001-system-design.md` - System architecture overview
- `002-implementation-guide.md` - Comprehensive implementation guide

## Modifications from Design Doc

1. **No Database/Drizzle**: All database-related code has been excluded
2. **Simplified Naming**: Service implementations use cleaner names:
   - `KVStoreLive` instead of `KVStoreCloudflare`
   - `ObjectStorageLive` instead of `ObjectStorageR2`
3. **Clean Dependencies**: Removed drizzle-orm and drizzle-kit from package.json
4. **Updated Env Interface**: Removed DB binding from CloudflareBindings
5. **Updated Handlers**: Fetch handler demonstrates KV and R2 usage without database operations

## Notes

- The library follows Effect-TS patterns for composition, error handling, and dependency injection
- Runtime is cached per isolate for better performance
- All services are swappable through Effect's layer system
- Full type safety throughout with TypeScript strict mode
