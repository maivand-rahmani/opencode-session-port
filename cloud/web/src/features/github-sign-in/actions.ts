import { requestJson, type ApiResult } from "@/shared/api";

export function startGitHubSignIn(): Promise<ApiResult> {
	return requestJson("/api/auth/sign-in/social", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ provider: "github" }),
	});
}
