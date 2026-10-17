/**
 * SessionPort project-destinations adapter tests (Phase 4, non-visual lane).
 *
 * Fake public clients only: no real host calls, no filesystem, no Git, no
 * model calls. These tests pin the declaration-derived candidate mapping,
 * fail-closed response validation, conservative duplicate/ambiguity handling,
 * and receiver-preserving `project.list` invocation. They are not runtime
 * validation of a live host and make no mapping or support claim: candidate
 * `{ projectID, targetDirectory }` pairs remain declaration/source-derived and
 * require runtime validation before restore use (OQ-16 stays OPEN).
 */

import { describe, expect, test } from "bun:test";
import {
	createProjectDestinationsAdapter,
	HostAdapterError,
	mapProjectListResponse,
	ProjectDestinationError,
} from "../../../src/tui/adapters/index.ts";

/** Distinctive message thrown by the fake when `this` is not the owning object. */
const DETACHED = "invoked without its owning project object as receiver";

interface ReceiverDependentProjectOwner {
	readonly ownerTag: string;
	list(...args: unknown[]): Promise<unknown>;
}

interface ReceiverDependentProjectClientHandle {
	readonly client: unknown;
	readonly project: ReceiverDependentProjectOwner;
	readonly calls: unknown[][];
}

/**
 * Fake `project` surface whose `list` verifies `this` is the exact owning
 * object before recording the argument list. Detached invocation throws a
 * distinctive error instead of silently working, so the adapter test fails if
 * the resolver wrapper loses the receiver.
 */
function createReceiverDependentProjectClient(response: unknown): ReceiverDependentProjectClientHandle {
	const calls: unknown[][] = [];
	const project: ReceiverDependentProjectOwner = {
		ownerTag: "project-owner",
		async list(...args: unknown[]): Promise<unknown> {
			if (this !== project || this.ownerTag !== "project-owner") {
				throw new Error(`project.list ${DETACHED}`);
			}
			calls.push(args);
			return response;
		},
	};
	return { client: { project }, project, calls };
}

/** Captures and asserts a thrown `HostAdapterError` (returns it for code checks). */
function captureHostAdapterError(run: () => unknown): HostAdapterError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(HostAdapterError);
		return error as HostAdapterError;
	}
	throw new Error("expected a HostAdapterError");
}

/** Captures and asserts a thrown `ProjectDestinationError` (returns it for code checks). */
function captureProjectDestinationError(run: () => unknown): ProjectDestinationError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(ProjectDestinationError);
		return error as ProjectDestinationError;
	}
	throw new Error("expected a ProjectDestinationError");
}

describe("project.list capability detection", () => {
	test("fails closed with capability-unavailable when project.list is absent or not callable", () => {
		const clients: unknown[] = [
			{},
			{ project: {} },
			{ project: { list: 42 } },
			{ project: { list: null } },
			{ project: { list: "list" } },
			{ project: { list: {} } },
			{ project: "not-an-object" },
			null,
			undefined,
			"client",
			[],
		];
		for (const client of clients) {
			const error = captureHostAdapterError(() => createProjectDestinationsAdapter(client));
			expect(error.code).toBe("capability-unavailable");
			expect(error.message).toContain("project.list");
		}
	});
});

describe("project.list receiver binding", () => {
	test("harness self-check: the receiver-dependent fake fails when detached", async () => {
		const { project } = createReceiverDependentProjectClient([]);
		const detached = project.list;
		await expect(detached()).rejects.toThrow(DETACHED);
	});

	test("invokes project.list with the owning project object preserved", async () => {
		const response = [
			{ id: "proj-1", canonical: "C:/work/one", name: "Work one", sandboxes: ["C:/work/one-sandbox"] },
		];
		const { client, calls } = createReceiverDependentProjectClient(response);
		const adapter = createProjectDestinationsAdapter(client);

		const candidates = await adapter.listDestinations();

		expect(calls).toHaveLength(1);
		expect(calls[0]!.every((argument) => argument === undefined)).toBe(true);
		expect(candidates).toEqual([{ projectID: "proj-1", targetDirectory: "C:/work/one", label: "Work one" }]);
	});
});

describe("candidate mapping", () => {
	test("maps projectID, verbatim canonical as targetDirectory, and name/canonical label fallback", () => {
		const candidates = mapProjectListResponse([
			{ id: "proj-1", canonical: "C:/work/one/", name: "Work one", sandboxes: [], vcs: "git" },
			{ id: "proj-2", canonical: "D:/other", sandboxes: ["D:/other-sandbox"] },
			{ id: "proj-3", canonical: "E:/third", name: "" },
			{ id: "proj-4", canonical: "F:/fourth", name: "   " },
		]);

		expect(candidates).toEqual([
			{ projectID: "proj-1", targetDirectory: "C:/work/one/", label: "Work one" },
			{ projectID: "proj-2", targetDirectory: "D:/other", label: "D:/other" },
			{ projectID: "proj-3", targetDirectory: "E:/third", label: "E:/third" },
			{ projectID: "proj-4", targetDirectory: "F:/fourth", label: "F:/fourth" },
		]);
	});

	test("returns an empty candidate set for an empty project list", () => {
		expect(mapProjectListResponse([])).toEqual([]);
	});

	test("never uses sandboxes or unrelated project fields", () => {
		const candidates = mapProjectListResponse([
			{
				id: "proj-1",
				canonical: "C:/work/one",
				name: "Work one",
				sandboxes: ["C:/sandbox-a", "C:/sandbox-b"],
				icon: { url: "https://example.invalid/icon" },
				commands: { start: "opencode" },
				vcs: "git",
				time: { created: 1, updated: 2, active: 3 },
			},
		]);

		expect(candidates).toHaveLength(1);
		const candidate = candidates[0]!;
		expect(Object.keys(candidate).sort()).toEqual(["label", "projectID", "targetDirectory"]);
		expect(JSON.stringify(candidate)).not.toContain("sandbox");
	});
});

describe("fail-closed response validation", () => {
	test("rejects non-array responses", () => {
		for (const response of [null, undefined, {}, "projects", 42, true]) {
			const error = captureProjectDestinationError(() => mapProjectListResponse(response));
			expect(error.code).toBe("invalid-response");
		}
	});

	test("rejects malformed records instead of skipping them", () => {
		const malformed: unknown[] = [
			null,
			"project",
			42,
			[],
			{ canonical: "C:/work/one" },
			{ id: "proj-1" },
			{ id: "", canonical: "C:/work/one" },
			{ id: "   ", canonical: "C:/work/one" },
			{ id: 7, canonical: "C:/work/one" },
			{ id: "proj-1", canonical: "" },
			{ id: "proj-1", canonical: "   " },
			{ id: "proj-1", canonical: 7 },
			{ id: "proj-1", canonical: "C:/work/one", name: 7 },
			{ id: "proj-1", canonical: "C:/work/one", name: null },
		];
		for (const record of malformed) {
			const error = captureProjectDestinationError(() => mapProjectListResponse([record]));
			expect(error.code).toBe("invalid-response");
		}
	});

	test("one malformed record fails the whole list (no silent skip)", () => {
		const error = captureProjectDestinationError(() =>
			mapProjectListResponse([
				{ id: "proj-1", canonical: "C:/work/one" },
				{ id: "proj-2", canonical: "C:/work/two", name: 42 },
				{ id: "proj-3", canonical: "C:/work/three" },
			]),
		);
		expect(error.code).toBe("invalid-response");
		expect(error.message).toContain("2 of 3");
	});

	test("error text never carries project data", () => {
		const error = captureProjectDestinationError(() =>
			mapProjectListResponse([
				{ id: "secret-project-id", canonical: "C:/secret/path" },
				{ id: "secret-project-id", canonical: "C:/other/secret-path" },
			]),
		);
		expect(error.code).toBe("invalid-response");
		expect(error.message).not.toContain("secret-project-id");
		expect(error.message).not.toContain("C:/secret/path");
		expect(error.message).not.toContain("C:/other/secret-path");
	});
});

describe("conservative duplicate and ambiguity handling", () => {
	test("deduplicates only unambiguously identical entries and keeps host order", () => {
		const candidates = mapProjectListResponse([
			{ id: "proj-1", canonical: "C:/work/one", name: "Work one" },
			{ id: "proj-1", canonical: "C:/work/one", name: "Work one" },
			{ id: "proj-2", canonical: "C:/work/two", name: "Work two" },
			{ id: "proj-1", canonical: "C:/work/one", name: "Work one" },
		]);

		expect(candidates).toEqual([
			{ projectID: "proj-1", targetDirectory: "C:/work/one", label: "Work one" },
			{ projectID: "proj-2", targetDirectory: "C:/work/two", label: "Work two" },
		]);
	});

	test("rejects conflicting projectID/canonical values", () => {
		const conflicting: unknown[][] = [
			[
				{ id: "proj-1", canonical: "C:/work/one" },
				{ id: "proj-1", canonical: "C:/work/other" },
			],
			[
				{ id: "proj-1", canonical: "C:/work/one" },
				{ id: "proj-2", canonical: "C:/work/one" },
			],
			[
				{ id: "proj-1", canonical: "C:/work/one", name: "One" },
				{ id: "proj-1", canonical: "C:/work/one", name: "Two" },
			],
		];
		for (const records of conflicting) {
			const error = captureProjectDestinationError(() => mapProjectListResponse(records));
			expect(error.code).toBe("invalid-response");
		}
	});
});

describe("adapter listDestinations behavior", () => {
	test("propagates malformed host responses as invalid-response through the adapter", async () => {
		const { client } = createReceiverDependentProjectClient({ not: "an array" });
		const adapter = createProjectDestinationsAdapter(client);

		await expect(adapter.listDestinations()).rejects.toMatchObject({
			name: "ProjectDestinationError",
			code: "invalid-response",
		});
	});

	test("propagates host rejections unchanged (no wrapping, retry, or swallowing)", async () => {
		const hostError = Object.assign(new Error("project list rejected"), { name: "HostApiError", status: 500 });
		const calls: unknown[][] = [];
		const client = {
			project: {
				async list(...args: unknown[]): Promise<unknown> {
					calls.push(args);
					throw hostError;
				},
			},
		};
		const adapter = createProjectDestinationsAdapter(client);

		await expect(adapter.listDestinations()).rejects.toBe(hostError);
		expect(calls).toHaveLength(1);
	});
});
