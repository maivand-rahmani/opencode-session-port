/**
 * Focused tests for the experimental `location.get` project resolver.
 *
 * Synthetic fake clients only: no real host call is made, and no runtime,
 * compatibility, or support claim follows. OQ-16 remains OPEN; the deliberate
 * E42 `location.get` project-persistence side effect is exercised only against
 * fakes here.
 */

import { describe, expect, test } from "bun:test";
import {
	createLocationResolver,
	LocationResolutionError,
} from "../../../src/tui/adapters/location-resolver.ts";

const DIRECTORY = "C:/work/project";
const PROJECT_ID = "proj_abc";

interface GetCall {
	readonly location: { readonly directory: string };
}

function recordingClient(response: unknown): { readonly client: unknown; readonly calls: GetCall[] } {
	const calls: GetCall[] = [];
	const client = {
		location: {
			async get(input: GetCall): Promise<unknown> {
				calls.push({ location: { directory: input.location.directory } });
				return response;
			},
		},
	};
	return { client, calls };
}

function validResponse(directory = DIRECTORY, projectID = PROJECT_ID): unknown {
	return { directory, project: { id: projectID, directory, canonical: directory } };
}

describe("createLocationResolver", () => {
	test("fails closed with capability-unavailable when location.get is absent or not callable", () => {
		for (const client of [{}, { location: {} }, { location: { get: 42 } }, null]) {
			try {
				createLocationResolver(client);
				throw new Error("expected createLocationResolver to reject capability absence");
			} catch (error) {
				expect(error).toBeInstanceOf(LocationResolutionError);
				expect((error as LocationResolutionError).code).toBe("capability-unavailable");
			}
		}
	});

	test("resolveActiveProject sends exactly { location: { directory } } and returns the exact match", async () => {
		const { client, calls } = recordingClient(validResponse());
		const resolved = await createLocationResolver(client).resolveActiveProject(DIRECTORY);

		expect(calls).toEqual([{ location: { directory: DIRECTORY } }]);
		expect(resolved).toEqual({ projectID: PROJECT_ID, directory: DIRECTORY });
	});

	test("resolveActiveProject rejects a blank directory without any host call", async () => {
		const { client, calls } = recordingClient(validResponse());

		for (const blank of [undefined, "", "   ", 42]) {
			await expect(createLocationResolver(client).resolveActiveProject(blank as unknown as string)).rejects.toMatchObject({
				code: "invalid-request",
			});
		}
		expect(calls).toHaveLength(0);
	});

	test("rejects malformed responses fail-closed without exposing values in the message", async () => {
		const malformed: unknown[] = [
			undefined,
			null,
			"nope",
			[],
			{},
			{ directory: DIRECTORY },
			{ directory: DIRECTORY, project: null },
			{ directory: DIRECTORY, project: {} },
			{ directory: DIRECTORY, project: { id: "   ", directory: DIRECTORY } },
			{ directory: DIRECTORY, project: { id: PROJECT_ID } },
			{ directory: DIRECTORY, project: { id: PROJECT_ID, directory: "   " } },
			{ directory: "   ", project: { id: PROJECT_ID, directory: DIRECTORY } },
		];

		for (const response of malformed) {
			const { client } = recordingClient(response);
			try {
				await createLocationResolver(client).resolveActiveProject(DIRECTORY);
				throw new Error("expected a malformed response to reject");
			} catch (error) {
				expect(error).toBeInstanceOf(LocationResolutionError);
				const resolutionError = error as LocationResolutionError;
				expect(["invalid-response", "mismatch"]).toContain(resolutionError.code);
				expect(resolutionError.message).not.toContain(DIRECTORY);
				expect(resolutionError.message).not.toContain(PROJECT_ID);
			}
		}
	});

	test("rejects directory and project.directory mismatches with a mismatch code", async () => {
		for (const response of [
			validResponse("C:/work/other"),
			{ directory: DIRECTORY, project: { id: PROJECT_ID, directory: "C:/work/other", canonical: "C:/work/other" } },
		]) {
			const { client } = recordingClient(response);
			await expect(createLocationResolver(client).resolveActiveProject(DIRECTORY)).rejects.toMatchObject({
				code: "mismatch",
			});
		}
	});

	test("resolveSelectedProject requires the exact candidate project ID and directory", async () => {
		const { client, calls } = recordingClient(validResponse());
		const resolved = await createLocationResolver(client).resolveSelectedProject({
			projectID: PROJECT_ID,
			targetDirectory: DIRECTORY,
		});

		expect(calls).toEqual([{ location: { directory: DIRECTORY } }]);
		expect(resolved).toEqual({ projectID: PROJECT_ID, directory: DIRECTORY });
	});

	test("resolveSelectedProject rejects a mismatched project ID before returning", async () => {
		const { client } = recordingClient(validResponse(DIRECTORY, "proj_other"));
		await expect(
			createLocationResolver(client).resolveSelectedProject({ projectID: PROJECT_ID, targetDirectory: DIRECTORY }),
		).rejects.toMatchObject({ code: "mismatch" });
	});

	test("resolveSelectedProject rejects malformed candidates without a host call", async () => {
		const { client, calls } = recordingClient(validResponse());

		await expect(
			createLocationResolver(client).resolveSelectedProject({ projectID: "  ", targetDirectory: DIRECTORY }),
		).rejects.toMatchObject({ code: "invalid-request" });
		await expect(
			createLocationResolver(client).resolveSelectedProject({ projectID: PROJECT_ID, targetDirectory: "" }),
		).rejects.toMatchObject({ code: "invalid-request" });
		await expect(
			createLocationResolver(client).resolveSelectedProject(null as unknown as { projectID: string; targetDirectory: string }),
		).rejects.toMatchObject({ code: "invalid-request" });
		expect(calls).toHaveLength(0);
	});

	test("host rejections propagate unchanged", async () => {
		const hostError = new Error("host transport failed");
		const client = {
			location: {
				async get(): Promise<unknown> {
					throw hostError;
				},
			},
		};

		await expect(createLocationResolver(client).resolveActiveProject(DIRECTORY)).rejects.toBe(hostError);
	});

	test("invokes location.get with the owning location object as receiver", async () => {
		const client = {
			location: {
				marker: "receiver-project",
				async get(input: GetCall): Promise<unknown> {
					return {
						directory: input.location.directory,
						project: {
							id: (this as { marker: string }).marker,
							directory: input.location.directory,
							canonical: input.location.directory,
						},
					};
				},
			},
		};

		const resolved = await createLocationResolver(client).resolveActiveProject(DIRECTORY);
		expect(resolved.projectID).toBe("receiver-project");
	});
});
