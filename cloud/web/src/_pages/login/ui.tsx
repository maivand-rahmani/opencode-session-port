import { LoginButton } from "@/features/github-sign-in";
import { SiteFrame } from "@/widgets/site-frame";

export function LoginPage() {
	return (
		<SiteFrame active="login">
			<main id="main-content" className="page-grid login-page">
				<section className="page-intro" aria-labelledby="page-title">
					<p className="eyebrow"><span className="eyebrow-line" />Account access <span className="eyebrow-index">01 / 03</span></p>
					<h1 id="page-title">Sign in before you review.</h1>
					<p className="intro-copy">Use the GitHub account connected to SessionPort. You’ll see the account and access requested before you approve anything.</p>
					<div className="intro-note">
						<span className="note-symbol" aria-hidden="true">↳</span>
						<p>Signing in does not approve a device request.</p>
					</div>
				</section>
				<section className="workbench login-workbench" aria-labelledby="sign-in-title">
					<div className="workbench-topline">
						<span className="workbench-kicker">SESSIONPORT ACCOUNT</span>
						<span className="workbench-state"><span className="state-dot" />GITHUB ONLY</span>
					</div>
					<div className="workbench-content">
						<p className="step-number">01</p>
						<h2 id="sign-in-title">Continue with GitHub</h2>
						<p className="panel-copy">SessionPort uses GitHub sign-in for account access. Your browser will continue to GitHub and return here when sign-in is complete.</p>
						<LoginButton />
						<p className="fine-print">Only GitHub sign-in is available. This page will not ask for your GitHub password.</p>
					</div>
					<div className="workbench-bottomline">
						<span>NO DEVICE ACCESS IS GRANTED HERE</span>
						<a href="/device">Back to authorization <span aria-hidden="true">↗</span></a>
					</div>
				</section>
			</main>
		</SiteFrame>
	);
}
