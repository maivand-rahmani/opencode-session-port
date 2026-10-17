// These test only the pure report-navigation state. They do not validate
// actual-host frames, keyboard input delivery, or dialog lifecycle behavior.
import { describe, expect, test } from "bun:test";
import {
	RestoreReportNavigator,
	type RestoreReportSession,
} from "../../../src/tui/ui/restore-report-flow.ts";

function session(sessionID: string): RestoreReportSession {
	return { sessionID, classification: "imported", status: "imported" };
}

describe("restore report navigation", () => {
	test("starts at the first outcome and respects both boundaries", () => {
		const navigator = new RestoreReportNavigator([session("ses-first"), session("ses-last")]);

		expect(navigator.snapshot()).toMatchObject({
			index: 0,
			count: 2,
			pageCount: 2,
			session: { sessionID: "ses-first" },
			canPrevious: false,
			canNext: true,
		});
		expect(navigator.previous().session?.sessionID).toBe("ses-first");

		expect(navigator.last()).toMatchObject({
			index: 1,
			session: { sessionID: "ses-last" },
			canPrevious: true,
			canNext: false,
		});
		expect(navigator.next().session?.sessionID).toBe("ses-last");
	});

	test("moves through every result without skipping and supports first/last jumps", () => {
		const navigator = new RestoreReportNavigator([
			session("ses-1"),
			session("ses-2"),
			session("ses-3"),
		]);
		const visited = [navigator.snapshot().session?.sessionID];

		visited.push(navigator.next().session?.sessionID);
		visited.push(navigator.next().session?.sessionID);

		expect(visited).toEqual(["ses-1", "ses-2", "ses-3"]);
		expect(navigator.first().session?.sessionID).toBe("ses-1");
		expect(navigator.last().session?.sessionID).toBe("ses-3");
	});

	test("keeps an empty report at a safe, non-navigable boundary", () => {
		const navigator = new RestoreReportNavigator([]);

		expect(navigator.snapshot()).toEqual({
			index: 0,
			count: 0,
			pageCount: 0,
			session: undefined,
			canPrevious: false,
			canNext: false,
		});
		expect(navigator.previous().session).toBeUndefined();
		expect(navigator.next().session).toBeUndefined();
		expect(navigator.last().index).toBe(0);
	});
});
