import type { Metadata } from "next";
import { LoginPage } from "@/_pages/login";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginRoute() {
	return <LoginPage />;
}
