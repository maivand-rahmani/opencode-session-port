import { DevicesPanel } from "@/features/revoke-device";
import { SignOutButton } from "@/features/sign-out";
import { SiteFrame } from "@/widgets/site-frame";

export function ConnectedDevicesPage() {
	return (
		<SiteFrame active="devices">
			<main id="main-content" className="page-grid devices-page">
				<section className="page-intro" aria-labelledby="page-title">
					<p className="eyebrow"><span className="eyebrow-line" />ACCOUNT ACCESS <span className="eyebrow-index">03 / 03</span></p>
					<h1 id="page-title">Know what’s connected.</h1>
					<p className="intro-copy">Review the OpenCode devices authorized for your account. Revoke access here whenever you need to.</p>
					<div className="intro-note">
						<span className="note-symbol" aria-hidden="true">↳</span>
						<p>Revoked devices need a new approval to reconnect.</p>
					</div>
					<div className="page-index" aria-hidden="true"><span>01</span><i /><span>02</span><i /><span className="current">03</span></div>
				</section>
				<DevicesPanel signOutControl={<SignOutButton />} />
			</main>
		</SiteFrame>
	);
}
