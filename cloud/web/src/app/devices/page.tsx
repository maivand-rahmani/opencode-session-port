import type { Metadata } from "next";
import { ConnectedDevicesPage } from "@/_pages/connected-devices";

export const metadata: Metadata = { title: "My devices" };

export default function DevicesRoute() {
	return <ConnectedDevicesPage />;
}
