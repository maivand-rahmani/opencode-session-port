/**
 * Composition tests for the Phase 2 wiring lane (`/checkpoint` and `/restore`
 * command callbacks).
 *
 * All effects are fake: fake public client, fake crypto (no Argon2 or
 * secretstream), fake artifact I/O, fake password provider, fake dialog, and a
 * notification recorder. These tests prove command-callback behavior and
 * fail-closed ordering only; no real host call, file, KDF, or import is made,
 * and no production policy/compatibility claim follows.
 */

import { describe, expect, test } from "bun:test";
import { encodeJson, type JsonObject, type SessionRecord } from "../../../src/core/contracts/index.ts";
import {
	EXPERIMENTAL_CRYPTO_POLICY_ID,
	EXPERIMENTAL_MAX_PASSWORD_BYTES,
	parseCheckpointOutputArgument,
	parseRestoreArtifactArgument,
} from "../../../src/tui/wiring/index.ts";
import {
	createWiringHarness,
	deriveTestId,
	fakeCryptoError,
	locationResponse,
	sessionImportResponse,
	sessionRecord,
	TEST_ACTIVE_DIRECTORY,
	TEST_DEST_DIRECTORY,
	TEST_DEST_PROJECT_ID,
	userMessage,
} from "./test-support.ts";

const CHECKPOINT_ARTIFACT_PATH = "C:/work/artifacts/checkpoint-one.sessionport";

/* ------------------------------------------------------------------------- */
/* Raw-argument parsing                                                      */
/* ------------------------------------------------------------------------- */

describe("command argument parsing", () => {
	test("checkpoint: blank/absent means the P-15 default, otherwise the path verbatim (trimmed of surrounding whitespace)", () => {
		expect(parseCheckpointOutputArgument(undefined)).toBeUndefined();
		expect(parseCheckpointOutputArgument("")).toBeUndefined();
		expect(parseCheckpointOutputArgument("   ")).toBeUndefined();
		expect(parseCheckpointOutputArgument("C:/out/a.sessionport")).toBe("C:/out/a.sessionport");
		expect(parseCheckpointOutputArgument("  C:/out/a.sessionport  ")).toBe("C:/out/a.sessionport");
	});

	test("restore: an absent/blank argument is the bare form; no flag syntax is interpreted", () => {
		expect(parseRestoreArtifactArgument(undefined)).toBeUndefined();
		expect(parseRestoreArtifactArgument("   ")).toBeUndefined();
		expect(parseRestoreArtifactArgument("  C:/in/a.sessionport ")).toBe("C:/in/a.sessionport");
		expect(parseRestoreArtifactArgument('--path "C:/in/a.sessionport"')).toBe('--path "C:/in/a.sessionport"');
	});
});

/* ------------------------------------------------------------------------- */
/* /checkpoint                                                               */
/* ------------------------------------------------------------------------- */

describe("checkpoint command callback", () => {
	test("collects, prompts, seals, writes, and reports path/size/count facts", async () => {
		const sessions = [
			sessionRecord("ses_a", [userMessage("msg_a1")], "proj_active"),
			sessionRecord("ses_b", [userMessage("msg_b1")], "proj_active"),
		];
		const harness = createWiringHarness({ client: { sessions } });

		await harness.handlers.checkpoint(undefined);

		expect(harness.notifications).toHaveLength(1);
		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("success");
		expect(notification.message).toContain("C:/work/active/.sessionport/checkpoint-test.sessionport");
		expect(notification.message).toContain("4 bytes");
		expect(notification.message).toContain("2 sessions");

		// One explicit location.get for the active directory; the exact policy
		// id and experimental limits are used.
		expect(harness.client.locationGetInputs).toEqual([{ location: { directory: TEST_ACTIVE_DIRECTORY } }]);
		expect(harness.crypto.createPolicies.map((policy) => policy.id)).toEqual([EXPERIMENTAL_CRYPTO_POLICY_ID]);
		expect(harness.client.sessionListInputs[0]?.limit).toBe(50);
		expect(harness.client.messageListInputs[0]?.limit).toBe(200);
		expect(harness.password.calls).toEqual([
			{ mode: "checkpoint", maxPasswordBytes: EXPERIMENTAL_MAX_PASSWORD_BYTES },
		]);

		// The P-15 resolver receives the active directory and no override; the
		// writer receives the resolved path and the sealed bytes.
		expect(harness.artifacts.resolveCalls).toHaveLength(1);
		expect(harness.artifacts.resolveCalls[0]?.projectDirectory).toBe(TEST_ACTIVE_DIRECTORY);
		expect("explicitPath" in (harness.artifacts.resolveCalls[0] ?? {})).toBe(false);
		expect(harness.artifacts.writeCalls).toEqual([
			{ path: "C:/work/active/.sessionport/checkpoint-test.sessionport", bytes: 4 },
		]);
	});

	test("forwards an explicit output-path argument to the P-15 resolver", async () => {
		const harness = createWiringHarness({
			client: { sessions: [sessionRecord("ses_a", [userMessage("msg_a1")], "proj_active")] },
		});

		await harness.handlers.checkpoint("  C:/out/custom.sessionport ");

		expect(harness.artifacts.resolveCalls[0]?.explicitPath).toBe("C:/out/custom.sessionport");
	});

	test("zero sessions: reports not-created before password, path, crypto, or write", async () => {
		const harness = createWiringHarness({ client: { sessions: [] } });

		await harness.handlers.checkpoint(undefined);

		expect(harness.notifications[0]?.variant).toBe("warning");
		expect(harness.notifications[0]?.message).toContain("No sessions were found");
		expect(harness.password.calls).toHaveLength(0);
		expect(harness.artifacts.resolveCalls).toHaveLength(0);
		expect(harness.artifacts.writeCalls).toHaveLength(0);
		expect(harness.crypto.createPolicies).toHaveLength(0);
		expect(harness.crypto.sealPasswords).toHaveLength(0);
	});

	test("canceled password: reports canceled without path, crypto, or write", async () => {
		const harness = createWiringHarness({
			client: { sessions: [sessionRecord("ses_a", [userMessage("msg_a1")], "proj_active")] },
			password: { result: "cancel" },
		});

		await harness.handlers.checkpoint(undefined);

		expect(harness.notifications[0]?.variant).toBe("info");
		expect(harness.notifications[0]?.message).toContain("canceled");
		expect(harness.artifacts.resolveCalls).toHaveLength(0);
		expect(harness.artifacts.writeCalls).toHaveLength(0);
		expect(harness.crypto.createPolicies).toHaveLength(0);
	});

	test("location mismatch prevents collection, prompt, and write", async () => {
		const harness = createWiringHarness({
			client: {
				sessions: [sessionRecord("ses_a", [userMessage("msg_a1")], "proj_active")],
				locationGet: async (input) => locationResponse("C:/somewhere/else", "proj_active"),
			},
		});

		await harness.handlers.checkpoint(undefined);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.message).toContain("could not be verified");
		expect(notification.message).not.toContain("C:/somewhere/else");
		expect(harness.client.sessionListInputs).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
		expect(harness.artifacts.writeCalls).toHaveLength(0);
	});

	test("missing active directory fails closed without any host call", async () => {
		const harness = createWiringHarness({ activeDirectory: undefined });

		await harness.handlers.checkpoint(undefined);

		expect(harness.notifications[0]?.variant).toBe("error");
		expect(harness.client.locationGetInputs).toHaveLength(0);
		expect(harness.client.sessionListInputs).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
		expect(harness.artifacts.writeCalls).toHaveLength(0);
	});

	test("writer failure is sanitized and never reported as a created artifact", async () => {
		const harness = createWiringHarness({
			client: { sessions: [sessionRecord("ses_a", [userMessage("msg_a1")], "proj_active")] },
			artifacts: { writeError: new Error("RAW-HOST-DETAIL") },
		});

		await harness.handlers.checkpoint(undefined);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.message).not.toContain("RAW-HOST-DETAIL");
		expect(notification.message).toContain("Checkpoint failed");
		expect(harness.artifacts.writeCalls).toHaveLength(0);
	});

	test("collects a referenced dependency from another project via session.get and never scans other projects", async () => {
		const externalParent = sessionRecord("ses_ext_parent", [userMessage("msg_ext")], FOREIGN_PROJECT_ID);
		const sessions = [
			sessionRecord("ses_child", [userMessage("msg_child")], "proj_active", { parentID: "ses_ext_parent" }),
			externalParent,
		];
		const harness = createWiringHarness({ client: { sessions } });

		await harness.handlers.checkpoint(undefined);

		expect(harness.notifications[0]?.variant).toBe("success");
		expect(harness.notifications[0]?.message).toContain("2 sessions");

		// The referenced dependency was resolved by explicit ID only through the
		// dependency-capable read adapter: no project.list and no extra
		// dependency-project session.list scan happened.
		expect(harness.client.sessionGetInputs).toEqual([{ sessionID: "ses_ext_parent" }]);
		expect(harness.client.projectListCalls).toBe(0);
		expect(harness.client.sessionListInputs).toEqual([{ project: "proj_active", limit: 50 }]);
		const collectedMessageSessionIDs = harness.client.messageListInputs.map((input) => input.sessionID);
		expect(collectedMessageSessionIDs).toHaveLength(2);
		expect(collectedMessageSessionIDs).toContain("ses_child");
		expect(collectedMessageSessionIDs).toContain("ses_ext_parent");
	});

	test("missing session.get capability reports a fixed checkpoint failure and writes nothing", async () => {
		const harness = createWiringHarness({
			client: {
				withSessionGet: false,
				sessions: [sessionRecord("ses_a", [userMessage("msg_a1")], "proj_active")],
			},
		});

		await harness.handlers.checkpoint(undefined);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.title).toBe("Checkpoint failed");
		expect(notification.message).toContain("capability");
		expect(notification.message).not.toContain("session.get");

		// Capability detection failed closed before any list, prompt, path,
		// crypto, or write.
		expect(harness.client.sessionListInputs).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
		expect(harness.artifacts.resolveCalls).toHaveLength(0);
		expect(harness.crypto.createPolicies).toHaveLength(0);
		expect(harness.artifacts.writeCalls).toHaveLength(0);
	});
});

/* ------------------------------------------------------------------------- */
/* /restore                                                                  */
/* ------------------------------------------------------------------------- */

function parentChildArtifactBytes(): Uint8Array {
	const parent = sessionRecord("ses_parent", [userMessage("msg_p1")], "proj_source");
	const child = sessionRecord("ses_child", [userMessage("msg_c1")], "proj_source", { parentID: "ses_parent" });
	return encodeJson({ sessions: [parent, child] });
}

function destinationProjects(): unknown {
	return [{ id: TEST_DEST_PROJECT_ID, canonical: TEST_DEST_DIRECTORY, name: "Dest" }];
}

/** Fixture foreign project used by the cross-project collision tests. */
const FOREIGN_PROJECT_ID = "proj_other";
const FOREIGN_DIRECTORY = "C:/work/other";

function destinationAndForeignProjects(): unknown {
	return [
		{ id: TEST_DEST_PROJECT_ID, canonical: TEST_DEST_DIRECTORY, name: "Dest" },
		{ id: FOREIGN_PROJECT_ID, canonical: FOREIGN_DIRECTORY, name: "Other" },
	];
}

describe("restore command callback", () => {
	test("probes capability, resolves the selected destination, preflights, then imports parent-first with explicit targets", async () => {
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// Capability probe happened before any other host surface was used.
		expect(harness.client.sessionImportGetterReads).toBeGreaterThan(0);
		expect(harness.client.projectListCalls).toBe(1);
		expect(harness.client.locationGetInputs).toEqual([{ location: { directory: TEST_DEST_DIRECTORY } }]);
		expect(harness.dialog.selectCalls).toEqual([{ title: "Choose an existing project to restore into", optionCount: 1 }]);
		expect(harness.password.calls).toEqual([{ mode: "restore", maxPasswordBytes: EXPERIMENTAL_MAX_PASSWORD_BYTES }]);
		expect(harness.artifacts.readCalls).toEqual([CHECKPOINT_ARTIFACT_PATH]);
		expect(harness.crypto.openAndStageCalls).toBe(1);

		// The destination snapshot used the resolved project scope.
		expect(harness.client.sessionListInputs.some((input) => input.project === TEST_DEST_PROJECT_ID)).toBe(true);

		// Parent-first import with the explicit destination on every call.
		expect(harness.client.importInputs).toHaveLength(2);
		const [parentImport, childImport] = harness.client.importInputs as Array<{
			info: { id: string; parentID?: string };
			location: { directory: string };
		}>;
		expect(parentImport?.info.id).toBe("ses_parent");
		expect(parentImport?.info.parentID).toBeUndefined();
		expect(childImport?.info.id).toBe("ses_child");
		expect(childImport?.info.parentID).toBe(parentImport?.info.id);
		expect(parentImport?.location).toEqual({ directory: TEST_DEST_DIRECTORY });
		expect(childImport?.location).toEqual({ directory: TEST_DEST_DIRECTORY });

		// The completed execution is mapped into the designer presentation model
		// and presented through the report dialog; no per-session toast is used.
		expect(harness.notifications).toHaveLength(0);
		expect(harness.report.models).toHaveLength(1);
		const model = harness.report.models[0]!;
		expect(model.summary).toEqual({ total: 2, imported: 2, skipped: 0, failed: 0, blocked: 0, notAttempted: 0 });
		expect(model.sessions.map((session) => session.sessionID)).toEqual(["ses_parent", "ses_child"]);
		expect(model.sessions.map((session) => session.classification)).toEqual(["imported", "imported"]);
		expect(model.sessions.map((session) => session.status)).toEqual(["imported", "imported"]);
	});

	test("restore destination snapshot never resolves session.get or performs dependency lookup", async () => {
		const harness = createWiringHarness({
			client: {
				sessions: [
					sessionRecord("ses_dest", [userMessage("msg_dest")], TEST_DEST_PROJECT_ID),
					sessionRecord("ses_foreign", [userMessage("msg_foreign")], FOREIGN_PROJECT_ID),
				],
				projects: async () => destinationAndForeignProjects(),
			},
			crypto: {
				authenticatedBytes: encodeJson({
					sessions: [sessionRecord("ses_src", [userMessage("msg_src")], "proj_source")],
				}),
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// The restore path uses the list-only adapter: it never reads the
		// session.get getter and never asks for a dependency by ID, so the
		// destination snapshot and inventory stay strictly project-scoped.
		expect(harness.client.sessionGetGetterReads).toBe(0);
		expect(harness.client.sessionGetInputs).toEqual([]);
		expect(harness.client.sessionListInputs.map((input) => input.project)).not.toContain("proj_source");
		expect(harness.client.importInputs).toHaveLength(1);
		expect(harness.report.models[0]?.summary.imported).toBe(1);
	});

	test("capability absence precedes project list, location, artifact read, and import (O-12)", async () => {
		const harness = createWiringHarness({
			client: {
				withImport: false,
				projects: async () => {
					throw new Error("project.list must not be called");
				},
				locationGet: async () => {
					throw new Error("location.get must not be called");
				},
			},
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("warning");
		expect(notification.message).toContain("session-import capability");
		expect(harness.client.sessionImportGetterReads).toBeGreaterThan(0);
		expect(harness.client.projectListCalls).toBe(0);
		expect(harness.client.locationGetInputs).toHaveLength(0);
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.artifacts.artifactIterations).toBe(0);
		expect(harness.crypto.openAndStageCalls).toBe(0);
		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
	});

	test("bare restore with no checkpoint: capability probe first, then the resolver, then a fixed no-checkpoint copy with no destination/read/password/import", async () => {
		const harness = createWiringHarness({
			client: {
				projects: async () => {
					throw new Error("project.list must not be called");
				},
			},
		});

		await harness.handlers.restore(undefined);
		await harness.handlers.restore("   ");

		expect(harness.notifications).toHaveLength(2);
		for (const notification of harness.notifications) {
			expect(notification.variant).toBe("warning");
			expect(notification.message).toContain(".sessionport");
			expect(notification.message).toContain("no sessions were changed");
			expect(notification.message).not.toContain("Usage: /restore");
		}
		// The capability probe stays first (O-12); the resolver then runs once
		// per command with the validated active directory, and nothing else.
		expect(harness.client.sessionImportGetterReads).toBeGreaterThan(0);
		expect(harness.latestArtifact.calls).toEqual([
			{ projectDirectory: TEST_ACTIVE_DIRECTORY },
			{ projectDirectory: TEST_ACTIVE_DIRECTORY },
		]);
		expect(harness.client.projectListCalls).toBe(0);
		expect(harness.client.locationGetInputs).toHaveLength(0);
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.artifacts.artifactIterations).toBe(0);
		expect(harness.crypto.openAndStageCalls).toBe(0);
		expect(harness.password.calls).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(0);
	});

	test("bare restore resolves the newest checkpoint and runs the same selection/auth/import flow", async () => {
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
			latestArtifact: CHECKPOINT_ARTIFACT_PATH,
		});

		await harness.handlers.restore("   ");

		expect(harness.latestArtifact.calls).toEqual([{ projectDirectory: TEST_ACTIVE_DIRECTORY }]);
		expect(harness.client.projectListCalls).toBe(1);
		expect(harness.dialog.selectCalls).toEqual([{ title: "Choose an existing project to restore into", optionCount: 1 }]);
		expect(harness.client.locationGetInputs).toEqual([{ location: { directory: TEST_DEST_DIRECTORY } }]);
		expect(harness.password.calls).toEqual([{ mode: "restore", maxPasswordBytes: EXPERIMENTAL_MAX_PASSWORD_BYTES }]);
		expect(harness.artifacts.readCalls).toEqual([CHECKPOINT_ARTIFACT_PATH]);
		expect(harness.crypto.openAndStageCalls).toBe(1);
		expect(harness.client.importInputs).toHaveLength(2);
		expect(harness.notifications).toHaveLength(0);
		expect(harness.report.models[0]?.summary.imported).toBe(2);
	});

	test("bare restore without an active directory reports a fixed message and never calls the resolver or the host", async () => {
		const harness = createWiringHarness({ activeDirectory: undefined });

		await harness.handlers.restore(undefined);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("warning");
		expect(notification.message).toContain("active project directory is unavailable");
		expect(notification.message).toContain("no sessions were changed");
		expect(harness.latestArtifact.calls).toHaveLength(0);
		expect(harness.client.projectListCalls).toBe(0);
		expect(harness.client.locationGetInputs).toHaveLength(0);
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(0);
	});

	test("bare restore capability absence precedes the latest-checkpoint resolver (O-12)", async () => {
		const harness = createWiringHarness({
			client: {
				withImport: false,
				projects: async () => {
					throw new Error("project.list must not be called");
				},
			},
			latestArtifact: CHECKPOINT_ARTIFACT_PATH,
		});

		await harness.handlers.restore(undefined);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("warning");
		expect(notification.message).toContain("session-import capability");
		expect(harness.latestArtifact.calls).toHaveLength(0);
		expect(harness.client.projectListCalls).toBe(0);
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
	});

	test("a latest-checkpoint resolution failure is sanitized and stops before destination/read/password/import", async () => {
		const rawFsMessage = "RAW-FS-DETAIL";
		const harness = createWiringHarness({
			client: {
				projects: async () => {
					throw new Error("project.list must not be called");
				},
			},
			latestArtifact: new Error(rawFsMessage),
		});

		await harness.handlers.restore(undefined);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.message).toContain("Restore failed");
		expect(notification.message).toContain("no sessions were changed");
		expect(notification.message).not.toContain(rawFsMessage);
		expect(harness.client.projectListCalls).toBe(0);
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(0);
	});

	test("an explicit artifact path bypasses the active-project lookup and resolver entirely", async () => {
		const harness = createWiringHarness({
			activeDirectory: undefined,
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.latestArtifact.calls).toHaveLength(0);
		expect(harness.artifacts.readCalls).toEqual([CHECKPOINT_ARTIFACT_PATH]);
		expect(harness.client.importInputs).toHaveLength(2);
		expect(harness.report.models[0]?.summary.imported).toBe(2);
	});

	test("canceled selection prevents location resolution, artifact read, and import", async () => {
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			dialog: { select: "cancel" },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.notifications[0]?.variant).toBe("info");
		expect(harness.client.locationGetInputs).toHaveLength(0);
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.artifacts.artifactIterations).toBe(0);
		expect(harness.crypto.openAndStageCalls).toBe(0);
		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
	});

	test("unresolved destination project mapping prevents artifact read/decrypt and import", async () => {
		const harness = createWiringHarness({
			client: {
				sessions: [],
				projects: async () => destinationProjects(),
				locationGet: async (input) => locationResponse(input.location.directory, "proj_wrong"),
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.message).toContain("could not be verified");
		expect(notification.message).not.toContain("proj_wrong");
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.artifacts.artifactIterations).toBe(0);
		expect(harness.crypto.openAndStageCalls).toBe(0);
		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.password.calls).toHaveLength(0);
	});

	test("destination directory mismatch also fails closed before any read", async () => {
		const harness = createWiringHarness({
			client: {
				sessions: [],
				projects: async () => destinationProjects(),
				locationGet: async () => locationResponse("C:/other/dir", TEST_DEST_PROJECT_ID),
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.notifications[0]?.variant).toBe("error");
		expect(harness.artifacts.readCalls).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(0);
	});

	test("wrong password: exactly three attempts, then a sanitized stop with no import", async () => {
		const rawAuthMessage = "RAW-AUTH-DETAIL";
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: {
				openAndStageErrors: [
					fakeCryptoError("authentication-failed", rawAuthMessage),
					fakeCryptoError("authentication-failed", rawAuthMessage),
					fakeCryptoError("authentication-failed", rawAuthMessage),
				],
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.password.calls).toHaveLength(3);
		expect(harness.crypto.openAndStageCalls).toBe(3);
		// Authentication must pass before the destination snapshot or any import.
		expect(harness.client.sessionListInputs).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(0);
		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.message).toContain("3 password attempts");
		expect(notification.message).not.toContain(rawAuthMessage);
	});

	test("two wrong passwords then success: the third attempt proceeds to import", async () => {
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: {
				openAndStageErrors: [
					fakeCryptoError("authentication-failed"),
					fakeCryptoError("authentication-failed"),
				],
				authenticatedBytes: parentChildArtifactBytes(),
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.password.calls).toHaveLength(3);
		expect(harness.crypto.openAndStageCalls).toBe(3);
		expect(harness.client.importInputs).toHaveLength(2);
		expect(harness.notifications).toHaveLength(0);
		expect(harness.report.models[0]?.summary.imported).toBe(2);
	});

	test("a non-authentication preflight error stops after one attempt with sanitized copy", async () => {
		const rawMessage = "RAW-TRUNCATED-DETAIL";
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: { openAndStageErrors: [fakeCryptoError("truncated-artifact", rawMessage)] },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.password.calls).toHaveLength(1);
		expect(harness.crypto.openAndStageCalls).toBe(1);
		expect(harness.client.importInputs).toHaveLength(0);
		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.message).not.toContain(rawMessage);
		expect(notification.message).toContain("could not be opened as a SessionPort checkpoint");
	});

	test("an empty checkpoint never reports success and imports nothing", async () => {
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: { authenticatedBytes: encodeJson({ sessions: [] }) },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("warning");
		expect(notification.message).toContain("no sessions");
		expect(harness.report.models).toHaveLength(0);
		expect(harness.client.importInputs).toHaveLength(0);
	});

	test("import failure is recorded per session without retry or raw host text; descendants are blocked", async () => {
		const rawImportMessage = "RAW-IMPORT-DETAIL";
		const harness = createWiringHarness({
			client: {
				sessions: [],
				projects: async () => destinationProjects(),
				importSession: async (input) => {
					const info = (input as { info: { parentID?: string } }).info;
					if (info.parentID === undefined) throw new Error(rawImportMessage);
					return sessionImportResponse(input);
				},
			},
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// One call per planned entry, ever: the parent failed and the child was blocked.
		expect(harness.client.importInputs).toHaveLength(1);

		// The partial execution is presented as per-session report facts; the
		// dialog itself renders the no-rollback notice for partial summaries.
		expect(harness.notifications).toHaveLength(0);
		expect(harness.report.models).toHaveLength(1);
		const model = harness.report.models[0]!;
		expect(model.summary).toEqual({ total: 2, imported: 0, skipped: 0, failed: 1, blocked: 1, notAttempted: 0 });
		expect(model.sessions.map((session) => session.sessionID)).toEqual(["ses_parent", "ses_child"]);
		expect(model.sessions.map((session) => session.status)).toEqual(["failed", "blocked"]);
		expect(JSON.stringify(model)).not.toContain(rawImportMessage);
	});

	test("a malformed `{}` import response becomes a failed outcome through the adapter without retry or leaked values", async () => {
		const harness = createWiringHarness({
			client: {
				sessions: [],
				projects: async () => destinationProjects(),
				// Deliberately malformed: the adapter must reject this response shape
				// instead of letting the executor record it as an import.
				importSession: async () => ({}),
			},
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// The parent's malformed response becomes a failed outcome, its child is
		// blocked, and the single attempted import is never retried.
		expect(harness.client.importInputs).toHaveLength(1);
		expect((harness.client.importInputs[0] as { info: { id: string } }).info.id).toBe("ses_parent");

		// Truthful per-session facts surface through the report-dialog path.
		expect(harness.notifications).toHaveLength(0);
		expect(harness.report.models).toHaveLength(1);
		const model = harness.report.models[0]!;
		expect(model.summary).toEqual({ total: 2, imported: 0, skipped: 0, failed: 1, blocked: 1, notAttempted: 0 });
		expect(model.sessions.map((session) => session.sessionID)).toEqual(["ses_parent", "ses_child"]);
		expect(model.sessions.map((session) => session.status)).toEqual(["failed", "blocked"]);

		// Neither the malformed response nor the sanitized adapter detail leaks.
		const serialized = JSON.stringify(model);
		expect(serialized).not.toContain("invalid-response");
		expect(serialized).not.toContain("projectID");
		expect(serialized).not.toContain("location");
	});

	test("a dialog-display failure after a clean execution falls back to bounded aggregate-only copy", async () => {
		const rawDialogMessage = "RAW-DIALOG-DETAIL";
		const harness = createWiringHarness({
			client: { sessions: [], projects: async () => destinationProjects() },
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
			report: { showError: new Error(rawDialogMessage) },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// The model was mapped and handed to the dialog before the display failure.
		expect(harness.report.models).toHaveLength(1);
		expect(harness.report.models[0]?.summary.imported).toBe(2);
		expect(harness.client.importInputs).toHaveLength(2);

		// Execution completed: the fallback reports it as finished, aggregate-only.
		expect(harness.notifications).toHaveLength(1);
		const notification = harness.notifications[0]!;
		expect(notification.title).toBe("Restore finished");
		expect(notification.variant).toBe("success");
		expect(notification.message).toContain("2 imported");
		expect(notification.message).toContain("could not be displayed");
		expect(notification.message).not.toContain(rawDialogMessage);
		expect(notification.message).not.toContain("ses_parent");
		expect(notification.message).not.toContain("ses_child");
		expect(notification.message).not.toContain("Restore failed");
		expect(notification.message).not.toContain("no sessions were changed");
	});

	test("a dialog-display failure on a partial execution keeps the no-rollback notice", async () => {
		const rawDialogMessage = "RAW-DIALOG-DETAIL";
		const rawImportMessage = "RAW-IMPORT-DETAIL";
		const harness = createWiringHarness({
			client: {
				sessions: [],
				projects: async () => destinationProjects(),
				importSession: async (input) => {
					const info = (input as { info: { parentID?: string } }).info;
					if (info.parentID === undefined) throw new Error(rawImportMessage);
					return sessionImportResponse(input);
				},
			},
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
			report: { showError: new Error(rawDialogMessage) },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.report.models).toHaveLength(1);
		expect(harness.notifications).toHaveLength(1);
		const notification = harness.notifications[0]!;
		expect(notification.title).toBe("Restore finished");
		expect(notification.variant).toBe("warning");
		expect(notification.message).toContain("1 failed");
		expect(notification.message).toContain("1 blocked");
		expect(notification.message).toContain("no atomic rollback");
		expect(notification.message).not.toContain(rawDialogMessage);
		expect(notification.message).not.toContain(rawImportMessage);
		expect(notification.message).not.toContain("ses_parent");
		expect(notification.message).not.toContain("ses_child");
	});

	/* ------------------------------------------------------------------ */
	/* Cross-project collision amendment (2026-10-14)                      */
	/* ------------------------------------------------------------------ */

	test("an external source ID visible in another project imports under a deterministic derived ID", async () => {
		const sessions = [sessionRecord("ses_remote", [], FOREIGN_PROJECT_ID)];
		const harness = createWiringHarness({
			client: {
				projects: async () => destinationAndForeignProjects(),
				sessions,
			},
			crypto: {
				authenticatedBytes: encodeJson({
					sessions: [sessionRecord("ses_remote", [userMessage("msg_remote")], "proj_source")],
				}),
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// The inventory reused the selection candidates (one project.list call),
		// the selected target was resolved once, and no message was read from any
		// project: the destination is empty and the foreign scan is metadata-only.
		expect(harness.client.projectListCalls).toBe(1);
		expect(harness.client.locationGetInputs).toEqual([{ location: { directory: TEST_DEST_DIRECTORY } }]);
		expect(harness.client.messageListInputs).toEqual([]);
		expect(harness.client.sessionListInputs.map((input) => input.project)).toContain(FOREIGN_PROJECT_ID);

		// One import: the source ID is occupied outside the selected destination,
		// so it is deterministically renamed (session and message IDs), while the
		// explicit target directory is unchanged.
		expect(harness.client.importInputs).toHaveLength(1);
		const imported = harness.client.importInputs[0] as {
			info: { id: string; projectID: string };
			messages: Array<{ id: string }>;
			location: { directory: string };
		};
		expect(imported.info.id).toBe(deriveTestId("session", "ses_remote"));
		expect(imported.info.id).not.toBe("ses_remote");
		expect(imported.messages[0]?.id).toBe(deriveTestId("message", "msg_remote"));
		expect(imported.location).toEqual({ directory: TEST_DEST_DIRECTORY });

		// The report stays truthful about the source ID and classification.
		expect(harness.notifications).toHaveLength(0);
		expect(harness.report.models[0]?.summary).toEqual({
			total: 1,
			imported: 1,
			skipped: 0,
			failed: 0,
			blocked: 0,
			notAttempted: 0,
		});
		expect(harness.report.models[0]?.sessions.map((session) => session.sessionID)).toEqual(["ses_remote"]);
		// The command never mutated host-visible state itself: the fake client
		// still holds exactly the foreign occupancy record it started with.
		expect(sessions).toHaveLength(1);
	});

	test("a manual rerun recognizes the deterministic remapped target as an exact skip and imports nothing", async () => {
		// The selected destination starts empty; the foreign project already
		// holds the source ID, forcing the deterministic remap on the first run.
		const sessions: SessionRecord[] = [sessionRecord("ses_retry", [], FOREIGN_PROJECT_ID)];
		const harness = createWiringHarness({
			client: {
				projects: async () => destinationAndForeignProjects(),
				sessions,
			},
			crypto: {
				// The artifact record uses the destination project so the imported
				// record can be read back under the selected destination scope.
				authenticatedBytes: encodeJson({
					sessions: [sessionRecord("ses_retry", [userMessage("msg_retry")], TEST_DEST_PROJECT_ID)],
				}),
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		expect(harness.client.importInputs).toHaveLength(1);
		const imported = harness.client.importInputs[0] as { info: JsonObject; messages: JsonObject[] };
		const derivedTargetID = imported.info["id"];
		expect(derivedTargetID).toBe(deriveTestId("session", "ses_retry"));

		// Seed the destination with exactly what the public import received (the
		// fake host stores the imported record) and rerun the same command.
		sessions.push({ info: imported.info, messages: imported.messages });
		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// No new import: the deterministic derived target is recognized as the
		// exact planned retry (no regeneration, no overwrite, no re-import).
		expect(harness.client.importInputs).toHaveLength(1);
		const rerunModel = harness.report.models[1]!;
		expect(rerunModel.summary).toEqual({
			total: 1,
			imported: 0,
			skipped: 1,
			failed: 0,
			blocked: 0,
			notAttempted: 0,
		});
		expect(rerunModel.sessions[0]?.classification).toBe("skipped");
		expect(rerunModel.sessions[0]?.skipReason).toBe("exact-planned-retry");

		// No overwrite and no new record: the seeded destination record is
		// untouched and no additional session was added to the fake host.
		expect(sessions).toHaveLength(2);
		expect(sessions[1]?.info["id"]).toBe(derivedTargetID);
	});

	test("a deterministic derived ID occupied outside the selected destination fails closed with zero imports", async () => {
		const externallyOccupiedDerivedID = deriveTestId("session", "ses_ext");
		const harness = createWiringHarness({
			client: {
				projects: async () => destinationAndForeignProjects(),
				sessions: [
					sessionRecord("ses_ext", [], FOREIGN_PROJECT_ID),
					sessionRecord(externallyOccupiedDerivedID, [], FOREIGN_PROJECT_ID),
				],
			},
			crypto: {
				authenticatedBytes: encodeJson({
					sessions: [sessionRecord("ses_ext", [userMessage("msg_ext")], "proj_source")],
				}),
			},
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// The externally occupied derived target fails the planner before any
		// import; the sanitized failure copy never echoes IDs or host text.
		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.report.models).toHaveLength(0);
		expect(harness.notifications).toHaveLength(1);
		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.title).toBe("Restore failed");
		expect(notification.message).toContain("does not match this destination safely");
		expect(notification.message).toContain("no sessions were changed");
		expect(notification.message).not.toContain("ses_ext");
		expect(notification.message).not.toContain(externallyOccupiedDerivedID);
	});

	test("an inventory read failure after the destination read fails closed with zero imports and sanitized copy", async () => {
		const rawInventoryMessage = "RAW-INVENTORY-DETAIL";
		const harness = createWiringHarness({
			client: {
				projects: async () => destinationAndForeignProjects(),
				sessionList: async (input) => {
					if (input.project === FOREIGN_PROJECT_ID) throw new Error(rawInventoryMessage);
					return { data: [], cursor: null };
				},
			},
			crypto: { authenticatedBytes: parentChildArtifactBytes() },
		});

		await harness.handlers.restore(CHECKPOINT_ARTIFACT_PATH);

		// The destination snapshot was read first, then the inventory failed on
		// the foreign project: nothing was planned or imported, and the failure
		// is reported through the existing sanitized collection category.
		expect(harness.client.sessionListInputs[0]?.project).toBe(TEST_DEST_PROJECT_ID);
		expect(harness.client.sessionListInputs.at(-1)?.project).toBe(FOREIGN_PROJECT_ID);
		expect(harness.client.importInputs).toHaveLength(0);
		expect(harness.report.models).toHaveLength(0);
		const notification = harness.notifications[0]!;
		expect(notification.variant).toBe("error");
		expect(notification.title).toBe("Restore failed");
		expect(notification.message).toContain("could not be read");
		expect(notification.message).toContain("no sessions were changed");
		expect(notification.message).not.toContain(rawInventoryMessage);
	});
});
