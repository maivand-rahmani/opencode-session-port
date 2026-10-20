# Native Authentication — bounded source contract approved; runtime acceptance unproven

> **STATUS: SOURCE CONTRACT APPROVED 2026-10-20 — RUNTIME ACCEPTANCE UNPROVEN — DESIGN RECORD**
>
> **No production auth is enabled.** The bounded native-auth source implementation exists locally and
> was approved for source scope on 2026-10-20 (Ora9 Phase 1). That approval covers the source
> contract only: it is not a live database apply, deployment, security/concurrency proof, OS/vault
> proof, OAuth acceptance, or auth enablement. The owner approved the redesign direction; this
> document remains the design record and does not self-approve runtime behavior.
>
> **Current-spec boundary.** For the native path, this SessionPort-owned opaque stateful credential
> contract supersedes the earlier JWT/vendor-native-device-provider proposal only. BetterAuth 1.7.11
> remains the browser GitHub authority (four bridge routes; no JWT or device-provider plugins). The
> older JWT/vendor acceptance text in [SECURITY.md](SECURITY.md) remains unreconciled; the AUTH-01
> task history records the native-path supersession explicitly. A separate documented reconciliation
> remains open. This file is not indexed in
> [README.md](README.md), so the package remains the nine-document set described there.

## 0. Initial review outcome and remediation

**Independent design review outcome: REVISE (ora6).** That review was documentation-scoped and did
not establish that any security control works at runtime. Later **Ora9 Phase 1 (2026-10-20)** approved
the bounded source contract only; it did not approve production consent UX or configuration, and it
does not prove routes, PostgreSQL behavior, CSRF, vault, OAuth, or deployment. Runtime and auth
enablement remain unaccepted.

### 0.1 Documentation findings addressed in this revision

The following changes are integrated into the body of this document rather than appended as a
second, contradictory contract:

1. **Browser verification URL and code handling.** The prior `/{user_code}` browser path contract
   is withdrawn. The browser verification URL is fixed and contains no human code in its URI,
   path, query, or redirect. The human code is submitted only in a POST body. Code-bearing pages
   require `no-store` and `no-referrer`, contain no third-party consent content, and must not log,
   trace, or echo the code.
2. **Short human code with a dedicated server key.** The owner selected the short-code +
   server-key direction. This document records the reviewer-recommended HMAC-SHA256 construction
   with distinct server-only key material, key IDs/versions, and an active/retiring key ring. The
   pending row stores the digest and key ID. No actual key, dummy key, or production fallback is
   created here. Rotation must preserve unexpired pending verification with the old key or
   explicitly expire those pending records; it must never silently strand a pending record or
   guess a key.
3. **High-entropy credentials.** Device, access, and refresh credentials are proposed as 32 CSPRNG
   bytes encoded with base64url and strictly parsed. Their persisted fingerprints use
   domain-separated SHA-256, with distinct domains by credential type/version. The transport and
   digest details remain proposed pending review, and no secret used here is the account root.
4. **Refresh locking and replay.** Refresh pre-reads the token only to locate its grant, locks the
   grant before the token row, and revalidates the relationship. A replay branch commits grant
   revocation and then returns its error outside the transaction; throwing a rollback after
   revocation is prohibited. Old access tokens remain valid until their own expiry, subject to
   the grant active check; this is the documented choice, not an unresolved one.
5. **Transaction boundaries and authoritative state.** Approve/deny lock only the pending row.
   Exchange locks the pending row and creates the grant plus token rows atomically. Refresh and
   revoke serialize on the grant. Browser revoke validates own-user ownership under the grant
   lock. There is no transaction that needs a pending-plus-grant lock ordering. Authentication
   checks use authoritative primary committed state, with no auth cache or stale read replica.
   A request whose check completed before revocation may finish.
6. **Schema and retention constraints.** The proposal records unique digests/fingerprints,
   enum/state checks, token expiry not exceeding grant expiry, indexed lookup and expiry access,
   and retention of spent refresh records for the period in which the grant can be used. User-FK
   disable/delete behavior and final replay archival/cleanup bounds remain explicit freeze gates,
   not guesses.
7. **Consent.** The consent section now records the proposed warning, the actual approving account
   as owner, the possibility of a different initiator, untrusted/escaped client description, and
   an explicit confirmation. Code possession is not ownership proof. This does not defeat
   phishing, does not claim owner approval of transferability, and does not infer a malicious
   initiator-to-owner binding.
8. **BetterAuth integration honesty.** Source research is complete for the installed BetterAuth
   1.7.11 public session API and selected source paths (section 3.5); runtime session behavior and
   a custom-route CSRF runtime proof remain pending; the source route/bridge exists locally. Unused vendor device/OAuth routes must not be
   accidentally enabled. Native credential storage remains blocked on secure-vault validation
   with no plaintext fallback.

### 0.2 Remaining unresolved proof and product gates

The following are not resolved by this documentation pass:

- Exact short-code entropy/length/alphabet, normalization, encoding, key provisioning, and
  rotation-overlap policy before human-code implementation.
- Exact high-entropy credential digest domain labels/version strings and transport-detail
  approval.
- Source research is complete for the BetterAuth session path; runtime session behavior and
  custom-route CSRF runtime proof remain pending. Browser routes exist in local source but are not
  approved for runtime use.
- Consent UX/product acceptance and the residual phishing risk before runtime use of native routes.
- User-FK disable/delete semantics and final replay-record archival/cleanup bounds.
- All production TTLs, caps, rate limits, origins, scopes, audiences, resources, and verification
  URLs; none are selected here.
- Native vault selection/validation, unused vendor-route isolation, and business `Device` linkage.
- PostgreSQL synthetic security/concurrency proof, route/schema/lifecycle approval, and all
  runtime tests. **No runtime or test evidence is claimed.**

## 1. Scope and terminology

- **Native client** means the planned SessionPort local/client integration that needs a cloud API
  credential. It does **not** mean OpenCode native import/update (the HOST-01 gate), a browser, or a
  third-party OAuth application.
- **Browser** means the same-origin SessionPort web surface backed by BetterAuth's GitHub login and
  browser session.
- **Fixed browser verification URL** means the configured browser URL for entering a human code.
  The code is never placed in its URI, path, query string, fragment, or redirect.
- **Pending authorization** is a short-lived native-login request awaiting browser approval.
- **Grant** is the durable, server-side authorization record created after approval and successful
  device-code exchange. It belongs to exactly one authenticated vendor user.
- **Access token** is the opaque credential accepted on native API bearer routes. **Refresh token**
  is the opaque credential accepted only at the native token endpoint. **Device code** is the
  high-entropy secret used only for the initial token exchange. **Human code** is the short,
  low-entropy, transferable code shown to the user and entered in the browser. The human code is
  not a bearer credential.
- **Human-code key ring** is the dedicated server-only key material proposed to hash human codes.
  It is distinct from the account root, sync passphrase, and any session key.
- This is an authentication design for the native client, not a general OAuth provider, a new
  identity provider, a replacement for BetterAuth browser login, or an authorization server for
  third parties. It is **RFC 8628-inspired** and is **not** an RFC 8628 conformance claim.
- **Out of scope and untouched:** account-root encryption, the sync passphrase, wrapped key
  material, encrypted session content, local state/outbox, and OpenCode host session data. This
  redesign changes only native authentication state and contracts; it does not alter crypto,
  passphrase handling, or session payloads.

## 2. Design summary and trust boundaries

The proposal is a SessionPort-owned, stateful opaque-token design:

1. **SessionPort owns the native state.** SessionPort creates and tracks pending authorizations,
   grants, token records, rotation state, and revocation. Native bearer credentials are opaque
   random values whose authoritative state is in the SessionPort primary database.
2. **BetterAuth retains its existing role.** BetterAuth remains the GitHub browser login and
   browser-session authority and owns its unchanged pinned 13-model vendor auth schema. The
   existing vendor device/OAuth-provider tables are left unchanged but are **unused by the native
   flow initially**. They must not be accidentally enabled by native route mounting or
   configuration. BetterAuth does not issue the native bearer token in this proposal, and no vendor
   field is added. Source research is complete for the installed BetterAuth 1.7.11 session path;
   runtime session behavior and a custom-route CSRF runtime proof remain pending.
3. **Public native client.** The native client is a public client with no shared secret. It cannot
   prove a user, grant, scope, audience, resource, or header value to the server. Any such
   client-supplied value is untrusted input, never an authorization fact.
4. **Two separate principals and namespaces.** Native bearer requests and browser cookie-session
   requests remain separate. Cookies are never a bearer fallback, and browser routes do not accept
   native bearer credentials. Native routes live under a separate namespace and do not override or
   alter `/api/auth/*`.
5. **No native JWT.** There are no native JWT claims, signer, issuer-to-JWKS trust path, or token
   introspection claims. Trusted user, scopes, audience, and resource are resolved server-side on
   every request.
6. **Stateful enforcement.** Every native bearer check requires a primary-database lookup of an
   active, unexpired token of the correct type bound to an active, unexpired grant, plus the
   route's server-side scope/resource/audience policy. Revocation is effective on the next check.
   No auth cache or stale read replica may supply the authoritative decision.
7. **No client persistence yet.** No new native-client storage for credentials is authorized until
   a secure vault is selected, validated, and approved. A vault failure must fail closed; there is
   no plaintext fallback or plaintext temporary file.

Trust rules:

- The authenticated **user** comes from the grant's vendor `User.id` FK; it is never taken from a
  native request header, body, query, or token-embedded claim.
- **Scopes** and **resource** come from the server-recorded grant, which was produced from the
  server's configured allowlist; a client cannot widen them later.
- **Audience** and the route-required scope come from server configuration and route policy, not
  from the client.
- A **grant ID**, client ID or other client metadata, client header, or client-supplied scope
  cannot select or alter a grant. Grant ownership checks are server-side and user-scoped.
- The browser cookie session is validated as its own principal through the source-researched
  BetterAuth session path; runtime session and custom-route CSRF proof remain pending. It is not
  converted into a native bearer token.

## 3. HTTP contract (implemented locally; runtime acceptance pending)

All paths below are implemented in local source (service, repository, and route modules) and were
frozen for source scope on 2026-10-20. Runtime behavior, live PostgreSQL, real OAuth, custom-route
CSRF, vault, and deployment acceptance remain unproven; the [M1–M3 contract](../evidence/m1-m3-schema-contract.md)
governs the exact schema. The namespace is deliberately separate from BetterAuth:

- Native namespace: `/api/native/v1/*`
- BetterAuth namespace: `/api/auth/*` (unchanged; not overridden)
- No native route may shadow, replace, proxy-around, or reinterpret a BetterAuth route.
- **No human code may appear in a URI, path, query string, fragment, or redirect.** Browser code
  entry is a POST body only.

| Method and path | Caller / authentication | Behavior (local source; acceptance pending) |
| --- | --- | --- |
| `POST /api/native/v1/device-authorizations` | Public native client; no shared secret, session, or cookie | Create a pending authorization. Return a high-entropy device code, a short human code, the configured fixed verification URI, and the configured poll interval. |
| `GET /api/native/v1/device-authorizations/verify` | Browser only; BetterAuth browser session (source research complete; runtime/custom CSRF proof pending) | Serve the fixed browser verification page. No code is present in the URL. |
| `POST /api/native/v1/device-authorizations/verify` | Browser only; session plus implemented CSRF/origin enforcement (runtime/custom CSRF proof pending) | Accept the human code only in the POST body, validate it through the key ring, and render the consent view. Read-only with respect to authorization state. |
| `POST /api/native/v1/device-authorizations/approve` | Browser only; session plus explicit CSRF/origin and confirmation (source research complete; runtime/custom CSRF proof pending) | Accept the human code only in the POST body plus an explicit confirmation; bind the current authenticated vendor user to the pending authorization, once. |
| `POST /api/native/v1/device-authorizations/deny` | Browser only; session plus explicit CSRF/origin (source research complete; runtime/custom CSRF proof pending) | Accept the human code only in the POST body; terminally deny the pending authorization. |
| `POST /api/native/v1/token` | Public native client; no shared secret, session, or cookie | Device-code exchange after approval, or refresh-token rotation. Return raw credentials only after commit. |
| `GET /api/native/v1/grants` | Browser only; BetterAuth browser session (source research complete; runtime/custom CSRF proof pending) | List the authenticated user's own grants and metadata; never return raw credentials or token fingerprints. |
| `POST /api/native/v1/grants/{grant_id}/revoke` | Browser only; session plus explicit CSRF/origin (source research complete; runtime/custom CSRF proof pending) | Revoke one own-user grant, with ownership validated under the grant lock. Cross-user lookup fails closed without revealing existence. |

### 3.1 Device-authorization creation

- The create endpoint is public because the native client has no user or shared secret yet. It is
  nevertheless a security-sensitive endpoint and must be rate-limited and bounded.
- The server generates a high-entropy device code and a deliberately short human code. It stores
  only digests/hashes, never the raw values. The human-code digest is keyed through the dedicated
  server key ring and accompanied by its key ID; the device-code digest is domain-separated.
- The server records the pending state, expiry, timestamps, polling metadata, and the
  **server-resolved trusted** scope/resource set. Any requested client metadata, scope, or resource
  is untrusted input to policy, not an authorization fact.
- The configured verification URI is a fixed absolute server-side value; it must not be derived
  from the request `Host` header or other untrusted input, and it must not contain the human code
  in its path, query, fragment, or redirect.
- The response must contain the raw device code once. It must not contain a grant, access token, or
  refresh token. The exact response field names and whether any lifetime metadata is returned are
  review-frozen.
- The human code is shown by the native client and entered by the user in the browser. It is not
  accepted by the token endpoint and is never sufficient to obtain tokens.

### 3.2 Fixed browser verification, approve, and deny

- These routes are browser-only. Source research is complete for the installed BetterAuth 1.7.11
  session path; runtime session behavior and a custom-route CSRF runtime proof remain pending
  (section 3.5). They must not accept native bearer credentials, trust a BFF-injected user header,
  or fall back from a missing session to a bearer.
- The browser verification URL is fixed. `GET` serves the entry page; `POST` accepts the human code
  only in the form body. The code is never placed in a path parameter, query string, fragment,
  hidden redirect, or `Location` header.
- `approve` and `deny` are state-changing. The code is posted in the body together with an
  explicit confirmation for approval. A separate custom-route CSRF mechanism and its proof remain
  undesigned/unproven; no mechanism is selected here (section 3.5).
- Code entry and consent responses require `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`; exact header composition and CSP are review-frozen. The pages
  must not load third-party scripts, frames, images, analytics, or other third-party consent
  content.
- Code-bearing POST bodies must be excluded from request-body logging, tracing, error echoes, and
  analytics. The code must not be written to logs or plaintext files. Exact redaction is a proof
  gate.
- `POST /verify` is a lookup only. It must not mutate the pending state, issue tokens, or create a
  grant. The consent view shows the actual signed-in account, the requested/server-allowed scopes,
  and any client description clearly marked as untrusted, HTML-escaped, and not identity proof.
  Approval requires an explicit confirmation.
- `approve` binds the current authenticated vendor `User.id` to the pending row. It must not accept
  a user, grant, or scope authority from the request body or headers. A pending authorization can
  be approved at most once and only while pending and unexpired. Approval locks only the pending
  row.
- The server scope allowlist is authoritative. The approval UI may show and confirm the
  server-resolved scopes/resource, but the request cannot add scopes beyond that allowlist.
- `deny` is terminal for that pending authorization and locks only the pending row. Approval is not
  token issuance; exchange still has to succeed.
- A pending authorization may be initiated by anyone and approved by a different authenticated
  user. That consent problem and the required warning are discussed in section 8. The browser
  route exists in local source but is not approved for runtime use until the consent/product UX
  and phishing-residual gate is accepted.

### 3.3 Token endpoint

- `POST /api/native/v1/token` is public in the client-authentication sense: no shared secret, Basic
  authentication, client assertion, browser session, or cookie is accepted. It is authenticated by
  a device code or refresh token in the request.
- The endpoint supports two distinct operations: a **device-code exchange** and a **refresh-token
  rotation**. The exact request discriminator and field names are not frozen; the operations must
  be distinguished explicitly and fail closed if ambiguous.
- A device-code exchange must use the high-entropy device code. A human code presented here is
  invalid. The pending authorization must be approved, unexpired, and unconsumed.
- A refresh must use a token of type `refresh`. A refresh token is never accepted as a native API
  bearer token, and an access token is never accepted for refresh. Old access tokens are not
  rotated by a normal refresh; they remain valid until their own expiry while the grant remains
  active (section 6.3).
- Raw access and refresh credentials are returned only after the successful database commit
  described in section 6. Token responses must not be cached; the exact cache-control headers are
  review-frozen.
- No token is ever accepted or returned in a URL query string, cookie, fragment, or browser
  storage under this proposal.

### 3.4 Browser grant management

- `GET /api/native/v1/grants` returns only the authenticated user's own grants. It must not return
  raw tokens, token digests/fingerprints, device codes, or another user's grant metadata.
- `POST /api/native/v1/grants/{grant_id}/revoke` revokes only an own-user grant. The route locks the
  grant, verifies ownership under that lock, and commits the revoked state. A foreign, unknown, or
  malformed grant ID must fail closed without disclosing whether it exists.
- Revocation is a browser-session-authorized operation, not a native bearer operation. The browser
  never receives a native token through this route.
- Repeated-revoke behavior and the exact response shape are review-frozen. Grant-state authority is
  described in sections 4 and 6.

### 3.5 BetterAuth 1.7.11 source findings and custom-route prerequisites (not runtime proof)

Source research is complete for the installed BetterAuth 1.7.11 package. The inspected public API
signature is:

```js
auth.api.getSession({
  headers: new Headers({ cookie: incomingCookie ?? '' }),
  query: { disableCookieCache: true, disableRefresh: true }
})
```

According to the inspected source, this path uses the authoritative stateful session store, bypasses
a cached revoked session, and avoids refresh writes; missing, expired, or revoked sessions return
`null`. This is **source inspection, not runtime proof**. Only the incoming Cookie is passed; no
identity-header or bearer fallback is allowed.

Source paths: `better-auth/dist/types/api.d.mts` (signature); `dist/api/routes/session.mjs` and
`session.d.mts` (cache bypass, `findSession`, expiry). The `originCheckMiddleware` in
`dist/api/index.mjs` is registered on BetterAuth's **own** router and does **not** protect separate
Fastify native routes. The exports expect a BetterAuth context, and no supported drop-in external
CSRF helper is established.

The custom native routes use a separate source mechanism, now implemented but not runtime-proven:
POST with `application/json`; a strictly **required** `Origin` equal to the configured canonical
public origin, rejecting missing/null/bad values; and an explicit session-bound CSRF HMAC token
validated by the API, not silently covered by BetterAuth. Forms and GET mutations are
excluded; CORS is not CSRF; the expected origin is not derived from `Host` or forwarded-header
trust. Current application foundations are `trustProxy=false` and a canonicalized public origin
only. The mechanism is implemented in source; exact production key material and runtime
validation remain gates.

## 4. Opaque credential and bearer model

### 4.1 High-entropy generation and fingerprints

- Device, access, and refresh credentials are proposed as **32 CSPRNG bytes before transport
  encoding**, encoded with base64url and parsed strictly to the expected decoded length. At least
  32 random bytes remains the security minimum; exact length and encoding details are review-frozen.
- Raw credential values are returned to the caller only in the response body. Only a
  **domain-separated SHA-256 fingerprint** is persisted for these high-entropy credentials.
  Domains are distinct by credential type and version. The exact domain labels, version strings,
  and transport-detail decisions remain proposed pending review.
- The human code is handled separately with the dedicated server key ring in section 4.2. It is
  not hashed with an unkeyed fast digest and is not a bearer credential.
- Raw device codes, access tokens, refresh tokens, and token responses must never appear in the
  database, application logs, access logs, traces, metrics, analytics, error messages, support
  bundles, or plaintext files. Request/response logging must be designed and tested for redaction.
- No raw credential is placed in a URL, query string, cookie, local/session storage, or plaintext
  client file. The native client may hold raw credentials only in memory until secure vault
  integration is validated and approved.

### 4.2 Human-code key ring and digest

- The owner selected a short human code protected by dedicated server-only key material. The
  reviewer-recommended construction is **HMAC-SHA256** with a distinct server-only secret, key IDs
  or versions, and an active/retiring key ring.
- The pending row stores the human-code HMAC digest and the key ID used to produce it. Raw human
  codes are never stored, logged, traced, or placed in a URL.
- The key material is separate from the account root, sync passphrase, session keys, and any
  content key. No actual key, dummy production key, or plaintext fallback is created by this
  document. Missing/unknown key ID or unavailable key material fails closed; there is no silent
  key guessing, default key, or production fallback.
- Rotation must either preserve unexpired pending verification with the retiring old key until
  those pending records expire, or explicitly expire those pending records. It must never silently
  strand a pending authorization or guess a key. Exact key provisioning, normalization, encoding,
  and rotation-overlap policy remain gated before human-code implementation.
- The short code is intentionally low entropy. Its security depends on the key ring, rate limits,
  expiry, uniqueness, and the browser-body controls; HMAC alone does not make a short code
  high-entropy or eliminate online guessing.

### 4.3 No JWT path

- This flow does **not** issue, parse, verify, or accept a native JWT access token.
- There is no native token signer, signing key, JWKS, issuer trust chain, JWT claim schema, or
  token-introspection claim set.
- A token string that happens to look like a JWT has no special meaning; only the opaque
  fingerprint lookup and the server-side records below are authoritative.

### 4.4 Bearer verification on every request

For every native bearer request, the server must perform all of the following, using the
authoritative primary database as the authority:

1. Accept the credential only from the native `Authorization` bearer header. Do not accept a
   cookie, query parameter, body field, or BFF user header as a fallback.
2. Validate the credential's format and bounds without treating any part as trusted data.
3. Compute its domain-separated fingerprint and look up the token record.
4. Require token type `access`, token state `active`, and token expiry later than server time.
5. Require the parent grant to exist, be `active`, be unrevoked, and be unexpired.
6. Resolve the user from the grant's vendor `User.id`; do not use a client-supplied user.
7. Resolve scopes and resource from the grant's server-recorded values. Require the route-required
   scope to be covered and the request's resource/audience to match the server-side route policy
   and configuration.
8. Reject on unknown, malformed, ambiguous, revoked, inactive, expired, wrong-type, wrong-scope,
   wrong-resource, or wrong-audience state.

The check must not be satisfied by a cookie session, an auth cache, a stale read replica, a client
header, or any token-embedded claim. The primary committed state is mandatory on every bearer
request; no cache or replica may be treated as sufficient authority for the token or grant state.

An access token whose grant has been revoked must fail even if a token row has not yet been updated.
The grant's committed state is a required authority. A refresh token, device code, or human code
presented as a bearer access token is always denied.

An in-flight request that has already passed the check before revocation commits may complete. The
design does not promise retroactive cancellation of work already authorized; subsequent checks must
deny.

## 5. Persistent model (source contract; migration 0003 prepared, not applied)

This section records the design contract. The exact Prisma schema and migration `0003` are now
prepared locally and frozen in [m1-m3-schema-contract.md](../evidence/m1-m3-schema-contract.md);
where this design text predates that contract, the ledger governs exact types, nullability, indexes,
and constraint names. Migration `0003` is **not applied**, and no PostgreSQL execution proof exists.

### 5.1 `NativePendingAuthorization`

| Field (conceptual) | Purpose / constraint |
| --- | --- |
| Internal pending identifier | Server-generated identifier; exact type/format review-frozen |
| Device-code digest | Unique domain-separated SHA-256 digest of the high-entropy device code; raw code never stored |
| Human-code digest | Unique HMAC-SHA256 digest of the short human code; raw code never stored |
| Human-code key ID | Key ID/version used for the HMAC digest; required for verification and rotation |
| State | `pending`, `approved`, `denied`, `consumed`, or `expired` |
| Expiry | Server-side expiry; expired pending records fail closed |
| Timestamps | Creation, approval, denial, and consumption timestamps as applicable |
| Trusted scopes | Server-resolved scope set from the configured allowlist; never a raw client value |
| Trusted resource | Server-resolved resource; exact representation review-frozen |
| Polling state | Server-side poll/too-fast/backoff metadata; exact fields review-frozen |
| Approved user | Nullable until approval; vendor `User.id` **String** FK to BetterAuth's `User.id` |

The pending row contains no access or refresh token. Approval populates the user reference and
moves the state to `approved`. Exchange consumes the row exactly once. The human-code digest and key
ID are stored together so rotation can identify which key verifies the row.

### 5.2 `NativeDeviceGrant`

| Field (conceptual) | Purpose / constraint |
| --- | --- |
| Grant identifier | Server-generated opaque ID, primary key; exact format review-frozen |
| User | Vendor `User.id` **String** FK; one grant belongs to one user |
| State | `active` or `revoked` |
| Timestamps | Creation and revocation timestamps; additional metadata review-frozen |
| Scopes | Server-resolved scopes copied from the approved pending row |
| Resource | Server-resolved resource copied from the approved pending row |
| Expiry | Absolute grant expiry; checked on every bearer and refresh operation |

Each approval that successfully exchanges creates a **distinct grant**. Two approvals by the same
browser user produce independent grants and independent token chains; there is no deduplication by
browser session, user, or client.

### 5.3 `NativeGrantToken`

| Field (conceptual) | Purpose / constraint |
| --- | --- |
| Internal token identifier | Server-generated identifier; not a credential |
| Grant | FK to `NativeDeviceGrant` |
| Type | `access` or `refresh` |
| Fingerprint | Unique domain-separated SHA-256 digest of the raw credential; raw value never stored |
| Expiry | Server-side expiry; must not exceed the grant expiry |
| State | `active`, `rotated`, or `revoked` |
| Replacement token | Nullable self-reference to the replacement token in a rotation chain |
| Timestamps | Creation and rotation/revocation timestamps as applicable |

Spent/rotated refresh fingerprints are retained so replay can be detected. **Retention requirement:**
spent refresh records are kept for at least the entire period in which the grant can still be used,
and must not be cleaned up while the grant is active or the record remains replay-relevant. Final
archival and cleanup policy remains an open gate. Old access tokens are not rotated by a normal
refresh; they remain valid until their own expiry, subject to the grant active check.

### 5.4 Constraints, indexes, and state integrity

- Unique constraints are proposed for the device-code digest, human-code digest, and token
  fingerprint. Exact constraint scope and migration representation are review-frozen.
- State values are restricted to the enums listed above; arbitrary state strings must not be
  accepted at the application or database boundary. Exact enum/check representation is
  review-frozen.
- A token's expiry must not exceed its grant's expiry. This invariant must hold at creation and
  rotation; it should be enforced by database constraint where feasible and by transaction
  invariant otherwise.
- Indexed lookup and expiry access is proposed for the device-code digest, human-code digest,
  token fingerprint, grant/user relationship, pending state/expiry, and grant state/expiry. Exact
  index definitions remain review-frozen.
- What happens to active grants and token records when the vendor user is disabled or deleted is
  **not decided**. It must be frozen in review, including whether grants fail closed immediately.
  No cascade, deletion, or retention behavior is guessed here.
- No raw code, token, or reversible credential encoding is stored. Final archival/cleanup bounds
  for spent refresh records and expired access records remain open gates.

### 5.5 Vendor and business boundaries

- BetterAuth's pinned **13-model vendor auth schema is unchanged**. No vendor field is added,
  removed, or repurposed by this design.
- The existing vendor device/OAuth-provider tables are not used by this native flow initially. The
  design does not rely on their contents. Their routes/tables must not be accidentally enabled by
  native mounting or configuration; explicit disabling/isolation remains a production review gate.
- The business `Device` model is now implemented in prepared source per the
  [M1–M3 contract](../evidence/m1-m3-schema-contract.md): `grantID` is a required, unique FK to
  `NativeDeviceGrant`, with no device status/name/revocation column; active state comes from the
  grant. The vendor `User.id` remains a **String**; native/business FKs use that type and are
  `ON DELETE RESTRICT`.
- No vendor column/table is altered. Native tables live in the prepared `0003` migration; it is
  **not applied** and creates no vendor-schema change.

## 6. Flow and transaction semantics

The flow below is implemented in local repository/service source, but no runtime transaction,
PostgreSQL concurrency, or security acceptance is proven. The transaction boundaries remain the
reviewed source contract, not live-database evidence.

### 6.1 Create, browser verification, and approve/deny

1. The native client calls the public create endpoint and receives the raw device code, short human
   code, fixed verification URI, and configured poll interval.
2. The server creates a pending record with only code digests, the human-code key ID,
   server-resolved scopes/resource, expiry, and polling metadata.
3. The browser authenticates through BetterAuth/GitHub, opens the fixed verification URL, submits
   the human code in a POST body, and sees the consent view. No code is placed in the URL or a
   redirect.
4. Approval locks only the pending row, rechecks `pending` and unexpired state, binds the current
   vendor user under the server scope allowlist, and commits `approved`. A second approval or a
   deny after approval fails closed. Denial commits `denied`; no grant or token can be created
   afterward.
5. No grant lock is taken for approve/deny because no grant exists. No transaction locks a pending
   row and an existing grant row together.
6. No vendor write occurs. Approval reads the browser session and writes only native state. There
   is no transaction spanning BetterAuth session state and native tables, so no cross-store
   atomicity is claimed.

### 6.2 Device-code exchange

Proposed transaction outline:

```text
exchange(device_code):
  BEGIN
  lock pending row identified by device-code digest
  require state = approved
  require unexpired and not consumed
  mark pending consumed
  insert NativeDeviceGrant for approved_user_id with trusted scopes/resource, active
  generate raw access and refresh credentials
  insert separate NativeGrantToken rows with domain-separated digests, types, expiries, active
  COMMIT
  return raw access and refresh credentials to the caller
```

- Only digests are persisted. Raw credentials are returned only after a successful commit.
- Exchange locks only the pending row. It creates the new grant and both token rows in the same
  transaction; it does not lock an existing grant because none exists yet.
- A crash or error before commit rolls back: no grant, no token, and no partial state exists. The
  pending row remains approved, so a bounded retry before expiry is possible.
- A crash, failure, or lost response **after** commit leaves a live grant/token chain whose raw
  credentials may be irretrievably lost. The device code is consumed. Recovery is reauthorization,
  not reuse of the code or a cached response.
- Two approvals by the same browser user, from two pending rows, create two independent grants.
  Revocation of one must not revoke the other.
- No occurrence of this flow writes vendor records, so no atomicity with a vendor write is claimed.

### 6.3 Refresh and replay

Proposed transaction and lock sequence:

```text
refresh(refresh_token):
  fp = fingerprint(refresh_token)
  pre = pre-read token row by fp to obtain grant_id   # no lock, no authority
  if pre missing: return invalid credential

  BEGIN
  g = lock grant by pre.grant_id
  t = lock refresh-token row by fp
  revalidate t.grant_id == g.id                       # pre-read was only a hint

  if t.state == rotated/spent:
      mark g revoked
      COMMIT
      return replay_error_outside_transaction        # do not throw/rollback after commit

  require g active and unexpired
  require t.type = refresh, t.state = active, t unexpired
  mark t rotated; link replacement
  insert new access and refresh records with domain-separated digests
  COMMIT
  return new raw access and refresh credentials
```

- The lock order is fixed: **grant before refresh token**. The pre-read only locates the grant and
  carries no authority; the token/grant relationship is revalidated under both locks.
- A replay of a rotated/spent refresh fingerprint commits revocation of the entire grant, then
  returns the replay error **after commit**. The error must not be thrown from inside the
  transaction in a way that rolls the revocation back. No new credentials are issued.
- If revalidation shows the token does not belong to the grant, the transaction fails closed
  without revoking an unrelated grant.
- Refresh tokens rotate. Old refresh fingerprints are retained as spent records with their
  replacement links.
- There is **no refresh reuse grace window**. A duplicate/concurrent refresh that presents a spent
  fingerprint is treated as replay under this contract; the native client must single-flight. The
  transaction proof must establish this behavior explicitly.
- If a refresh response is lost after commit, the old token is already spent; retrying it is
  indistinguishable from replay and must not be used as recovery. The client must reauthorize. No
  plaintext response caching or temporary credential file is allowed.
- **Old access tokens remain valid until their own expiry, subject to the grant active check.**
  Normal refresh does not rotate or revoke them. Replay revocation or browser revocation makes
  them unusable immediately because the grant check fails.
- A refresh token presented as an access bearer is denied. Whether other token-type misuse also
  triggers grant revocation remains an explicit review question; this document does not invent
  that behavior.

### 6.4 Revocation

1. The browser calls the own-user revoke endpoint with a valid browser session and explicit
   CSRF/origin checks.
2. The server locks the grant, verifies own-user ownership **under the same lock**, marks it
   `revoked`, and commits.
3. Every subsequent bearer check must reject the grant because its committed primary-database state
   is no longer `active`. Token-level state may also be updated, but the grant state is mandatory
   authority.
4. Revocation and refresh serialize on the grant lock. If refresh wins first, revocation still
   revokes the grant and its newly minted token chain. If revocation wins first, refresh fails. Old
   access tokens remain unusable because the grant check fails.
5. A request that already passed its check before revocation commits may complete. There is no
   retroactive cancellation guarantee for in-flight work already authorized.
6. No vendor write or cross-store atomicity is involved or claimed.
7. The authorization decision must use the primary committed state; no auth cache or stale replica
   may delay revocation.

### 6.5 State and failure semantics

Pending-authorization states:

| Current state | Event | Required result |
| --- | --- | --- |
| `pending` | Exchange/poll | Remain pending; no tokens |
| `pending` | Approve | Become `approved` once; bind vendor user |
| `pending` | Deny | Become `denied`; terminal |
| `pending` | Expiry reached | Become `expired`; terminal |
| `approved` | Exchange | Become `consumed`; create one grant and token chain atomically |
| `approved` | Expiry reached | Become `expired`; exchange fails |
| `denied` | Exchange/approve/deny | Distinct denied failure; no tokens; no state change |
| `expired` | Exchange/approve/deny | Distinct expired failure; no tokens |
| `consumed` | Exchange again | Distinct consumed failure; no tokens |
| Any state | Poll faster than allowed | Distinct too-fast/slow-down failure; no tokens |
| Any state | Unknown or malformed code | Uniform fail-closed denial; no token/grant |
| Non-pending | Approve or deny | State conflict; no binding or token |

Failure rules:

- A failure must never create a grant, token, or partial token chain.
- Replay of a spent refresh is the failure path that mutates state: it commits grant revocation,
  then returns the replay error outside that transaction.
- Denied, expired, consumed, too-fast, wrong-type, wrong-scope, wrong-resource, and unknown failures
  must be distinguishable where needed for correct client behavior, without leaking raw credentials
  or another user's data. Exact error codes/statuses remain review-frozen.
- If authorization state is ambiguous or a required check cannot be completed, fail closed.

### 6.6 Crash, lost responses, and vendor atomicity

- Before commit: transaction rollback; there is no partial grant/token chain. A bounded retry
  remains possible until the pending authorization expires.
- After commit, before the response reaches the client: the grant/token chain exists and only
  digests are stored. Raw credentials are unrecoverable; the flow requires reauthorization.
- The replay path commits revocation before returning its error. That committed revocation is not
  rolled back by the error path.
- No plaintext response cache, grace period, replay window, or temporary file may be used to
  compensate for a lost response.
- The flow performs no vendor writes. There is no claim of atomicity between native state and
  BetterAuth session state, GitHub identity state, or any business record.

### 6.7 Locking and authoritative state

- Approve and deny lock only the pending row.
- Exchange locks only the pending row and creates the grant and token rows atomically. It does not
  lock an existing grant because none exists.
- Refresh follows the fixed pre-read, grant-lock, token-lock, revalidate sequence described in
  section 6.3.
- Browser revoke locks only the grant and validates own-user ownership under that lock.
- Refresh and revoke serialize on the grant. There is no transaction that locks an existing pending
  row and an existing grant row together, so there is no pending-plus-grant ordering to define.
- Replay commits grant revocation and then returns its error outside the transaction; the error
  path must not roll back the committed revocation.
- The authoritative decision is the primary committed state. No auth cache or stale replica is
  allowed. A request that passed its check before revocation may finish; later checks deny.
- The planned proof matrix must exercise these fixed sequences under concurrency. This document is
  a design claim, not implementation or PostgreSQL proof.

## 7. Configuration, brute-force controls, and code protection

### 7.1 Required operator-approved configuration

No production values are proposed here. Every setting below must be supplied as an explicit,
bounded, operator-approved configuration; missing, malformed, or ambiguous configuration fails
closed. Values from the V1 archive or unrelated local profiles are **not** inherited defaults.

| Configuration area | What review must freeze |
| --- | --- |
| Origin and transport | Canonical public origin, TLS termination/validation, HTTPS enforcement, trusted browser origin(s) for CSRF/origin checks, fixed absolute verification URL with no human code in URI/path/query/fragment/redirect, and a rule that security decisions never use the request `Host` header. No wildcard origin. |
| Browser code handling | Code only in POST body; `no-store` and `no-referrer`; no third-party consent content; body/error/log redaction; no code in redirects; consent page account/scopes/client-description behavior. |
| Human-code key ring | Key IDs/versions, active/retiring ring, provisioning and secure storage, rotation overlap/expiry behavior, and fail-closed handling for missing/unknown keys. No dummy key, default key, or production fallback. |
| Scopes and resource | Exact allowed scope set, which scopes are required by each native route, trusted resource identifier(s), and how approval narrows/confirms the server-resolved set. |
| Audience | Exact audience value(s) and the route policy that checks them from server-side data, not token claims. |
| Lifetimes | Pending/device-code lifetime, access lifetime, refresh lifetime, grant lifetime, and their required ordering/relationship, including token expiry not exceeding grant expiry. No production TTLs are chosen here. |
| Polling and backoff | Poll interval, too-fast detection, slow-down/backoff schedule, retry bounds, and rate limits. |
| Rate limits | Creation, browser verification/lookup, human-code lookup, approve, deny, token exchange, refresh, grant list, and revoke limits; dimensions (per code, per user, per source, global), burst, window, and response behavior. |
| Capacity | Maximum outstanding pending authorizations and maximum active grants per user, plus retention bounds for pending and spent token records. |
| Credential format | The 32-CSPRNG-byte base64url and domain-separated SHA-256 proposal; exact length policy, strict parsing, digest domain labels/version strings, and transport details remain review-frozen. |
| BetterAuth integration | Source research is complete for the installed BetterAuth 1.7.11 session path; runtime session behavior and a separate custom-route CSRF runtime proof remain pending (section 3.5). Routes exist in local source, but no route is approved for runtime use from source findings alone. |
| Logging and audit | Which metadata may be logged, retention, redaction verification for code-bearing bodies, and security-event handling for replay, repeated failures, and revocation. |

The design does not choose production TTLs, grant caps, poll intervals, rate limits, scope names,
audience values, resource values, or verification URLs.

### 7.2 Brute-force and guessing controls

- **Creation** must be rate-limited and capacity-bounded to limit code-table exhaustion and
  resource abuse.
- **Polling/exchange** must enforce a minimum interval, detect too-fast polls distinctly, and apply
  per-code and source-based limits. The high-entropy device code reduces online guessing, but the
  endpoint still needs bounded attempts and safe logging.
- **Human-code lookup, verification, and approval** must be rate-limited against guessing and
  failed approval attempts. A short code is low entropy by design; HMAC keying, rate limits,
  expiry, uniqueness, and safe storage are essential.
- **Failed approvals** must not reveal another user's data and must be subject to rate limits and
  audit. The exact lockout/window behavior is a review requirement.
- These controls are **requirements**, not implemented protections. No threshold or algorithm is
  approved here.

### 7.3 Human-code key direction and rotation

The owner selected the **short human code + dedicated server-only key** direction. The
reviewer-recommended construction is:

- **HMAC-SHA256** over the normalized short code, using a distinct server-only secret.
- Key IDs/versions and an active/retiring key ring; the pending row stores the digest and the key
  ID used.
- No secret is generated, committed, or documented here. There is no dummy production key, default
  key, environment fallback, or plaintext fallback. Missing key material fails closed.
- The key is distinct from the account root, sync passphrase, session keys, and content keys. It is
  not the account root.
- Rotation must preserve unexpired pending verification with the retiring old key or explicitly
  expire those pending records. It must never silently strand a pending authorization or guess a
  key. No raw codes are persisted.
- Exact entropy/length/alphabet, normalization, encoding, key provisioning/secure storage, and
  rotation-overlap policy remain **gated before human-code implementation**. This section records a
  direction, not an approved production construction.

The device code remains the high-entropy exchange credential; the human code only supports browser
lookup/approval. That separation limits what a guessed human code can do, but it does not resolve
offline guessing, online approval attacks, or wrong-user consent.

## 8. Consent, browser handling, and unresolved decisions

### 8.1 Wrong-user approval and consent

The human code is **intentionally transferable**. The actual approving account becomes the grant
owner. The initiator can be a different person, and possession of a code is **not ownership proof**
or proof that the initiator is the account owner.

Proposed plain-language warning:

> **Approve only a request you started in OpenCode. Anyone who gave you this code may receive
> access to your account.**

The consent view must show:

- the actual signed-in account identity;
- the requested/server-allowed scopes;
- any client description, clearly marked as untrusted, HTML-escaped, and not identity proof; and
- an explicit confirmation action before approval.

This warning is proposed. It is **not** a claim that phishing is defeated, that users will read it,
or that the owner has approved the transferability risk. The design does not infer or approve any
binding between a malicious initiator and the approver's account; no such binding is proposed.
Per-user/initiator ownership before approval remains unresolved. The residual phishing/product UX
acceptance gate must be satisfied before routes are implemented.

### 8.2 Browser body handling

- The user code is submitted only in a POST body on a fixed verification URL. It must not appear in
  a path, query string, fragment, redirect, or `Location` header.
- Code-bearing responses require `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
  Exact header composition/CSP is review-frozen.
- The verification and consent pages must contain no third-party scripts, frames, images,
  analytics, or other third-party consent content.
- Code-bearing POST bodies, errors, traces, and analytics must be redacted; the code must not be
  logged or persisted. Exact redaction and tests are proof gates.
- These are proposed controls, not implemented evidence. No claim is made that the browser,
  extensions, proxies, or deployment logging cannot observe the code.

### 8.3 Unresolved specification and proof items

| ID | Missing decision or proof | Why it matters |
| --- | --- | --- |
| U-1 | Consent UX/product acceptance, wrong-user approval, phishing residual, and per-user/initiator ownership | Human-code approval makes the approver the owner; code possession is not ownership proof. This remains a gate before routes. |
| U-2 | Short-code entropy/length/alphabet, normalization, encoding, key provisioning/secure storage, and rotation-overlap policy | The HMAC direction is recorded, but production key handling and exact code policy are not approved. |
| U-3 | Exact high-entropy token digest domain labels/version strings and transport-detail approval | The 32-byte/base64url/SHA-256 proposal is not a production approval. |
| U-4 | Exact HTTP wire/status/error/cache contract; runtime validation of the source-researched BetterAuth session path; separate custom-route CSRF runtime proof | Source research is complete and a session-bound custom-route CSRF mechanism is implemented in local source, but runtime session behavior and CSRF behavior remain unproven. |
| U-5 | Scope, resource, and audience model, including approval narrowing and route policy | Prevents client-supplied scope/resource from becoming authority. |
| U-6 | Implementation proof of the fixed lock and replay sequences, including replay revocation outside the transaction | The design choice is fixed, but no PostgreSQL/concurrency evidence exists. |
| U-7 | Vendor user disable/delete behavior and token-row revocation vs grant-state cleanup | Fail-closed account-state behavior is not decided; no cascade is guessed. |
| U-8 | Grant/access/refresh lifetimes, poll/backoff, rate limits, and capacity bounds | No production defaults may be assumed; all require operator approval. |
| U-9 | Replay-record retention/archival/cleanup and expired access-token cleanup | Spent refresh records must cover the usable grant period; final archival policy is open. |
| U-10 | Native vault selection and storage lifecycle | No new client credential storage is authorized before validation; failure must be fail-closed. |
| U-11 | Business `Device` linkage and any future device identity model | No separate Device entity or business FK is approved; the unfreeze decision is separate. |
| U-12 | Whether unused vendor device/OAuth routes/tables must be disabled or isolated | They are unused by this flow initially, but must not be accidentally enabled. |
| U-13 | Proof of browser body/header/log/third-party controls | The fixed URL and body-only rule are designed, but no runtime redaction or browser proof exists. |

## 9. Planned proof matrix (not run)

This matrix remains the required acceptance evidence for the PostgreSQL security/concurrency proof
node. **No row is accepted and no live PostgreSQL/runtime proof exists.** Local route/repository
synthetic tests and a prepared migration exist, but they do not satisfy this matrix or substitute for
independent security review. Proof prerequisite: P-08
requires runtime validation of the section 3.5 session path and the separate custom-route CSRF
runtime proof; source findings alone do not satisfy it.

| ID | Scenario | Required outcome |
| --- | --- | --- |
| P-01 | Two pending authorizations approved by the same browser user, then exchanged | Two distinct grants; independent token chains; no deduplication by session/user |
| P-02 | Revoke one of the two grants | Only that grant and its tokens fail; the other grant remains usable |
| P-03 | Approve/deny/exchange race on one pending authorization | At most one terminal transition; at most one grant; all losing paths fail closed |
| P-04 | Unknown, malformed, expired, or revoked access token | Denied; no fallback to a cookie, cache, replica, or another principal |
| P-05 | Refresh token presented as bearer access; access token presented at refresh | Denied by type; no grant/token creation |
| P-06 | Insufficient scope, wrong resource, or wrong audience | Denied; server-side scope/resource/audience policy is authoritative |
| P-07 | Forged foreign grant ID, user, scopes, or resource in headers/body | No effect; only server records and session identity decide |
| P-08 | Missing/expired browser session, missing CSRF, or bad origin on verify/approve/deny/list/revoke | Denied; no state change; requires the separate custom-route session/CSRF proof described in section 3.5 |
| P-09 | Cross-user grant list/revoke | Own-user scope only; no existence disclosure |
| P-10 | Device-code reuse after exchange | Denied as consumed; no second grant |
| P-11 | Expired, denied, consumed, and too-fast poll states | Distinct fail-closed outcomes; no tokens where forbidden |
| P-12 | Human-code guessing and repeated failed approvals | Bounded by the reviewed rate/lockout controls; no data leak |
| P-13 | Concurrent exchange of the same device code | Exactly one grant/token chain; loser fails closed |
| P-14 | Concurrent/duplicate refresh with one refresh token | One rotation chain; a spent-fingerprint presentation triggers replay revocation; exact proof must match the fixed sequence |
| P-15 | Replay of an old refresh token after rotation | Grant revocation committed; replay error returned outside the transaction; all subsequent bearer checks fail |
| P-16 | Lost exchange or refresh response after commit | No plaintext recovery; client must reauthorize; no cache/grace reuse |
| P-17 | Revoke vs refresh concurrency | Serialized on the grant lock; no bearer credential remains usable after a committed revocation, even if a token row was not updated |
| P-18 | Revocation after a bearer check has passed | In-flight work may finish, but the next check denies; documented non-retroactivity |
| P-19 | Crash/failure before exchange or refresh commit | No partial grant/token chain; transaction rollback; pending state remains consistent |
| P-20 | Raw-code/token leakage scan | No raw device code, human code, access token, refresh token, or token response in DB, logs, traces, metrics, files, errors, or URLs; only digests |
| P-21 | Cookie/bearer separation | A cookie alone never authenticates a native bearer route; a native bearer never authenticates a browser-only route; no fallback |
| P-22 | Expiry and state enforcement | Expired grant, expired/rotated/revoked token, inactive grant, and wrong token type all deny |
| P-23 | Browser code handling | Human code appears only in POST bodies; fixed verification URL has no code; no code in redirects; `no-store`/`no-referrer`; no third-party consent content; body/log redaction |
| P-24 | Human-code key rotation | Pending rows under a retiring key still verify until expiry or are explicitly expired; unknown/missing key ID fails closed; no key guessing or fallback; no raw code persisted |
| P-25 | Old access token after normal refresh | Old access remains valid until its own expiry while the grant is active; it fails after expiry, grant revocation, or replay revocation |
| P-26 | Schema/index integrity | Unique code digests and token fingerprints, valid enum/state values, token expiry not exceeding grant expiry, and indexed lookup/expiry paths hold under the reviewed schema |
| P-27 | Primary-state enforcement | Bearer and revoke checks use committed primary state; no auth cache or stale replica satisfies them |

Wrong-user approval is also a required review case: the evidence must show that approval by a
different authenticated user binds that approver as the grant user, that the actual account,
scopes, warning, and escaped/untrusted client description are shown, that explicit confirmation is
required, and that no code assumes the initiator and approver are the same. It is not sufficient to
test only the happy path where one user initiates and approves.

The matrix must be run in the dedicated synthetic PostgreSQL proof stage against the reviewed
schema and transaction boundaries. It must not be reported as a real PostgreSQL integration,
deployment, production security review, or auth-enablement evidence.

## 10. Bounded implementation graph (source nodes implemented; later nodes gated)

Under the 2026-10-20 source approval, the source nodes below are implemented locally:
credential/config primitives, native repository/schema migration preparation, and native/browser
routes. The PostgreSQL proof, vault/OS integration, and auth enablement are **not** accepted. The
bounded sequence remains:

1. **Review and freeze** the HTTP contract, schema, configuration bounds, consent/product UX, and
   the source-researched session integration plan — the bounded source contract was frozen
   2026-10-20; runtime session validation and custom-route CSRF runtime proof remain prerequisites.
2. **Hashing/config primitive** — implemented in local source: credential generation, keyed
   human-code hashing/key-ring handling, fingerprinting, and configuration validation; no production
   secret.
3. **Native repository and schema migrations** — repository source and `0003` are prepared; the
   migration is **not applied** by this document or lane.
4. **Native routes** — implemented in local source behind explicit authentication/CSRF/origin rules.
   Runtime use remains blocked by the consent/phishing product-UX gate, runtime session validation,
   and custom-route CSRF runtime proof.
5. **PostgreSQL synthetic security/concurrency proof** — execute the planned matrix above against
   the reviewed schema and transaction boundaries.
6. **Native vault integration** — only after secure storage is selected, validated, and approved;
   failure must fail closed with no plaintext fallback.
7. **Auth enablement** — only after separate review and recorded evidence. Design acceptance or a
   proof run does not itself enable auth.

No runtime node above is authorized by source approval. Routes and schema exist as local source,
but migration `0003` has **not** been applied and auth/storage enablement is not approved. HOST-01 and
the cloud crypto work remain unrelated gates: this redesign neither passes nor relaxes HOST-01,
CRYPTO-01, STORE-01/02, SYNC-01–04, or any other gate. Native-client storage for credentials
remains blocked until the secure vault is validated; there is no plaintext fallback.

## 11. Crosslinks and preserved status

- [SECURITY.md](SECURITY.md) §5–§6 and §10: older vault/auth draft with the JWT/vendor-device-provider
  contract and AUTH-01/AUTH-02 gates. It has not been reconciled by this document; formal
  documentation reconciliation remains open.
- [API_AND_DATA.md](API_AND_DATA.md) §1/§3: updated to record the current opaque native/browser
  principal split and endpoint statuses. §4.2/§6 remain planned data-model material.
- [ARCHITECTURE.md](ARCHITECTURE.md) §3, §6, and §9: local source components, deployment topology,
  and gate index. This flow does not alter the repository layout.
- [ROADMAP.md](ROADMAP.md) AUTH-01, AUTH-02, AUTH-03, WEB-01, API-01/API-02: statuses are reconciled
  to local source vs runtime acceptance; no task is marked complete or unblocked by source approval.
- [auth-schema-generation.md](../evidence/auth-schema-generation.md): provenance for the unchanged
  pinned 13-model vendor auth schema. The vendor schema is unchanged; `0003` is prepared, not applied.
- [README.md](README.md): this file is not added to the nine-document index, but the index now records
  the bounded source reconciliation.

Current actuals: local source modules, nine native methods, four browser routes, and prepared
migration `0003` exist; the migration is **not applied**, no real database/runtime proof exists, no
auth is enabled, no production parameters are selected, and no actual human-code key or secret is
claimed. HOST-01 and cloud crypto remain gated. The unused vendor device/OAuth routes must not be
treated as enabled by this design.

## 12. Review disposition

**SOURCE CONTRACT APPROVED 2026-10-20; RUNTIME ACCEPTANCE PENDING.** The initial ora6 outcome was
**REVISE**. Later Ora9 Phase 1 approved the bounded source contract only; it did not accept runtime
routes, live schema behavior, CSRF, vault, OAuth, consent UX, or production configuration. The
remaining review must:

- return an explicit disposition (accept, reject, or revise with reasons);
- verify the documentation corrections in section 0.1 against the body and confirm no contradictory
  old contract remains;
- resolve or explicitly defer every unresolved item in section 8.3, especially consent/phishing,
  short-code key provisioning/rotation, exact token-digest details, the BetterAuth session
  runtime/CSRF proof, user disable/delete behavior, retention/archival, and configuration bounds;
- reconcile the remaining JWT/vendor acceptance text in documentation; and
- authorize each remaining runtime/vault/enablement node separately. Even a favorable security
  review is not runtime acceptance or auth enablement.

The residual phishing/product UX acceptance gate remains open. No live runtime, database, migration
application, or PostgreSQL proof is claimed.

---

*Document control: design transcription from the completed ora5 input, revised for the ora6 REVISE
findings and reconciled on 2026-10-20 with the bounded source approval. Local source and synthetic
tests exist; no live database, deployment, OAuth/CSRF/vault runtime, or auth enablement proof exists.
No production key generation or secret handling is claimed. Status: SOURCE CONTRACT APPROVED —
RUNTIME ACCEPTANCE UNPROVEN.*
