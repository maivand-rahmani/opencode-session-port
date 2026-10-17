/** V1 OMO boundary: no stable public session-transfer API exists, so transfer no OMO data. */
export type OmoNoopResult = {
	readonly status: "no-op";
	readonly reason: "no-public-session-transfer-api";
};

export interface OmoAdapter {
	capture(): Promise<OmoNoopResult>;
	restore(): Promise<OmoNoopResult>;
}

const RESULT: OmoNoopResult = Object.freeze({
	status: "no-op",
	reason: "no-public-session-transfer-api",
});

/**
 * Deliberately does not inspect OMO configuration, package inventory, job-board
 * state, credentials, agents, tools, or host-managed files. Native OpenCode
 * sessions are the complete V1 payload; a future adapter requires an explicit,
 * stable, versioned public transfer API.
 */
export function createOmoAdapter(): OmoAdapter {
	return Object.freeze({
		capture: async () => RESULT,
		restore: async () => RESULT,
	});
}
