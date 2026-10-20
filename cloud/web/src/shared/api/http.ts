export type ApiResult = {
	ok: boolean;
	status: number;
	data: unknown;
	networkError: boolean;
};

export async function requestJson(path: string, init?: RequestInit): Promise<ApiResult> {
	try {
		const response = await fetch(path, {
			...init,
			cache: "no-store",
			credentials: "same-origin",
		});
		let data: unknown = null;
		try {
			data = await response.json();
		} catch {
			data = null;
		}
		return { ok: response.ok, status: response.status, data, networkError: false };
	} catch {
		return { ok: false, status: 0, data: null, networkError: true };
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
