// These exercise password-state/port behavior with a fake dialog only. They do
// not render OpenTUI or inspect actual-host frames, logs, clipboard, or lifecycle.
import { describe, expect, test } from "bun:test";
import {
	PasswordPromptState,
	showPasswordPrompt,
	type PasswordDialogPort,
	type PasswordPromptSnapshot,
} from "../../../src/tui/ui/password-flow.ts";

interface FakeRenderedDialog {
	readonly prompt: PasswordPromptState;
	readonly accept: (password: Uint8Array) => void;
	readonly cancel: () => void;
}

class FakeDialog implements PasswordDialogPort<FakeRenderedDialog> {
	clearCount = 0;
	#render: (() => FakeRenderedDialog) | undefined;
	#onClose: (() => void) | undefined;

	show(render: () => FakeRenderedDialog, onClose?: () => void): void {
		this.#render = render;
		this.#onClose = onClose;
	}

	clear(): void {
		this.clearCount += 1;
		this.#onClose?.();
	}

	render(): FakeRenderedDialog {
		if (!this.#render) throw new Error("dialog has not been shown");
		return this.#render();
	}

	closeFromHost(): void {
		this.#onClose?.();
	}
}

function openFakeDialog(mode: "checkpoint" | "restore", maxPasswordBytes?: number) {
	const dialog = new FakeDialog();
	const result = showPasswordPrompt(
		dialog,
		mode,
		(prompt, accept, cancel) => ({ prompt, accept, cancel }),
		maxPasswordBytes,
	);
	return { dialog, result, rendered: dialog.render() };
}

function accepted(submission: ReturnType<PasswordPromptState["submit"]>): Uint8Array {
	if (submission.status !== "accepted") {
		throw new Error(`expected an accepted password, got ${submission.status}`);
	}
	return submission.password;
}

describe("password prompt flow", () => {
	test("mismatch clears both fields and retries the two-entry checkpoint prompt", async () => {
		const { dialog, result, rendered } = openFakeDialog("checkpoint");
		const { prompt } = rendered;

		prompt.insert("first-value");
		expect(prompt.submit()).toEqual({ status: "confirmation-required" });
		prompt.insert("different-value");
		expect(prompt.submit()).toEqual({ status: "mismatch" });

		const afterMismatch = prompt.snapshot();
		expect(afterMismatch.passwordMask).toBe("");
		expect(afterMismatch.confirmationMask).toBe("");
		expect(afterMismatch.activeField).toBe("password");
		expect(afterMismatch.message).toBe("The entries did not match. Try again.");
		expect(afterMismatch.closed).toBe(false);
		expect(JSON.stringify(afterMismatch)).not.toContain("first-value");
		expect(JSON.stringify(afterMismatch)).not.toContain("different-value");

		prompt.insert("match-this");
		expect(prompt.submit()).toEqual({ status: "confirmation-required" });
		prompt.insert("match-this");
		rendered.accept(accepted(prompt.submit()));

		const returnedPassword = await result;
		expect(returnedPassword).toBeDefined();
		expect(Array.from(returnedPassword ?? [])).toEqual(
			Array.from(new TextEncoder().encode("match-this")),
		);
		expect(dialog.clearCount).toBe(1);
		expect(prompt.snapshot().passwordMask).toBe("");
		expect(prompt.snapshot().closed).toBe(true);
	});

	test("returns exact UTF-8 bytes without Unicode normalization", () => {
		const prompt = new PasswordPromptState("checkpoint");
		const decomposed = "e\u0301";

		prompt.insert(decomposed);
		prompt.submit();
		prompt.insert(decomposed);
		const bytes = accepted(prompt.submit());

		expect(Array.from(bytes)).toEqual([0x65, 0xcc, 0x81]);
		expect(Array.from(bytes)).not.toEqual([0xc3, 0xa9]);
	});

	test("accepts a password whose UTF-8 encoding is exactly at the byte limit", () => {
		const prompt = new PasswordPromptState("restore", 4);
		prompt.insert("pass");

		const bytes = accepted(prompt.submit());
		expect(Array.from(bytes)).toEqual([0x70, 0x61, 0x73, 0x73]);
	});

	test("rejects typed text that would exceed the limit by one byte", () => {
		const { rendered } = openFakeDialog("restore", 4);
		const { prompt } = rendered;
		prompt.insert("k9!x");
		prompt.insert("!");

		expect(prompt.snapshot()).toMatchObject({
			passwordMask: "●".repeat(4),
			message: "Password limit reached. Remove some text before adding more.",
		});
		expect(JSON.stringify(prompt.snapshot())).not.toContain("k9!x");
		expect(Array.from(accepted(prompt.submit()))).toEqual([0x6b, 0x39, 0x21, 0x78]);
	});

	test("counts multi-byte UTF-8 exactly and rejects an over-limit paste whole", () => {
		const prompt = new PasswordPromptState("restore", 6);
		prompt.insert("é");
		prompt.insertPasteBytes(new TextEncoder().encode("🦊x"));

		expect(prompt.snapshot()).toMatchObject({
			passwordMask: "●",
			message: "Password limit reached. Remove some text before adding more.",
		});
		prompt.insertPasteBytes(new TextEncoder().encode("🦊"));

		expect(prompt.snapshot()).toMatchObject({ passwordMask: "●●", message: undefined });
		expect(Array.from(accepted(prompt.submit()))).toEqual([0xc3, 0xa9, 0xf0, 0x9f, 0xa6, 0x8a]);
	});

	test("accepts a weak checkpoint password without strength rejection", () => {
		const prompt = new PasswordPromptState("checkpoint");
		prompt.insert("x");
		expect(prompt.submit()).toEqual({ status: "confirmation-required" });
		prompt.insert("x");

		const bytes = accepted(prompt.submit());
		expect(Array.from(bytes)).toEqual([0x78]);
	});

	test("accepts valid pasted UTF-8 without stripping a leading BOM", () => {
		const prompt = new PasswordPromptState("restore");
		const pastedBytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x6f, 0x6b]);

		prompt.insertPasteBytes(pastedBytes);
		const password = accepted(prompt.submit());

		expect(Array.from(password)).toEqual(Array.from(pastedBytes));
	});

	test("rejects malformed pasted UTF-8 without changing the active field", () => {
		const prompt = new PasswordPromptState("restore");
		prompt.insert("kept-value");

		prompt.insertPasteBytes(new Uint8Array([0x70, 0x80, 0x61, 0x73, 0x73]));

		expect(prompt.snapshot()).toMatchObject({
			passwordMask: "●".repeat("kept-value".length),
			message: "Paste was not valid UTF-8 and was not added.",
			closed: false,
		});
		expect(JSON.stringify(prompt.snapshot())).not.toContain("kept-value");
	});

	test("fails closed for an unpaired surrogate instead of TextEncoder replacement", () => {
		const prompt = new PasswordPromptState("restore");
		prompt.insert("\ud800");

		expect(prompt.submit()).toEqual({ status: "invalid-encoding" });
		expect(prompt.snapshot()).toMatchObject({
			passwordMask: "●",
			message: "Password contains invalid Unicode and cannot be encoded as UTF-8.",
			closed: false,
		});
	});

	test("cancel resolves undefined and clears the active secret", async () => {
		const { dialog, result, rendered } = openFakeDialog("checkpoint");
		rendered.prompt.insert("never-return-this");
		rendered.cancel();

		expect(await result).toBeUndefined();
		expect(dialog.clearCount).toBe(1);
		expect(rendered.prompt.snapshot()).toMatchObject({
			passwordMask: "",
			confirmationMask: "",
			closed: true,
		});
	});

	test("restore accepts one entry and exposes no confirmation field", () => {
		const prompt = new PasswordPromptState("restore");
		prompt.insert("single-entry");

		const view = prompt.snapshot();
		expect(view).not.toHaveProperty("confirmationMask");
		expect(prompt.submit().status).toBe("accepted");
	});

	test("backspace removes one complete Unicode code point from the active field", () => {
		const prompt = new PasswordPromptState("restore");
		prompt.insert("secret🦊");
		prompt.backspace();

		expect(prompt.snapshot().passwordMask).toBe("●".repeat("secret".length));
		expect(JSON.stringify(prompt.snapshot())).not.toContain("secret");
	});

	test("clearActive clears only the focused field", () => {
		const prompt = new PasswordPromptState("checkpoint");
		prompt.insert("keep-this");
		prompt.switchField();
		prompt.insert("clear-this");
		prompt.clearActive();

		expect(prompt.snapshot()).toMatchObject({
			passwordMask: "●".repeat("keep-this".length),
			confirmationMask: "",
		});
		expect(JSON.stringify(prompt.snapshot())).not.toContain("keep-this");
		expect(JSON.stringify(prompt.snapshot())).not.toContain("clear-this");
	});

	test("password snapshots contain masks only, never the entered text", () => {
		const prompt = new PasswordPromptState("checkpoint");
		const secret = "raw-value-Ω🦊";
		prompt.insert(secret);

		const firstView: PasswordPromptSnapshot = prompt.snapshot();
		expect(JSON.stringify(firstView)).not.toContain(secret);
		expect(firstView.passwordMask).toBe("●".repeat(Array.from(secret).length));

		prompt.switchField();
		prompt.insert(secret);
		const bothFields = JSON.stringify(prompt.snapshot());
		expect(bothFields).not.toContain(secret);
		expect(bothFields).toContain("●");
	});

	test("fake host-close callback clears both checkpoint fields", async () => {
		const { dialog, result, rendered } = openFakeDialog("checkpoint");
		rendered.prompt.insert("first-secret");
		rendered.prompt.switchField();
		rendered.prompt.insert("second-secret");

		dialog.closeFromHost();

		expect(await result).toBeUndefined();
		expect(rendered.prompt.snapshot()).toMatchObject({
			passwordMask: "",
			confirmationMask: "",
			closed: true,
		});
	});
});
