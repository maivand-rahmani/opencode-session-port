"use client";

import { useState } from "react";
import { apiErrorMessage } from "@/shared/api";
import { signOutBrowser } from "./actions";

export function SignOutButton() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function signOut() {
		if (busy) return;
		setBusy(true);
		setError(null);
		const result = await signOutBrowser();
		if (result.ok || result.status === 401) {
			window.location.assign("/login");
			return;
		}
		setBusy(false);
		setError(result.networkError
			? "Couldn’t reach the sign-out service."
			: apiErrorMessage(result.data, "Sign-out is unavailable right now."));
	}

	return (
		<div className="signout-control">
			<button className="text-button signout-button" type="button" onClick={signOut} disabled={busy}>
				{busy ? "Signing out…" : "Sign out"}
			</button>
			{error ? <span className="signout-error" role="alert">{error}</span> : null}
		</div>
	);
}
