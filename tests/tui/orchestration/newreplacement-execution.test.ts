/**
 * Deterministic tests for the bounded 0.1.7 standalone replacement engine.
 *
 * Synthetic records and fake import/read/inventory/recovery/delete ports only.
 * The executor itself is wired to the real `src/core/restore/replacement.ts`
 * exports, so every preview, fingerprint, classifier, and verifier path below
 * exercises that real policy. No host call, crypto, password, filesystem, or UI
 * effect is performed. These tests pin preview/confirmation behavior,
 * replacement ordering, copy/import downgrades, no-delete gates, one-shot
 * delete reconciliation, and display-safe reports. They do not claim a live
 * host result or production policy.
 */

import { expect, test } from "bun:test";
import type { JsonObject, SessionRecord } from "../../../src/core/contracts/index.ts";
import type { SessionImportAdapter } from "../../../src/tui/adapters/index.ts";
import {
	createReplacementDeletePortFactory,
	createReplacementReferenceInventoryReader,
	referenceInventoryFromAdapter,
	runRestoreReplacementExecution,
	type ReplacementDeleteOutcome,
	type ReplacementDeletePort,
	type ReplacementReferenceInventory,
	type RestoreReplacementExecutionInput,
	type StandaloneRestorePlanEntry,
} from "../../../src/tui/orchestration/newreplacement-execution.ts";
import type { SessionReferenceInventoryResult } from "../../../src/tui/adapters/session-reference-inventory.ts";

const TARGET = {
	directory: "C:/work/target",
	projectID: "proj_target",
	canonicalProjectID: "proj_target",
} as const;

function record(
	id: string,
	options: {
		readonly title?: string;
		readonly messages?: readonly JsonObject[];
		readonly projectID?: string;
		readonly info?: Readonly<Record<string, unknown>>;
	} = {},
): SessionRecord {
	return {
		info: {
			id,
			projectID: options.projectID ?? TARGET.projectID,
			title: options.title ?? `title ${id}`,
			time: { created: 1, updated: 1000 },
			location: { directory: TARGET.directory },
			...(options.info ?? {}),
		} as JsonObject,
		messages: [...(options.messages ?? [{ id: `msg_${id}`, type: "user", text: `text ${id}` }])] as JsonObject[],
	};
}

interface HarnessOptions {
	readonly entries: readonly StandaloneRestorePlanEntry[];
	readonly destination?: readonly SessionRecord[];
	readonly sourceRecords?: readonly SessionRecord[];
	readonly globalInventory?: ReplacementReferenceInventory;
	readonly confirm?: (preview: unknown) => boolean | Promise<boolean>;
	readonly importResponse?: (request: { record: SessionRecord; target: { directory: string } }, call: number) => unknown;
	readonly readSession?: (sessionID: string, call: number) => SessionRecord | undefined | Promise<SessionRecord | undefined>;
	readonly inventory?: ReplacementReferenceInventory | ((call: number) => ReplacementReferenceInventory | Promise<ReplacementReferenceInventory>);
	readonly recovery?: { verified: boolean; path?: string } | ((records: readonly SessionRecord[], call: number) => { verified: boolean; path?: string } | Promise<{ verified: boolean; path?: string }>);
	readonly deleteCapability?: boolean;
	readonly deleteOutcome?: ReplacementDeleteOutcome | ((sessionID: string, call: number) => ReplacementDeleteOutcome);
	readonly deleteThrows?: boolean;
	readonly removeLiveOnDeleted?: boolean;
	readonly clock?: () => number;
}

interface Harness {
	readonly input: RestoreReplacementExecutionInput;
	readonly events: string[];
	readonly deleteIDs: string[];
	readonly factoryScopes: readonly (readonly string[])[];
	readonly imported: SessionRecord[];
}

function makeHarness(options: HarnessOptions): Harness {
	const events: string[] = [];
	const deleteIDs: string[] = [];
	const factoryScopes: string[][] = [];
	const imported: SessionRecord[] = [];
	const live = new Map<string, SessionRecord>();
	const destination = options.destination ?? options.entries.map((entry) => record(entry.sourceSessionID));
	for (const value of destination) live.set(String((value.info as JsonObject)["id"]), value);
	const sourceRecords = options.sourceRecords ?? destination;
	const globalInventory = options.globalInventory ?? {
		infos: destination.map((value) => value.info),
		complete: true,
	};

	const clock = options.clock ?? (() => 1000);
	let importCall = 0;
	let inventoryCall = 0;
	let recoveryCall = 0;
	let deleteCall = 0;
	const readCalls = new Map<string, number>();

	const importer: SessionImportAdapter = {
		async importSession(request) {
			events.push("import");
			importCall += 1;
			imported.push(request.record);
			live.set(String((request.record.info as JsonObject)["id"]), request.record);
			if (options.importResponse !== undefined) {
				return (await options.importResponse(request, importCall)) as never;
			}
			return {
				id: String((request.record.info as JsonObject)["id"]),
				projectID: TARGET.canonicalProjectID,
				location: { directory: request.target.directory },
			};
		},
	};

	const input: RestoreReplacementExecutionInput = {
		plan: { entries: options.entries },
		sourceRecords,
		destination,
		globalInventory,
		target: TARGET,
		confirm(preview) {
			events.push("confirm");
			return options.confirm !== undefined ? (options.confirm(preview) as boolean | Promise<boolean>) : true;
		},
		importer,
		async readSession(sessionID) {
			events.push(`read:${sessionID}`);
			const next = (readCalls.get(sessionID) ?? 0) + 1;
			readCalls.set(sessionID, next);
			if (options.readSession !== undefined) return options.readSession(sessionID, next);
			return live.get(sessionID);
		},
		async readReferenceInventory() {
			events.push("inventory");
			inventoryCall += 1;
			if (typeof options.inventory === "function") return options.inventory(inventoryCall);
			if (options.inventory !== undefined) return options.inventory;
			return globalInventory;
		},
		recovery: {
			async writeAndVerify(records) {
				events.push("recovery");
				recoveryCall += 1;
				if (typeof options.recovery === "function") return options.recovery(records, recoveryCall);
				return options.recovery ?? { verified: true, path: "C:/state/recovery.sessionport" };
			},
		},
		deletePortFactory(ids) {
			events.push(`factory:${ids.join(",")}`);
			factoryScopes.push([...ids]);
			const port: ReplacementDeletePort = {
				capability: { available: options.deleteCapability ?? true },
				async removeSession(sessionID) {
					events.push(`delete:${sessionID}`);
					deleteCall += 1;
					deleteIDs.push(sessionID);
					if (options.deleteThrows === true) throw new Error("synthetic host delete failure");
					const result =
						typeof options.deleteOutcome === "function"
							? options.deleteOutcome(sessionID, deleteCall)
							: (options.deleteOutcome ?? { status: "deleted" });
					if (result.status === "deleted" && options.removeLiveOnDeleted !== false) live.delete(sessionID);
					return result;
				},
			};
			return port;
		},
		clock,
	};

	return { input, events, deleteIDs, factoryScopes, imported };
}

async function run(options: HarnessOptions) {
	const harness = makeHarness(options);
	const result = await runRestoreReplacementExecution(harness.input);
	return { ...harness, result };
}

function replaceEntry(source: string, candidate = `ses_new_${source}`): StandaloneRestorePlanEntry {
	return { sourceSessionID: source, record: record(candidate) };
}

/* ------------------------------------------------------------------------- */
/* Preview / confirmation                                                    */
/* ------------------------------------------------------------------------- */

test("confirmation cancellation performs no import, recovery, or delete", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		confirm: () => false,
	});

	expect(harness.result.preview.entries[0]?.action).toBe("replace");
	expect(Object.isFrozen(harness.result.preview)).toBe(true);
	expect(harness.events).toContain("confirm");
	expect(harness.events).not.toContain("import");
	expect(harness.events).not.toContain("recovery");
	expect(harness.deleteIDs).toEqual([]);
	expect(harness.result.report.entries[0]?.outcome).toBe("skipped");
	expect(harness.result.report.entries[0]?.reason).toBe("confirmation-cancelled");
});

test("confirmation exception and non-boolean answer cancel all writes", async () => {
	const thrown = await run({
		entries: [replaceEntry("ses_old")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		confirm: () => {
			throw new Error("synthetic confirm failure");
		},
	});
	expect(thrown.events).not.toContain("import");
	expect(thrown.deleteIDs).toEqual([]);

	const nonBoolean = await run({
		entries: [replaceEntry("ses_old")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		confirm: () => "yes" as unknown as boolean,
	});
	expect(nonBoolean.events).not.toContain("import");
	expect(nonBoolean.deleteIDs).toEqual([]);
});

test("standard replace follows the complete safety order and deletes only the old target", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
	});

	expect(harness.result.preview.entries[0]?.action).toBe("replace");
	expect(harness.imported).toHaveLength(1);
	expect(String((harness.imported[0]!.info as JsonObject)["id"])).toBe("ses_candidate");
	expect(harness.deleteIDs).toEqual(["ses_old"]);
	expect(harness.result.report.entries[0]?.outcome).toBe("replaced");
	expect(harness.result.report.recoveryPath).toBe("C:/state/recovery.sessionport");

	const mutations = harness.events.filter((event) =>
		event === "import" ||
		event === "recovery" ||
		event.startsWith("delete:") ||
		event.startsWith("read:ses_old") ||
		event === "inventory",
	);
	expect(mutations).toEqual([
		"import",
		"read:ses_old",
		"inventory",
		"recovery",
		"delete:ses_old",
		"read:ses_old",
	]);
	expect(harness.factoryScopes).toEqual([["ses_old"]]);
});

test("target-absent entry imports only; no delete factory or delete call", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [],
		sourceRecords: [record("ses_old")],
		globalInventory: { infos: [], complete: true },
	});
	expect(harness.result.preview.entries[0]?.action).toBe("import");
	expect(harness.result.report.entries[0]?.outcome).toBe("imported");
	expect(harness.imported).toHaveLength(1);
	expect(harness.deleteIDs).toEqual([]);
	expect(harness.factoryScopes).toEqual([]);
});

test("exact skipped and same-ID collision entries never import or delete", async () => {
	const skipped = await run({
		entries: [{ sourceSessionID: "ses_old", record: record("ses_candidate"), classification: "skipped" }],
		destination: [record("ses_old")],
	});
	expect(skipped.result.preview.entries[0]?.action).toBe("skip");
	expect(skipped.result.report.entries[0]?.outcome).toBe("skipped");
	expect(skipped.imported).toHaveLength(0);
	expect(skipped.deleteIDs).toEqual([]);

	const collision = await run({
		entries: [{ sourceSessionID: "ses_same", record: record("ses_same") }],
		destination: [record("ses_same")],
	});
	expect(collision.result.preview.entries[0]?.action).toBe("skip");
	expect(collision.result.preview.entries[0]?.reason).toBe("candidate-collision");
	expect(collision.imported).toHaveLength(0);
	expect(collision.deleteIDs).toEqual([]);
});

/* ------------------------------------------------------------------------- */
/* Copy downgrades                                                           */
/* ------------------------------------------------------------------------- */

test("fork and revert sources become parentless copies and retain the old target", async () => {
	for (const graph of [{ fork: { sessionID: "ses_elsewhere" } }, { revert: { messageID: "msg_1" } }, { parentID: "ses_parent" }]) {
		const harness = await run({
			entries: [replaceEntry("ses_old", "ses_candidate")],
			destination: [record("ses_old")],
			sourceRecords: [record("ses_old", { info: graph })],
		});
		expect(harness.result.preview.entries[0]?.action).toBe("copy");
		expect(harness.result.report.entries[0]?.outcome).toBe("copied");
		expect(harness.imported).toHaveLength(1);
		expect((harness.imported[0]!.info as JsonObject)["parentID"]).toBeUndefined();
		expect((harness.imported[0]!.info as JsonObject)["fork"]).toBeUndefined();
		expect((harness.imported[0]!.info as JsonObject)["revert"]).toBeUndefined();
		expect(harness.deleteIDs).toEqual([]);
	}
});

test("destination children and incoming references downgrade to copy", async () => {
	const child = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old"), record("ses_child", { info: { parentID: "ses_old" } })],
		sourceRecords: [record("ses_old")],
	});
	expect(child.result.preview.entries[0]?.action).toBe("copy");
	expect(child.result.preview.entries[0]?.reason).toBe("destination-child-reference");
	expect(child.deleteIDs).toEqual([]);

	const incoming = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		globalInventory: {
			infos: [record("ses_old").info, record("ses_other", { info: { fork: { sessionID: "ses_old" } } }).info],
			complete: true,
		},
	});
	expect(incoming.result.preview.entries[0]?.action).toBe("copy");
	expect(incoming.result.preview.entries[0]?.reason).toBe("incoming-reference");
	expect(incoming.deleteIDs).toEqual([]);
});

test("incomplete inventory and missing delete capability downgrade to copy", async () => {
	for (const options of [
		{ globalInventory: { infos: [], complete: false } },
		{ deleteCapability: false },
	] as const) {
		const harness = await run({
			entries: [replaceEntry("ses_old", "ses_candidate")],
			destination: [record("ses_old")],
			sourceRecords: [record("ses_old")],
			...options,
		});
		expect(harness.result.preview.entries[0]?.action).toBe("copy");
		expect(harness.result.report.entries[0]?.outcome).toBe("copied");
		expect(harness.deleteIDs).toEqual([]);
	}
});

test("real classifier copy and rejection downgrade to copy without aborting", async () => {
	const unsettledTarget = record("ses_old", {
		messages: [{ id: "msg_unsettled", type: "assistant", time: { created: 1 } }],
	});
	const classifierCopy = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [unsettledTarget],
		sourceRecords: [record("ses_old")],
	});
	expect(classifierCopy.result.preview.entries[0]?.action).toBe("copy");
	expect(classifierCopy.result.preview.entries[0]?.reason).toBe("classifier-copy");
	expect(classifierCopy.result.report.entries[0]?.outcome).toBe("copied");
	expect(classifierCopy.imported).toHaveLength(1);
	expect(classifierCopy.deleteIDs).toEqual([]);

	const classifierRejected = await run({
		entries: [{ sourceSessionID: "not-ses-old", record: record("ses_candidate") }],
		destination: [record("not-ses-old")],
		sourceRecords: [record("not-ses-old")],
	});
	expect(classifierRejected.result.preview.entries[0]?.action).toBe("copy");
	expect(classifierRejected.result.preview.entries[0]?.reason).toBe("classifier-unavailable");
	expect(classifierRejected.imported).toHaveLength(1);
	expect(classifierRejected.deleteIDs).toEqual([]);
});

/* ------------------------------------------------------------------------- */
/* Post-import no-delete gates                                               */
/* ------------------------------------------------------------------------- */

test("old target changed after candidate import is kept and never deleted", async () => {
	const changed = record("ses_old", { title: "edited while restoring" });
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		readSession: (sessionID) => (sessionID === "ses_old" ? changed : record(sessionID)),
	});
	expect(harness.result.report.entries[0]?.outcome).toBe("kept");
	expect(harness.result.report.entries[0]?.reason).toBe("target-changed");
	expect(harness.events).not.toContain("recovery");
	expect(harness.deleteIDs).toEqual([]);
});

test("new incoming reference discovered before delete keeps the old target", async () => {
	const incoming = {
		infos: [record("ses_old").info, record("ses_late", { info: { parentID: "ses_old" } }).info],
		complete: true,
	};
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		inventory: incoming,
	});
	expect(harness.result.report.entries[0]?.outcome).toBe("kept");
	expect(harness.result.report.entries[0]?.reason).toBe("incoming-reference");
	expect(harness.events).not.toContain("recovery");
	expect(harness.deleteIDs).toEqual([]);
});

test("same-ID source child hidden by destination cannot authorize parent replace", async () => {
	const sourceA = record("ses_a");
	for (const sourceChild of [
		{ parentID: "ses_a" },
		{ fork: { sessionID: "ses_a", boundary: { type: "before", messageID: "msg_boundary" } } },
	]) {
		const harness = await run({
			entries: [replaceEntry("ses_a", "ses_candidate")],
			destination: [record("ses_a"), record("ses_b")],
			sourceRecords: [sourceA, record("ses_b", { info: sourceChild })],
			globalInventory: { infos: [record("ses_a").info, record("ses_b").info], complete: true },
		});
		expect(harness.result.preview.entries[0]?.action).toBe("copy");
		expect(harness.result.preview.entries[0]?.reason).toBe("incoming-reference");
		expect(harness.imported).toHaveLength(1);
		expect(harness.deleteIDs).toEqual([]);
	}
});

test("late fresh reference-metadata conflict keeps the old target", async () => {
	const lateB = record("ses_b", { info: { parentID: "ses_a" } });
	const harness = await run({
		entries: [replaceEntry("ses_a", "ses_candidate")],
		destination: [record("ses_a"), record("ses_b")],
		sourceRecords: [record("ses_a"), record("ses_b")],
		inventory: {
			infos: [record("ses_a").info, lateB.info],
			complete: true,
		},
	});
	expect(harness.result.preview.entries[0]?.action).toBe("replace");
	expect(harness.result.report.entries[0]?.outcome).toBe("kept");
	expect(harness.result.report.entries[0]?.reason).toBe("incoming-reference");
	expect(harness.events).not.toContain("recovery");
	expect(harness.deleteIDs).toEqual([]);
});

test("ordinary title/time differences remain replace-eligible", async () => {
	const sourceA = record("ses_a", { title: "source title", info: { time: { created: 1, updated: 5 } } });
	const destinationA = record("ses_a", { title: "destination title", info: { time: { created: 2, updated: 90 } } });
	const harness = await run({
		entries: [replaceEntry("ses_a", "ses_candidate")],
		destination: [destinationA],
		sourceRecords: [sourceA],
		globalInventory: { infos: [destinationA.info], complete: true },
	});
	expect(harness.result.preview.entries[0]?.action).toBe("replace");
	expect(harness.result.report.entries[0]?.outcome).toBe("replaced");
	expect(harness.deleteIDs).toEqual(["ses_a"]);
});

test("fresh incomplete inventory keeps the old target", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		inventory: { infos: [], complete: false },
	});
	expect(harness.result.report.entries[0]?.outcome).toBe("kept");
	expect(harness.result.report.entries[0]?.reason).toBe("inventory-incomplete");
	expect(harness.deleteIDs).toEqual([]);
});

test("unsettled old target is copied, not deleted", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old", { info: { parentID: "ses_parent" } })],
		sourceRecords: [record("ses_old")],
	});
	expect(harness.result.preview.entries[0]?.action).toBe("copy");
	expect(harness.result.report.entries[0]?.outcome).toBe("copied");
	expect(harness.deleteIDs).toEqual([]);
});

test("candidate readback failures never delete", async () => {
	for (const failure of ["throw", "undefined"] as const) {
		const harness = await run({
			entries: [replaceEntry("ses_old", "ses_candidate")],
			destination: [record("ses_old")],
			sourceRecords: [record("ses_old")],
			readSession: (sessionID) => {
				if (sessionID !== "ses_candidate") return record(sessionID);
				if (failure === "throw") throw new Error("synthetic readback failure");
				return undefined;
			},
		});
		expect(harness.result.report.entries[0]?.outcome).toBe("failed");
		expect(harness.result.report.entries[0]?.reason).toBe("candidate-readback-failed");
		expect(harness.events).not.toContain("recovery");
		expect(harness.deleteIDs).toEqual([]);
	}
});

test("real core verifier rejects wrong candidate project, title, message, tool, or time", async () => {
	const wrongCandidates: readonly { readonly name: string; readonly actual?: SessionRecord; readonly response?: unknown }[] = [
		{
			name: "project",
			response: { id: "ses_candidate", projectID: "proj_wrong", location: { directory: TARGET.directory } },
		},
		{ name: "title", actual: record("ses_candidate", { title: "wrong title" }) },
		{
			name: "message",
			actual: record("ses_candidate", {
				messages: [{ id: "msg_other", type: "user", text: "different", time: { created: 1 } }],
			}),
		},
		{ name: "tool", actual: record("ses_candidate", { info: { tools: true } }) },
		{ name: "time", actual: record("ses_candidate", { info: { time: { created: 1, updated: 999999 } } }) },
	];
	for (const wrong of wrongCandidates) {
		const harness = await run({
			entries: [replaceEntry("ses_old", "ses_candidate")],
			destination: [record("ses_old")],
			sourceRecords: [record("ses_old")],
			...(wrong.response !== undefined ? { importResponse: () => wrong.response } : {}),
			...(wrong.actual !== undefined
				? { readSession: (sessionID: string) => (sessionID === "ses_candidate" ? wrong.actual! : record(sessionID)) }
				: {}),
		});
		expect(harness.result.report.entries[0]?.outcome).toBe("failed");
		expect(harness.deleteIDs).toEqual([]);
	}
});

test("recovery failure blocks deletion but not the verified import", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		recovery: { verified: false },
	});
	expect(harness.imported).toHaveLength(1);
	expect(harness.events).toContain("recovery");
	expect(harness.result.report.entries[0]?.outcome).toBe("kept");
	expect(harness.result.report.entries[0]?.reason).toBe("recovery-unverified");
	expect(harness.deleteIDs).toEqual([]);
});

test("old target already absent before delete is reported as import-only, not our delete", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		readSession: (sessionID) => {
			if (sessionID === "ses_old") return undefined;
			return record(sessionID);
		},
	});
	expect(harness.result.report.entries[0]?.outcome).toBe("imported");
	expect(harness.result.report.entries[0]?.reason).toBe("old-already-absent");
	expect(harness.events).not.toContain("recovery");
	expect(harness.deleteIDs).toEqual([]);
});

/* ------------------------------------------------------------------------- */
/* Delete reconciliation                                                     */
/* ------------------------------------------------------------------------- */

test("ambiguous delete exception reconciles once with readback and does not retry", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		deleteThrows: true,
	});
	expect(harness.deleteIDs).toEqual(["ses_old"]);
	expect(harness.result.report.entries[0]?.outcome).toBe("kept");
	expect(harness.result.report.entries[0]?.reason).toBe("delete-uncertain-present");
	const oldReads = harness.events.filter((event) => event === "read:ses_old");
	expect(oldReads).toHaveLength(2); // fresh before delete + one reconciliation
	expect(harness.factoryScopes).toEqual([["ses_old"]]);
});

test("reported-deleted but still-present old target is a failure without retry", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		removeLiveOnDeleted: false,
	});
	expect(harness.deleteIDs).toEqual(["ses_old"]);
	expect(harness.result.report.entries[0]?.outcome).toBe("failed");
	expect(harness.result.report.entries[0]?.reason).toBe("delete-unverified-present");
	expect(harness.events.filter((event) => event === "delete:ses_old")).toHaveLength(1);
});

test("delete uncertain and readback absent is verified success", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		deleteOutcome: { status: "uncertain" },
		readSession: (sessionID, call) => {
			if (sessionID === "ses_old" && call >= 2) return undefined;
			return record(sessionID);
		},
	});
	expect(harness.result.report.entries[0]?.outcome).toBe("replaced");
	expect(harness.result.report.entries[0]?.reason).toBe("delete-uncertain-absence-verified");
	expect(harness.events.filter((event) => event === "delete:ses_old")).toHaveLength(1);
});

test("delete unreadable readback is uncertain and never retried", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old")],
		sourceRecords: [record("ses_old")],
		deleteThrows: true,
		readSession: (sessionID, call) => {
			if (sessionID === "ses_old" && call >= 2) throw new Error("read failed");
			return record(sessionID);
		},
	});
	expect(harness.deleteIDs).toEqual(["ses_old"]);
	expect(harness.result.report.entries[0]?.outcome).toBe("uncertain");
	expect(harness.result.report.entries[0]?.reason).toBe("delete-uncertain-unreadable");
});

/* ------------------------------------------------------------------------- */
/* Batch scope, uniqueness, malformed plans, and leak boundary               */
/* ------------------------------------------------------------------------- */

test("copy entries are excluded from the delete scope", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_oldCopy", "ses_candidateCopy"), replaceEntry("ses_oldReplace", "ses_candidateReplace")],
		destination: [record("ses_oldCopy"), record("ses_oldReplace")],
		sourceRecords: [
			record("ses_oldCopy", {
				info: { fork: { sessionID: "ses_other", boundary: { type: "before", messageID: "msg_boundary" } } },
			}),
			record("ses_oldReplace"),
		],
	});
	expect(harness.result.preview.entries.map((entry) => entry.action)).toEqual(["copy", "replace"]);
	expect(harness.factoryScopes).toEqual([["ses_oldReplace"]]);
	expect(harness.deleteIDs).toEqual(["ses_oldReplace"]);
	expect(harness.result.report.entries.map((entry) => entry.outcome)).toEqual(["copied", "replaced"]);
});

test("batch scope is unique and frozen once for all replace targets", async () => {
	const harness = await run({
		entries: [replaceEntry("ses_old1", "ses_candidate1"), replaceEntry("ses_old2", "ses_candidate2")],
		destination: [record("ses_old1"), record("ses_old2")],
		sourceRecords: [record("ses_old1"), record("ses_old2")],
	});
	expect(harness.factoryScopes).toEqual([["ses_old1", "ses_old2"]]);
	expect(harness.result.preview.entries.map((entry) => entry.action)).toEqual(["replace", "replace"]);
	expect(harness.deleteIDs).toEqual(["ses_old1", "ses_old2"]);
	expect(harness.result.report.entries.map((entry) => entry.outcome)).toEqual(["replaced", "replaced"]);
});

test("duplicate source/candidate IDs and malformed records fail before any write", async () => {
	const duplicateHarness = makeHarness({
		entries: [replaceEntry("ses_old", "ses_candidate"), replaceEntry("ses_old", "ses_candidate2")],
		destination: [record("ses_old")],
	});
	await expect(runRestoreReplacementExecution(duplicateHarness.input)).rejects.toThrow(TypeError);
	expect(duplicateHarness.events).toEqual([]);

	const events: string[] = [];
	const malformed = {
		plan: { entries: [{ sourceSessionID: "ses_old", record: { info: {}, messages: [] } }] },
		sourceRecords: [],
		destination: [],
		globalInventory: { infos: [], complete: true },
		target: TARGET,
		confirm: () => {
			events.push("confirm");
			return true;
		},
		importer: { importSession: async () => ({}) },
		readSession: async () => undefined,
		readReferenceInventory: async () => ({ infos: [], complete: true }),
		recovery: { writeAndVerify: async () => ({ verified: true }) },
		deletePortFactory: () => ({ capability: { available: true }, removeSession: async () => ({ status: "deleted" as const }) }),
		clock: () => 1,
	};
	await expect(runRestoreReplacementExecution(malformed as never)).rejects.toThrow(TypeError);
	expect(events).toEqual([]);
});

test("real core exports drive a complete verified replace", async () => {
	const realRecord = (id: string): SessionRecord => ({
		info: {
			id,
			projectID: TARGET.canonicalProjectID,
			title: `real title ${id}`,
			time: { created: 1, updated: 1000 },
			location: { directory: TARGET.directory },
		} as JsonObject,
		messages: [{ id: `msg_real_${id}`, type: "user", text: "real message", time: { created: 1 } }] as JsonObject[],
	});
	const old = realRecord("ses_old");
	const candidate = realRecord("ses_candidate");
	const harness = await run({
		entries: [{ sourceSessionID: "ses_old", record: candidate }],
		destination: [old],
		sourceRecords: [old],
		globalInventory: { infos: [old.info], complete: true },
	});
	expect(harness.result.preview.entries[0]?.action).toBe("replace");
	expect(harness.result.report.entries[0]?.outcome).toBe("replaced");
	expect(harness.deleteIDs).toEqual(["ses_old"]);
});

test("real delete and reference-inventory adapters map into engine ports", async () => {
	const removed: string[] = [];
	const factory = createReplacementDeletePortFactory({
		session: {
			remove: async ({ sessionID }: { readonly sessionID: string }) => {
				removed.push(sessionID);
			},
		},
	});
	const deletePort = factory(["ses_old"]);
	expect(deletePort.capability.available).toBe(true);
	expect((await deletePort.removeSession("ses_old")).status).toBe("deleted");
	expect((await deletePort.removeSession("ses_old")).status).toBe("not-retried");
	expect((await deletePort.removeSession("ses_other")).status).toBe("refused");
	expect(removed).toEqual(["ses_old"]);

	const old = record("ses_old");
	const complete: SessionReferenceInventoryResult = {
		status: "complete",
		scope: "global",
		deleteEligible: true,
		entries: [
			{
				id: "ses_old",
				projectID: TARGET.projectID,
				revertPresent: false,
				unknownReferenceShape: false,
				parentIDUnknownShape: false,
				forkUnknownShape: false,
				revertUnknownShape: false,
				info: old.info,
			},
		],
	};
	expect(referenceInventoryFromAdapter(complete)).toEqual({ infos: [old.info], complete: true });
	const incomplete: SessionReferenceInventoryResult = {
		status: "incomplete",
		scope: "global",
		deleteEligible: false,
		reason: "capability-unavailable",
		detail: "fixed test detail",
	};
	expect(referenceInventoryFromAdapter(incomplete)).toEqual({ infos: [], complete: false });

	const reader = createReplacementReferenceInventoryReader({
		readIncomingReferences: async () => complete,
	});
	expect(await reader()).toEqual({ infos: [old.info], complete: true });
});

test("report is display-safe and compatible with the standalone UI shape", async () => {
	const secret = "TOPSECRET-MESSAGE-PAYLOAD";
	const harness = await run({
		entries: [replaceEntry("ses_old", "ses_candidate")],
		destination: [record("ses_old", { messages: [{ id: "msg_secret", type: "user", text: secret }] })],
		sourceRecords: [record("ses_old", { messages: [{ id: "msg_secret", type: "user", text: secret }] })],
	});

	const previewUI: {
		readonly entries: readonly {
			readonly sessionID: string;
			readonly title: string;
			readonly action: "replace" | "copy" | "import" | "skip";
			readonly reason?: string;
		}[];
		readonly recoveryRequired: boolean;
	} = harness.result.preview;
	const reportUI: {
		readonly entries: readonly {
			readonly sessionID: string;
			readonly title: string;
			readonly outcome: "replaced" | "copied" | "imported" | "skipped" | "kept" | "failed" | "uncertain";
			readonly reason?: string;
		}[];
		readonly recoveryPath?: string;
	} = harness.result.report;

	expect(previewUI.entries).toHaveLength(1);
	expect(reportUI.entries).toHaveLength(1);
	const serialized = JSON.stringify(harness.result);
	expect(serialized).not.toContain(secret);
	expect(serialized).not.toContain("TOPSECRET");
	expect(serialized).not.toContain("messages");
	expect(serialized).not.toContain("password");
	expect(serialized).not.toContain("candidate\"");
	expect(reportUI.recoveryPath).toBe("C:/state/recovery.sessionport");
});

