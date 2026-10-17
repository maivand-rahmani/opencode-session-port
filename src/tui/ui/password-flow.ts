/**
 * Secret-entry state for the password dialog.
 *
 * This module deliberately exposes masks and actions, never password strings.
 * JavaScript strings cannot be reliably zeroed; dispose() drops the owned
 * references as a best-effort cleanup, not a secure-erasure guarantee.
 */

export type PasswordMode = "checkpoint" | "restore";

export type PasswordField = "password" | "confirmation";

export interface PasswordPromptSnapshot {
	readonly mode: PasswordMode;
	readonly activeField: PasswordField;
	readonly passwordMask: string;
	readonly confirmationMask?: string;
	readonly message?: string;
	readonly closed: boolean;
}

export type PasswordSubmission =
	| { readonly status: "confirmation-required" }
	| { readonly status: "mismatch" }
	| { readonly status: "invalid-encoding" }
	| { readonly status: "accepted"; readonly password: Uint8Array }
	| { readonly status: "closed" };

const MASK_GLYPH = "●";
const MISMATCH_MESSAGE = "The entries did not match. Try again.";
const INVALID_PASTE_MESSAGE = "Paste was not valid UTF-8 and was not added.";
const INVALID_ENCODING_MESSAGE = "Password contains invalid Unicode and cannot be encoded as UTF-8.";
const PASSWORD_LIMIT_MESSAGE = "Password limit reached. Remove some text before adding more.";

/**
 * Count the bytes TextEncoder would produce, stopping as soon as the supplied
 * limit is exceeded. Unpaired surrogates count as their UTF-8 replacement
 * character here; submit() still rejects them as invalid Unicode.
 */
function utf8ByteLengthWithin(value: string, limit: number): number | undefined {
	let byteLength = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		let bytes: number;

		if (unit <= 0x7f) {
			bytes = 1;
		} else if (unit <= 0x7ff) {
			bytes = 2;
		} else if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes = 4;
				index += 1;
			} else {
				bytes = 3;
			}
		} else {
			// BMP characters and isolated low surrogates (TextEncoder replacement).
			bytes = 3;
		}

		// Subtraction keeps the addition bounded even for very large input.
		if (bytes > limit - byteLength) return undefined;
		byteLength += bytes;
	}
	return byteLength;
}

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function mask(value: string): string {
	// One mask per Unicode code point keeps surrogate pairs intact and never
	// includes any part of the entered value in a rendered string.
	return MASK_GLYPH.repeat(Array.from(value).length);
}

/** Owns the one or two secret strings for a single modal session. */
export class PasswordPromptState {
	readonly #mode: PasswordMode;
	readonly #maxPasswordBytes: number;
	#password = "";
	#confirmation = "";
	#activeField: PasswordField = "password";
	#message: string | undefined;
	#closed = false;

	constructor(mode: PasswordMode, maxPasswordBytes = 4096) {
		if (!Number.isSafeInteger(maxPasswordBytes) || maxPasswordBytes < 0) {
			throw new RangeError("maxPasswordBytes must be a non-negative safe integer");
		}
		this.#mode = mode;
		this.#maxPasswordBytes = maxPasswordBytes;
	}

	snapshot(): PasswordPromptSnapshot {
		const shared = {
			mode: this.#mode,
			activeField: this.#activeField,
			passwordMask: mask(this.#password),
			message: this.#message,
			closed: this.#closed,
		};

		return Object.freeze(
			this.#mode === "checkpoint"
				? { ...shared, confirmationMask: mask(this.#confirmation) }
				: shared,
		);
	}

	/** Add keyboard or pasted text exactly as supplied; no normalization/filtering. */
	insert(text: string): void {
		if (this.#closed || text.length === 0) return;
		const isConfirmation = this.#mode === "checkpoint" && this.#activeField === "confirmation";
		const currentValue = isConfirmation ? this.#confirmation : this.#password;
		const currentByteLength = utf8ByteLengthWithin(currentValue, this.#maxPasswordBytes);
		const additionalByteLength =
			currentByteLength === undefined
				? undefined
				: utf8ByteLengthWithin(text, this.#maxPasswordBytes - currentByteLength);

		if (additionalByteLength === undefined) {
			this.#message = PASSWORD_LIMIT_MESSAGE;
			return;
		}

		this.#message = undefined;
		if (isConfirmation) {
			this.#confirmation += text;
			return;
		}
		this.#password += text;
	}

	/**
	 * Decode pasted bytes as strict UTF-8 without stripping a leading BOM.
	 * Invalid byte sequences fail closed and leave the current field unchanged.
	 */
	insertPasteBytes(bytes: Uint8Array): void {
		if (this.#closed || bytes.length === 0) return;

		try {
			const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			this.insert(text);
		} catch {
			this.#message = INVALID_PASTE_MESSAGE;
		}
	}

	/** Delete one Unicode code point from the currently active field. */
	backspace(): void {
		if (this.#closed) return;
		this.#message = undefined;
		if (this.#mode === "checkpoint" && this.#activeField === "confirmation") {
			this.#confirmation = Array.from(this.#confirmation).slice(0, -1).join("");
			return;
		}
		this.#password = Array.from(this.#password).slice(0, -1).join("");
	}

	clearActive(): void {
		if (this.#closed) return;
		this.#message = undefined;
		if (this.#mode === "checkpoint" && this.#activeField === "confirmation") {
			this.#confirmation = "";
			return;
		}
		this.#password = "";
	}

	/** Move between the checkpoint password and confirmation fields. */
	switchField(): void {
		if (this.#closed || this.#mode !== "checkpoint") return;
		this.#activeField = this.#activeField === "password" ? "confirmation" : "password";
		this.#message = undefined;
	}

	submit(): PasswordSubmission {
		if (this.#closed) return { status: "closed" };

		if (this.#mode === "checkpoint" && this.#activeField === "password") {
			if (!isWellFormedUnicode(this.#password)) {
				this.#message = INVALID_ENCODING_MESSAGE;
				return { status: "invalid-encoding" };
			}
			this.#activeField = "confirmation";
			this.#message = undefined;
			return { status: "confirmation-required" };
		}

		if (
			!isWellFormedUnicode(this.#password) ||
			(this.#mode === "checkpoint" && !isWellFormedUnicode(this.#confirmation))
		) {
			this.#message = INVALID_ENCODING_MESSAGE;
			return { status: "invalid-encoding" };
		}

		if (this.#mode === "checkpoint" && this.#password !== this.#confirmation) {
			this.#password = "";
			this.#confirmation = "";
			this.#activeField = "password";
			this.#message = MISMATCH_MESSAGE;
			return { status: "mismatch" };
		}

		// TextEncoder provides the required exact UTF-8 encoding without any
		// Unicode normalization. Clear owned string references before returning.
		const password = new TextEncoder().encode(this.#password);
		this.dispose();
		return { status: "accepted", password };
	}

	/** Drop the owned secret references on cancel, completion, or unmount. */
	dispose(): void {
		this.#password = "";
		this.#confirmation = "";
		this.#message = undefined;
		this.#closed = true;
	}
}

export interface PasswordDialogPort<Rendered> {
	show(render: () => Rendered, onClose?: () => void): void;
	clear(): void;
}

/**
 * Small dialog lifecycle seam so cancellation/cleanup can be tested without
 * loading the OpenTUI runtime. The real UI supplies the public dialog API.
 */
export function showPasswordPrompt<Rendered>(
	dialog: PasswordDialogPort<Rendered>,
	mode: PasswordMode,
	render: (
		prompt: PasswordPromptState,
		accept: (password: Uint8Array) => void,
		cancel: () => void,
	) => Rendered,
	maxPasswordBytes = 4096,
): Promise<Uint8Array | undefined> {
	return new Promise((resolve, reject) => {
		const prompt = new PasswordPromptState(mode, maxPasswordBytes);
		let settled = false;

		const settle = (password: Uint8Array | undefined): void => {
			if (settled) return;
			settled = true;
			prompt.dispose();
			try {
				dialog.clear();
			} finally {
				resolve(password);
			}
		};

		const onClose = (): void => {
			if (settled) return;
			settled = true;
			prompt.dispose();
			resolve(undefined);
		};

		try {
			dialog.show(
				() => render(prompt, (password) => settle(password), () => settle(undefined)),
				onClose,
			);
		} catch (error) {
			settled = true;
			prompt.dispose();
			reject(error);
		}
	});
}
