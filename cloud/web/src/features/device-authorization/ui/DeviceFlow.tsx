"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { fetchBrowserSession, parseSession, type SessionData } from "@/entities/browser-session";
import { apiErrorCode, apiErrorMessage } from "@/shared/api";
import { LoadingPanel, StatusNotice } from "@/shared/ui/feedback";
import { decideDeviceAuthorization, verifyDeviceAuthorization } from "../actions";
import {
	isValidHumanCode,
	normalizeCodeInput,
	parseActionStatus,
	parseConsent,
	type ConsentData,
} from "../model";

type SessionState = "loading" | "ready" | "signed-out" | "error";
type Screen = "entry" | "consent" | "expired" | "result";
type Decision = "approve" | "deny";

export function DeviceFlow({ signOutControl }: { signOutControl?: ReactNode }) {
	const [sessionState, setSessionState] = useState<SessionState>("loading");
	const [session, setSession] = useState<SessionData | null>(null);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [screen, setScreen] = useState<Screen>("entry");
	const [userCode, setUserCode] = useState("");
	const [consent, setConsent] = useState<ConsentData | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [busyDecision, setBusyDecision] = useState<Decision | null>(null);
	const [inputError, setInputError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const codeInputRef = useRef<HTMLInputElement>(null);
	const previousScreen = useRef<Screen>("entry");

	const loadSession = useCallback(async () => {
		setSessionState("loading");
		setSessionError(null);
		const result = await fetchBrowserSession();
		if (result.networkError) {
			setSession(null);
			setSessionState("error");
			setSessionError("We couldn’t reach SessionPort. Check your connection and try again.");
			return;
		}
		if (result.status === 401 || apiErrorCode(result.data) === "unauthenticated") {
			setSession(null);
			setSessionState("signed-out");
			return;
		}
		if (!result.ok) {
			setSession(null);
			setSessionState("error");
			setSessionError(apiErrorMessage(result.data, "Your account could not be loaded right now."));
			return;
		}
		const value = parseSession(result.data);
		if (!value) {
			setSession(null);
			setSessionState("error");
			setSessionError("The account service returned an unexpected response. Please try again.");
			return;
		}
		setSession(value);
		setSessionState("ready");
	}, []);

	useEffect(() => {
		if (window.location.hash) window.history.replaceState(window.history.state, "", "/device");
	}, []);

	useEffect(() => {
		const clearOnPageHide = () => {
			setUserCode("");
			setConsent(null);
			setConfirmed(false);
			setInputError(null);
			setActionError(null);
			setOutcome(null);
			setScreen("entry");
		};
		window.addEventListener("pagehide", clearOnPageHide);
		return () => window.removeEventListener("pagehide", clearOnPageHide);
	}, []);

	useEffect(() => {
		void loadSession();
	}, [loadSession]);

	useEffect(() => {
		if (previousScreen.current !== screen) {
			if (screen === "entry") codeInputRef.current?.focus();
			else headingRef.current?.focus();
			previousScreen.current = screen;
		}
	}, [screen]);

	function updateCode(value: string) {
		const normalized = normalizeCodeInput(value);
		setUserCode(normalized.code);
		setInputError(
			normalized.invalidCharacter
				? "Use letters and numbers from the code."
				: normalized.tooLong
					? "A request code has 12 characters."
					: null,
		);
	}

	async function verifyRequest(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!session || busy) return;
		setInputError(null);
		setActionError(null);
		if (!isValidHumanCode(userCode)) {
			setInputError("Enter the 12-character code shown in OpenCode.");
			return;
		}
		setBusy(true);
		const result = await verifyDeviceAuthorization(userCode, session.csrfToken);
		setBusy(false);
		if (result.networkError) {
			setInputError("The request could not be checked. Check your connection and try again.");
			return;
		}
		if (result.status === 401 || apiErrorCode(result.data) === "unauthenticated") {
			setSession(null);
			setSessionState("signed-out");
			setUserCode("");
			return;
		}
		if (!result.ok) {
			if (result.status === 404 || apiErrorCode(result.data) === "not-found") {
				setUserCode("");
				setScreen("expired");
				return;
			}
			setInputError(apiErrorMessage(result.data, "The request could not be checked. Please try again."));
			return;
		}
		const value = parseConsent(result.data);
		if (!value) {
			setInputError("The request service returned an unexpected response. Please try again.");
			return;
		}
		if (Date.parse(value.expiresAt) <= Date.now()) {
			setUserCode("");
			setConsent(null);
			setScreen("expired");
			return;
		}
		setConsent(value);
		setConfirmed(false);
		setScreen("consent");
	}

	async function decide(decision: Decision) {
		if (!session || !consent || busyDecision) return;
		if (decision === "approve" && !confirmed) return;
		setBusyDecision(decision);
		setActionError(null);
		const result = await decideDeviceAuthorization(decision, userCode, session.csrfToken);
		setBusyDecision(null);
		if (result.networkError) {
			setActionError("We couldn’t confirm the decision. Check your connection before trying again.");
			return;
		}
		if (result.status === 401 || apiErrorCode(result.data) === "unauthenticated") {
			setSession(null);
			setSessionState("signed-out");
			setUserCode("");
			setConsent(null);
			return;
		}
		const expected = decision === "approve" ? "approved" : "denied";
		if (!result.ok || !parseActionStatus(result.data, expected)) {
			if (result.status === 404 || apiErrorCode(result.data) === "not-found") {
				setUserCode("");
				setConsent(null);
				setScreen("expired");
				return;
			}
			setActionError(apiErrorMessage(result.data, "The decision was not confirmed. Please try again."));
			return;
		}
		setUserCode("");
		setConsent(null);
		setConfirmed(false);
		setOutcome(expected);
		setScreen("result");
	}

	function startOver() {
		setUserCode("");
		setConsent(null);
		setConfirmed(false);
		setInputError(null);
		setActionError(null);
		setOutcome(null);
		setScreen("entry");
	}

	return (
		<main id="main-content" className="page-grid device-page">
			<section className="page-intro" aria-labelledby="page-title">
				<p className="eyebrow"><span className="eyebrow-line" />OPEN-CODE APPROVAL <span className="eyebrow-index">02 / 03</span></p>
				<h1 id="page-title">A careful check before a device connects.</h1>
				<p className="intro-copy">Enter the code shown in OpenCode. Review the account and requested access, then decide whether to approve it.</p>
				<div className="intro-note">
					<span className="note-symbol" aria-hidden="true">↳</span>
					<p>Signing in and approving access are separate steps.</p>
				</div>
				<div className="page-index" aria-hidden="true"><span>01</span><i /><span className="current">02</span><i /><span>03</span></div>
			</section>

			<section className="workbench" aria-labelledby="workbench-title">
				<div className="workbench-topline">
					<span className="workbench-kicker">DEVICE AUTHORIZATION</span>
					<span className="workbench-state"><span className="state-dot" />HUMAN REVIEW</span>
				</div>
				<div className="workbench-content">
					{sessionState === "loading" ? (
						<>
							<p className="step-number">—</p>
							<h2 id="workbench-title">Checking your account</h2>
							<LoadingPanel label="Loading account details" />
						</>
					) : null}

					{sessionState === "error" ? (
						<>
							<p className="step-number">!</p>
							<h2 id="workbench-title">Account details unavailable</h2>
							<StatusNotice>{sessionError}</StatusNotice>
							<button className="button button-secondary button-wide" type="button" onClick={() => void loadSession()}>Try again</button>
						</>
					) : null}

					{sessionState === "signed-out" ? (
						<>
							<p className="step-number">01</p>
							<h2 id="workbench-title">Sign in to continue</h2>
							<p className="panel-copy">Your account is needed to verify who would receive access. No request has been approved.</p>
							<Link className="button button-primary button-wide" href="/login">Sign in with GitHub <span className="button-arrow" aria-hidden="true">↗</span></Link>
						</>
					) : null}

					{sessionState === "ready" && session ? (
						<>
							<p className="step-number">{screen === "consent" ? "02" : screen === "result" ? "03" : "01"}</p>
							<h2 id="workbench-title" ref={headingRef} tabIndex={-1}>{screenTitle(screen, outcome)}</h2>
							<div className="signed-in-line">
								<span className="account-mark" aria-hidden="true">{initials(session.user.name)}</span>
								<span><strong>{session.user.name}</strong><small>{session.user.email}</small></span>
								{signOutControl}
							</div>

							{screen === "entry" ? (
								<form className="code-form" method="post" onSubmit={verifyRequest} noValidate>
									<label className="field-label" htmlFor="human-code">Request code</label>
									<p id="code-help" className="field-help">Enter the 12 characters shown in OpenCode. Spaces and dashes are okay.</p>
									<input
										id="human-code"
										ref={codeInputRef}
										className="code-input"
										type="text"
										value={userCode}
										onChange={(event) => updateCode(event.currentTarget.value)}
										autoComplete="off"
										autoCapitalize="characters"
										autoCorrect="off"
										spellCheck={false}
										inputMode="text"
										aria-describedby={`code-help${inputError ? " code-error" : ""}`}
										aria-invalid={inputError ? "true" : undefined}
										placeholder="•••• •••• ••••"
									/>
									{inputError ? <p id="code-error" className="field-error" role="alert">{inputError}</p> : null}
									<button className="button button-primary button-wide" type="submit" disabled={busy}>
										{busy ? <><span className="button-spinner" aria-hidden="true" />Checking request…</> : <>Review request <span className="button-arrow" aria-hidden="true">→</span></>}
									</button>
									<p className="fine-print">The code stays out of the address bar and is cleared after you decide.</p>
								</form>
							) : null}

							{screen === "consent" && consent ? (
								<div className="consent-view">
									<div className="consent-account">
										<p className="detail-label">ACCOUNT THAT WILL RECEIVE ACCESS</p>
										<strong>{consent.account.name}</strong>
										<span>{consent.account.email}</span>
									</div>
									<div className="scope-block">
										<p className="detail-label">ACCESS REQUESTED</p>
										{consent.scopes.length === 0 ? <p className="scope-empty">No access scopes were returned.</p> : null}
										<ul className="scope-list">
											{consent.scopes.map((scope, index) => <li key={`${scope}-${index}`}><span aria-hidden="true">+</span>{scope}</li>)}
										</ul>
									</div>
									<p className="expiry-line">Request expires <time dateTime={consent.expiresAt}>{formatDate(consent.expiresAt)}</time></p>
									<div className="warning-notice">
										<span className="warning-mark" aria-hidden="true">!</span>
										<p>Approve only a request you started in OpenCode. Anyone who gave you this code may receive access to your account.</p>
									</div>
									<label className="consent-check">
										<input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} disabled={busyDecision !== null} />
										<span>I started this request in OpenCode and understand the warning above.</span>
									</label>
									{actionError ? <StatusNotice>{actionError}</StatusNotice> : null}
									<div className="decision-actions">
										<button className="button button-primary" type="button" onClick={() => void decide("approve")} disabled={!confirmed || busyDecision !== null}>
											{busyDecision === "approve" ? <><span className="button-spinner" aria-hidden="true" />Approving…</> : "Approve access"}
										</button>
										<button className="button button-quiet" type="button" onClick={() => void decide("deny")} disabled={busyDecision !== null}>
											{busyDecision === "deny" ? "Denying…" : "Deny request"}
										</button>
									</div>
								</div>
							) : null}

							{screen === "expired" ? (
								<div className="terminal-state">
									<StatusNotice variant="notice">This request has expired or is no longer available. Ask OpenCode to create a new code.</StatusNotice>
									<button className="button button-secondary button-wide" type="button" onClick={startOver}>Enter a new code</button>
								</div>
							) : null}

							{screen === "result" ? (
								<div className="terminal-state">
									<StatusNotice variant="success">
										{outcome === "approved" ? "Access approved. OpenCode can now continue with this account." : "Request denied. This device was not approved."}
									</StatusNotice>
									<button className="button button-secondary button-wide" type="button" onClick={startOver}>Review another request</button>
								</div>
							) : null}
						</>
					) : null}
				</div>
				<div className="workbench-bottomline">
					<span>YOUR ACCOUNT · YOUR DECISION</span>
					<Link href="/devices">Manage devices <span aria-hidden="true">↗</span></Link>
				</div>
			</section>
		</main>
	);
}

function screenTitle(screen: Screen, outcome: "approved" | "denied" | null): string {
	if (screen === "consent") return "Review this request";
	if (screen === "expired") return "Request no longer active";
	if (screen === "result") return outcome === "approved" ? "Access approved" : "Request denied";
	return "Enter your request code";
}

function initials(name: string): string {
	const letters = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "");
	return letters.join("").toUpperCase() || "SP";
}

function formatDate(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
