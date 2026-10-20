import type { ReactNode } from "react";

export function StatusNotice({
	children,
	variant = "error",
}: {
	children: ReactNode;
	variant?: "error" | "notice" | "success";
}) {
	return (
		<div className={`status-notice status-${variant}`} role={variant === "error" ? "alert" : "status"}>
			<span className="status-mark" aria-hidden="true">{variant === "success" ? "✓" : "•"}</span>
			<div>{children}</div>
		</div>
	);
}

export function LoadingPanel({ label = "Loading account details" }: { label?: string }) {
	return (
		<div className="loading-panel" role="status" aria-live="polite">
			<span className="loading-indicator" aria-hidden="true" />
			<span>{label}</span>
		</div>
	);
}
