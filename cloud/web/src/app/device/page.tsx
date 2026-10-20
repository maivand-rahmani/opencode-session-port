import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DeviceApprovalPage } from "@/_pages/device-approval";

export const metadata: Metadata = { title: "Authorize a device" };

type DevicePageProps = {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DeviceRoute({ searchParams }: DevicePageProps) {
	const query = await searchParams;
	if (Object.keys(query).length > 0) redirect("/device");
	return <DeviceApprovalPage />;
}
