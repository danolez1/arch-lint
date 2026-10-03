# Architecture Conventions

A set of engineering conventions for TypeScript web applications: how to layer code, where things live, how errors, configuration and logging work, and how to keep all of it from drifting. The conventions do not depend on a framework. Tool names such as Zod, Drizzle, Redis, BullMQ and Tailwind appear as examples of a pattern, and you can swap them for whatever your stack uses.

Many of these conventions can be checked by reading source text, and arch-lint has a rule for each of those. [Section 18](#18-architecture-enforcement) maps each convention to the rule ids that enforce it, and lists the conventions that have no rule and rely on review. Rule ids in backticks throughout the guide refer to that table. [RULES.md](RULES.md) has the full list and [RULE-OPTIONS.md](RULE-OPTIONS.md) the options.

---

## 1. Layered Architecture

Dependencies flow in one direction and no layer is skipped. There are two chains, one for code that runs in the browser (or an app) and one for code that runs on the server.

| Layer              | Responsibility                       | May depend on                 | Must not                                            |
| ------------------ | ------------------------------------ | ----------------------------- | --------------------------------------------------- |
| **UI**             | Rendering, interaction               | Stores, components            | Business logic, HTTP calls, service imports         |
| **Store**          | Client state                         | Client services               | Direct database access                              |
| **Client service** | Thin wrappers over API calls         | The HTTP client               | Raw `fetch`, database access                        |
| **Route (BFF)**    | Validation, auth, response shaping   | Services, models, lib helpers | Database queries, business logic                    |
| **Server service** | Business logic, orchestration        | Models, external clients      | Request and response objects                        |
| **Model**          | Database queries, domain data access | ORM, database driver          | Request and response objects, caches, higher layers |
| **Data**           | Persistence                          | Nothing                       |                                                     |

Read the client chain as: a component calls a store action, the store calls a service function, the service calls the shared HTTP client, and the request reaches a route. The server chain continues: the route validates input and calls services or models, and only models touch the database.

Rules that back this up: `no-service-in-tsx` and `no-raw-fetch-in-components` keep components view-only, `no-db-in-routes` and `no-db-outside-models` keep queries in the models layer, `models-stay-below-services` stops a model importing from a higher layer, and `no-cache-in-models` keeps caching out of models so they always return fresh data.

### Backend for Frontend: the single gateway

Browsers never call backend microservices directly. The BFF is the one gateway between them.

The BFF validates input, authenticates the session, fans out to backend services and reshapes the response for the UI. It does not hold business logic, run database queries or read blob storage. A request goes from the browser to a BFF route, from there to one or more backend services, and the response comes back along the same path.

Mobile clients can call backend services directly through an SDK. The SDK is the abstraction layer, so no BFF is needed for them.

### Service layer pattern

Give each service small, reusable functions and let routes compose them. A route stays thin: validate, call services, set a status, return.

```typescript
// services/user.service.ts
export function resolveUserBySub(sub: string): ServiceResult<User> { ... }
export function verifyOwnership(resourceId: string, userId: string): ServiceResult<Resource> { ... }

// routes/users.ts: validate, call service(s), set status, return
```

A route that only reads one record can call a model directly. As soon as it combines two steps or applies a business rule, move that into a service.

### Mobile clients

The same layering applies to a Dart or other native codebase. Data, domain, sync and auth code does not import a UI toolkit (`no-ui-toolkit`) and does not import from the screens directory (`no-feature-import`). Screens reach the local store through a repository, not by importing the store or calling it directly (`no-store-in-features`). The server origin lives in one environment helper so a release build can show which server it talks to (`no-hardcoded-origin`).

---

## 2. Project Structure

### Monorepo layout

```
project/
├── apps/                    # Client-facing applications
│   ├── web/                 # Primary web app
│   └── admin/               # Admin portal
├── services/                # Backend services
│   └── {service-name}/
├── packages/                # Shared libraries
│   ├── types/               # Shared TypeScript interfaces and utils
│   ├── ui/                  # Component library
│   ├── db/                  # ORM schema, migrations, client
│   ├── env/                 # Validated env config
│   ├── http-client/         # Shared HTTP client
│   └── service-core/        # Shared middleware (auth, error handler, tracing, logger)
├── plugins/                 # Extension modules (importers, adapters)
├── tools/                   # CLI tools, linters, scripts
├── docs/                    # Architecture docs, plans, audit reports
│   ├── adr/                 # Architecture Decision Records
│   ├── plans/               # Design and implementation docs
│   └── COMPLIANCE_REGISTER.md
├── package.json             # Root workspaces
└── turbo.json               # Build pipeline (any task runner works)
```

### Per-service structure

```
services/{service-name}/
├── src/
│   ├── index.ts             # App entry, mounts routes
│   ├── routes/              # One file per resource group
│   ├── models/              # Database access layer (ORM queries)
│   ├── services/            # Business logic (calls models and external APIs)
│   ├── workers/             # Background job definitions
│   ├── middleware/          # Auth, logging, rate limiting
│   └── lib/
│       ├── env.ts           # Validated env vars
│       ├── logger.ts        # Structured logger instance
│       ├── queue.ts         # Job queue definition
│       ├── paths.ts         # Internal route constants
│       └── external-apis.ts # External URL constants
├── prompts/                 # AI prompt templates, if the service uses any
├── tests/
│   ├── unit/                # Pure functions, no database, no network
│   ├── function/            # Model and service tests with a mocked database
│   ├── integration/         # Real database and external services
│   └── setup/
│       ├── test-db.ts       # Database init, cleanup, teardown
│       └── preload.ts       # Test preload, swaps in the test database
└── package.json
```

### Per-plugin structure

```
plugins/{plugin-name}/
├── src/
│   ├── index.ts             # Plugin manifest and registration
│   ├── parser.ts            # Format-specific parsing
│   └── mapper.ts            # Parsed data to the internal schema
├── prompts/                 # AI prompts, if the plugin uses AI cleanup
├── tests/
│   ├── unit/
│   └── integration/
└── package.json
```

### Naming

| Thing                      | Convention              | Example             |
| -------------------------- | ----------------------- | ------------------- |
| Files and directories      | `kebab-case`            | `user-profile.ts`   |
| Classes, interfaces, types | `PascalCase`            | `UserProfile`       |
| Functions and variables    | `camelCase`             | `getUserProfile`    |
| Constants                  | `UPPER_SNAKE_CASE`      | `MAX_RETRY_COUNT`   |
| Database tables            | `snake_case` plural     | `user_profiles`     |
| Environment variables      | `UPPER_SNAKE_CASE`      | `DATABASE_URL`      |
| Test files                 | `{name}.{type}.test.ts` | `auth.unit.test.ts` |
| Prompt placeholders        | `{{UPPER_SNAKE_CASE}}`  | `{{USER_NAME}}`     |

Test type suffixes are `unit`, `fn`, `integration`, `load`, `contract`, `e2e` and `performance`. `kebab-case-filenames` flags an uppercase letter in a file name and `test-file-naming` checks the suffix. Of the other naming rows, only file names and test suffixes have rules.

---

## 3. Error Handling

### A custom error hierarchy

Do not `throw new Error(...)`. Define a base error class and typed subclasses, so every failure carries a code and an HTTP status. `no-raw-throw` flags a bare `new Error(...)` in backend code.

```typescript
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly statusCode: number;
}

export class NotFoundError extends AppError { ... }
export class ValidationError extends AppError { ... }
export class AuthError extends AppError { ... }
export class ExternalServiceError extends AppError { ... }
```

### Error codes

Use a const object. It tree-shakes and carries no runtime enum overhead. Every error has a code.

```typescript
export const ErrorCode = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  DB_ERROR: "DB_ERROR",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  SCOPE_DENIED: "SCOPE_DENIED",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
```

### Safe error access

A caught value is `unknown`. Never write `(e as Error).message` (`no-unsafe-error-cast`). Use a helper:

```typescript
export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
```

### Never swallow an error

An empty `catch` block, or an empty `.catch(() => {})`, hides failures (`no-empty-catch`). Handle the error, rethrow it, or write a one-line comment saying why ignoring it is correct.

### Result type

Model and service functions return a discriminated result and do not throw across layer boundaries. Catch at the boundary where you can do something useful, log with the structured logger, and return a failure result.

```typescript
type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: ErrorCode };

function ok<T>(data: T): ServiceResult<T>;
function err(message: string, code: ErrorCode): ServiceResult<never>;
```

`err-requires-error-code` flags a result-style `err()` call that does not name an error code.

---

## 4. A Single HTTP Gateway

All outgoing HTTP goes through one shared HTTP client. No raw `fetch()`, `axios` or `XMLHttpRequest` in application code. `no-raw-fetch`, `no-raw-fetch-in-components` and `no-axios` flag the violations.

### Client types

| Client                | Use                              | Auth                                    |
| --------------------- | -------------------------------- | --------------------------------------- |
| Service client        | Route to backend service         | Bearer token forwarding                 |
| External client       | Service to a third-party API     | Per provider (bearer, API key, OAuth2)  |
| Browser client        | Browser to the BFF               | Cookie-based                            |
| Object storage client | Service to S3-compatible storage | Request signing (for example AWS SigV4) |
| Webhook client        | Worker to a customer webhook     | HMAC signature                          |

### Auth strategies

| Strategy              | Config                          | Use                         |
| --------------------- | ------------------------------- | --------------------------- |
| `bearer(token)`       | Token string or getter function | Service-to-service, OAuth   |
| `signed(credentials)` | Access key, secret, region      | S3-compatible storage       |
| `apiKey(header, key)` | Header name and key value       | CDN, third-party APIs       |
| `hmac(secret, algo)`  | Shared secret and hash          | Webhook delivery signing    |
| `oauth2(config)`      | Client credentials flow         | Identity provider tokens    |
| `custom(fn)`          | `(req) => headers`              | Providers with many headers |
| `none()`              | No auth                         | Public endpoints            |

### Built-in behaviour

The values below are sensible defaults. Make them configurable per request.

- **Retry:** 3 attempts with exponential backoff (1s base) and jitter. Retry on 5xx, 429 and connection errors (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`).
- **Timeouts:** 10s between internal services, 30s for external APIs, 5s for health probes.
- **Error mapping:** an HTTP status becomes a typed error. 404 maps to `NotFoundError`, 400 to `ValidationError`, 401 and 403 to `AuthError`, 5xx to `ExternalServiceError`.
- **Tracing:** propagate an `X-Request-ID` header across every boundary.
- **Logging:** log every request and response with method, URL, status and duration.
- **Typing:** `client.get<T>(path)` returns `ServiceResult<T>`.
- **Uploads:** send files with `client.post(path, formData)`.
- **Circuit breaker:** optional per client. It opens after N consecutive failures and half-opens after a cooldown.

### Forbidden and required

| Forbidden                             | Required                              |
| ------------------------------------- | ------------------------------------- |
| `fetch(url, opts)`                    | `client.get(path, opts)`              |
| `axios.get(url)`                      | `client.get<T>(path)`                 |
| A hand-written `Authorization` header | An auth strategy in the client config |
| Inline retry loops                    | The client's built-in retry           |
| `AbortSignal.timeout()`               | The client's `timeout` option         |

The client implementation itself is the one place that may call `fetch`. Exempt it in the rule configuration.

---

## 5. Environment and Configuration

### No raw `process.env`

Read environment variables through a validated config module with a schema for every required variable. A validation failure is fatal: crash at startup, not at runtime. `no-raw-process-env` flags direct reads, and `environment-adapter-required` extends the same idea to other runtimes (Bun and `import.meta` environment access).

```typescript
// env.ts
export const env = createEnv({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SESSION_SECRET: z.string().min(32),
});
```

### No magic strings

- **URLs:** import route strings from a `paths.ts` constants file (`no-magic-path`).
- **Display text:** import from an `intl/` module (`no-hardcoded-attr-text` covers `aria-label`, `placeholder`, `title` and `alt`).
- **External API URLs:** import from `external-apis.ts`.
- **Server origins in native apps:** keep them in one environment helper (`no-hardcoded-origin`).
- **String comparisons:** compare against an enum or const object, never an inline string (`enum-literal-bypass`).
- **Error messages:** centralise them in an `error-messages.ts` constants file.

```typescript
// Correct
if (role === UserRole.Admin) { ... }

// Forbidden
if (role === "admin") { ... }
```

### No magic numbers

Give every numeric constant a name. No rule checks this one.

```typescript
// Correct
const RETAIN_24H_SECONDS = 86_400;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// Forbidden
removeOnComplete: {
  age: 86400;
}
```

### Centralised enums

Any string used in a conditional, a switch case or a property lookup belongs in a shared enum or const object.

```typescript
export const UserRole = {
  Admin: "admin",
  User: "user",
  Guest: "guest",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
```

Document the enum and any member whose purpose is not obvious. Prop values that are plain style words, such as a button `size` or `variant`, can stay as strings, and `enum-literal-bypass` ignores a configurable list of them.

---

## 6. Logging

### Server side: a structured logger only

Use a structured logging library. No `console.log`, `console.warn` or `console.error` in backend source (`no-console`).

```typescript
import { getLogger } from "./lib/logger";

const logger = getLogger("user-service");

logger.info({ userId, action: "create" }, "User created");
logger.error({ err: error }, "Failed to process event");
logger.warn({ retryCount }, "Retrying after transient failure");
```

### Client side

- `console.log` is forbidden in production.
- `console.error` is allowed for critical errors.
- `console.warn` is allowed for warnings.

`no-console` takes a per-layer method list, so the server layer can ban all methods while the client layer bans only the noisy ones.

### Bootstrap exception

`process.stderr.write()` followed by `process.exit(1)` is fine inside environment validation, because the logger does not exist yet.

### Logging and sensitive data

Code that handles sensitive data (personal records, credentials, extracted document text) needs a stricter logger contract so that nothing sensitive reaches a log line by accident.

- Log messages and service names are string literals, never built from variables (`static-log-message`, `static-logger-service`).
- Messages use an event identifier from a registered list (`safe-log-event-required`).
- A scalar field attached to a log call comes from a reviewed source expression for that event (`safe-log-scalar-source-required`).
- Loggers are constructed only in the logger adapter (`logger-construction-boundary`) and are called directly, never aliased, returned or passed as callbacks (`logger-callback-forbidden`).
- Values with names that suggest sensitive text, such as document text or personal identifiers, are never log arguments (`no-direct-clinical-log-argument`).
- Output of any kind goes through the adapter, not `console`, process streams or a third-party logger. Three more rules enforce this for web and mobile code. Their ids start with a domain-specific prefix, so find them with `arch-lint arch --list`.

---

## 7. Code Quality Rules

### TypeScript strictness

- **No `any`:** use specific types, `unknown` or generics (`no-any`).
- **No unused code:** turn on `noUnusedLocals` in the compiler.
- **No raw `Date` methods:** use a date library such as `date-fns` or `dayjs` for date and time work (`no-date-methods`).
- **No broad types:** prefer `Record<string, unknown>` over `object`, and union types over `string` for known values.
- **Types live in a types folder:** exported interfaces and type aliases go in `types/` (`types-in-types-folder`). That keeps implementation files short and gives shared shapes one definition, usable by frontend, backend and tests alike.

### Runtime type safety

For JSONB and other loosely typed fields, use a runtime type guard, not a cast.

```typescript
// Correct
export function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((v) => typeof v === "string");
}
const channels = isStringArray(rule.channels) ? rule.channels : ["default"];

// Forbidden
const channels = rule.channels as string[];
```

### UI standards

- **Design tokens, not hex colours:** use semantic tokens or CSS variables through utility classes (`no-hardcoded-hex`).
- **No inline styles:** use utility-first CSS (`no-inline-styles`). The exception is a value that is dynamic by nature, such as canvas sizing, computed positions or a progress bar width.
- **Semantic colour classes only:** `bg-background`, `text-primary`, `text-muted-foreground`, `border-border`, `bg-destructive`. Never `bg-neutral-950`, `text-blue-600` and the like.
- **Responsive by default:** a layout-impacting utility such as a grid column count, `flex-row` or a fixed width needs a breakpoint variant nearby (`require-responsive-layout`).
- **Touch targets:** buttons, links and box-shaped inputs have an effective hit area of at least 48 by 48 px (`min-touch-target`).
- **No direct HTTP in components:** components use stores, stores use services, services use the HTTP client.
- **Design system components:** use `<Button>`, `<Input>`, `<Select>` and `<Textarea>` instead of the raw HTML elements. No rule checks this.
- **`cn()` helper:** merge class names with `clsx` and `tailwind-merge`.

### Architecture boundaries

- **No database imports in routes:** routes call models or services, never the ORM (`no-db-in-routes`).
- **No cross-package relative imports:** import another workspace by its package name, not `../../packages/x` (`no-relative-cross-package`).
- **Fixed module sources:** `import()` and `require()` take string literals, so dependency tools can see where code comes from (`dynamic-module-source-forbidden`).
- **No verbose conditional logic:** when two branches (guest and signed-in, free and paid) share most of their code, extract the shared part into a helper or use a strategy. Parameterise the differences.
- **No duplicate interfaces:** if the same type appears in three or more files, move it to a shared types module.

---

## 8. Code Comments and Documentation

### Inline comments explain why, not what

A comment must add understanding that the code cannot carry. If deleting it loses nothing, delete it. `no-narration-comments` flags short comments that open with a banned phrase and comments that mostly repeat the next code line.

| Allowed                                                                 | Forbidden                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Reasoning: `// Constant-time comparison (timing attack prevention)`     | Narrating code: `// increment counter` before `counter++`        |
| Constraints: `// Set TTL on first increment`                            | Naming the operation: `// start working` before `startWorking()` |
| Business logic: `// Legacy rows have no date, so epoch means "undated"` | Labelling returns: `// return the result`                        |
| Pipeline steps: `// Step 1: Try direct text extraction`                 | Block labels: `// constructor`, `// imports`, `// end of class`  |
| Justifying an empty catch: `// Ignore malformed messages`               |                                                                  |
| Scope or limitation: `// Currently just ping/pong`                      |                                                                  |
| `TODO`, `FIXME` and tool directives such as `eslint-disable`            |                                                                  |

Section divider comments are fine in files with 50 or more declarations. Keep comments to one line, two at most.

### JSDoc on exported declarations

Write at least a one-line JSDoc on every exported function, type, interface, enum and constant (`require-export-jsdoc`). Skip `@param` and `@returns`, because the TypeScript signature already says it. Add them only when the name and type cannot convey the meaning.

```typescript
/** Generates a scoped access token for the given grant. */
export function createScopedToken(grant: Grant, ttl: number): string {

/** Stored API key record (never contains the raw key). */
export interface ApiKeyRecord {

/** Standardised error codes returned by API responses. */
export const ErrorCode = { ... } as const;
```

Internal helpers need one only when they are not obvious. Route handlers use OpenAPI metadata instead, and barrel `index.ts` re-exports need nothing. If a team prefers to let names and types carry the meaning, switch `require-export-jsdoc` off. Make that choice once, for the whole codebase.

### Route documentation

Use the framework's OpenAPI support instead of JSDoc on route handlers.

```typescript
.get("/", handler, {
  detail: { summary: "List resources", tags: ["Resources"] },
})

// BFF routes have no OpenAPI equivalent and keep a JSDoc block:
/** BFF: GET /api/resources, lists all resources for the authenticated user */
```

---

## 9. Design Patterns

### Repository pattern (models)

Models wrap ORM queries and return `ServiceResult<T>`. Only the models layer holds a database handle or builds a query (`no-db-outside-models`), and a model never reaches up into a service, a worker or a component (`models-stay-below-services`).

### Adapter pattern

Wrap third-party providers behind one interface so you can swap a provider without touching business logic. Payment gateways and text extraction (PDF parsing, OCR, transcription) are the usual cases.

```typescript
interface PaymentAdapter {
  charge(amount: number, currency: string): ServiceResult<Payment>;
  refund(paymentId: string): ServiceResult<Refund>;
}
```

### Singleton pattern

Expensive resources get one instance: database pools, cache connections, the logger and HTTP clients.

### Guard clauses

Validate at the top of a function and return early on failure.

```typescript
if (!user) return unauthorized();
if (!file) return badRequest("File required");
// core logic
```

### Optimistic UI updates

Update client state before the API call returns, and revert if it fails.

### Dependency injection through parameters

Do not import global state inside a reusable function. Pass dependencies in as arguments.

```typescript
// Correct: userId as a parameter
export function getUserProfile(userId: string): ServiceResult<Profile> { ... }

// Forbidden: reading request headers inside a model function
```

### Transactions

A failure halfway through a set of writes leaves partial state, so group them.

- A function with two or more direct database writes runs in a transaction (`tx-required-multi-write`).
- A delete followed by an insert in one function runs in a transaction, or a failed insert leaves the table empty (`tx-delete-then-insert`).
- A service or worker function that calls two or more mutating model functions runs in a transaction (`tx-service-orchestration`). A saga that spans network calls cannot hold one, so exempt those files individually and write down the compensation logic.

### Feature flags

Store flags in the database, let an admin surface toggle them, and have the endpoint check the flag before it runs restricted logic.

---

## 10. Background Jobs and Realtime

### Job queue pattern

BullMQ is shown as an example. Any queue with retries, concurrency and rate limits fits.

```typescript
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    // 1. Emit "processing:started"
    // 2. Do the work
    // 3. Emit "processing:progress" at each stage
    // 4. Emit "processing:completed" or "processing:error"
    // 5. Return { success, ...result }
  },
  {
    connection,
    concurrency: 5,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
    limiter: { max: 10, duration: 1000 },
  }
);

// Shut down gracefully on SIGTERM and SIGINT: worker.close(), then connection.quit()
// Heartbeat every 30s for monitoring
```

### Queue configuration

```typescript
const STANDARD_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
};
```

### Dead letter queue

When a job fails for good, move it to a dead letter queue for manual inspection.

```typescript
async function moveToDeadLetter(job: Job, errorType: string): Promise<void> { ... }
```

### Batch operations

Add jobs with `queue.addBulk(jobs)` instead of calling `queue.add()` in a loop.

### Work off the request path

Anything slow or fallible that a request triggers goes through the queue: transactional email, report generation, file processing, webhook delivery. For email, define content in templates (not inline strings), enqueue a send job, and let a worker call the low-level sender.

### Retry utility

```typescript
function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    baseDelay?: number;
    shouldRetry?: (err: unknown) => boolean;
  }
): Promise<T>;
// Exponential backoff: delay = baseDelay * 2^attempt + jitter (0 to 200ms)
// Retryable: ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNRESET, HTTP 5xx, 429
```

### Realtime architecture

The API or a worker publishes to a cache pub/sub channel. A socket server, running as a separate process on its own port, subscribes and forwards events to clients. A cache-backed adapter keeps several socket instances in sync.

---

## 11. Testing

### Test types

| Type        | Location             | What it tests                                         |
| ----------- | -------------------- | ----------------------------------------------------- |
| Unit        | `tests/unit/`        | Pure functions and utilities, no database, no network |
| Function    | `tests/function/`    | Models and services with a mocked database            |
| Integration | `tests/integration/` | Full pipelines with a real database and services      |
| Load        | `tests/load/`        | Concurrent requests, throughput                       |
| Performance | `tests/performance/` | Query time, processing time                           |
| E2E         | `tests/e2e/`         | Full HTTP flows against a running test server         |

### Three environments

| Env     | Database                                      | Secrets                                |
| ------- | --------------------------------------------- | -------------------------------------- |
| `local` | Docker database (`.env.local`)                | Local secrets manager or `.env.local`  |
| `test`  | Dedicated test database (`DATABASE_URL_TEST`) | Same infrastructure, separate database |
| `prod`  | Production database                           | Production secrets manager             |

### Test database setup

```typescript
export async function initTestDb() {
  await runMigrations(testDb);
}
export async function cleanupTestDb() {
  // Disable FK constraints, truncate every table, re-enable
  await client.query("SET session_replication_role = 'replica'");
  for (const table of allTables)
    await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
  await client.query("SET session_replication_role = 'origin'");
}
export async function closeTestDb() {
  await pool.end();
}
```

### Test preload

This example uses a Bun-style module mock. Other runners have their own equivalent.

```typescript
// tests/setup/preload.ts, loaded through the test runner config
await initTestDb();
mock.module("@/lib/db", () => ({ db: testDb }));
```

A runner that keeps module mocks alive across files in one process can make unrelated tests see the wrong database. If your suite has that problem, run test files one at a time. `no-whole-dir-test-script` checks that a package's `test` script does so (it is off by default).

### File naming

Always `{module-name}.{unit|fn|integration|load|contract|e2e|performance}.test.ts`. Never a bare `foo.test.ts`, because the type is then ambiguous (`test-file-naming`).

---

## 12. AI and LLM Integration Patterns

### Prompt templates

Store prompts as `.txt` files with `{{VARIABLE}}` placeholders. Never build a prompt by interpolating strings in code.

```
{service-or-plugin}/prompts/
├── text-cleanup.txt
├── classification.txt
└── summarisation.txt
```

```typescript
const cache = new Map<string, string>();

function loadPromptTemplate(
  path: string,
  vars: Record<string, string>
): string {
  const template = cache.get(path) ?? readFileSync(path, "utf-8");
  cache.set(path, template);
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replaceAll(`{{${k}}}`, v ?? "Not specified"),
    template
  );
}
```

### Structured output

Pair each prompt with a JSON schema so the response parses reliably.

```typescript
const schema = {
  name: "TextClassification",
  strict: true,
  schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: ["news", "opinion", "technical"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["category", "confidence"],
    additionalProperties: false,
  },
};
```

### Batch processing

Long text goes through the model in chunks split at natural boundaries, with a concurrency limit.

```typescript
const result = await processInBatches(
  rawText,
  async (chunk, index, total) => {
    const prompt = loadPromptTemplate("prompts/my-prompt.txt", { TEXT: chunk });
    return await fetchWithStructuredOutput(model, prompt, schema);
  },
  { contextName: "my-operation", concurrencyLimit: 10 }
);
```

### Cost tracking

Record the cost of every AI call.

```typescript
await trackApiCost({
  userId,
  provider,
  operation,
  model,
  tokens,
  costUsd,
  success,
  durationMs,
});
```

---

## 13. Client State

### Store pattern

```typescript
interface ResourceState {
  data: Resource[] | null;
  loading: boolean;
  error: string | null;
  _fetchPromise?: Promise<Resource[]> | null;
}

// In-flight dedup: if (_fetchPromise) return _fetchPromise
// Call the service function, check { success, data }, set state
// Error messages come from the i18n module, never raw strings
```

### Internationalisation

All user-facing text comes from one i18n module. No hardcoded strings in components. `no-hardcoded-attr-text` catches literal text in JSX attributes. Literal text between tags is not covered by a rule, so review for it.

```typescript
import { content } from "@/lib/intl";

<h1>{content.home.hero.title}</h1>
<p>{content.errors.notFound}</p>
```

---

## 14. Security

### Core defences

- **Injection:** parameterised queries only (the ORM does this). No `sql.raw()` with interpolated values.
- **Auth:** verify in layers: edge middleware, then the API route, then model-level checks.
- **CSRF:** `SameSite=Strict` cookies. If you use `lax`, add the double-submit cookie pattern.
- **SSRF:** validate webhook and proxy target URLs. Reject RFC 1918 ranges (10.x, 172.16-31.x, 192.168.x), loopback (127.x, ::1), link-local (169.254.x) and cloud metadata endpoints.
- **CSP:** strict script sources, no inline scripts.
- **Secrets:** never commit `.env` files. Use a secrets manager. Never write decrypted secrets into database payloads.

### Security headers

Every API service sets:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cache-Control: no-store  (on authenticated responses)
```

### Middleware and guards

Edge middleware does cheap checks only: verify a signed token's signature and expiry, and redirect. It does no database work. The full session check happens in the API route. Client-side guards (components that hide a page from the wrong role) are a convenience for the user, not a security control, because the server must enforce the same rule. Prefer composition (a guard component wrapping children) over higher-order components.

### Timing-safe comparisons

Compare secrets in constant time.

```typescript
// Correct
crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Forbidden
if (secret === userInput) { ... }
```

### Input validation

- Validate every external input (API body, URL params, query strings) with schema validation at the top of the route handler.
- Check the MIME type or magic bytes of uploaded files.
- Webhook URLs must be HTTPS and must not point at private addresses.
- Use runtime type guards on JSONB fields, not `as` casts.

### Sessions

- Use a separate session secret for each application.
- Check the minimum secret length (32 characters or more) at startup.
- Encryption keys are required environment variables and never default to an empty string.

### Tenant isolation and audit

- A route reaches data through an authorized service boundary, not through an internal database handle that skips tenant scoping (`tenant-bypass-boundary`).
- Routes write audit entries through a wrapper that never fails the request, not through the raw audit write primitive (`no-direct-write-audit-in-routes`).

### Uploads

File bytes go straight to object storage through signed requests. They do not travel as request bodies through your routes and services, and mobile clients do not post multipart bodies to them (`no-image-body-upload`, `no-mobile-image-body-upload`).

### Personal data lifecycle

Plan for erasure and export from the start. A delete-account service cascades to all related data (files, comments, sessions), and a user can request a machine-readable export of what you hold on them. No rule checks either.

### Dependencies

- Pin dependency versions. No wildcards (`*`) in production packages.
- Align versions across workspaces so there is only one version of each package.
- Hash-pin Python requirements (`pip-compile --generate-hashes`).
- Run CVE scanning in CI (Trivy, `npm audit`, `pip-audit`).
- Track a remediation timeline: critical within 24 hours, high within a week, medium within 30 days.

### Role verification

Never hardcode a role at login. After the OAuth callback, verify the role against the identity provider or the database.

---

## 15. Performance

### Database

- Index every foreign key and search column in the schema.
- Avoid N+1 queries. Use eager loading, joins or CTEs.
- Maintain `updatedAt` columns with database triggers, not application code.
- Paginate every list endpoint and enforce a maximum page size.

### Frontend

- Code-split heavy components (charts, editors, 3D viewers) with dynamic imports.
- Use optimised image components with explicit dimensions.

### Caching

- Cache expensive computations in Redis or an equivalent.
- Use stale-while-revalidate for client data.
- Rate limit API routes with a sliding window (Redis and a Lua script keep the count atomic).

### Concurrency safety

Use advisory locks for operations that are open to time-of-check to time-of-use races.

```typescript
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${resourceId}))`);
  // operation that must not race
});
```

---

## 16. Code Deduplication

### When to extract

Extract shared code when the same logic appears in three or more places across service boundaries. Some boilerplate is fine to repeat in each service: logger setup, the startup sequence, queue configuration with service-specific settings.

### Shared package

```
packages/service-core/src/
├── middleware/
│   ├── auth.ts               # Auth plugins (JWT verify, API key factory)
│   ├── error-handler.ts      # Central error handler
│   └── request-tracing.ts    # X-Request-ID propagation
├── logger.ts                 # createServiceLogger(name) factory
├── error-messages.ts         # Base error message constants
├── webhook-delivery.ts       # Shared webhook logic
└── cache-client.ts           # Cache client factory
```

### What not to deduplicate

- Service-specific routes and their `paths.ts`, because each service owns its API.
- Service-specific model functions, which share a pattern but not an entity.
- Plugin-internal types, which are domain-specific.
- Config files with three to five lines of boilerplate.

### Shared queries

When two services need the same database query, put it in the shared database package. Do not put it behind an HTTP call, which adds latency on a hot path.

```typescript
// packages/db/src/queries/grants.ts
export function findGrantById(grantId: string) { ... }
```

### Shared auth

When several apps share OAuth logic, move it to a shared auth client package.

```
packages/auth-client/src/
├── auth-helpers.ts    # PKCE, token exchange, user info fetch
└── session.ts         # Session factory (configurable storage strategy)
```

---

## 17. Git Conventions

### Commit messages

Follow conventional commits: `type(scope): description`. Common types are `feat`, `fix`, `chore`, `docs`, `refactor`, `test` and `perf`. `arch-lint commit-msg` checks the header, the type list, scopes and banned trailers. It is a command wired into the `commit-msg` hook, not one of the architecture rules.

### Staging

Stage files by explicit path. When several people or sessions share one checkout, a broad `git add` pulls in files that are not yours.

### Database changes

Always use migrations, and never push a schema directly to a database. Applied migrations are immutable: add a new one instead of editing a released one.

- No package script that pushes a schema straight to a database (`no-drizzle-push`; it matches `drizzle-kit push` by default, and the `pattern` option covers another tool).
- No top-level `BEGIN` or `COMMIT` in a migration, since the migrator wraps each file (`migration-no-tx-control`).
- No `ALTER DEFAULT PRIVILEGES` that names an owner role (`migration-no-default-privileges-for-role`).
- Journal entries increase strictly in order (`migration-journal-order`).
- A migration already on the base branch is not removed, renamed or re-timestamped (`migration-released-immutable`).

### Dependency updates

When you align versions across a monorepo, update every package in one commit. Then run the full typecheck and test suite.

---

## 18. Architecture Enforcement

Conventions that live only in a document drift. arch-lint turns the ones that can be checked from source text into rules, runs them locally and in CI, and fails the build on a violation that is not already on record.

### Running the rules

```sh
npx arch-lint init                    # adds scripts and arch-lint.config.json
npx arch-lint arch --list             # every rule, its kind and what it enforces
npx arch-lint arch                    # run every enabled rule
npx arch-lint arch --rule no-any,no-raw-throw
npx arch-lint arch --all              # also show baselined debt per rule
npx arch-lint check                   # lint, format and architecture rules, one exit code
```

`arch-lint arch --list` is the authoritative list of ids. [RULES.md](RULES.md) is generated from the same registry and [RULE-OPTIONS.md](RULE-OPTIONS.md) documents every option. Older ids keep working, so `no-console-log` still resolves to `no-console`, and `no-enum-literal-bypass` to `enum-literal-bypass`.

### Configuration

Rules are controlled from `arch-lint.config.json` ([CONFIG.md](CONFIG.md)). Without a config the `recommended` preset applies: `no-any`, `no-empty-catch`, `no-narration-comments` and `no-console`. Everything else is off until you list it.

- **Layers** give a name to a set of paths (`backend`, `routes`, `models`, `frontend`). A rule can be limited to a layer, and several rules have a default layer. Map the layer names to your own directories so that the conventions in sections 1 and 9 apply to the right files.
- **Exemptions** work at two levels: an exact file (`exempt.files`) or a directory prefix (`exempt.dirs`). Write down why next to each one.
- **Options** tune a rule, for example `no-date-methods` accepts a `variant` and `no-console` a per-layer method list.

### Which rule enforces which convention

| Convention                                                        | Section | Rule ids                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Components stay view-only                                         | 1, 7    | `no-service-in-tsx`, `no-raw-fetch-in-components`                                                                                                                                                           |
| Only models touch the database                                    | 1, 9    | `no-db-outside-models`, `no-db-in-routes`                                                                                                                                                                   |
| Models do not import higher layers or caches                      | 1, 9    | `models-stay-below-services`, `no-cache-in-models`                                                                                                                                                          |
| Native app layering                                               | 1       | `no-ui-toolkit`, `no-feature-import`, `no-store-in-features`                                                                                                                                                |
| Typed errors with codes, no swallowed errors                      | 3       | `no-raw-throw`, `no-unsafe-error-cast`, `err-requires-error-code`, `no-empty-catch`                                                                                                                         |
| Single HTTP gateway                                               | 4       | `no-raw-fetch`, `no-axios`, `no-raw-fetch-in-components`                                                                                                                                                    |
| Validated environment access                                      | 5       | `no-raw-process-env`, `environment-adapter-required`                                                                                                                                                        |
| No magic route strings, text, origins or enum values              | 5       | `no-magic-path`, `no-hardcoded-attr-text`, `no-hardcoded-origin`, `enum-literal-bypass`                                                                                                                     |
| Structured logger instead of console                              | 6       | `no-console`                                                                                                                                                                                                |
| Safe logging of sensitive data                                    | 6       | `static-log-message`, `static-logger-service`, `safe-log-event-required`, `safe-log-scalar-source-required`, `logger-construction-boundary`, `logger-callback-forbidden`, `no-direct-clinical-log-argument` |
| No `any`, no raw date methods, types in a types folder            | 7       | `no-any`, `no-date-methods`, `types-in-types-folder`                                                                                                                                                        |
| Design tokens, no inline styles, responsive layout, touch targets | 7       | `no-hardcoded-hex`, `no-inline-styles`, `require-responsive-layout`, `min-touch-target`                                                                                                                     |
| Workspace imports by package name, fixed module sources           | 7       | `no-relative-cross-package`, `dynamic-module-source-forbidden`                                                                                                                                              |
| Comments explain why, exports documented                          | 8       | `no-narration-comments`, `require-export-jsdoc`                                                                                                                                                             |
| Transactions around multi-step writes                             | 9       | `tx-required-multi-write`, `tx-delete-then-insert`, `tx-service-orchestration`                                                                                                                              |
| File and test file naming                                         | 2, 11   | `kebab-case-filenames`, `test-file-naming`                                                                                                                                                                  |
| Test script isolation when module mocks leak                      | 11      | `no-whole-dir-test-script`                                                                                                                                                                                  |
| Tenant boundary and audit writes                                  | 14      | `tenant-bypass-boundary`, `no-direct-write-audit-in-routes`                                                                                                                                                 |
| Uploads go direct to object storage                               | 14      | `no-image-body-upload`, `no-mobile-image-body-upload`                                                                                                                                                       |
| Migrations                                                        | 17      | `no-drizzle-push`, `migration-no-tx-control`, `migration-no-default-privileges-for-role`, `migration-journal-order`, `migration-released-immutable`                                                         |

Three notes on the table. Three more logging rules exist whose ids begin with a domain-specific prefix. They send all output in web and mobile code through the logger adapter, and `arch-lint arch --list` shows them. `test-file-naming` and `no-whole-dir-test-script` are off by default, so turn them on in the config. And `no-dash` (no en or em dashes in Dart sources) enforces a style choice this guide does not otherwise cover.

### Conventions with no rule

These rely on review, the compiler or other tooling. Do not assume arch-lint will catch a violation.

- Layer direction between the client layers, other than components calling services or `fetch` (store to service to HTTP client order is not checked).
- Returning a `ServiceResult` instead of throwing across layer boundaries, and centralised error message constants.
- HTTP client behaviour: retry, timeouts, tracing, circuit breaking.
- Magic numbers, broad types, runtime type guards for JSONB, and unused code (use `noUnusedLocals`).
- Design system components over raw HTML elements, the `cn()` helper, and semantic colour class names. `no-hardcoded-hex` only sees hex literals.
- Literal text between JSX tags. `no-hardcoded-attr-text` covers attributes only.
- Naming conventions other than file names and test suffixes.
- Queue and worker standards, dead letter handling, realtime design, test layout and environments, prompt templates, cost tracking and client store shape.
- Security practice: headers, CSRF, SSRF checks, timing-safe comparison, input validation, session secrets, dependency pinning, CVE scanning and the personal data lifecycle.
- Performance (indexes, pagination, caching), deduplication, ADRs and the compliance register.
- Staging by explicit path, and the rest of the git conventions beyond the commit header and migrations.

### The baseline

A codebase that adopts the rules usually has violations on day one. `arch-lint arch --update-baseline` records them in `arch-lint.baseline.json` as tolerated counts per rule and file. A run exits with code 1 only for violations that are not in the baseline, so new code is held to the rules while old debt is paid down gradually. After fixing debt, update the baseline to lock the improvement in. Do not raise a count to get a commit through. Fix the code, or add a reasoned exemption.

### Hooks and CI

`arch-lint hooks install` writes a pre-commit hook (staged-file lint and format, then the rules), a pre-push hook (the migration journal check when migrations are configured, then the full `check`) and a commit-msg hook. `arch-lint init --ci` writes a CI workflow that runs `arch-lint check`. See [HOOKS.md](HOOKS.md). CI runs the same checks as the hooks, so `--no-verify` can get you unstuck but it will not get a failing rule merged.

### Adding a rule

When a convention keeps being broken in review, write a rule for it. [WRITING-RULES.md](WRITING-RULES.md) walks through one end to end. In short: write the check, register it, add test cases, run it against the codebase, record the existing violations in the baseline, and add the rule to the compliance register.

---

## 19. Compliance Register

Keep a living document that tracks every convention, both the automated ones and the ones enforced in review.

### Structure

```
COMPLIANCE_REGISTER.md

Part 1: Automated (arch-lint rules, CI-blocking)
  Numbered table: Rule | Detects | Required | Exemptions

Part 2: Binding conventions (review-enforced)
  Grouped by category:
    A. Error handling
    B. Architecture
    C. HTTP client
    D. Environment and config
    E. Logging
    F. Code quality
    G. Code comments and docs
    H. UI standards
    I. Naming
    J. Database and schema
    K. Schema validation
    L. AI and prompts
    M. Queue and workers
    N. State management
    O. Testing
    P. Project structure
    Q. Git and workflow
    R. Security
```

### Purpose

- One source of truth for every engineering rule.
- Each rule points to the section of this guide that justifies it.
- New engineers can onboard by reading one file.
- Audit reports grade against it.

Part 1 can be generated from the rule registry, which is how [RULES.md](RULES.md) is produced. Part 2 is written by hand, and its entries are the "Conventions with no rule" list above plus anything specific to your project.

---

## 20. Code Quality Audits

### Audit dimensions

Audit the codebase on a schedule and grade each dimension.

| Dimension                 | What to check                                                                |
| ------------------------- | ---------------------------------------------------------------------------- |
| Type safety               | `any` usage, broad types (`object`, `string` for known values), unsafe casts |
| Enum and constant usage   | Magic strings in conditionals, unnamed WebSocket close codes                 |
| Magic strings and numbers | Hardcoded error messages, unnamed numeric constants                          |
| Internationalisation      | Hardcoded user-facing strings in components                                  |
| UI styling                | Hardcoded colours, inline styles, raw HTML elements                          |
| Code duplication          | The same logic in three or more files across service boundaries              |
| Comment compliance        | Missing JSDoc on exports, narration comments                                 |
| Architecture lint         | Violation counts per rule, and the size of the baseline                      |

### Issue priority

| Priority | Definition                                            | Target      |
| -------- | ----------------------------------------------------- | ----------- |
| P1       | Blocks correctness, security or data integrity        | This sprint |
| P2       | Violates conventions, causes maintenance burden       | Next sprint |
| P3       | Nice-to-have cleanup, deferred pending infrastructure | Backlog     |

### Remediation process

1. **Audit.** Build a file-by-file compliance index.
2. **Design.** Write a remediation plan with a phased order.
3. **Implement.** Fix in priority order and verify after each phase.
4. **Update the report.** Flip resolved items and update the grades.
5. **Repeat.** Schedule the next audit.

---

## 21. Tech Debt Management

### Identification

Keep a tech debt register that covers:

- **Dependency drift:** mismatched versions across workspaces.
- **Wildcard dependencies:** a `"*"` in `package.json` gets replaced with a pinned version.
- **Missing tests:** packages or services with no coverage.
- **Missing documentation:** ADRs, runbooks, API docs.
- **Deferred primitives:** UI components that are needed but not built.
- **Security patches:** CVEs in dependencies.
- **Baselined violations:** the counts recorded in the arch-lint baseline.

### Remediation strategy

Batch the work by dependency and risk.

1. **Batch 1, parallel:** independent fixes such as version bumps, magic number extraction, type safety and N+1 fixes.
2. **Batch 2, sequential:** changes that need integration, such as Docker builds, database migrations and security middleware.
3. **Batch 3, parallel:** test coverage gaps.
4. **Batch 4, backlog:** documentation, observability and infrastructure.

After each batch, run lint, typecheck and tests to catch regressions.

### Version alignment

Pin each shared dependency to the highest version in use across the monorepo, and update every workspace in a single commit.

---

## 22. Verification Checklist

Before you mark a task complete:

1. **Static analysis:** the type check passes with zero errors.
2. **Lint:** every rule passes, including `arch-lint arch`. `arch-lint check` runs lint, format and the architecture rules together.
3. **Formatting:** code is formatted per the project config.
4. **Tests:** all relevant tests pass.
5. **Self-review:**
   - [ ] Validated env config instead of `process.env`?
   - [ ] Path constants instead of hardcoded URLs?
   - [ ] Design tokens instead of hardcoded colours?
   - [ ] Structured logger instead of `console.log`?
   - [ ] No `any` types?
   - [ ] Business logic in models and services, not components?
   - [ ] Layer boundaries respected?
   - [ ] Named constants for every magic number?
   - [ ] Runtime type guards for JSONB fields?
   - [ ] Timing-safe comparisons for secrets?
   - [ ] Pagination on list endpoints?
   - [ ] Security headers on new endpoints?
   - [ ] Transaction around any multi-step write?
6. **Trace the data flow:** follow one request from the database through the model, the route, the service and the store to the UI.
