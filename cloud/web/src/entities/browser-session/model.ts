import { isRecord } from "@/shared/api";

export type User = { id: string; name: string; email: string };
export type SessionData = { user: User; csrfToken: string };

export function parseSession(value: unknown): SessionData | null {
	if (!isRecord(value)) return null;
	const user = parseUser(value.user);
	if (!user || typeof value.csrfToken !== "string" || value.csrfToken.length === 0) return null;
	return { user, csrfToken: value.csrfToken };
}

export function parseUser(value: unknown): User | null {
	if (!isRecord(value)) return null;
	if (
		typeof value.id !== "string" || value.id.trim().length === 0 ||
		typeof value.name !== "string" || value.name.trim().length === 0 ||
		typeof value.email !== "string" || value.email.trim().length === 0
	) return null;
	return { id: value.id, name: value.name, email: value.email };
}
