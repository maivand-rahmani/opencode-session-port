import type { ReactNode } from "react";

type SiteFrameProps = {
	active?: "device" | "devices" | "login";
	children: ReactNode;
};

export function SiteFrame({ active, children }: SiteFrameProps) {
	return (
		<div className="site-frame">
			<a className="skip-link" href="#main-content">Skip to main content</a>
			<header className="site-header">
				<a className="brand" href="/device" aria-label="SessionPort home">
					<BrandGlyph />
					<span className="brand-word">SessionPort</span>
					<span className="brand-divider" aria-hidden="true" />
					<span className="brand-context">OpenCode</span>
				</a>
				<nav className="site-nav" aria-label="Account">
					<a href="/device" aria-current={active === "device" ? "page" : undefined}>Authorize</a>
					<a href="/devices" aria-current={active === "devices" ? "page" : undefined}>My devices</a>
				</nav>
			</header>
			{children}
			<footer className="site-footer">
				<span>SessionPort · account access</span>
				<span>Only approve requests you started in OpenCode.</span>
			</footer>
		</div>
	);
}

export function BrandGlyph() {
	return (
		<svg className="brand-glyph" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
			<path d="M6 5.5h20v21H6z" fill="none" stroke="currentColor" strokeWidth="1.6" />
			<path d="M12 10.5v11M20 10.5v11M12 16h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
			<circle cx="16" cy="16" r="2" fill="currentColor" />
		</svg>
	);
}
