import { describe, expect, test, vi } from "vitest";
import { createDebugFlag } from "../lib/content/debug-flag";
import type { BgResponse } from "../lib/messages";

/** Promesse résolue de l'extérieur. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function setup() {
	const answers: Array<ReturnType<typeof deferred<BgResponse<boolean>>>> = [];
	const fetchFlag = vi.fn(() => {
		const d = deferred<BgResponse<boolean>>();
		answers.push(d);
		return d.promise;
	});
	const onRise = vi.fn();
	const flag = createDebugFlag(fetchFlag, onRise);
	return { flag, fetchFlag, onRise, answers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createDebugFlag", () => {
	test("faux tant que rien n'est lu, aucune lecture sans appel", () => {
		const t = setup();
		expect(t.flag.current()).toBe(false);
		expect(t.fetchFlag).not.toHaveBeenCalled();
	});

	test("passage de faux à vrai : onRise une fois ; une seconde lecture vraie ne le rappelle pas", async () => {
		const t = setup();
		t.flag.read();
		t.answers[0]?.resolve({ ok: true, data: true });
		await flush();
		expect(t.flag.current()).toBe(true);
		expect(t.onRise).toHaveBeenCalledTimes(1);

		t.flag.read();
		t.answers[1]?.resolve({ ok: true, data: true });
		await flush();
		expect(t.onRise).toHaveBeenCalledTimes(1);
	});

	test("compte ordinaire, erreur ou service worker indisponible : faux, sans onRise", async () => {
		const t = setup();
		t.flag.read();
		t.answers[0]?.resolve({ ok: true, data: false });
		await flush();
		t.flag.read();
		t.answers[1]?.resolve({ ok: false, error: { code: "network" } });
		await flush();
		t.flag.read();
		t.answers[2]?.reject(new Error("boom"));
		await flush();
		expect(t.flag.current()).toBe(false);
		expect(t.onRise).not.toHaveBeenCalled();
	});

	test("readIfOff : aucune lecture si le drapeau est déjà vrai", async () => {
		const t = setup();
		t.flag.readIfOff();
		expect(t.fetchFlag).toHaveBeenCalledTimes(1);
		t.answers[0]?.resolve({ ok: true, data: true });
		await flush();
		t.flag.readIfOff();
		expect(t.fetchFlag).toHaveBeenCalledTimes(1);
	});

	test("réponses dans le désordre : seule la dernière lecture compte", async () => {
		const t = setup();
		t.flag.read();
		t.flag.read();
		t.answers[1]?.resolve({ ok: true, data: false });
		await flush();
		t.answers[0]?.resolve({ ok: true, data: true });
		await flush();
		expect(t.flag.current()).toBe(false);
		expect(t.onRise).not.toHaveBeenCalled();
	});

	test("vrai puis faux (déconnexion) puis vrai : onRise de nouveau", async () => {
		const t = setup();
		for (const data of [true, false, true]) {
			t.flag.read();
			t.answers.at(-1)?.resolve({ ok: true, data });
			await flush();
		}
		expect(t.onRise).toHaveBeenCalledTimes(2);
	});
});
