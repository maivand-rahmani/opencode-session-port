"use client";

import { useState } from "react";
import { apiErrorMessage, isRecord } from "@/shared/api";
import { StatusNotice } from "@/shared/ui/feedback";
import { startGitHubSignIn } from "./actions";

export function LoginButton() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function startSignIn() {
		if (busy) return;
		setBusy(true);
		setError(null);
		const result = await startGitHubSignIn();
		setBusy(false);
		if (result.networkError) {
			setError("Sign-in could not be reached. Check your connection and try again.");
			return;
		}
		if (!result.ok) {
			setError(apiErrorMessage(result.data, "GitHub sign-in is unavailable right now. Please try again."));
			return;
		}
		const url = isRecord(result.data) ? result.data.url : undefined;
		if (typeof url !== "string" || !isSafeGitHubAuthorizationUrl(url)) {
			setError("The sign-in service returned an unexpected response. Please try again.");
			return;
		}
		window.location.assign(url);
	}

	return (
		<div className="login-action">
			{error ? <StatusNotice>{error}</StatusNotice> : null}
			<button className="button button-primary github-button" type="button" onClick={startSignIn} disabled={busy}>
				{busy ? <span className="button-spinner" aria-hidden="true" /> : <GitHubMark />}
				<span>{busy ? "Connecting to GitHub…" : "Continue with GitHub"}</span>
				{!busy ? <span className="button-arrow" aria-hidden="true">↗</span> : null}
			</button>
			<p className="login-privacy">You’ll be redirected to <strong>github.com</strong> to sign in.</p>
		</div>
	);
}

function isSafeGitHubAuthorizationUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.origin === "https://github.com" &&
			url.pathname === "/login/oauth/authorize" &&
			url.username === "" &&
			url.password === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

function GitHubMark() {
	return (
		<svg className="github-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path fill="currentColor" d="M12 .8a11.2 11.2 0 0 0-3.54 21.82c.56.1.76-.24.76-.54v-2.1c-3.1.68-3.76-1.32-3.76-1.32-.5-1.3-1.24-1.65-1.24-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.62 1.22 3.26.93.1-.72.4-1.22.72-1.5-2.48-.28-5.08-1.24-5.08-5.52 0-1.22.44-2.22 1.16-3-.12-.28-.5-1.42.12-2.96 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.62 1.54.24 2.68.12 2.96.72.78 1.16 1.78 1.16 3 0 4.3-2.6 5.24-5.1 5.52.4.34.76 1.02.76 2.06v3.05c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" />
		</svg>
	);
}
