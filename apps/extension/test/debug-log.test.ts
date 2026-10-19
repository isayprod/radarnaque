import { describe, expect, test, vi } from "vitest";
import { createDebugLog, type DebugSink } from "../lib/debug-log";

function fakeSink() {
	return {
		groupCollapsed: vi.fn<DebugSink["groupCollapsed"]>(),
		log: vi.fn<DebugSink["log"]>(),
		groupEnd: vi.fn<DebugSink["groupEnd"]>(),
	};
}

describe("createDebugLog", () => {
	test("écrit un groupe replié préfixé, avec l'objet tel quel", () => {
		const sink = fakeSink();
		const data = { a: 1 };
		createDebugLog(() => true, sink).group("scan envoyé", data);
		expect(sink.groupCollapsed).toHaveBeenCalledWith(
			"[Radarnaque debug] scan envoyé",
		);
		expect(sink.log).toHaveBeenCalledWith(data);
		expect(sink.groupEnd).toHaveBeenCalledTimes(1);
		// Ordre : ouverture, contenu, fermeture.
		const order = [
			sink.groupCollapsed.mock.invocationCallOrder[0],
			sink.log.mock.invocationCallOrder[0],
			sink.groupEnd.mock.invocationCallOrder[0],
		];
		expect(order).toEqual([...order].sort((x, y) => (x ?? 0) - (y ?? 0)));
	});

	test("n'écrit rien quand enabled() est faux, et relit enabled à chaque appel", () => {
		const sink = fakeSink();
		let enabled = false;
		const log = createDebugLog(() => enabled, sink);
		log.group("scan envoyé", {});
		expect(sink.groupCollapsed).not.toHaveBeenCalled();
		expect(sink.log).not.toHaveBeenCalled();
		expect(sink.groupEnd).not.toHaveBeenCalled();
		enabled = true;
		log.group("scan envoyé", {});
		expect(sink.groupCollapsed).toHaveBeenCalledTimes(1);
	});

	test("ne lève jamais, même si la console ou enabled échouent", () => {
		const sink = fakeSink();
		sink.log.mockImplementation(() => {
			throw new Error("console cassée");
		});
		expect(() =>
			createDebugLog(() => true, sink).group("scan reçu", {}),
		).not.toThrow();
		expect(() =>
			createDebugLog(() => {
				throw new Error("boom");
			}, sink).group("scan reçu", {}),
		).not.toThrow();
	});

	test("enabled() rend le prédicat, et faux s'il lève", () => {
		let on = false;
		const log = createDebugLog(() => on, fakeSink());
		expect(log.enabled()).toBe(false);
		on = true;
		expect(log.enabled()).toBe(true);
		expect(
			createDebugLog(() => {
				throw new Error("boom");
			}, fakeSink()).enabled(),
		).toBe(false);
	});
});
