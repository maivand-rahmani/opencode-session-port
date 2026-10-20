import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../_app/styles/globals.css";

export const metadata: Metadata = {
	title: {
		default: "SessionPort · OpenCode access",
		template: "%s · SessionPort",
	},
	description: "Review OpenCode device access for your SessionPort account.",
	referrer: "no-referrer",
	robots: { index: false, follow: false },
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	themeColor: "#f3f4ef",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
