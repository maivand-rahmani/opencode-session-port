/**
 * Native-delete adapter tests (`session-delete.ts`).
 *
 * Synthetic fake clients only: no real host call, no delete, no filesystem,
 * crypto, Git, or model call. These tests pin the frozen allowed-ID plan, the
 * single-DELETE-per-ID rule (including uncertain throws), the fixed redacted
 * outcomes, and the typed copy-only capability fallback. The live native call
 * remains unverified until the parent host probe runs.
 */

import { describe, expect, test } from "bun:test";
import { HostAdapterError } from "../../../src/tui/adapters/host-client.ts";
import {
	createSessionDeletePort,
	probeSessionDeleteCapability,
	type SessionDeletePort,
} from "../../../src/tui/adapters/session-delete.ts";

interface FakeDeleteHandle {
	readonly client: unknown;
	readonly calls: unknown[];
}

/** Recording fake of the public native-delete surface. */
function createFakeDeleteClient(handler?: (input: unknown) => unknown | Promise<unknown>): FakeDeleteHandle {
	const calls: unknown[] = [];
	const client = {
		session: {
			async remove(input: unknown): Promise<unknown> {
				calls.push(input);
				return handler ? handler(input) : undefined;
			},
			async list(): Promise<unknown> {
				throw new Error("session.list must never be called by the delete adapter");
			},
		},
	};
	return { client, calls };
}

function createPort(client: unknown, allowedSessionIDs: readonly string[] = ["ses_old"]): SessionDeletePort {
	return createSessionDeletePort(client, { allowedSessionIDs });
}

/* ------------------------------------------------------------------------- */
/* Capability probe                                                          */
/* ------------------------------------------------------------------------- */

describe("session delete capability probe", () => {
	test("reports a callable remove without invoking it", () => {
		const handle = createFakeDeleteClient();
		expect(probeSessionDeleteCapability(handle.client)).toEqual({ available: true });
		expect(handle.calls).toEqual([]);
	});

	test("reports missing and non-callable remove as unavailable copy-only", () => {
		for (const client of [
			{ session: {} },
			{ session: { remove: 42 } },
			{ session: { remove: null } },
			{},
			null,
			"not-a-client",
		]) {
			expect(probeSessionDeleteCapability(client)).toMatchObject({
				available: false,
				fallback: "copy-only",
			});
		}
	});

	test("never throws when the client getter throws", () => {
		const hostile = {
			get session(): never {
				throw new Error("host getter secret");
			},
		};
		expect(() => probeSessionDeleteCapability(hostile)).not.toThrow();
		expect(probeSessionDeleteCapability(hostile)).toMatchObject({ available: false, fallback: "copy-only" });
	});
});

/* ------------------------------------------------------------------------- */
/* Allowed-ID scope and single-DELETE rule                                   */
/* ------------------------------------------------------------------------- */

describe("native delete scope", () => {
	test("deletes exactly one allowed old ID once and never retries", async () => {
		const handle = createFakeDeleteClient();
		const port = createPort(handle.client, ["ses_old"]);

		expect(await port.removeSession("ses_old")).toEqual({ status: "deleted", sessionID: "ses_old" });
		expect(handle.calls).toEqual([{ sessionID: "ses_old" }]);

		expect(await port.removeSession("ses_old")).toEqual({
			status: "not-retried",
			sessionID: "ses_old",
			reason: "delete-already-attempted",
		});
		expect(handle.calls).toEqual([{ sessionID: "ses_old" }]);
	});

	test("refuses candidate and non-allowed IDs without a host call", async () => {
		const handle = createFakeDeleteClient();
		const port = createPort(handle.client, ["ses_old"]);

		for (const id of ["ses_candidate", "ses_new", "proj_1", "ses_other"]) {
			expect(await port.removeSession(id)).toEqual({
				status: "refused",
				sessionID: id,
				reason: "session-id-not-allowed",
			});
		}
		expect(handle.calls).toEqual([]);
	});

	test("freezes the allowed-ID plan at construction", async () => {
		const handle = createFakeDeleteClient();
		const mutableAllowed = ["ses_old"];
		const port = createPort(handle.client, mutableAllowed);
		mutableAllowed.push("ses_added_later");

		expect(await port.removeSession("ses_added_later")).toMatchObject({ status: "refused" });
		expect(await port.removeSession("ses_old")).toMatchObject({ status: "deleted" });
		expect(handle.calls).toEqual([{ sessionID: "ses_old" }]);
	});

	test("deduplicates no contradictory plan: duplicate allowed IDs fail closed", () => {
		const handle = createFakeDeleteClient();
		expect(() => createPort(handle.client, ["ses_old", "ses_old"])).toThrow(HostAdapterError);
		expect(() => createPort(handle.client, ["ses_old", "ses_old"])).toThrow(/ambiguous delete plan/);
		expect(handle.calls).toEqual([]);
	});

	test("rejects malformed allowed-ID inputs before any host call", () => {
		const handle = createFakeDeleteClient();
		const invalidPlans: readonly unknown[] = [undefined, null, "ses_old", {}, [""], [1], [null]];
		for (const allowedSessionIDs of invalidPlans) {
			expect(() =>
				createSessionDeletePort(handle.client, { allowedSessionIDs } as unknown as {
					readonly allowedSessionIDs: readonly string[];
				}),
			).toThrow(HostAdapterError);
		}
		expect(handle.calls).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- */
/* Fixed redacted outcomes                                                   */
/* ------------------------------------------------------------------------- */

describe("native delete outcomes", () => {
	test("a thrown host call is uncertain, and is never retried", async () => {
		const hostSecret = "host-response-value-that-must-not-leak";
		const handle = createFakeDeleteClient(async () => {
			throw new Error(hostSecret);
		});
		const port = createPort(handle.client, ["ses_old"]);

		const first = await port.removeSession("ses_old");
		expect(first).toEqual({ status: "uncertain", sessionID: "ses_old", reason: "delete-call-threw" });
		expect(JSON.stringify(first)).not.toContain(hostSecret);

		const second = await port.removeSession("ses_old");
		expect(second).toEqual({
			status: "not-retried",
			sessionID: "ses_old",
			reason: "delete-already-attempted",
		});
		expect(handle.calls).toHaveLength(1);
		expect(JSON.stringify(second)).not.toContain(hostSecret);
	});

	test("concurrent calls for one ID issue at most one DELETE", async () => {
		let release: (() => void) | undefined;
		const handle = createFakeDeleteClient(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const port = createPort(handle.client, ["ses_old"]);

		const first = port.removeSession("ses_old");
		const second = port.removeSession("ses_old");

		expect(await second).toMatchObject({ status: "not-retried" });
		expect(handle.calls).toHaveLength(1);
		release?.();
		expect(await first).toEqual({ status: "deleted", sessionID: "ses_old" });
		expect(handle.calls).toHaveLength(1);
	});

	test("missing capability is a typed copy-only fallback, not a construction error", async () => {
		const port = createPort({ session: {} }, ["ses_old"]);
		expect(port.capability).toMatchObject({ available: false, fallback: "copy-only" });
		expect(await port.removeSession("ses_old")).toEqual({
			status: "capability-unavailable",
			sessionID: "ses_old",
			reason: "session-remove-unavailable",
			fallback: "copy-only",
		});
	});

	test("a throwing client getter is a typed copy-only fallback", async () => {
		const hostile = {
			get session(): never {
				throw new Error("host getter secret");
			},
		};
		const port = createPort(hostile, ["ses_old"]);
		expect(port.capability).toMatchObject({ available: false, fallback: "copy-only" });
		expect(await port.removeSession("ses_old")).toMatchObject({
			status: "capability-unavailable",
			fallback: "copy-only",
		});
	});

	test("only the explicit allowed old ID can reach session.remove", async () => {
		const accessed: string[] = [];
		const calls: unknown[] = [];
		const client = new Proxy(
			{},
			{
				get(_target, property) {
					accessed.push(String(property));
					if (property === "session") {
						return {
							async remove(input: unknown): Promise<void> {
								calls.push(input);
							},
						};
					}
					return undefined;
				},
			},
		);

		const port = createPort(client, ["ses_old"]);
		expect(await port.removeSession("ses_new_candidate")).toMatchObject({ status: "refused" });
		expect(await port.removeSession("ses_old")).toMatchObject({ status: "deleted" });
		expect(calls).toEqual([{ sessionID: "ses_old" }]);
		expect(accessed).toContain("session");
		expect(accessed).not.toContain("import");
		expect(accessed).not.toContain("message");
	});
});
