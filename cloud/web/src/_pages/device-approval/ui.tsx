import { DeviceFlow } from "@/features/device-authorization";
import { SignOutButton } from "@/features/sign-out";
import { SiteFrame } from "@/widgets/site-frame";

export function DeviceApprovalPage() {
	return (
		<SiteFrame active="device">
			<DeviceFlow signOutControl={<SignOutButton />} />
		</SiteFrame>
	);
}
