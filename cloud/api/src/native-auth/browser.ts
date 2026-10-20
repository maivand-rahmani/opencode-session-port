/**
 * Browser-only BetterAuth runtime for native-auth browser sessions.
 *
 * Importing this module constructs nothing. `createBrowserAuth` dynamically
 * loads BetterAuth and the Prisma adapter, builds a GitHub-only browser auth
 * instance with no vendor plugins, and returns a small structural authority for
 * browser routes and the website.
 *
 * Session reads pass only a Cookie header, in a fresh `Headers` object, and
 * explicitly disable cookie caching and refresh. A returned session is read
 * from the authoritative BetterAuth state, checked for a matching user and
 * unexpired expiry, and reduced to safe fields. No bearer fallback exists.
 * Provider errors and malformed provider results are replaced by a fixed
 * `BrowserAuthError`; a genuinely missing session remains `null`.
 */

import type { PrismaClient } from '../../prisma/generated/client/client.js';

export const BROWSER_AUTH_BASE_PATH = '/api/auth';

const MAX_COOKIE_BYTES = 8192;
const MAX_AUTHORITY_ID_BYTES = 1024;
const MAX_NAME_LENGTH = 256;
const MAX_EMAIL_LENGTH = 320;
const MAX_SECRET_BYTES = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface BrowserAuthConfig {
  readonly publicOrigin: string;
  readonly allowLoopbackHttp?: boolean;
  readonly betterAuth: {
    readonly secret: string;
    readonly github: {
      readonly clientID: string;
      readonly clientSecret: string;
    };
  };
}

export interface BrowserAuthProviderOptions {
  readonly baseURL: string;
  readonly basePath: typeof BROWSER_AUTH_BASE_PATH;
  readonly secret: string;
  readonly trustedOrigins: readonly string[];
  readonly database: PrismaClient;
  readonly socialProviders: {
    readonly github: {
      readonly clientId: string;
      readonly clientSecret: string;
    };
  };
  readonly plugins: readonly never[];
  readonly emailAndPassword: {
    readonly enabled: false;
  };
  readonly logger: {
    readonly disabled: true;
  };
}

export interface BrowserAuthSessionQuery {
  readonly disableCookieCache: true;
  readonly disableRefresh: true;
}

export interface BrowserAuthProvider {
  readonly handler: (request: Request) => Promise<Response>;
  readonly api: {
    readonly getSession: (input: {
      readonly headers: Headers;
      readonly query: BrowserAuthSessionQuery;
    }) => Promise<unknown>;
  };
}

export type BrowserAuthProviderFactory = (
  options: BrowserAuthProviderOptions,
) => BrowserAuthProvider | Promise<BrowserAuthProvider>;

export interface BrowserAuthFactoryOptions {
  /**
   * Focused-test injection point. Production callers omit this and use the
   * pinned BetterAuth + Prisma adapter runtime.
   */
  readonly providerFactory?: BrowserAuthProviderFactory;
  /** Injected clock for deterministic session-expiry checks. */
  readonly now?: () => Date;
}

export interface BrowserSession {
  readonly sessionID: string;
  readonly userID: string;
  readonly name?: string;
  readonly email?: string;
  readonly expiresAt: Date;
}

export interface BrowserSessionAuthority {
  readonly readSession: (
    cookie: string,
  ) => Promise<BrowserSession | null>;
  readonly handle: (request: Request) => Promise<Response>;
}

export class BrowserAuthError extends Error {
  readonly code = 'browser-auth-unavailable';

  constructor() {
    super('Browser authentication is unavailable.');
    this.name = 'BrowserAuthError';
  }
}

/**
 * Build the browser session authority.
 *
 * `prisma` must be the generated Prisma 7 client or an equivalent client the
 * installed Prisma adapter accepts. It is not connected or queried here.
 */
export async function createBrowserAuth(
  config: BrowserAuthConfig,
  prisma: PrismaClient,
  options: BrowserAuthFactoryOptions = {},
): Promise<BrowserSessionAuthority> {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new BrowserAuthError();
  }

  const providerOptions = readBrowserProviderOptions(config, prisma);
  const now = readClock(options.now);

  if (
    options.providerFactory !== undefined &&
    typeof options.providerFactory !== 'function'
  ) {
    throw new BrowserAuthError();
  }

  let provider: BrowserAuthProvider;
  try {
    const factory =
      options.providerFactory ?? defaultBrowserAuthProviderFactory;
    provider = readProvider(await factory(providerOptions));
  } catch {
    throw new BrowserAuthError();
  }

  const readSession = async (
    cookie: string,
  ): Promise<BrowserSession | null> => {
    const cookieValue = readCookie(cookie);
    if (cookieValue === null) {
      return null;
    }

    let raw: unknown;
    try {
      const headers = new Headers({ cookie: cookieValue });
      raw = await provider.api.getSession({
        headers,
        query: {
          disableCookieCache: true,
          disableRefresh: true,
        },
      });
    } catch {
      throw new BrowserAuthError();
    }

    return parseBrowserSession(raw, now);
  };

  const handle = async (request: Request): Promise<Response> => {
    if (!(request instanceof Request)) {
      throw new BrowserAuthError();
    }

    try {
      const response = await provider.handler(request);
      if (!(response instanceof Response)) {
        throw new BrowserAuthError();
      }
      return response;
    } catch (error) {
      if (error instanceof BrowserAuthError) {
        throw error;
      }
      throw new BrowserAuthError();
    }
  };

  return Object.freeze({ readSession, handle });
}

function readBrowserProviderOptions(
  config: BrowserAuthConfig,
  prisma: PrismaClient,
): BrowserAuthProviderOptions {
  if (
    typeof config !== 'object' ||
    config === null ||
    typeof prisma !== 'object' ||
    prisma === null ||
    typeof config.publicOrigin !== 'string' ||
    (config.allowLoopbackHttp !== undefined &&
      typeof config.allowLoopbackHttp !== 'boolean') ||
    !isCanonicalOrigin(
      config.publicOrigin,
      config.allowLoopbackHttp === true,
    ) ||
    typeof config.betterAuth !== 'object' ||
    config.betterAuth === null
  ) {
    throw new BrowserAuthError();
  }

  const secret = readRequiredSecret(
    config.betterAuth.secret,
    false,
  );
  const github = config.betterAuth.github;
  if (typeof github !== 'object' || github === null) {
    throw new BrowserAuthError();
  }
  const clientID = readRequiredSecret(github.clientID, true);
  const clientSecret = readRequiredSecret(github.clientSecret, true);

  return Object.freeze({
    baseURL: config.publicOrigin,
    basePath: BROWSER_AUTH_BASE_PATH,
    secret,
    trustedOrigins: Object.freeze([config.publicOrigin]),
    database: prisma,
    socialProviders: Object.freeze({
      github: Object.freeze({
        clientId: clientID,
        clientSecret,
      }),
    }),
    plugins: Object.freeze([]),
    emailAndPassword: Object.freeze({ enabled: false }),
    logger: Object.freeze({ disabled: true }),
  });
}

function readRequiredSecret(value: unknown, allowShorter: boolean): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES ||
    (!allowShorter && Buffer.byteLength(value, 'utf8') < 32)
  ) {
    throw new BrowserAuthError();
  }
  return value;
}

function readClock(clock: (() => Date) | undefined): () => Date {
  if (clock === undefined) {
    return () => new Date();
  }
  if (typeof clock !== 'function') {
    throw new BrowserAuthError();
  }
  return () => {
    let value: unknown;
    try {
      value = clock();
    } catch {
      throw new BrowserAuthError();
    }
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new BrowserAuthError();
    }
    return new Date(value.getTime());
  };
}

function readCookie(cookie: string): string | null {
  if (typeof cookie !== 'string') {
    throw new BrowserAuthError();
  }
  if (cookie.length === 0) {
    return null;
  }
  if (
    Buffer.byteLength(cookie, 'utf8') > MAX_COOKIE_BYTES ||
    CONTROL_CHARACTERS.test(cookie)
  ) {
    throw new BrowserAuthError();
  }
  return cookie;
}

function parseBrowserSession(
  value: unknown,
  now: () => Date,
): BrowserSession | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new BrowserAuthError();
  }

  const session = value.session;
  const user = value.user;
  if (!isRecord(session) || !isRecord(user)) {
    throw new BrowserAuthError();
  }

  const sessionID = readAuthorityID(session.id);
  const sessionUserID = readAuthorityID(session.userId);
  const userID = readAuthorityID(user.id);
  if (sessionUserID !== userID) {
    throw new BrowserAuthError();
  }

  const expiresAt = readExpiry(session.expiresAt);
  if (expiresAt.getTime() <= now().getTime()) {
    return null;
  }

  const name = readOptionalSafeString(user.name, MAX_NAME_LENGTH);
  const email = readOptionalSafeString(user.email, MAX_EMAIL_LENGTH);

  return Object.freeze({
    sessionID,
    userID,
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    expiresAt,
  });
}

function readAuthorityID(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new BrowserAuthError();
  }

  const bytes = Buffer.from(value, 'utf8');
  if (
    bytes.length === 0 ||
    bytes.length > MAX_AUTHORITY_ID_BYTES ||
    bytes.toString('utf8') !== value
  ) {
    throw new BrowserAuthError();
  }
  return value;
}

function readExpiry(value: unknown): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new BrowserAuthError();
    }
    return new Date(value.getTime());
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  throw new BrowserAuthError();
}

function readOptionalSafeString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalOrigin(
  value: string,
  allowLoopbackHttp: boolean,
): boolean {
  if (
    value.length === 0 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== 'https:' &&
    (parsed.protocol !== 'http:' ||
      !allowLoopbackHttp ||
      !isLoopbackHostname(parsed.hostname))
  ) {
    return false;
  }

  return (
    parsed.origin === value &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.pathname === '/'
  );
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }

  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every(
      (octet) => /^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255,
    )
  );
}

function readProvider(value: unknown): BrowserAuthProvider {
  if (
    !isRecord(value) ||
    typeof value.handler !== 'function' ||
    !isRecord(value.api) ||
    typeof value.api.getSession !== 'function'
  ) {
    throw new BrowserAuthError();
  }
  return value as unknown as BrowserAuthProvider;
}

/**
 * Default provider construction. Dynamic specifiers keep this module
 * import-safe before the pinned dependencies are installed and let focused
 * tests replace the entire provider with a structural stub.
 */
async function defaultBrowserAuthProviderFactory(
  options: BrowserAuthProviderOptions,
): Promise<BrowserAuthProvider> {
  const [betterAuthModule, prismaAdapterModule] = await Promise.all([
    dynamicImport('better-auth'),
    dynamicImport('@better-auth/prisma-adapter'),
  ]);

  const betterAuth = readNamedCallable(
    betterAuthModule,
    'betterAuth',
    true,
  ) as (options: Record<string, unknown>) => unknown;
  const prismaAdapter = readNamedCallable(
    prismaAdapterModule,
    'prismaAdapter',
    true,
  ) as (
    client: unknown,
    options: { readonly provider: 'postgresql' },
  ) => unknown;

  const database = await prismaAdapter(options.database, {
    provider: 'postgresql',
  });

  const auth = await betterAuth({
    baseURL: options.baseURL,
    basePath: options.basePath,
    secret: options.secret,
    trustedOrigins: [...options.trustedOrigins],
    database,
    socialProviders: {
      github: {
        clientId: options.socialProviders.github.clientId,
        clientSecret: options.socialProviders.github.clientSecret,
      },
    },
    plugins: [],
    emailAndPassword: { enabled: false },
    logger: { disabled: true },
  });

  return readProvider(auth);
}

function dynamicImport(specifier: string): Promise<unknown> {
  return import(specifier);
}

function readNamedCallable(
  module: unknown,
  name: string,
  allowDefaultFunction: boolean,
): ((...args: never[]) => unknown) | undefined {
  if (!isRecord(module)) {
    return undefined;
  }

  const named = module[name];
  if (typeof named === 'function') {
    return named as (...args: never[]) => unknown;
  }

  const defaultExport = module.default;
  if (isRecord(defaultExport)) {
    const defaultNamed = defaultExport[name];
    if (typeof defaultNamed === 'function') {
      return defaultNamed as (...args: never[]) => unknown;
    }
  }
  if (allowDefaultFunction && typeof defaultExport === 'function') {
    return defaultExport as (...args: never[]) => unknown;
  }
  return undefined;
}
