// These tests mount the OpenTUI dialog with a fake plugin dialog port.
// They cover static rendered text and keyboard dispatch, not a real host.
import { describe, expect, mock, test } from "bun:test";
import type { JSX } from "@opentui/solid";
import * as solidRuntime from "solid-js/dist/solid.js";
import type { SessionPortSettingsHost } from "../../../src/tui/ui/settings-dialog.tsx";

const { createSignal } = solidRuntime;

interface TestKeyEvent {
	readonly name: string;
	preventDefault(): void;
	stopPropagation(): void;
}

const keyHandlers: Array<(event: TestKeyEvent) => void> = [];
mock.module("solid-js", () => solidRuntime);
const openTui = await import("@opentui/solid");
mock.module("@opentui/solid", () => ({
	...openTui,
	useKeyboard: (callback: (event: TestKeyEvent) => void) => {
		keyHandlers.push(callback);
	},
}));

const { createSessionPortSettingsUi } = await import(
	"../../../src/tui/ui/settings-dialog.tsx"
);

class FakeDialog {
	clearCount = 0;
	options: unknown;
	#render: (() => JSX.Element) | undefined;
	#onClose: (() => void) | undefined;

	set(options: unknown): void {
		this.options = options;
	}

	show(render: () => JSX.Element, onClose?: () => void): void {
		this.#render = render;
		this.#onClose = onClose;
	}

	clear(): void {
		this.clearCount += 1;
		this.closeFromHost();
	}

	render(): JSX.Element {
		if (!this.#render) throw new Error("dialog has not been shown");
		return this.#render();
	}

	closeFromHost(): void {
		const onClose = this.#onClose;
		this.#render = undefined;
		this.#onClose = undefined;
		onClose?.();
	}
}

function createHarness(
	initial = false,
	setSidebarActions?: (value: boolean) => Promise<void>,
) {
	const dialog = new FakeDialog();
	const [enabled, setEnabled] = createSignal(initial);
	const setCalls: boolean[] = [];
	const cleanupClearCounts: number[] = [];
	const context = {
		ui: { dialog },
		theme: {
			text: {
				base: "#eeeeee",
				muted: "#888888",
				action: { primary: { base: "#55aaff" } },
				feedback: { error: { base: "#ff5555" } },
			},
			background: { base: "#111111", raised: { base: "#222222" } },
			border: { base: "#555555" },
		},
	} as unknown as SessionPortSettingsHost;
	const ui = createSessionPortSettingsUi(context, {
		sidebarActions: enabled,
		setSidebarActions(value) {
			setCalls.push(value);
			if (setSidebarActions) return setSidebarActions(value);
			setEnabled(value);
			return Promise.resolve();
		},
		cleanupCheckpoints() {
			cleanupClearCounts.push(dialog.clearCount);
			return Promise.resolve();
		},
	});
	return { dialog, ui, setCalls, setEnabled, enabled, cleanupClearCounts };
}

async function mount(dialog: FakeDialog) {
	keyHandlers.length = 0;
	const setup = await openTui.testRender(() => dialog.render(), { width: 80, height: 24 });
	await setup.renderOnce();
	return setup;
}

function emitKey(name: string) {
	let prevented = false;
	let stopped = false;
	const callback = keyHandlers.at(-1);
	if (!callback) throw new Error("Dialog did not register a keyboard handler");
	callback({
		name,
		preventDefault() {
			prevented = true;
		},
		stopPropagation() {
			stopped = true;
		},
	});
	return { prevented, stopped };
}

describe("SessionPort settings dialog", () => {
	test("opens centered, renders the setting, and routes keyboard toggles to the setter", async () => {
		let resolveSave!: () => void;
		const pendingSave = new Promise<void>((resolve) => {
			resolveSave = resolve;
		});
		let updateValue = (_value: boolean) => {};
		const harness = createHarness(false, (value) => {
			updateValue(value);
			return pendingSave;
		});
		updateValue = harness.setEnabled;
		harness.ui.open();
		expect(harness.dialog.options).toEqual({ size: "medium", centered: true });
		const setup = await mount(harness.dialog);
		try {
			await setup.flush();
			expect(setup.captureCharFrame()).toContain("SessionPort settings");
			expect(setup.captureCharFrame()).toContain("Sidebar quick actions");
			expect(setup.captureCharFrame()).toContain("Delete older checkpoints");
			expect(setup.captureCharFrame()).toContain("off");

			const arrow = emitKey("right");
			expect(arrow).toEqual({ prevented: true, stopped: true });
			expect(harness.setCalls).toEqual([true]);
			expect(harness.enabled()).toBe(true);

			resolveSave();
			await pendingSave;
			await setup.flush();
			expect(harness.setCalls).toEqual([true]);

			emitKey("enter");
			expect(harness.setCalls).toEqual([true, false]);
			expect(harness.enabled()).toBe(false);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("moves selection with up and down and closes before activating cleanup", async () => {
		const harness = createHarness();
		harness.ui.open();
		const setup = await mount(harness.dialog);
		try {
			expect(emitKey("down")).toEqual({ prevented: true, stopped: true });
			emitKey("left");
			expect(harness.setCalls).toEqual([]);

			expect(emitKey("up")).toEqual({ prevented: true, stopped: true });
			emitKey("enter");
			expect(harness.setCalls).toEqual([true]);
			expect(harness.cleanupClearCounts).toEqual([]);
			await Promise.resolve();

			emitKey("down");
			expect(emitKey("enter")).toEqual({ prevented: true, stopped: true });
			expect(harness.dialog.clearCount).toBe(1);
			// The callback observes the clear, proving the modal closes first.
			expect(harness.cleanupClearCounts).toEqual([1]);
			expect(harness.setCalls).toEqual([true]);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("catches a rejected save without leaking the host error", async () => {
		let rejectSave!: (reason?: unknown) => void;
		const pendingSave = new Promise<void>((_resolve, reject) => {
			rejectSave = reject;
		});
		const harness = createHarness(true, () => pendingSave);
		harness.ui.open();
		const setup = await mount(harness.dialog);
		try {
			emitKey("left");
			expect(harness.setCalls).toEqual([false]);
			rejectSave(new Error("private host detail"));
			await pendingSave.catch(() => {});
			await setup.flush();
			// The rejected save must not close the dialog or persist a value.
			expect(harness.dialog.clearCount).toBe(0);
			expect(harness.setCalls).toEqual([false]);
			expect(harness.enabled()).toBe(true);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("Escape consumes the key and clears the dialog", async () => {
		const harness = createHarness();
		harness.ui.open();
		const setup = await mount(harness.dialog);
		try {
			const escape = emitKey("escape");
			expect(escape).toEqual({ prevented: true, stopped: true });
			expect(harness.dialog.clearCount).toBe(1);
		} finally {
			setup.renderer.destroy();
		}
	});
});
