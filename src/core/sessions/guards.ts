/** Internal runtime guards shared by the session collection modules. */

/** True for JSON-shaped object values (non-null, not an array). */
export function isJsonObject(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort message text for wrapping a caught `unknown` value. */
export function errorText(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
