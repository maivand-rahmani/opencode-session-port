import { parseUser, type User } from "@/entities/browser-session";
import { isRecord } from "@/shared/api";

export type ConsentData = { account: User; scopes: string[]; expiresAt: string };

export function parseConsent(value: unknown): ConsentData | null {
	if (!isRecord(value) || !isRecord(value.consent)) return null;
	const consent = value.consent;
	const account = parseUser(consent.account);
	if (
		!account ||
		!Array.isArray(consent.scopes) ||
		!consent.scopes.every((scope) => typeof scope === "string" && scope.trim().length > 0) ||
		typeof consent.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(consent.expiresAt))
	) {
		return null;
	}
	return { account, scopes: consent.scopes, expiresAt: consent.expiresAt };
}

export function parseActionStatus(value: unknown, expected: "approved" | "denied"): boolean {
	return isRecord(value) && value.status === expected;
}

export function normalizeCodeInput(value: string): { code: string; invalidCharacter: boolean; tooLong: boolean } {
	let code = "";
	let invalidCharacter = false;
	for (const character of value) {
		if (character === " " || character === "-" || character === "\t" || character === "\r" || character === "\n") continue;
		const charCode = character.charCodeAt(0);
		if (charCode >= 97 && charCode <= 122) {
			code += String.fromCharCode(charCode - 32);
		} else if ((charCode >= 65 && charCode <= 90) || (charCode >= 48 && charCode <= 57)) {
			code += character;
		} else {
			invalidCharacter = true;
		}
	}
	const tooLong = code.length > 12;
	return { code: code.slice(0, 12), invalidCharacter, tooLong };
}

export function isValidHumanCode(value: string): boolean {
	return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(value);
}
