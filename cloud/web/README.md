# SessionPort web · M3 minimal surface

The M3 web surface is a small, same-origin account boundary: GitHub sign-in, OpenCode request review, and connected-device revocation. It is a utility, not a marketing site. The browser talks only to the fixed `/api/...` routes below; it never receives the internal API origin or a native bearer credential.

## Server configuration

The BFF proxy routes fail closed with the existing `{ error: { code, message, retryable, requestID } }` envelope unless all required values are explicitly configured:

- `SESSIONPORT_PUBLIC_ORIGIN` — the canonical public web origin, with no path, query, fragment, or user info. HTTP is accepted only for loopback development.
- `SESSIONPORT_INTERNAL_API_ORIGIN` — a server-only API origin, with the same origin-only validation. Never derive either origin from `Host`, `Forwarded`, or proxy headers.
- `SESSIONPORT_WEB_POLICY_JSON` — a required, non-secret JSON object with exactly `{ "maxRequestBytes": number, "maxResponseBytes": number, "upstreamTimeoutMs": number }`. Every value must be a positive safe integer, and `upstreamTimeoutMs` must also be a valid timer value (at most `2147483647`). There are no production defaults; operators must supply values appropriate for their deployment.

The BFF does not sign or validate CSRF tokens and never reads a browser CSRF secret. The internal API issues the browser token only after its authoritative cookie-only session read. The BFF requires the canonical 43-character base64url token shape, forwards the token and cookie unchanged on POST, and returns the API-issued token unchanged in the session DTO. The API remains the authority for the session and token HMAC validation. The token is held in component memory and sent only in `x-sessionport-csrf`; it is not stored in browser storage, a cookie, a URL, or logs.

Every upstream call uses `redirect: "manual"`, one deadline covering the fetch and bounded response body read, and the configured byte limits. Request bodies are read through a bounded stream rather than `await request.json()`. Overflow is rejected with a fixed `413` for request bodies or a fixed `503` for upstream response bodies, and the stream is cancelled. The timeout is cleared only after the response body has been read or a fixed failure returned.

## Source layout

The web app uses Next's App Router as a thin adapter over a small Feature-Sliced Design tree:

```
src/app/                    Next App Router pages and route handlers only
src/proxy.ts                Next proxy adapter for security headers
src/_app/server/            application server composition; index.server.ts is the public entry
src/_app/security/          CSP/nonce proxy implementation; index.server.ts is the public entry
src/_app/styles/            global styles imported by the root layout
src/_pages/                 login, device-approval, connected-devices composition
src/widgets/site-frame/     shared page frame
src/features/               github-sign-in, sign-out, device-authorization, revoke-device
src/entities/               browser-session, device-grant typed DTOs/models and API reads
src/shared/api/             generic fetch/request/error helpers only
src/shared/ui/feedback/     shared status and loading UI
```

Imports flow only downward: `_app` → `_pages` → `widgets` → `features` → `entities` → `shared`. Code outside a slice imports that slice only through its public `index.ts` (or `index.server.ts` for the server BFF). `shared` segments may import each other. Features do not import widgets or pages, entities do not import features, and pages compose features/entities.

`src/_app/server/index.server.ts` is the only public entry for the business BFF. Route handlers import it; client modules cannot. The repository does not add a `server-only` runtime dependency. Instead, `cloud/web/test/architecture.test.ts` scans the complete TypeScript import graph and fails on upward, cross-slice, deep-public-path, adapter, or client-to-server-BFF imports. This is a static boundary, not a runtime module marker.

## Browser and API paths

The browser-facing fixed pages are `/login`, `/device`, and `/devices`. The native flow should advertise the canonical verification URI path `/api/native/v1/device-authorizations/verify`; its `GET` redirects to the fixed public `/device` page without carrying query parameters. `/device` also redirects away from query values and removes any fragment before loading account data; the user must enter the code manually.

The same-origin BFF routes map only these requests to the internal API:

| Browser request | Internal API request |
| --- | --- |
| `GET /api/native/v1/session` | `GET /api/native/v1/session` |
| `POST /api/native/v1/device-authorizations/verify` | Same path |
| `POST /api/native/v1/device-authorizations/approve` | Same path |
| `POST /api/native/v1/device-authorizations/deny` | Same path |
| `GET /api/native/v1/grants` | Same path |
| `POST /api/native/v1/grants/:uuid/revoke` | Same path |
| `POST /api/auth/sign-in/social` | Better Auth sign-in; provider and callback are fixed server-side |
| `GET /api/auth/get-session` | Better Auth get-session; only the public user fields are returned |
| `GET /api/auth/callback/github` | Better Auth GitHub callback; only OAuth callback query keys are forwarded |
| `POST /api/auth/sign-out` | Better Auth sign-out |

No other auth or native path is proxied. Native POSTs require JSON, one exact configured `Origin`, a present session cookie, and one canonical 43-character base64url CSRF header. The BFF forwards only the required cookie, exact origin, content type, and CSRF header; client `Authorization`, `Host`, forwarding headers, and user assertions do not cross. The API enforces the authoritative session and validates the CSRF HMAC; a syntactically valid BFF request is never treated as authentication.

## DTOs expected from the native API

- Session: `{ user: { id, name, email }, csrfToken }`, where `csrfToken` is the API-issued canonical 43-character base64url value. The BFF returns exactly these fields and never exposes a session ID or cookie-derived token.
- Verify: `{ consent: { account: { id, name, email }, scopes: string[], expiresAt: string } }`.
- Approve / deny / revoke: `{ status: "approved" | "denied" | "revoked" }`.
- Grants: `{ grants: [{ id, deviceID, createdAt, expiresAt, lastSeenAt, revokedAt, status }] }`, where nullable timestamps are `null` or date strings and status is `active` or `revoked`.
- Errors use the existing fixed API envelope and known error-code set, including the approved native codes such as `authorization-expired`, `authorization-denied`, `authorization-consumed`, `state-conflict`, `rate-limited`, and `invalid-request`. The BFF emits only fixed messages for known codes and never relays raw vendor or user-supplied text.

The consent screen shows the account and scopes returned by the server, requires a separate confirmation checkbox, and always offers deny. The code is normalized in memory to 12 Crockford characters; it is never read from a URL or emitted in page copy. A successful approve or deny clears the component-held code. Device rows contain grant metadata only and never expose tokens or checkpoint/session content.

## Browser policy

The app uses local system fonts, CSS-only decoration, and inline local SVG marks. It has no external font, image, analytics, or script dependency. `src/proxy.ts` applies a per-response nonce CSP, same-origin connections, no-referrer, no-store, and browser hardening headers. The OAuth hand-off is limited to `https://github.com/login/oauth/authorize`; backend redirects are manual and validated before a fixed same-origin callback destination is returned.

The account/API service is not implemented in this web slice. Do not present an unavailable response as a successful sign-in, approval, or revocation. The orchestrator owns build, contract integration, and browser validation.
