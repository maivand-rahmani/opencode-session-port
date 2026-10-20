"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchBrowserSession, parseSession, type SessionData } from "@/entities/browser-session";
import { fetchDeviceGrants, parseGrants, type DeviceGrant } from "@/entities/device-grant";
import { apiErrorCode, apiErrorMessage } from "@/shared/api";
import { LoadingPanel, StatusNotice } from "@/shared/ui/feedback";
import { revokeDevice } from "../actions";
import { parseRevokeStatus } from "../model";

type LoadState = "loading" | "ready" | "signed-out" | "error";

export function DevicesPanel({ signOutControl }: { signOutControl?: ReactNode }) {
	const [state, setState] = useState<LoadState>("loading");
	const [session, setSession] = useState<SessionData | null>(null);
	const [grants, setGrants] = useState<DeviceGrant[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [actionMessage, setActionMessage] = useState<string | null>(null);
	const [confirmingID, setConfirmingID] = useState<string | null>(null);
	const [revokingID, setRevokingID] = useState<string | null>(null);

	const loadAccount = useCallback(async () => {
		setState("loading");
		setLoadError(null);
		setActionError(null);
		setActionMessage(null);
		const sessionResult = await fetchBrowserSession();
		if (sessionResult.networkError) {
			setSession(null);
			setState("error");
			setLoadError("We couldn’t reach SessionPort. Check your connection and try again.");
			return;
		}
		if (sessionResult.status === 401 || apiErrorCode(sessionResult.data) === "unauthenticated") {
			setSession(null);
			setState("signed-out");
			return;
		}
		const sessionValue = sessionResult.ok ? parseSession(sessionResult.data) : null;
		if (!sessionValue) {
			setSession(null);
			setState("error");
			setLoadError(apiErrorMessage(sessionResult.data, "Your account could not be loaded right now."));
			return;
		}

		setSession(sessionValue);
		const grantsResult = await fetchDeviceGrants();
		if (grantsResult.networkError) {
			setState("error");
			setLoadError("Your device list could not be reached. Check your connection and try again.");
			return;
		}
		if (grantsResult.status === 401 || apiErrorCode(grantsResult.data) === "unauthenticated") {
			setSession(null);
			setState("signed-out");
			return;
		}
		if (!grantsResult.ok) {
			setState("error");
			setLoadError(apiErrorMessage(grantsResult.data, "Your device list could not be loaded right now."));
			return;
		}
		const values = parseGrants(grantsResult.data);
		if (!values) {
			setState("error");
			setLoadError("The device service returned an unexpected response. Please try again.");
			return;
		}
		setGrants(values);
		setState("ready");
	}, []);

	useEffect(() => {
		void loadAccount();
	}, [loadAccount]);

	async function revokeGrant(grant: DeviceGrant) {
		if (!session || revokingID) return;
		setRevokingID(grant.id);
		setActionError(null);
		setActionMessage(null);
		const result = await revokeDevice(grant.id, session.csrfToken);
		setRevokingID(null);
		if (result.networkError) {
			setActionError("We couldn’t confirm the revocation. Check your connection before trying again.");
			return;
		}
		if (result.status === 401 || apiErrorCode(result.data) === "unauthenticated") {
			setSession(null);
			setState("signed-out");
			return;
		}
		if (!result.ok || !parseRevokeStatus(result.data)) {
			setActionError(apiErrorMessage(result.data, "Access was not revoked. Please try again."));
			return;
		}
		setGrants((current) => current.map((item) => item.id === grant.id ? { ...item, status: "revoked" } : item));
		setConfirmingID(null);
		setActionMessage("Access revoked. This device will need approval again to reconnect.");
	}

	const active = grants.filter((grant) => grant.status === "active" && Date.parse(grant.expiresAt) > Date.now());
	const expired = grants.filter((grant) => grant.status === "active" && Date.parse(grant.expiresAt) <= Date.now());
	const revoked = grants.filter((grant) => grant.status === "revoked");

	return (
		<div className="workbench devices-workbench" aria-labelledby="devices-panel-title">
			<div className="workbench-topline">
				<span className="workbench-kicker">CONNECTED DEVICES</span>
				<span className="workbench-state"><span className="state-dot" />ACCOUNT ACCESS</span>
			</div>
			<div className="workbench-content">
				<p className="step-number">03</p>
				<h2 id="devices-panel-title">Your device access</h2>
				{state === "loading" ? <LoadingPanel label="Loading your devices" /> : null}
				{state === "error" ? (
					<div className="terminal-state">
						<StatusNotice>{loadError}</StatusNotice>
						<button className="button button-secondary button-wide" type="button" onClick={() => void loadAccount()}>Try again</button>
					</div>
				) : null}
				{state === "signed-out" ? (
					<div className="terminal-state">
						<p className="panel-copy">Sign in to view or revoke the devices connected to your account.</p>
						<Link className="button button-primary button-wide" href="/login">Sign in with GitHub <span className="button-arrow" aria-hidden="true">↗</span></Link>
					</div>
				) : null}
				{state === "ready" ? (
					<>
						{session ? <div className="devices-account"><span className="account-mark" aria-hidden="true">{initials(session.user.name)}</span><span><strong>{session.user.name}</strong><small>{session.user.email}</small></span>{signOutControl}</div> : null}
						{actionMessage ? <StatusNotice variant="success">{actionMessage}</StatusNotice> : null}
						{actionError ? <StatusNotice>{actionError}</StatusNotice> : null}
						{grants.length === 0 ? (
							<div className="empty-state">
								<span className="empty-mark" aria-hidden="true">—</span>
								<h3>No devices yet</h3>
								<p>When you approve a request from OpenCode, it will appear here.</p>
							</div>
						) : (
							<div className="grant-sections">
								{active.length > 0 ? <GrantGroup title="ACTIVE ACCESS" grants={active} confirmingID={confirmingID} revokingID={revokingID} onConfirm={(id) => setConfirmingID(id)} onCancel={() => setConfirmingID(null)} onRevoke={revokeGrant} /> : null}
								{expired.length > 0 ? <GrantGroup title="EXPIRED" grants={expired} confirmingID={confirmingID} revokingID={revokingID} onConfirm={(id) => setConfirmingID(id)} onCancel={() => setConfirmingID(null)} onRevoke={revokeGrant} /> : null}
								{revoked.length > 0 ? <GrantGroup title="REVOKED" grants={revoked} confirmingID={confirmingID} revokingID={revokingID} onConfirm={(id) => setConfirmingID(id)} onCancel={() => setConfirmingID(null)} onRevoke={revokeGrant} /> : null}
							</div>
						)}
					</>
				) : null}
			</div>
			<div className="workbench-bottomline">
				<span>ACCESS YOU CAN REVIEW</span>
				<Link href="/device">Authorize a device <span aria-hidden="true">↗</span></Link>
			</div>
		</div>
	);
}

function GrantGroup({
	title,
	grants,
	confirmingID,
	revokingID,
	onConfirm,
	onCancel,
	onRevoke,
}: {
	title: string;
	grants: DeviceGrant[];
	confirmingID: string | null;
	revokingID: string | null;
	onConfirm: (id: string) => void;
	onCancel: () => void;
	onRevoke: (grant: DeviceGrant) => void;
}) {
	return (
		<section className="grant-group" aria-labelledby={`group-${title.toLowerCase().replaceAll(" ", "-")}`}>
			<h3 className="detail-label" id={`group-${title.toLowerCase().replaceAll(" ", "-")}`}>{title} <span>{String(grants.length).padStart(2, "0")}</span></h3>
			<ul className="grant-list">
				{grants.map((grant) => {
					const live = grant.status === "active" && Date.parse(grant.expiresAt) > Date.now();
					const status = live ? "Active" : grant.status === "revoked" ? "Revoked" : "Expired";
					const deviceSuffix = grant.deviceID.slice(-8);
					return (
						<li className="grant-row" key={grant.id}>
							<div className="grant-heading">
								<div>
									<strong className="grant-name">OpenCode device</strong>
									<span className="grant-id">DEVICE · {deviceSuffix}</span>
								</div>
								<span className={`grant-status ${live ? "is-active" : ""}`}>{status}</span>
							</div>
							<dl className="grant-meta">
								<div><dt>Added</dt><dd><time dateTime={grant.createdAt}>{formatDate(grant.createdAt)}</time></dd></div>
								<div><dt>Last seen</dt><dd>{grant.lastSeenAt ? <time dateTime={grant.lastSeenAt}>{formatDate(grant.lastSeenAt)}</time> : "Not seen yet"}</dd></div>
								<div><dt>Expires</dt><dd><time dateTime={grant.expiresAt}>{formatDate(grant.expiresAt)}</time></dd></div>
								{grant.status === "revoked" && grant.revokedAt ? <div><dt>Revoked</dt><dd><time dateTime={grant.revokedAt}>{formatDate(grant.revokedAt)}</time></dd></div> : null}
							</dl>
							{live && confirmingID !== grant.id ? (
								<button className="text-button revoke-trigger" type="button" onClick={() => onConfirm(grant.id)} aria-label={`Revoke access for device ending ${deviceSuffix}`}>Revoke access <span aria-hidden="true">↗</span></button>
							) : null}
							{live && confirmingID === grant.id ? (
								<div className="revoke-confirm" aria-label="Confirm device revocation">
									<p>Revoke this device’s access? It will need approval again to reconnect.</p>
									<div>
										<button className="button button-danger-small" type="button" onClick={() => onRevoke(grant)} disabled={revokingID !== null}>{revokingID === grant.id ? "Revoking…" : "Confirm revoke"}</button>
										<button className="button button-quiet button-small" type="button" onClick={onCancel} disabled={revokingID !== null}>Keep access</button>
									</div>
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function initials(name: string): string {
	return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "SP";
}

function formatDate(value: string): string {
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
