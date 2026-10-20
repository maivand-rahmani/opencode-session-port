import { describe, expect, test } from "bun:test";
import {
	installSessionPortCommands,
	SESSIONPORT_COMMAND_IDS,
	type SessionPortCommandHost,
} from "../../../src/tui/ui/sessionport-commands.tsx";

describe("SessionPort command registration", () => {
	test("registers slash commands from the app slot and hands back its disposer", async () => {
		let slotClaim: Parameters<SessionPortCommandHost["ui"]["slot"]>[0] | undefined;
		let layerFactory: Parameters<SessionPortCommandHost["keymap"]["layer"]>[0] | undefined;
		let disposeCount = 0;
		const disposer = () => {
			disposeCount += 1;
		};
		const context: SessionPortCommandHost = {
			ui: {
				slot: (claim) => {
					slotClaim = claim;
					return disposer;
				},
			},
			keymap: {
				layer: (factory) => {
					layerFactory = factory;
				},
			},
		};
		const handlers = {
			checkpoint: async () => {},
			restore: async () => {},
			sync: async () => {},
		};

		const cleanup = installSessionPortCommands(context, handlers);

		expect(slotClaim?.append).toBe("app");
		expect(layerFactory).toBeUndefined();
		expect(cleanup).toBe(disposer);
		expect(slotClaim?.render({})).toBeNull();
		expect(layerFactory).toBeDefined();

		const commands = layerFactory?.().commands ?? [];
		expect(layerFactory?.().mode).toBe("global");
		expect(commands.map((command) => command.id)).toEqual([
			SESSIONPORT_COMMAND_IDS.checkpoint,
			SESSIONPORT_COMMAND_IDS.restore,
			SESSIONPORT_COMMAND_IDS.sync,
		]);
		expect(commands.map((command) => command.slash?.name)).toEqual(["checkpoint", "restore", "sync"]);
		expect(commands.every((command) => command.slash?.arguments === true)).toBe(true);
		expect(commands.every((command) => command.group === "SessionPort")).toBe(true);
		expect(commands.every((command) => command.bind === false)).toBe(true);
		expect(commands.every((command) => command.palette === true)).toBe(true);
		expect(commands.map((command) => command.description)).toEqual([
			"Create a password-encrypted checkpoint of the current project's sessions.",
			"Choose an existing project and restore a checkpoint without overwriting its local sessions.",
			"Sign in to SessionPort cloud on this device.",
		]);

		cleanup();
		expect(disposeCount).toBe(1);
	});

	test("forwards raw slash input to each async handler without parsing or trimming", async () => {
		let slotClaim: Parameters<SessionPortCommandHost["ui"]["slot"]>[0] | undefined;
		let layerFactory: Parameters<SessionPortCommandHost["keymap"]["layer"]>[0] | undefined;
		const context: SessionPortCommandHost = {
			ui: {
				slot: (claim) => {
					slotClaim = claim;
					return () => {};
				},
			},
			keymap: {
				layer: (factory) => {
					layerFactory = factory;
				},
			},
		};
		const checkpointInputs: Array<string | undefined> = [];
		const restoreInputs: Array<string | undefined> = [];
		const syncInputs: Array<string | undefined> = [];

		installSessionPortCommands(context, {
			checkpoint: async (rawInput) => {
				checkpointInputs.push(rawInput);
			},
			restore: async (rawInput) => {
				restoreInputs.push(rawInput);
			},
			sync: async (rawInput) => {
				syncInputs.push(rawInput);
			},
		});
		// Simulate the host mounting the slot component before dispatching commands.
		slotClaim?.render({});
		const commands = layerFactory?.().commands ?? [];
		const checkpoint = commands.find((command) => command.id === SESSIONPORT_COMMAND_IDS.checkpoint);
		const restore = commands.find((command) => command.id === SESSIONPORT_COMMAND_IDS.restore);
		const sync = commands.find((command) => command.id === SESSIONPORT_COMMAND_IDS.sync);
		if (!checkpoint || !restore || !sync) throw new Error("expected all SessionPort commands");
		const rawCheckpoint = '  --output "folder with spaces"  ';
		const rawRestore = "  relative\targument  ";
		const rawSync = "  login  ";

		await checkpoint.run(rawCheckpoint);
		await restore.run(rawRestore);
		await sync.run(rawSync);
		await checkpoint.run(undefined);

		expect(checkpointInputs).toEqual([rawCheckpoint, undefined]);
		expect(restoreInputs).toEqual([rawRestore]);
		expect(syncInputs).toEqual([rawSync]);
	});
});
