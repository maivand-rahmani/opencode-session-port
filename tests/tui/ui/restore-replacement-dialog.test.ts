// These tests mount the actual OpenTUI dialog with a fake plugin dialog port.
// They validate keyboard behavior and rendered terminal text, not a real host.
import { describe, expect, mock, test } from "bun:test";
import * as openTui from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import type { RestoreReplacementPreview } from "../../../src/tui/ui/restore-replacement-dialog.tsx";

interface TestKeyEvent {
	readonly name: string;
	readonly sequence: string;
	readonly ctrl: boolean;
	readonly meta: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

const keyHandlers: Array<(event: TestKeyEvent) => void> = [];
mock.module("@opentui/solid", () => ({
	...openTui,
	useKeyboard: (callback: (event: TestKeyEvent) => void) => {
		keyHandlers.push(callback);
	},
}));

const { createRestoreReplacementUi } = await import(
	"../../../src/tui/ui/restore-replacement-dialog.tsx"
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

function createHarness() {
	const dialog = new FakeDialog();
	const context = { ui: { dialog } } as unknown as Parameters<typeof createRestoreReplacementUi>[0];
	return { dialog, ui: createRestoreReplacementUi(context) };
}

function mount(dialog: FakeDialog) {
	keyHandlers.length = 0;
	return openTui.testRender(() => dialog.render(), { width: 120, height: 60 }).then(async (setup) => {
		await setup.renderOnce();
		return setup;
	});
}

type TestSetup = Awaited<ReturnType<typeof mount>>;

function emitKey(name: string, sequence = name): void {
	const keyEvent: TestKeyEvent = {
		name,
		sequence,
		ctrl: false,
		meta: false,
		preventDefault() {},
		stopPropagation() {},
	};
	const callback = keyHandlers.at(-1);
	if (!callback) throw new Error("Dialog did not register a keyboard handler");
	callback(keyEvent);
}

const replacementPlan: RestoreReplacementPreview = {
	recoveryRequired: true,
	entries: [
		{
			sessionID: "ses-replace-001",
			title: "Existing work",
			action: "replace",
		},
		{
			sessionID: "ses-copy-002",
			title: "Forked work",
			action: "copy",
		},
	],
};

describe("restore replacement dialog", () => {
	test("shows the receiving target and does not make Enter accept replacement by default", async () => {
		const { dialog, ui } = createHarness();
		const result = ui.confirm(replacementPlan);
		const setup = await mount(dialog);
		try {
			await setup.flush();
			const frame = setup.captureCharFrame();
			expect(frame).toContain("Existing work");
			expect(frame).toContain("ses-replace-001");
			expect(frame).toContain("Restore and replace 1 session");
			expect(frame).toContain("An existing session is deleted only after");
			const compactFrame = frame.replace(/\s/gu, "");
			expect(compactFrame).toContain("Knownsessionrelationshipsare");
			expect(compactFrame).toContain("notpreservedinthenewcopy");

			emitKey("return", "\r");
			expect(await result).toBe(false);
			expect(dialog.clearCount).toBe(1);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("requires an explicit choice before continuing with or without replacement", async () => {
		const noReplacement = createHarness();
		const continueResult = noReplacement.ui.confirm({
			recoveryRequired: false,
			entries: [{ sessionID: "ses-copy", title: "Copied session", action: "copy" }],
		});
		const continueSetup = await mount(noReplacement.dialog);
		try {
			await continueSetup.flush();
			expect(continueSetup.captureCharFrame()).toContain("Continue restore");
			emitKey("tab", "\t");
			await continueSetup.flush();
			emitKey("return", "\r");
			expect(await continueResult).toBe(true);
		} finally {
			continueSetup.renderer.destroy();
		}

		const replacement = createHarness();
		const replaceResult = replacement.ui.confirm(replacementPlan);
		const replaceSetup = await mount(replacement.dialog);
		try {
			emitKey("tab", "\t");
			await replaceSetup.flush();
			emitKey("return", "\r");
			expect(await replaceResult).toBe(true);
		} finally {
			replaceSetup.renderer.destroy();
		}
	});

	test("Escape and host dismissal both resolve a pending confirmation as false", async () => {
		const escapeHarness = createHarness();
		const escaped = escapeHarness.ui.confirm(replacementPlan);
		const escapeSetup = await mount(escapeHarness.dialog);
		try {
			emitKey("escape", "\x1b");
			expect(await escaped).toBe(false);
		} finally {
			escapeSetup.renderer.destroy();
		}

		const dismissedHarness = createHarness();
		const dismissed = dismissedHarness.ui.confirm(replacementPlan);
		const dismissedSetup = await mount(dismissedHarness.dialog);
		try {
			dismissedHarness.dialog.closeFromHost();
			expect(await dismissed).toBe(false);
			emitKey("return", "\r");
			expect(dismissedHarness.dialog.clearCount).toBe(0);
		} finally {
			dismissedSetup.renderer.destroy();
		}
	});

	test("reports copied and uncertain outcomes, retains long IDs, and closes safely", async () => {
		const longID = `ses-${"long-session-id-".repeat(6)}`;
		const { dialog, ui } = createHarness();
		const report = ui.report({
			entries: [
				{
					sessionID: longID,
					title: "Readback needs review",
					outcome: "uncertain",
					reason: "local_readback_uncertain",
				},
				{ sessionID: "ses-copied", title: "A copied session", outcome: "copied" },
			],
			recoveryPath: "C:\\local\\encrypted-recovery.spc",
		});
		const setup = await mount(dialog);
		try {
			await setup.flush();
			const frame = setup.captureCharFrame();
			expect(frame).toContain("Restore needs attention");
			expect(frame).not.toContain("Restore finished");
			expect(frame).toContain("Copied sessions keep their originals");
			expect(frame).toContain("encrypted-recovery.spc");
			expect(frame.replace(/[^a-zA-Z0-9_-]/gu, "")).toContain(longID);
			expect(frame).toContain("uncertain");
			expect(frame).toContain("local_readback_uncertain");
			emitKey("escape", "\x1b");
			await report;
			expect(dialog.clearCount).toBe(1);
		} finally {
			setup.renderer.destroy();
		}
	});
});
