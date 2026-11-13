import { describe, expect, test } from "bun:test";
import * as openTui from "@opentui/solid";
import { SESSIONPORT_COMMAND_IDS } from "../../../src/tui/ui/sessionport-commands.tsx";
import {
	installSessionPortSidebarActions,
	type SessionPortSidebarHost,
} from "../../../src/tui/ui/sidebar-actions.tsx";

interface CapturedClaim {
	render(input: { readonly sessionID: string }): unknown;
	readonly append?: string;
}

function createHarness(enabled: () => boolean = () => true): {
	readonly claim: CapturedClaim;
	readonly dispatched: string[];
	readonly dispose: () => void;
} {
	const dispatched: string[] = [];
	let claim: CapturedClaim | undefined;
	const host = {
		ui: {
			slot(value: CapturedClaim) {
				claim = value;
				return () => {};
			},
		},
		keymap: {
			dispatch(id: string) {
				dispatched.push(id);
			},
		},
		theme: {
			text: {
				muted: { base: "#888888" },
				action: {
					primary: {
						base: "#ffffff",
						state: () => "#ffffff",
					},
				},
			},
		},
	} as unknown as SessionPortSidebarHost;
	const dispose = installSessionPortSidebarActions(host, { enabled });
	if (claim === undefined) throw new Error("sidebar claim was not captured");
	return { claim, dispatched, dispose };
}

describe("optional sidebar quick actions", () => {
	test("renders two labels and dispatches the native command IDs on click", async () => {
		const harness = createHarness();
		expect(harness.claim.append).toBe("sidebar.footer");
		const setup = await openTui.testRender(() => harness.claim.render({ sessionID: "ses_a" }), {
			width: 42,
			height: 8,
		});
		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			expect(frame).toContain("Checkpoint");
			expect(frame).toContain("Restore");

			const checkpoint = setup.renderer.root.findDescendantById("sessionport.sidebar.checkpoint");
			expect(checkpoint).toBeDefined();
			await setup.mockMouse.click(checkpoint!.x, checkpoint!.y);
			const restore = setup.renderer.root.findDescendantById("sessionport.sidebar.restore");
			expect(restore).toBeDefined();
			await setup.mockMouse.click(restore!.x, restore!.y);

			expect(harness.dispatched).toEqual([
				SESSIONPORT_COMMAND_IDS.checkpoint,
				SESSIONPORT_COMMAND_IDS.restore,
			]);
		} finally {
			setup.renderer.destroy();
		}
	});

	test("renders nothing and has no click targets while disabled", async () => {
		const harness = createHarness(() => false);
		const setup = await openTui.testRender(() => harness.claim.render({ sessionID: "ses_a" }), {
			width: 42,
			height: 8,
		});
		try {
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			expect(frame).not.toContain("Checkpoint");
			expect(frame).not.toContain("Restore");
			expect(setup.renderer.root.findDescendantById("sessionport.sidebar.checkpoint")).toBeUndefined();
			expect(setup.renderer.root.findDescendantById("sessionport.sidebar.restore")).toBeUndefined();
		} finally {
			setup.renderer.destroy();
		}
	});

	test("dispose is a callable slot cleanup", () => {
		const harness = createHarness();
		expect(typeof harness.dispose).toBe("function");
		expect(() => harness.dispose()).not.toThrow();
	});
});
