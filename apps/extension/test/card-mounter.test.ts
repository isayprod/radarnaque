import { describe, expect, test, vi } from "vitest";
import type { ShadowRootContentScriptUiOptions } from "wxt/utils/content-script-ui/shadow-root";
import type { CardRef } from "../lib/adapters/types";
import { CARD_HOST_TAG, type CardView } from "../lib/content/card-controller";
import {
	type CardRenderer,
	type CardUi,
	createCardMounter,
} from "../lib/content/card-mounter";

const view = (status: "idle" | "loading"): CardView => ({
	state: { status },
	locale: "fr",
	onActivate: () => {},
});

/** `createShadowRootUi` simulé, résolu à la demande ; `mount()` insère l'hôte après l'ancre. */
function fakeUiFactory() {
	const calls: Array<{
		options: ShadowRootContentScriptUiOptions<CardRenderer>;
		resolve(): void;
	}> = [];
	const createUi = vi.fn(
		(options: ShadowRootContentScriptUiOptions<CardRenderer>) =>
			new Promise<CardUi>((resolve) => {
				calls.push({
					options,
					resolve() {
						const anchor = options.anchor as Element;
						const host = anchor.ownerDocument.createElement(options.name);
						const container = anchor.ownerDocument.createElement("div");
						let mounted: CardRenderer | undefined;
						resolve({
							shadowHost: host,
							mount() {
								anchor.after(host);
								mounted = options.onMount(
									container,
									host.attachShadow({ mode: "open" }),
									host,
								);
							},
							remove() {
								options.onRemove?.(mounted);
								host.remove();
							},
						});
					},
				});
			}),
	);
	return { calls, createUi };
}

function setup() {
	const factory = fakeUiFactory();
	const renders: CardView[] = [];
	const unmounts = vi.fn();
	const mountCard = createCardMounter({
		createUi: factory.createUi,
		createRenderer: () => ({
			render: (v) => renders.push(v),
			unmount: unmounts,
		}),
	});
	const anchor = document.createElement("span");
	document.body.append(anchor);
	const card: CardRef = { element: anchor, externalId: "1", url: "x" };
	return { ...factory, renders, unmounts, mountCard, anchor, card };
}

describe("createCardMounter", () => {
	test("une UI inline par carte, après l'ancre ; la dernière vue est rendue au montage", async () => {
		const t = setup();
		const mount = t.mountCard(t.anchor, t.card, view("idle"));
		expect(t.calls[0]?.options).toMatchObject({
			name: CARD_HOST_TAG,
			position: "inline",
			append: "after",
			anchor: t.anchor,
		});
		expect(mount.isMounted()).toBe(true);
		mount.update(view("loading"));
		t.calls[0]?.resolve();
		await vi.waitFor(() => expect(t.renders).toHaveLength(1));
		expect(t.renders[0]?.state.status).toBe("loading");
		expect(t.anchor.nextElementSibling?.localName).toBe(CARD_HOST_TAG);

		mount.update(view("idle"));
		expect(t.renders).toHaveLength(2);
		mount.unmount();
		expect(t.unmounts).toHaveBeenCalledTimes(1);
		expect(t.anchor.nextElementSibling).toBeNull();
		expect(mount.isMounted()).toBe(false);
	});

	test("unmount avant la création : rien n'est inséré", async () => {
		const t = setup();
		const mount = t.mountCard(t.anchor, t.card, view("idle"));
		mount.unmount();
		t.calls[0]?.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(t.anchor.nextElementSibling).toBeNull();
		expect(t.renders).toHaveLength(0);
		expect(mount.isMounted()).toBe(false);
	});

	test("hôte retiré par le site : isMounted devient faux", async () => {
		const t = setup();
		const mount = t.mountCard(t.anchor, t.card, view("idle"));
		t.calls[0]?.resolve();
		await vi.waitFor(() => expect(t.renders).toHaveLength(1));
		t.anchor.nextElementSibling?.remove();
		expect(mount.isMounted()).toBe(false);
	});
});
