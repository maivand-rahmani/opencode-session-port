import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { createApi, type CreateApiOptions } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import type { MeDTO, MeRepository } from '../src/me/repository.js';
import type { MeApiDependencies } from '../src/me/routes.js';
import type {
  BrowserSessionAuthority,
} from '../src/native-auth/browser.js';
import type { NativeAuthRouteDependencies } from '../src/native-auth/routes.js';
import type { NativeAuthService } from '../src/native-auth/service.js';
import type { RequestPrincipal } from '../src/protocol/principal.js';
import type { AuthorizeRequest } from '../src/protocol/principal.js';
import { RequestAuthorizationError } from '../src/protocol/principal.js';
import type { BrowserAuthBridgeOptions } from '../src/runtime/browser-routes.js';
import { createRouteAuthorizer } from '../src/runtime/cloud.js';
import type {
  CreateOrLinkInput,
  CreateOrLinkResult,
  ListWithStateInput,
  ProjectRepository,
  ProjectStateDTO,
} from '../src/projects/repository.js';
import type { ProjectListRepository } from '../src/projects/routes.js';
import type {
  CommitRevisionInput,
  CommitRevisionResult,
  RevisionPage,
  RevisionPageInput,
  RevisionRepository,
} from '../src/revisions/repository.js';

/*
 * Protocol-level integration tests for the partial sequential M2 mount.
 *
 * They use the real `createApi` gate and real route registration functions
 * with structural fake repositories and trusted authorizer callbacks. No
 * network, database, storage, native auth, or real persistence is used. The
 * callbacks are the only identity source; no header/body value is trusted.
 */

const TEST_CONFIG: ApiConfig = {
  host: '127.0.0.1',
  port: 43123,
  publicOrigin: 'https://api.example.test',
  bodyLimitBytes: 1024,
  readinessTimeoutMs: 50,
  retryAfterSeconds: 7,
};

const USER_ID = 'user_01HTRUSTEDINTEGRATION';
const OTHER_USER_ID = 'user_01HFORGEDINTEGRATION';
const DEVICE_ID = '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const OTHER_DEVICE_ID = '55bb2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const PROJECT_ID = '5d4e8c2a-1b3f-4a6d-9e8c-0f1a2b3c4d5e';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const UPLOAD_ID = 'aa11bb22-cc33-4d44-8e55-ff66aa77bb88';
const HEAD_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-10-18T12:00:00.000Z';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REVISIONS_URL = `/v1/projects/${PROJECT_ID}/revisions?after=0&limit=1`;
const VALID_PROJECT_BODY = { projectID: PROJECT_ID };
const VALID_REVISION_BODY = {
  revisionID: REVISION_ID,
  uploadID: UPLOAD_ID,
  parentRevisionID: null,
};

interface ErrorPayload {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestID: string;
  };
}

interface AuthorizerCall {
  readonly routeID: string;
  readonly request: FastifyRequest;
}

interface RecordingAuthorizer {
  readonly calls: AuthorizerCall[];
  readonly authorize: AuthorizeRequest;
}

interface RecordingMeAuthorizer {
  readonly calls: Array<{ readonly action: string; readonly request: FastifyRequest }>;
  readonly authorize: MeApiDependencies['authorize'];
}

function devicePrincipal(
  userID = USER_ID,
  deviceID = DEVICE_ID,
): RequestPrincipal {
  return { kind: 'device', userID, deviceID };
}

function browserPrincipal(userID = USER_ID): RequestPrincipal {
  return { kind: 'browser', userID };
}

function recordingAuthorizer(
  principal: RequestPrincipal | null,
  error: unknown = undefined,
): RecordingAuthorizer {
  const calls: AuthorizerCall[] = [];
  const authorize: AuthorizeRequest = async (request, routeID) => {
    calls.push({ routeID, request });
    if (error !== undefined) {
      throw error;
    }
    return principal;
  };
  return { calls, authorize };
}

function recordingMeAuthorizer(
  principal: RequestPrincipal | null,
  error: unknown = undefined,
): RecordingMeAuthorizer {
  const calls: Array<{ action: string; request: FastifyRequest }> = [];
  const authorize: MeApiDependencies['authorize'] = async (request, action) => {
    calls.push({ action, request });
    if (error !== undefined) {
      throw error;
    }
    return principal;
  };
  return { calls, authorize };
}

class FakeProjectsRepository implements ProjectRepository {
  readonly createCalls: CreateOrLinkInput[] = [];
  readonly listActiveCalls: string[] = [];
  readonly listWithStateCalls: ListWithStateInput[] = [];

  async createOrLink(input: CreateOrLinkInput): Promise<CreateOrLinkResult> {
    this.createCalls.push(input);
    return {
      outcome: 'created',
      statusCode: 201,
      project: {
        projectID: input.projectID.toLowerCase(),
        encryptedLabel:
          input.encryptedLabel === undefined
            ? null
            : new Uint8Array(input.encryptedLabel),
        createdAt: CREATED_AT,
      },
    };
  }

  async listActive(input: { readonly userID: string }): Promise<readonly never[]> {
    this.listActiveCalls.push(input.userID);
    return [];
  }

  async listWithState(
    input: ListWithStateInput,
  ): Promise<readonly ProjectStateDTO[]> {
    // Used only to prove GET /v1/projects does not enable implicitly.
    this.listWithStateCalls.push(input);
    return [STATE_PROJECT];
  }
}

class FakeProjectListRepository implements ProjectListRepository {
  readonly stateCalls: ListWithStateInput[] = [];

  async listWithState(
    input: ListWithStateInput,
  ): Promise<readonly ProjectStateDTO[]> {
    this.stateCalls.push(input);
    return [STATE_PROJECT];
  }
}

class FakeRevisionsRepository implements RevisionRepository {
  readonly commitCalls: CommitRevisionInput[] = [];
  readonly pageCalls: RevisionPageInput[] = [];

  async commit(input: CommitRevisionInput): Promise<CommitRevisionResult> {
    this.commitCalls.push(input);
    return {
      statusCode: 201,
      revisionID: input.revisionID,
      seq: '1',
      headIDs: [input.revisionID],
      conflict: false,
    };
  }

  async page(input: RevisionPageInput): Promise<RevisionPage> {
    this.pageCalls.push(input);
    return PAGE_RESULT;
  }
}

class FakeMeRepository implements MeRepository {
  readonly readCalls: string[] = [];

  async read(userID: string): Promise<MeDTO> {
    this.readCalls.push(userID);
    return {
      ...ME_RESULT,
      userID,
    };
  }
}

const STATE_PROJECT: ProjectStateDTO = {
  projectID: PROJECT_ID,
  encryptedLabel: Uint8Array.from([1, 2, 3]),
  createdAt: CREATED_AT,
  headIDs: [HEAD_ID],
  revisionCount: 1,
};

const PAGE_RESULT: RevisionPage = {
  upperBound: '1',
  nextAfter: '1',
  hasMore: false,
  currentHeadIDs: [REVISION_ID],
  revisions: [
    {
      revisionID: REVISION_ID,
      parentRevisionID: null,
      seq: '1',
      deviceID: DEVICE_ID,
      keyEpoch: 1,
      sizeBytes: 1_024,
      ciphertextSha256: 'AQID',
      createdAt: CREATED_AT,
    },
  ],
};

const ME_RESULT: MeDTO = {
  userID: USER_ID,
  limits: {
    storageLimitBytes: 1_073_741_824,
    storageUsedBytes: 0,
    storageReservedBytes: 0,
    maxCiphertextBytes: 1_048_576,
    maxActiveDevices: 3,
    maxActiveProjects: 10,
  },
  counts: { activeDevices: 0, activeProjects: 1 },
};

type ModuleName = 'projects' | 'projectList' | 'revisions' | 'me';

interface HarnessOptions {
  readonly projectPrincipal?: RequestPrincipal | null;
  readonly projectListPrincipal?: RequestPrincipal | null;
  readonly revisionsPrincipal?: RequestPrincipal | null;
  readonly mePrincipal?: RequestPrincipal | null;
  readonly include?: Partial<Record<ModuleName, boolean>>;
  readonly throwFor?: ModuleName | 'all';
  readonly authError?: unknown;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly projectsRepository: FakeProjectsRepository;
  readonly projectListRepository: FakeProjectListRepository;
  readonly revisionsRepository: FakeRevisionsRepository;
  readonly meRepository: FakeMeRepository;
  readonly projectAuth: RecordingAuthorizer;
  readonly projectListAuth: RecordingAuthorizer;
  readonly revisionsAuth: RecordingAuthorizer;
  readonly meAuth: RecordingMeAuthorizer;
}

function makeHarness(
  t: TestContext,
  options: HarnessOptions = {},
): Harness {
  const include: Record<ModuleName, boolean> = {
    projects: true,
    projectList: true,
    revisions: true,
    me: true,
    ...options.include,
  };
  const throwFor = options.throwFor ?? 'all';
  const errorFor = (module: ModuleName): unknown =>
    options.authError !== undefined &&
    (throwFor === 'all' || throwFor === module)
      ? options.authError
      : undefined;

  const projectsRepository = new FakeProjectsRepository();
  const projectListRepository = new FakeProjectListRepository();
  const revisionsRepository = new FakeRevisionsRepository();
  const meRepository = new FakeMeRepository();

  const projectAuth = recordingAuthorizer(
    options.projectPrincipal !== undefined
      ? options.projectPrincipal
      : devicePrincipal(),
    errorFor('projects'),
  );
  const projectListAuth = recordingAuthorizer(
    options.projectListPrincipal !== undefined
      ? options.projectListPrincipal
      : browserPrincipal(),
    errorFor('projectList'),
  );
  const revisionsAuth = recordingAuthorizer(
    options.revisionsPrincipal !== undefined
      ? options.revisionsPrincipal
      : devicePrincipal(),
    errorFor('revisions'),
  );
  const meAuth = recordingMeAuthorizer(
    options.mePrincipal !== undefined ? options.mePrincipal : browserPrincipal(),
    errorFor('me'),
  );

  const dependencies: CreateApiOptions = { config: TEST_CONFIG };
  if (include.projects) {
    dependencies.projects = {
      repository: projectsRepository,
      authorize: projectAuth.authorize,
    };
  }
  if (include.projectList) {
    dependencies.projectList = {
      repository: projectListRepository,
      authorize: projectListAuth.authorize,
    };
  }
  if (include.revisions) {
    dependencies.revisions = {
      repository: revisionsRepository,
      authorize: revisionsAuth.authorize,
    };
  }
  if (include.me) {
    dependencies.me = {
      repository: meRepository,
      authorize: meAuth.authorize,
    };
  }

  const app = createApi(dependencies);
  t.after(async () => {
    await app.close();
  });

  return {
    app,
    projectsRepository,
    projectListRepository,
    revisionsRepository,
    meRepository,
    projectAuth,
    projectListAuth,
    revisionsAuth,
    meAuth,
  };
}

function errorPayload(body: string): ErrorPayload {
  return JSON.parse(body) as ErrorPayload;
}

function assertUnauthenticated(response: {
  statusCode: number;
  body: string;
}): void {
  assert.equal(response.statusCode, 401);
  const payload = errorPayload(response.body);
  assert.equal(payload.error.code, 'unauthenticated');
  assert.equal(payload.error.message, 'Authentication is required.');
  assert.equal(payload.error.retryable, false);
  assert.match(payload.error.requestID, UUID_V4);
}

function forgedHeaders(): Record<string, string> {
  return {
    authorization: 'Bearer synthetic-forged-token',
    cookie: 'session=synthetic-forged-cookie',
    'x-user-id': OTHER_USER_ID,
    'x-device-id': OTHER_DEVICE_ID,
    'x-forwarded-user': OTHER_USER_ID,
  };
}

test('routes configured dependencies through their own trusted authorizers', async (t) => {
  const harness = makeHarness(t);

  const create = await harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: forgedHeaders(),
    payload: VALID_PROJECT_BODY,
  });
  assert.equal(create.statusCode, 201);
  assert.deepEqual(create.json(), {
    projectID: PROJECT_ID,
    encryptedLabel: null,
    createdAt: CREATED_AT,
  });
  assert.equal(harness.projectsRepository.createCalls.length, 1);
  assert.equal(
    harness.projectsRepository.createCalls[0]?.userID,
    USER_ID,
  );
  assert.equal(harness.projectAuth.calls[0]?.routeID, 'projects.create');
  assert.equal(harness.projectAuth.calls[0]?.request.method, 'POST');
  assert.ok(!create.body.includes(OTHER_USER_ID));
  assert.ok(!create.body.includes(OTHER_DEVICE_ID));

  const list = await harness.app.inject({
    method: 'GET',
    url: '/v1/projects',
    headers: forgedHeaders(),
  });
  assert.equal(list.statusCode, 200);
  assert.equal(harness.projectListRepository.stateCalls.length, 1);
  assert.equal(
    harness.projectListRepository.stateCalls[0]?.userID,
    USER_ID,
  );
  assert.equal(harness.projectListAuth.calls[0]?.routeID, 'projects.list');
  assert.equal(harness.projectsRepository.listWithStateCalls.length, 0);
  const listBody = list.json() as {
    projects: Array<{ projectID: string; revisionCount: number }>;
  };
  assert.equal(listBody.projects[0]?.projectID, PROJECT_ID);
  assert.equal(listBody.projects[0]?.revisionCount, 1);
  assert.ok(!list.body.includes(OTHER_USER_ID));

  const page = await harness.app.inject({
    method: 'GET',
    url: REVISIONS_URL,
    headers: forgedHeaders(),
  });
  assert.equal(page.statusCode, 200);
  assert.equal(harness.revisionsRepository.pageCalls.length, 1);
  assert.equal(harness.revisionsRepository.pageCalls[0]?.userID, USER_ID);
  assert.equal(harness.revisionsAuth.calls[0]?.routeID, 'revisions.list');

  const commit = await harness.app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: forgedHeaders(),
    payload: VALID_REVISION_BODY,
  });
  assert.equal(commit.statusCode, 201);
  assert.equal(harness.revisionsRepository.commitCalls.length, 1);
  assert.equal(harness.revisionsRepository.commitCalls[0]?.userID, USER_ID);
  assert.equal(
    harness.revisionsRepository.commitCalls[0]?.deviceID,
    DEVICE_ID,
  );
  assert.equal(
    harness.revisionsAuth.calls[1]?.routeID,
    'revisions.commit',
  );
  assert.deepEqual(commit.json(), {
    revisionID: REVISION_ID,
    seq: '1',
    headIDs: [REVISION_ID],
    conflict: false,
  });

  const me = await harness.app.inject({
    method: 'GET',
    url: '/v1/me',
    headers: forgedHeaders(),
  });
  assert.equal(me.statusCode, 200);
  assert.equal(harness.meRepository.readCalls.length, 1);
  assert.equal(harness.meRepository.readCalls[0], USER_ID);
  assert.equal(harness.meAuth.calls[0]?.action, 'me.read');
  assert.equal((me.json() as { userID: string }).userID, USER_ID);

  assert.deepEqual(
    harness.projectAuth.calls.map((call) => call.routeID),
    ['projects.create'],
  );
  assert.deepEqual(
    harness.projectListAuth.calls.map((call) => call.routeID),
    ['projects.list'],
  );
  assert.deepEqual(
    harness.revisionsAuth.calls.map((call) => call.routeID),
    ['revisions.list', 'revisions.commit'],
  );
});

test('browser principals may list projects and read me but not device-only routes', async (t) => {
  const harness = makeHarness(t, {
    projectPrincipal: browserPrincipal(OTHER_USER_ID),
    revisionsPrincipal: browserPrincipal(OTHER_USER_ID),
  });

  const create = await harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { 'content-type': 'application/json' },
    payload: '{"projectID":',
  });
  assert.equal(create.statusCode, 403);
  assert.equal(errorPayload(create.body).error.code, 'forbidden');
  assert.equal(errorPayload(create.body).error.retryable, false);

  const commit = await harness.app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: { 'content-type': 'application/json' },
    payload: '{"revisionID":',
  });
  assert.equal(commit.statusCode, 403);
  assert.equal(errorPayload(commit.body).error.code, 'forbidden');

  const page = await harness.app.inject({
    method: 'GET',
    url: REVISIONS_URL,
  });
  assert.equal(page.statusCode, 403);
  assert.equal(errorPayload(page.body).error.code, 'forbidden');

  const list = await harness.app.inject({
    method: 'GET',
    url: '/v1/projects',
  });
  assert.equal(list.statusCode, 200);
  assert.equal(harness.projectListRepository.stateCalls[0]?.userID, USER_ID);

  const me = await harness.app.inject({ method: 'GET', url: '/v1/me' });
  assert.equal(me.statusCode, 200);
  assert.equal(harness.meRepository.readCalls[0], USER_ID);

  assert.equal(harness.projectsRepository.createCalls.length, 0);
  assert.equal(harness.revisionsRepository.commitCalls.length, 0);
  assert.equal(harness.revisionsRepository.pageCalls.length, 0);
  assert.equal(harness.projectListRepository.stateCalls.length, 1);
  assert.equal(harness.meRepository.readCalls.length, 1);
});

test('null authorization is 401 before malformed or oversized body parsing', async (t) => {
  const harness = makeHarness(t, {
    projectPrincipal: null,
    projectListPrincipal: null,
    revisionsPrincipal: null,
    mePrincipal: null,
  });

  const malformedProject = await harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { 'content-type': 'application/json' },
    payload: '{"projectID":',
  });
  assertUnauthenticated(malformedProject);

  const oversizedProject = await harness.app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      projectID: PROJECT_ID,
      label: 'x'.repeat(TEST_CONFIG.bodyLimitBytes + 1),
    }),
  });
  assertUnauthenticated(oversizedProject);

  const malformedRevision = await harness.app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: { 'content-type': 'application/json' },
    payload: '{"revisionID":',
  });
  assertUnauthenticated(malformedRevision);

  const oversizedRevision = await harness.app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      revisionID: REVISION_ID,
      uploadID: UPLOAD_ID,
      parentRevisionID: null,
      padding: 'x'.repeat(TEST_CONFIG.bodyLimitBytes + 1),
    }),
  });
  assertUnauthenticated(oversizedRevision);

  assertUnauthenticated(
    await harness.app.inject({ method: 'GET', url: '/v1/projects' }),
  );
  assertUnauthenticated(
    await harness.app.inject({ method: 'GET', url: REVISIONS_URL }),
  );
  assertUnauthenticated(
    await harness.app.inject({ method: 'GET', url: '/v1/me' }),
  );

  assert.equal(harness.projectsRepository.createCalls.length, 0);
  assert.equal(harness.projectListRepository.stateCalls.length, 0);
  assert.equal(harness.revisionsRepository.commitCalls.length, 0);
  assert.equal(harness.revisionsRepository.pageCalls.length, 0);
  assert.equal(harness.meRepository.readCalls.length, 0);
});

test('authorizer failures are sanitised 503 responses with Retry-After', async (t) => {
  const secret = 'synthetic-authorizer-secret-value';
  const harness = makeHarness(t, {
    authError: new Error(`native auth failed with ${secret} at /internal/path`),
    throwFor: 'all',
  });

  for (const request of [
    { method: 'POST' as const, url: '/v1/projects', payload: VALID_PROJECT_BODY },
    { method: 'GET' as const, url: '/v1/projects' },
    { method: 'GET' as const, url: REVISIONS_URL },
    { method: 'GET' as const, url: '/v1/me' },
  ]) {
    const response = await harness.app.inject(request);
    assert.equal(response.statusCode, 503, request.url);
    assert.equal(response.headers['retry-after'], '7');
    const payload = errorPayload(response.body);
    assert.equal(payload.error.code, 'unavailable');
    assert.equal(payload.error.retryable, true);
    assert.match(payload.error.requestID, UUID_V4);
    assert.ok(!response.body.includes(secret));
    assert.ok(!response.body.includes('/internal/path'));
  }

  assert.equal(harness.projectsRepository.createCalls.length, 0);
  assert.equal(harness.projectListRepository.stateCalls.length, 0);
  assert.equal(harness.revisionsRepository.pageCalls.length, 0);
  assert.equal(harness.meRepository.readCalls.length, 0);
});

test('absent options preserve the original 401 and auth 503 gates', async (t) => {
  const app = createApi({ config: TEST_CONFIG });
  t.after(async () => {
    await app.close();
  });

  for (const request of [
    { method: 'POST' as const, url: '/v1/projects', payload: VALID_PROJECT_BODY },
    { method: 'GET' as const, url: '/v1/projects' },
    { method: 'GET' as const, url: REVISIONS_URL },
    { method: 'POST' as const, url: `/v1/projects/${PROJECT_ID}/revisions`, payload: VALID_REVISION_BODY },
    { method: 'GET' as const, url: '/v1/me' },
  ]) {
    assertUnauthenticated(await app.inject(request));
  }

  const auth = await app.inject({ method: 'GET', url: '/api/auth/session' });
  assert.equal(auth.statusCode, 503);
  assert.equal(auth.headers['retry-after'], '7');
  assert.equal(errorPayload(auth.body).error.code, 'unavailable');
});

test('projectList is required for GET /v1/projects; projects alone stays 401', async (t) => {
  const repository = new FakeProjectsRepository();
  const app = createApi({
    config: TEST_CONFIG,
    projects: {
      repository,
      authorizeCreate: async () => ({ userID: USER_ID }),
    },
  });
  t.after(async () => {
    await app.close();
  });

  const create = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    payload: VALID_PROJECT_BODY,
  });
  assert.equal(create.statusCode, 201);
  assert.equal(repository.createCalls.length, 1);

  assertUnauthenticated(
    await app.inject({ method: 'GET', url: '/v1/projects' }),
  );
  assertUnauthenticated(await app.inject({ method: 'GET', url: REVISIONS_URL }));
  assertUnauthenticated(await app.inject({ method: 'GET', url: '/v1/me' }));
  assert.equal(repository.listWithStateCalls.length, 0);
});

test('module options enable only their own exact routes', async (t) => {
  const listRepository = new FakeProjectListRepository();
  const listAuth = recordingAuthorizer(browserPrincipal());
  const listOnly = createApi({
    config: TEST_CONFIG,
    projectList: {
      repository: listRepository,
      authorize: listAuth.authorize,
    },
  });
  t.after(async () => {
    await listOnly.close();
  });

  const list = await listOnly.inject({ method: 'GET', url: '/v1/projects' });
  assert.equal(list.statusCode, 200);
  assert.equal(listRepository.stateCalls.length, 1);
  assertUnauthenticated(
    await listOnly.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: VALID_PROJECT_BODY,
    }),
  );
  assertUnauthenticated(
    await listOnly.inject({ method: 'GET', url: REVISIONS_URL }),
  );
  assertUnauthenticated(
    await listOnly.inject({ method: 'GET', url: '/v1/me' }),
  );

  const revisionsRepository = new FakeRevisionsRepository();
  const revisionsAuth = recordingAuthorizer(devicePrincipal());
  const revisionsOnly = createApi({
    config: TEST_CONFIG,
    revisions: {
      repository: revisionsRepository,
      authorize: revisionsAuth.authorize,
    },
  });
  t.after(async () => {
    await revisionsOnly.close();
  });

  assert.equal(
    (await revisionsOnly.inject({ method: 'GET', url: REVISIONS_URL }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await revisionsOnly.inject({
        method: 'POST',
        url: `/v1/projects/${PROJECT_ID}/revisions`,
        payload: VALID_REVISION_BODY,
      })
    ).statusCode,
    201,
  );
  assertUnauthenticated(
    await revisionsOnly.inject({ method: 'GET', url: '/v1/projects' }),
  );
  assertUnauthenticated(
    await revisionsOnly.inject({ method: 'GET', url: '/v1/me' }),
  );

  const meRepository = new FakeMeRepository();
  const meAuth = recordingMeAuthorizer(browserPrincipal());
  const meOnly = createApi({
    config: TEST_CONFIG,
    me: {
      repository: meRepository,
      authorize: meAuth.authorize,
    },
  });
  t.after(async () => {
    await meOnly.close();
  });

  assert.equal((await meOnly.inject({ method: 'GET', url: '/v1/me' })).statusCode, 200);
  assertUnauthenticated(
    await meOnly.inject({ method: 'GET', url: '/v1/projects' }),
  );
  assertUnauthenticated(
    await meOnly.inject({ method: 'GET', url: REVISIONS_URL }),
  );
});

test('all other /v1 methods and path variants stay behind the original 401 gate', async (t) => {
  const harness = makeHarness(t);

  const deniedPaths = [
    '/v1',
    '/v1/devices',
    '/v1/projects/',
    '/v1/projects/extra',
    `/v1/projects/${PROJECT_ID}/revisions/`,
    '/v1/projects//revisions',
    `/v1/projects/${PROJECT_ID}/revisions/extra`,
    '/v1/projects/%2f/revisions',
    '/v1/projects/%41/revisions',
    '/v1/projects/%C3%A9/revisions',
    '/v1%2fprojects',
    '//v1/projects',
    '/v1//projects',
    '/V1/projects',
  ];

  for (const url of deniedPaths) {
    assertUnauthenticated(
      await harness.app.inject({ method: 'GET', url }),
    );
  }

  for (const request of [
    { method: 'HEAD' as const, url: '/v1/projects' },
    { method: 'PUT' as const, url: `/v1/projects/${PROJECT_ID}/revisions` },
    { method: 'DELETE' as const, url: `/v1/projects/${PROJECT_ID}/revisions` },
    { method: 'OPTIONS' as const, url: '/v1/me' },
    { method: 'POST' as const, url: '/v1/me', payload: {} },
    { method: 'PUT' as const, url: '/v1/projects' },
  ]) {
    const response = await harness.app.inject(request);
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    if (request.method !== 'HEAD') {
      assert.equal(errorPayload(response.body).error.code, 'unauthenticated');
    }
  }

  const invalidUuid = await harness.app.inject({
    method: 'GET',
    url: '/v1/projects/not-a-uuid/revisions?after=0&limit=1',
  });
  assert.equal(invalidUuid.statusCode, 422);
  assert.equal(errorPayload(invalidUuid.body).error.code, 'invalid-request');
  assert.equal(
    harness.revisionsAuth.calls.at(-1)?.routeID,
    'revisions.list',
  );
  assert.equal(harness.revisionsRepository.pageCalls.length, 0);

  const valid = await harness.app.inject({
    method: 'GET',
    url: REVISIONS_URL,
  });
  assert.equal(valid.statusCode, 200);
});

test('absolute URLs and encoded route boundaries use the same gate', async (t) => {
  const harness = makeHarness(t);

  const absolute = await harness.app.inject({
    method: 'GET',
    url: `http://api.example.test/v1/projects`,
  });
  assert.equal(absolute.statusCode, 200);
  assert.equal(harness.projectListRepository.stateCalls.length, 1);

  for (const url of [
    'http://api.example.test/v1%2fprojects',
    'http://api.example.test/v1/projects/%2f/revisions',
    'http://api.example.test/v1//projects',
  ]) {
    assertUnauthenticated(
      await harness.app.inject({ method: 'GET', url }),
    );
  }

  const auth = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in',
  });
  assert.equal(auth.statusCode, 503);
  assert.equal(auth.headers['retry-after'], '7');
  assert.equal(errorPayload(auth.body).error.code, 'unavailable');
});

test('malformed dependencies throw fixed sanitised errors before serving', () => {
  const fixed = {
    projects: /Invalid projects API dependency\./,
    projectList: /Invalid project list API dependency\./,
    revisions: /Invalid revisions API dependency\./,
    me: /Invalid me API dependency\./,
  } as const;

  assert.throws(
    () => createApi({ config: TEST_CONFIG, projects: null as never }),
    fixed.projects,
  );
  assert.throws(
    () => createApi({ config: TEST_CONFIG, projectList: {} as never }),
    fixed.projectList,
  );
  assert.throws(
    () => createApi({ config: TEST_CONFIG, revisions: {} as never }),
    fixed.revisions,
  );
  assert.throws(
    () => createApi({ config: TEST_CONFIG, me: {} as never }),
    fixed.me,
  );

  const secret = 'dependency-getter-secret';
  const malformed = {
    get repository(): never {
      throw new Error(secret);
    },
    authorize: async () => null,
  };

  assert.throws(
    () => createApi({ config: TEST_CONFIG, projectList: malformed as never }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'Invalid project list API dependency.');
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );
});

class FakeRuntimeBrowserAuthority implements BrowserSessionAuthority {
  readonly handleCalls: Request[] = [];
  sessionUserID: string | null = null;

  async readSession(cookie: string) {
    if (this.sessionUserID === null || !cookie.includes('session=')) {
      return null;
    }
    return {
      sessionID: 'session-1',
      userID: this.sessionUserID,
      expiresAt: new Date('2026-10-21T00:00:00.000Z'),
    };
  }

  async handle(request: Request): Promise<Response> {
    this.handleCalls.push(request);
    return new Response(
      JSON.stringify({
        session: { token: 'raw-vendor-token' },
        user: { id: 'user-browser', name: 'Browser User' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
}

function fakeNativeService(): NativeAuthService {
  const unused = async (): Promise<never> => {
    throw new Error('unused native service method');
  };
  return {
    createDeviceAuthorization: unused,
    verifyUserCode: unused,
    approveUserCode: unused,
    denyUserCode: unused,
    exchangeDeviceCode: unused,
    refreshToken: unused,
    listGrants: unused,
    revokeGrant: unused,
    authorizeBearer: unused,
  } as unknown as NativeAuthService;
}

function fakeNativeAuthOption(
  browser: BrowserSessionAuthority,
): Omit<NativeAuthRouteDependencies, 'retryAfterSeconds'> {
  const rate = { windowSeconds: 60, maxRequests: 60 };
  return {
    service: fakeNativeService(),
    browser,
    config: {
      publicOrigin: TEST_CONFIG.publicOrigin,
      verificationUri: `${TEST_CONFIG.publicOrigin}/api/native/v1/device-authorizations/verify`,
      allowLoopbackHttp: false,
      csrfKey: new Uint8Array(32),
      policy: {
        rateLimits: {
          createAuthorization: rate,
          browserVerification: rate,
          browserLookup: rate,
          approveAuthorization: rate,
          denyAuthorization: rate,
          exchangeDeviceCode: rate,
          refreshToken: rate,
          listGrants: rate,
          revokeGrant: rate,
        },
        capacity: {
          maxOutstandingPendingAuthorizationsPerUser: 10,
          maxActiveGrantsPerUser: 3,
          retentionSeconds: {
            pendingAuthorizationRecords: 1,
            spentTokenRecords: 1,
            revokedGrantRecords: 1,
          },
        },
      },
    },
    rateLimiter: {
      async consume() {
        return { kind: 'allowed' as const };
      },
    },
  } as unknown as Omit<NativeAuthRouteDependencies, 'retryAfterSeconds'>;
}

function fakeBrowserAuthOption(
  authority: BrowserSessionAuthority,
): BrowserAuthBridgeOptions {
  return {
    authority,
    canonicalOrigin: TEST_CONFIG.publicOrigin,
    maxResponseBytes: 1_024,
  };
}

test('native routes remain 503 without nativeAuth and expose only frozen paths with it', async (t) => {
  const withoutNative = makeHarness(t);
  for (const url of [
    '/api/native/v1/session',
    '/api/native/v1/token',
    '/api/native/v1/unknown',
  ]) {
    const response = await withoutNative.app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 503, url);
    assert.equal(response.headers['retry-after'], '7');
  }

  const browser = new FakeRuntimeBrowserAuthority();
  const withNative = createApi({
    config: TEST_CONFIG,
    nativeAuth: fakeNativeAuthOption(browser),
  });
  t.after(async () => {
    await withNative.close();
  });

  const session = await withNative.inject({
    method: 'GET',
    url: '/api/native/v1/session',
  });
  assert.equal(session.statusCode, 401);
  assert.equal(errorPayload(session.body).error.code, 'unauthenticated');

  for (const request of [
    { method: 'GET' as const, url: '/api/native/v1/unknown' },
    { method: 'POST' as const, url: '/api/native/v1/session' },
    { method: 'GET' as const, url: '/api/native/v1/grants/11111111-1111-4111-8111-111111111111/revoke' },
    { method: 'GET' as const, url: '/api/native/v1' },
  ]) {
    const response = await withNative.inject(request);
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
    assert.equal(errorPayload(response.body).error.code, 'not-found');
  }
});

test('browser auth bridge is default-denied and exposes only four exact routes', async (t) => {
  const authority = new FakeRuntimeBrowserAuthority();
  const app = createApi({
    config: TEST_CONFIG,
    browserAuth: fakeBrowserAuthOption(authority),
  });
  t.after(async () => {
    await app.close();
  });

  const session = await app.inject({
    method: 'GET',
    url: '/api/auth/get-session',
    headers: { cookie: 'session=abc', host: 'evil.example.test' },
  });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json(), {
    user: { id: 'user-browser', name: 'Browser User' },
  });
  assert.ok(!session.body.includes('raw-vendor-token'));
  assert.equal(authority.handleCalls.length, 1);
  assert.equal(
    authority.handleCalls[0]?.url,
    'https://api.example.test/api/auth/get-session',
  );

  for (const request of [
    { method: 'GET' as const, url: '/api/auth/jwt' },
    { method: 'GET' as const, url: '/api/auth/device/code' },
    { method: 'POST' as const, url: '/api/auth/get-session' },
    { method: 'GET' as const, url: '/api/auth/sign-in/social' },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 503, `${request.method} ${request.url}`);
    assert.equal(response.headers['retry-after'], '7');
  }
});

test('shared authorization failures map to fixed 401/403/503 without route catch masking', async (t) => {
  const forbidden = new RequestAuthorizationError('forbidden');
  const app = createApi({
    config: TEST_CONFIG,
    projects: {
      repository: new FakeProjectsRepository(),
      authorize: async () => {
        throw forbidden;
      },
    },
    revisions: {
      repository: new FakeRevisionsRepository(),
      authorize: async () => {
        throw forbidden;
      },
    },
    me: {
      repository: new FakeMeRepository(),
      authorize: async () => {
        throw new RequestAuthorizationError('forbidden');
      },
    },
  });
  t.after(async () => {
    await app.close();
  });

  for (const request of [
    {
      method: 'POST' as const,
      url: '/v1/projects',
      payload: VALID_PROJECT_BODY,
    },
    { method: 'GET' as const, url: REVISIONS_URL },
    { method: 'GET' as const, url: '/v1/me' },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
    assert.equal(errorPayload(response.body).error.code, 'forbidden');
    assert.equal(errorPayload(response.body).error.message, 'The request is not permitted.');
    assert.equal(response.headers['retry-after'], undefined);
  }
});

test('route authorizer enforces bearer scope, cookie policy, duplicates, and forged headers', async (t) => {
  const USER = 'user-runtime-authorized';
  const DEVICE = '44aa2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
  const calls: Array<{ routeID: string; authorization?: string }> = [];
  const service = {
    async authorizeBearer(
      headers: { readonly authorization?: string },
      routeID: string,
    ) {
      calls.push({ routeID, authorization: headers.authorization });
      if (headers.authorization === 'Bearer revoked') {
        return { ok: false, code: 'forbidden', statusCode: 403, message: 'The request is not permitted.', retryable: false };
      }
      if (headers.authorization === 'Bearer invalid') {
        return { ok: false, code: 'unauthenticated', statusCode: 401, message: 'Authentication is required.', retryable: false };
      }
      return {
        ok: true,
        principal: {
          kind: 'device',
          userID: USER,
          deviceID: DEVICE,
          grantID: '11111111-1111-4111-8111-111111111111',
        },
      };
    },
  } as unknown as NativeAuthService;
  const browser = new FakeRuntimeBrowserAuthority();
  browser.sessionUserID = USER;
  const authorize = createRouteAuthorizer(service, browser);

  const projectsRepository = new FakeProjectsRepository();
  const projectListRepository = new FakeProjectListRepository();
  const revisionsRepository = new FakeRevisionsRepository();
  const meRepository = new FakeMeRepository();
  const app = createApi({
    config: TEST_CONFIG,
    projects: { repository: projectsRepository, authorize },
    projectList: { repository: projectListRepository, authorize },
    revisions: { repository: revisionsRepository, authorize },
    me: { repository: meRepository, authorize },
  });
  t.after(async () => {
    await app.close();
  });

  const valid = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      authorization: 'Bearer valid',
      'x-user-id': OTHER_USER_ID,
    },
    payload: VALID_PROJECT_BODY,
  });
  assert.equal(valid.statusCode, 201);
  assert.equal(projectsRepository.createCalls[0]?.userID, USER);
  assert.equal(calls[0]?.routeID, 'projects.create');

  const missingScope = await app.inject({
    method: 'POST',
    url: `/v1/projects/${PROJECT_ID}/revisions`,
    headers: { authorization: 'Bearer revoked' },
    payload: VALID_REVISION_BODY,
  });
  assert.equal(missingScope.statusCode, 403);
  assert.equal(errorPayload(missingScope.body).error.code, 'forbidden');
  assert.equal(revisionsRepository.commitCalls.length, 0);

  const invalidBearer = await app.inject({
    method: 'GET',
    url: '/v1/projects',
    headers: {
      authorization: 'Bearer invalid',
      cookie: 'session=abc',
      'x-user-id': OTHER_USER_ID,
    },
  });
  assert.equal(invalidBearer.statusCode, 401);
  assert.equal(errorPayload(invalidBearer.body).error.code, 'unauthenticated');
  assert.equal(projectListRepository.stateCalls.length, 0);
  assert.equal(calls.at(-1)?.authorization, 'Bearer invalid');

  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      authorization: ['Bearer valid', 'Bearer valid'],
    } as never,
    payload: VALID_PROJECT_BODY,
  });
  assert.equal(duplicate.statusCode, 401);
  assert.equal(errorPayload(duplicate.body).error.code, 'unauthenticated');

  const cookieList = await app.inject({
    method: 'GET',
    url: '/v1/projects',
    headers: { cookie: 'session=abc', 'x-user-id': OTHER_USER_ID },
  });
  assert.equal(cookieList.statusCode, 200);
  assert.equal(projectListRepository.stateCalls[0]?.userID, USER);

  const cookieCreate = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { cookie: 'session=abc' },
    payload: VALID_PROJECT_BODY,
  });
  assert.equal(cookieCreate.statusCode, 403);
  assert.equal(errorPayload(cookieCreate.body).error.code, 'forbidden');
  assert.equal(projectsRepository.createCalls.length, 1);
});
