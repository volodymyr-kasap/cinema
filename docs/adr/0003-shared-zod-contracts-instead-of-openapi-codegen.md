# 3. Shared Zod contracts instead of OpenAPI codegen

**Status:** accepted (2026-08-27)

## Context

The API shape must be described once. Both the server (request validation) and
the SPA (response parsing) need it, and the OpenAPI document has to stay
truthful without a manual step.

## Decision

`packages/contracts` holds Zod schemas as the single source of truth. The API
validates requests with them, the SPA parses responses with them, and the
OpenAPI document is generated from them with `z.toJSONSchema`.

## Alternatives considered

- **NestJS DTOs plus `@nestjs/swagger` and a generated client.** Two independent
  descriptions of the same shape, a codegen step in CI, and
  `@nestjs/swagger@12` drags in `class-validator`/`class-transformer`.
- **`nestjs-zod`.** The right idea, but its peer range caps below NestJS 12.

## Consequences

- Validation and OpenAPI are hand-rolled, roughly 120 lines across two modules.
- A contract change breaks the SPA's tests and the API's response-validation
  interceptor at once, which is the desired failure mode.
- A guard test asserts that each route's registry entry and its `@Validated`
  decorator reference the same schema object, so the document cannot drift from
  what the handler actually returns.
