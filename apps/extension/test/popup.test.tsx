import type { Me } from "@radarnaque/shared";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import App from "../entrypoints/popup/App";
import { PUBLIC_URL } from "../lib/config";
import { detectLocale, dictionaries, type MessageKey, t } from "../lib/i18n";
import type { BgRequest, BgResponse } from "../lib/messages";
import { localePref, pendingSignIn, sessionToken } from "../lib/storage";
import { superuserMe, trialMe } from "./helpers";

const { sendToBackground } = vi.hoisted(() => ({
	sendToBackground: vi.fn<(req: BgRequest) => Promise<BgResponse<unknown>>>(),
}));

vi.mock("../lib/messages", () => ({ sendToBackground }));

type Handler = (req: BgRequest) => BgResponse<unknown>;

const ok = (data: unknown): BgResponse<unknown> => ({ ok: true, data });
const fail = (code: string): BgResponse<unknown> => ({
	ok: false,
	error: { code },
});
const signedOut = ok({ status: "signedOut" });
const signedIn = (me: Me = trialMe) => ok({ status: "signedIn", me });

/** Réponses du service worker simulé, par type de message. */
function background(handlers: Partial<Record<BgRequest["type"], Handler>>) {
	sendToBackground.mockImplementation(async (req) => {
		const handler = handlers[req.type];
		if (!handler) throw new Error(`message inattendu : ${req.type}`);
		return handler(req);
	});
}

function requestsOf(type: BgRequest["type"]) {
	return sendToBackground.mock.calls
		.map(([req]) => req)
		.filter((req) => req.type === type);
}

afterEach(cleanup);

beforeEach(() => {
	fakeBrowser.reset();
	sendToBackground.mockReset();
	vi.spyOn(browser.i18n, "getUILanguage").mockReturnValue("fr-BE");
});

describe("popup", () => {
	test("signed out → submit email sends auth/start with normalized email and shows code step", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);

		await user.type(
			await screen.findByLabelText("Adresse email"),
			"  Jean.Dupont@Exemple.BE ",
		);
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);

		expect(
			await screen.findByText(
				"Vérifiez votre boîte mail : cliquez sur le lien ou saisissez le code",
			),
		).toBeTruthy();
		expect(requestsOf("auth/start")).toEqual([
			{
				type: "auth/start",
				email: "jean.dupont@exemple.be",
				locale: "fr",
			},
		]);
		const code = screen.getByLabelText("Code à 6 chiffres");
		expect(code.getAttribute("inputmode")).toBe("numeric");
		expect(
			screen.getByRole("button", { name: "Renvoyer l'email" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Changer d'adresse" }),
		).toBeTruthy();
	});

	test("invalid email is rejected without calling the background", async () => {
		background({ "auth/state": () => signedOut });
		const user = userEvent.setup();
		render(<App />);

		await user.type(
			await screen.findByLabelText("Adresse email"),
			"pas-un-email",
		);
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);

		expect(await screen.findByText("Adresse email invalide.")).toBeTruthy();
		expect(requestsOf("auth/start")).toHaveLength(0);
	});

	test("rate_limited shows its translated message and stays on the email step", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => fail("rate_limited"),
		});
		const user = userEvent.setup();
		render(<App />);

		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);

		expect(
			await screen.findByText(
				"Trop de tentatives. Patientez quelques minutes avant de réessayer.",
			),
		).toBeTruthy();
		expect(screen.getByLabelText("Adresse email")).toBeTruthy();
	});

	test("network failure shows the generic unavailable message", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => fail("network"),
		});
		const user = userEvent.setup();
		render(<App />);

		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);

		expect(
			await screen.findByText("Service momentanément indisponible. Réessayez."),
		).toBeTruthy();
	});

	test("6th digit auto-submits auth/verify-otp; success shows plan and remaining scans", async () => {
		let verified = false;
		background({
			"auth/state": () => (verified ? signedIn() : signedOut),
			"auth/start": () => ok(null),
			"auth/verify-otp": () => {
				verified = true;
				return ok(null);
			},
		});
		const user = userEvent.setup();
		render(<App />);

		await user.type(await screen.findByLabelText("Adresse email"), "A@B.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);
		const code = await screen.findByLabelText("Code à 6 chiffres");

		await user.type(code, "12345");
		expect(requestsOf("auth/verify-otp")).toHaveLength(0);
		await user.type(code, "6");

		expect(await screen.findByText("Essai")).toBeTruthy();
		expect(requestsOf("auth/verify-otp")).toEqual([
			{ type: "auth/verify-otp", email: "a@b.be", otp: "123456" },
		]);
		expect(screen.getByText("a@b.be")).toBeTruthy();
		expect(screen.getByText("Analyses IA restantes")).toBeTruthy();
		expect(quotaCount()).toBe("3");
		expect(screen.queryByText(/photos/)).toBeNull();
		expect(screen.getByRole("button", { name: "Se déconnecter" })).toBeTruthy();
	});

	test("non-digits are ignored in the code field", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);
		const code = await screen.findByLabelText("Code à 6 chiffres");

		await user.type(code, "1a2 b3");

		expect((code as HTMLInputElement).value).toBe("123");
		expect(requestsOf("auth/verify-otp")).toHaveLength(0);
	});

	test("invalid_otp shows translated error and keeps code step", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => ok(null),
			"auth/verify-otp": () => fail("invalid_otp"),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);

		await user.type(
			await screen.findByLabelText("Code à 6 chiffres"),
			"000000",
		);

		expect(
			await screen.findByText(
				"Code incorrect ou expiré. Vérifiez-le ou demandez un nouvel email.",
			),
		).toBeTruthy();
		const code = screen.getByLabelText("Code à 6 chiffres") as HTMLInputElement;
		expect(code.value).toBe("");
		expect(
			screen.getByRole("button", { name: "Renvoyer l'email" }),
		).toBeTruthy();
	});

	test("resend sends auth/start again and confirms; change address returns to the email step", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => ok(null),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);

		await user.click(
			await screen.findByRole("button", { name: "Renvoyer l'email" }),
		);
		expect(await screen.findByText("Email renvoyé.")).toBeTruthy();
		expect(requestsOf("auth/start")).toHaveLength(2);

		await user.click(screen.getByRole("button", { name: "Changer d'adresse" }));
		const email = (await screen.findByLabelText(
			"Adresse email",
		)) as HTMLInputElement;
		expect(email.value).toBe("a@b.be");
	});

	test("token written by callback (storage change) switches to signed in without user action", async () => {
		let token: string | null = null;
		background({ "auth/state": () => (token ? signedIn() : signedOut) });
		render(<App />);
		await screen.findByLabelText("Adresse email");

		token = "session-from-callback";
		await sessionToken.setValue(token);

		expect(await screen.findByText("Essai")).toBeTruthy();
		expect(screen.queryByLabelText("Adresse email")).toBeNull();
	});

	test("sign out returns to email step", async () => {
		let out = false;
		background({
			"auth/state": () => (out ? signedOut : signedIn()),
			"auth/sign-out": () => {
				out = true;
				return ok(null);
			},
		});
		const user = userEvent.setup();
		render(<App />);

		await user.click(
			await screen.findByRole("button", { name: "Se déconnecter" }),
		);

		expect(await screen.findByLabelText("Adresse email")).toBeTruthy();
		expect(requestsOf("auth/sign-out")).toHaveLength(1);
	});

	test("pasting a formatted code submits exactly one auth/verify-otp with digits only", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => ok(null),
			"auth/verify-otp": () => fail("invalid_otp"),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);
		await user.click(await screen.findByLabelText("Code à 6 chiffres"));

		await user.paste("123 456");

		await waitFor(() =>
			expect(requestsOf("auth/verify-otp")).toEqual([
				{ type: "auth/verify-otp", email: "a@b.be", otp: "123456" },
			]),
		);
		await screen.findByText(
			"Code incorrect ou expiré. Vérifiez-le ou demandez un nouvel email.",
		);
		expect(requestsOf("auth/verify-otp")).toHaveLength(1);
	});

	test("reopening the popup after auth/start restores the code step for the same email", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		const first = render(<App />);
		await user.type(await screen.findByLabelText("Adresse email"), " A@B.be ");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);
		await screen.findByLabelText("Code à 6 chiffres");
		first.unmount();

		render(<App />);

		const code = (await screen.findByLabelText(
			"Code à 6 chiffres",
		)) as HTMLInputElement;
		expect(code.value).toBe("");
		expect(screen.getByText("a@b.be")).toBeTruthy();
		expect(requestsOf("auth/start")).toHaveLength(1);
		const pending = await pendingSignIn.getValue();
		expect(pending?.email).toBe("a@b.be");
		expect(Date.now() - (pending?.sentAt ?? 0)).toBeLessThan(5_000);
	});

	test("resend refreshes sentAt of the pending sign-in", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		await pendingSignIn.setValue({
			email: "a@b.be",
			sentAt: Date.now() - 60_000,
		});
		const before = Date.now();
		const user = userEvent.setup();
		render(<App />);

		await user.click(
			await screen.findByRole("button", { name: "Renvoyer l'email" }),
		);

		await screen.findByText("Email renvoyé.");
		expect((await pendingSignIn.getValue())?.sentAt).toBeGreaterThanOrEqual(
			before,
		);
	});

	test("an expired pending sign-in (> 10 min) shows the email step and is removed", async () => {
		await pendingSignIn.setValue({
			email: "a@b.be",
			sentAt: Date.now() - 10 * 60_000 - 1,
		});
		background({ "auth/state": () => signedOut });
		render(<App />);

		expect(await screen.findByLabelText("Adresse email")).toBeTruthy();
		expect(screen.queryByLabelText("Code à 6 chiffres")).toBeNull();
		await waitFor(async () =>
			expect(await pendingSignIn.getValue()).toBeNull(),
		);
	});

	test("a successful sign-in clears the pending sign-in", async () => {
		let verified = false;
		background({
			"auth/state": () => (verified ? signedIn() : signedOut),
			"auth/start": () => ok(null),
			"auth/verify-otp": () => {
				verified = true;
				return ok(null);
			},
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);
		await screen.findByLabelText("Code à 6 chiffres");
		expect(await pendingSignIn.getValue()).not.toBeNull();

		await user.type(screen.getByLabelText("Code à 6 chiffres"), "123456");

		await screen.findByText("Essai");
		await waitFor(async () =>
			expect(await pendingSignIn.getValue()).toBeNull(),
		);
	});

	test("change address clears the pending sign-in", async () => {
		background({ "auth/state": () => signedOut });
		await pendingSignIn.setValue({ email: "a@b.be", sentAt: Date.now() });
		const user = userEvent.setup();
		render(<App />);

		await user.click(
			await screen.findByRole("button", { name: "Changer d'adresse" }),
		);

		await screen.findByLabelText("Adresse email");
		await waitFor(async () =>
			expect(await pendingSignIn.getValue()).toBeNull(),
		);
	});

	test("sign out clears the pending sign-in", async () => {
		let out = false;
		background({
			"auth/state": () => (out ? signedOut : signedIn()),
			"auth/sign-out": () => {
				out = true;
				return ok(null);
			},
		});
		const user = userEvent.setup();
		render(<App />);
		const signOut = await screen.findByRole("button", {
			name: "Se déconnecter",
		});
		await pendingSignIn.setValue({ email: "a@b.be", sentAt: Date.now() });

		await user.click(signOut);

		await screen.findByLabelText("Adresse email");
		expect(await pendingSignIn.getValue()).toBeNull();
	});

	test("session_expired during verification returns to the email step", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => ok(null),
			"auth/verify-otp": () => fail("session_expired"),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);

		await user.type(
			await screen.findByLabelText("Code à 6 chiffres"),
			"123456",
		);

		expect(await screen.findByLabelText("Adresse email")).toBeTruthy();
		expect(
			screen.getByText("Votre session a expiré. Reconnectez-vous."),
		).toBeTruthy();
	});

	test("state failure shows the unavailable message with a retry", async () => {
		let calls = 0;
		background({
			"auth/state": () => (++calls === 1 ? fail("network") : signedIn()),
		});
		const user = userEvent.setup();
		render(<App />);

		// Le message générique reste annoncé (aria-live), masqué à l'écran : le titre
		// et la phrase de l'écran injoignable disent déjà la même chose.
		const message = await screen.findByText(
			"Service momentanément indisponible. Réessayez.",
		);
		expect(message.closest(".sr-only")).not.toBeNull();
		expect(message.closest("[aria-live='polite']")).not.toBeNull();
		await user.click(screen.getByRole("button", { name: "Réessayer" }));

		expect(await screen.findByText("Essai")).toBeTruthy();
	});

	test("account view: admin is unlimited, no plan shows no subscription, standard shows its plan", async () => {
		const admin: Me = {
			...trialMe,
			role: "admin",
			plan: null,
			unlimited: true,
			quotas: [],
			totalCap: null,
		};
		background({ "auth/state": () => signedIn(admin) });
		const { unmount } = render(<App />);
		expect(await screen.findByText("Administrateur · illimité")).toBeTruthy();
		unmount();

		background({
			"auth/state": () =>
				signedIn({ ...admin, unlimited: false, role: "user" }),
		});
		const second = render(<App />);
		expect(await screen.findByText("Aucun abonnement actif")).toBeTruthy();
		second.unmount();

		background({
			"auth/state": () =>
				signedIn({
					...trialMe,
					plan: "standard",
					totalCap: null,
					quotas: [{ scanKind: "full", limit: 150, used: 20, remaining: 130 }],
				}),
		});
		render(<App />);
		expect(await screen.findByText("Standard")).toBeTruthy();
		expect(quotaCount()).toBe("130");
	});

	test("superuser shows Premium : « Superuser (dev) — Premium » en FR et en NL, sans analyses restantes", async () => {
		background({ "auth/state": () => signedIn(superuserMe) });
		const { unmount } = render(<App />);
		expect(await screen.findByText("Superuser (dev) — Premium")).toBeTruthy();
		expect(screen.queryByText("Administrateur · illimité")).toBeNull();
		expect(screen.queryByText(/restante/)).toBeNull();
		unmount();

		await localePref.setValue("nl");
		render(<App />);
		expect(await screen.findByText("Superuser (dev) — Premium")).toBeTruthy();
		expect(screen.queryByText("Beheerder · onbeperkt")).toBeNull();
		expect(screen.queryByText("Resterende AI-analyses")).toBeNull();
		expect(quotaCount()).toBeNull();
	});

	test("shows remaining scans : le quota full, limité par le plafond total, 0 compris", async () => {
		const premium = (remaining: number, cap: number | null = null): Me => ({
			...trialMe,
			plan: "premium",
			totalCap:
				cap === null
					? null
					: { scanKind: null, limit: 300, used: 300 - cap, remaining: cap },
			quotas: [
				{ scanKind: "full", limit: 300, used: 300 - remaining, remaining },
			],
		});
		const cases: Array<[Me, string]> = [
			[premium(300), "300"],
			[premium(120, 40), "40"],
			[premium(1), "1"],
			[premium(0), "0"],
		];
		for (const [me, count] of cases) {
			background({ "auth/state": () => signedIn(me) });
			const { unmount } = render(<App />);
			expect(await screen.findByText("Analyses IA restantes")).toBeTruthy();
			expect(quotaCount()).toBe(count);
			unmount();
		}
		await localePref.setValue("nl");
		background({ "auth/state": () => signedIn(premium(2)) });
		render(<App />);
		expect(await screen.findByText("Resterende AI-analyses")).toBeTruthy();
		expect(quotaCount()).toBe("2");
	});

	test("NL locale renders Dutch labels", async () => {
		await localePref.setValue("nl");
		background({ "auth/state": () => signedOut });
		render(<App />);

		expect(await screen.findByLabelText("E-mailadres")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Ontvang mijn aanmeldlink" }),
		).toBeTruthy();
	});

	test("NL account view uses Dutch plan and scan labels", async () => {
		await localePref.setValue("nl");
		background({ "auth/state": () => signedIn() });
		render(<App />);

		expect(await screen.findByText("Proef")).toBeTruthy();
		expect(screen.getByText("Resterende AI-analyses")).toBeTruthy();
		expect(quotaCount()).toBe("3");
		expect(screen.getByRole("button", { name: "Afmelden" })).toBeTruthy();
	});

	test("without a stored preference the locale comes from the browser UI language", async () => {
		vi.mocked(browser.i18n.getUILanguage).mockReturnValue("nl-BE");
		background({ "auth/state": () => signedOut });
		render(<App />);

		expect(await screen.findByLabelText("E-mailadres")).toBeTruthy();
	});

	test("locale selector switches language and saves localePref", async () => {
		background({ "auth/state": () => signedOut });
		const user = userEvent.setup();
		render(<App />);
		await screen.findByLabelText("Adresse email");

		await user.click(screen.getByRole("button", { name: "NL" }));

		expect(await screen.findByLabelText("E-mailadres")).toBeTruthy();
		await waitFor(async () => expect(await localePref.getValue()).toBe("nl"));
		expect(
			screen.getByRole("button", { name: "NL" }).getAttribute("aria-pressed"),
		).toBe("true");
	});

	test("auth/start carries the selected locale", async () => {
		await localePref.setValue("nl");
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);

		await user.type(await screen.findByLabelText("E-mailadres"), "a@b.be");
		await user.click(
			screen.getByRole("button", { name: "Ontvang mijn aanmeldlink" }),
		);

		await waitFor(() =>
			expect(requestsOf("auth/start")).toEqual([
				{ type: "auth/start", email: "a@b.be", locale: "nl" },
			]),
		);
	});

	test("delete section hidden when signed out", async () => {
		background({ "auth/state": () => signedOut });
		render(<App />);
		await screen.findByLabelText("Adresse email");

		expect(screen.queryByText("Supprimer mon compte")).toBeNull();
		expect(
			screen.queryByLabelText("Tapez SUPPRIMER pour confirmer"),
		).toBeNull();
	});

	test("delete section is collapsed by default when signed in", async () => {
		background({ "auth/state": () => signedIn() });
		render(<App />);

		const title = await screen.findByText("Supprimer mon compte");
		expect(title.closest("details")?.hasAttribute("open")).toBe(false);
	});

	test("delete button disabled until the word is typed (fr)", async () => {
		background({ "auth/state": () => signedIn() });
		const user = userEvent.setup();
		render(<App />);
		const input = await screen.findByLabelText(
			"Tapez SUPPRIMER pour confirmer",
		);
		const button = screen.getByRole("button", {
			name: "Supprimer définitivement",
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);

		await user.type(input, "supprim");
		expect(button.disabled).toBe(true);

		await user.clear(input);
		await user.type(input, "  supprimer ");
		expect(button.disabled).toBe(false);
	});

	test("delete word is VERWIJDEREN in nl", async () => {
		await localePref.setValue("nl");
		background({ "auth/state": () => signedIn() });
		const user = userEvent.setup();
		render(<App />);
		const input = await screen.findByLabelText(
			"Typ VERWIJDEREN om te bevestigen",
		);
		const button = screen.getByRole("button", {
			name: "Definitief verwijderen",
		}) as HTMLButtonElement;

		await user.type(input, "SUPPRIMER");
		expect(button.disabled).toBe(true);

		await user.clear(input);
		await user.type(input, "verwijderen");
		expect(button.disabled).toBe(false);
		expect(screen.getByText("Mijn account verwijderen")).toBeTruthy();
	});

	test("double click sends one account/delete", async () => {
		let release: (response: BgResponse<unknown>) => void = () => {};
		let deleted = false;
		background({
			"auth/state": () => (deleted ? signedOut : signedIn()),
			"account/delete": () =>
				new Promise<BgResponse<unknown>>((resolve) => {
					release = resolve;
				}) as unknown as BgResponse<unknown>,
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(
			await screen.findByLabelText("Tapez SUPPRIMER pour confirmer"),
			"SUPPRIMER",
		);
		const button = screen.getByRole("button", {
			name: "Supprimer définitivement",
		});

		await user.dblClick(button);

		expect(requestsOf("account/delete")).toEqual([{ type: "account/delete" }]);
		const pending = await screen.findByRole("button", { name: "Suppression…" });
		expect((pending as HTMLButtonElement).disabled).toBe(true);
		deleted = true;
		release(ok(null));
		await screen.findByLabelText("Adresse email");
		expect(requestsOf("account/delete")).toHaveLength(1);
	});

	test("success shows message then sign-in screen", async () => {
		let deleted = false;
		background({
			"auth/state": () => (deleted ? signedOut : signedIn()),
			"account/delete": () => {
				deleted = true;
				return ok(null);
			},
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(
			await screen.findByLabelText("Tapez SUPPRIMER pour confirmer"),
			"SUPPRIMER",
		);

		await user.click(
			screen.getByRole("button", { name: "Supprimer définitivement" }),
		);

		expect(await screen.findByLabelText("Adresse email")).toBeTruthy();
		expect(screen.getByText("Votre compte a été supprimé.")).toBeTruthy();
		expect(screen.queryByText("Supprimer mon compte")).toBeNull();
	});

	test("failure keeps the section and shows the error", async () => {
		background({
			"auth/state": () => signedIn(),
			"account/delete": () => fail("unavailable"),
		});
		const user = userEvent.setup();
		render(<App />);
		const input = (await screen.findByLabelText(
			"Tapez SUPPRIMER pour confirmer",
		)) as HTMLInputElement;
		await user.type(input, "SUPPRIMER");
		const title = screen.getByText("Supprimer mon compte");
		title.closest("details")?.setAttribute("open", "");

		await user.click(
			screen.getByRole("button", { name: "Supprimer définitivement" }),
		);

		expect(
			await screen.findByText(
				"La suppression a échoué, votre compte n'a pas été modifié. Réessayez.",
			),
		).toBeTruthy();
		expect(title.closest("details")?.hasAttribute("open")).toBe(true);
		expect(input.value).toBe("SUPPRIMER");
		expect(
			(
				screen.getByRole("button", {
					name: "Supprimer définitivement",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
		expect(screen.queryByText("Votre compte a été supprimé.")).toBeNull();
		expect(screen.getByText("Essai")).toBeTruthy();
	});

	test("sign-out disabled while a deletion is pending", async () => {
		let release: (response: BgResponse<unknown>) => void = () => {};
		background({
			"auth/state": () => signedIn(),
			"account/delete": () =>
				new Promise<BgResponse<unknown>>((resolve) => {
					release = resolve;
				}) as unknown as BgResponse<unknown>,
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(
			await screen.findByLabelText("Tapez SUPPRIMER pour confirmer"),
			"SUPPRIMER",
		);
		const signOut = screen.getByRole("button", {
			name: "Se déconnecter",
		}) as HTMLButtonElement;
		expect(signOut.disabled).toBe(false);

		await user.click(
			screen.getByRole("button", { name: "Supprimer définitivement" }),
		);

		await screen.findByRole("button", { name: "Suppression…" });
		expect(signOut.disabled).toBe(true);
		await user.click(signOut);
		expect(requestsOf("auth/sign-out")).toHaveLength(0);
		release(fail("unavailable"));
		await screen.findByText(
			"La suppression a échoué, votre compte n'a pas été modifié. Réessayez.",
		);
		expect(signOut.disabled).toBe(false);
	});

	test("delete disabled while a sign-out is pending", async () => {
		let release: (response: BgResponse<unknown>) => void = () => {};
		background({
			"auth/state": () => signedIn(),
			"auth/sign-out": () =>
				new Promise<BgResponse<unknown>>((resolve) => {
					release = resolve;
				}) as unknown as BgResponse<unknown>,
		});
		const user = userEvent.setup();
		render(<App />);
		const input = await screen.findByLabelText(
			"Tapez SUPPRIMER pour confirmer",
		);
		await user.type(input, "SUPPRIMER");
		const submit = screen.getByRole("button", {
			name: "Supprimer définitivement",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(false);

		await user.click(screen.getByRole("button", { name: "Se déconnecter" }));

		await waitFor(() => expect(submit.disabled).toBe(true));
		await user.click(submit);
		await user.type(input, "{Enter}");
		expect(requestsOf("account/delete")).toHaveLength(0);
		release(fail("unavailable"));
		await waitFor(() => expect(submit.disabled).toBe(false));
	});

	test("session_expired on delete signs out without claiming the account was deleted", async () => {
		background({
			"auth/state": () => signedIn(),
			"account/delete": () => fail("session_expired"),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(
			await screen.findByLabelText("Tapez SUPPRIMER pour confirmer"),
			"SUPPRIMER",
		);

		await user.click(
			screen.getByRole("button", { name: "Supprimer définitivement" }),
		);

		expect(await screen.findByLabelText("Adresse email")).toBeTruthy();
		expect(
			screen.getByText("Votre session a expiré. Reconnectez-vous."),
		).toBeTruthy();
		expect(screen.queryByText("Votre compte a été supprimé.")).toBeNull();
	});

	test.each(["network", "background_unavailable"])(
		"delete failure %s says the server could not be reached",
		async (code) => {
			background({
				"auth/state": () => signedIn(),
				"account/delete": () => fail(code),
			});
			const user = userEvent.setup();
			render(<App />);
			await user.type(
				await screen.findByLabelText("Tapez SUPPRIMER pour confirmer"),
				"SUPPRIMER",
			);

			await user.click(
				screen.getByRole("button", { name: "Supprimer définitivement" }),
			);

			expect(
				await screen.findByText(
					"Impossible de joindre le serveur. Si votre compte a été supprimé, vous serez déconnecté.",
				),
			).toBeTruthy();
			expect(
				screen.queryByText(
					"La suppression a échoué, votre compte n'a pas été modifié. Réessayez.",
				),
			).toBeNull();
		},
	);

	test("nl delete texts use je/jouw like the rest of the popup", async () => {
		await localePref.setValue("nl");
		background({
			"auth/state": () => signedIn(),
			"account/delete": () => fail("network"),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(
			await screen.findByLabelText("Typ VERWIJDEREN om te bevestigen"),
			"VERWIJDEREN",
		);
		await user.click(
			screen.getByRole("button", { name: "Definitief verwijderen" }),
		);

		expect(
			await screen.findByText(
				"De server is niet bereikbaar. Als je account verwijderd is, word je afgemeld.",
			),
		).toBeTruthy();
		for (const key of [
			"delete.explanation",
			"delete.success",
			"delete.failure",
			"delete.unreachable",
		] as const) {
			expect(t("nl", key)).not.toMatch(/\b(uw|u)\b/i);
		}
		expect(t("nl", "delete.success")).toBe("Je account is verwijderd.");
		expect(t("nl", "delete.failure")).toBe(
			"Verwijderen is mislukt, je account is niet gewijzigd. Probeer opnieuw.",
		);
	});

	test("privacy link points to /privacy with the active locale", async () => {
		background({ "auth/state": () => signedOut });
		const user = userEvent.setup();
		render(<App />);

		const fr = await screen.findByRole("link", { name: "Confidentialité" });
		expect(fr.getAttribute("href")).toBe(
			"http://localhost:8080/privacy/?lang=fr",
		);
		expect(fr.getAttribute("target")).toBe("_blank");
		expect(fr.getAttribute("rel")).toContain("noopener");

		await user.click(screen.getByRole("button", { name: "NL" }));

		const nl = await screen.findByRole("link", { name: "Privacy" });
		expect(nl.getAttribute("href")).toBe(
			"http://localhost:8080/privacy/?lang=nl",
		);
	});
});

/** Passe l'écran de connexion : email « a@b.be » envoyé, champ du code affiché. */
async function toCodeStep(user: ReturnType<typeof userEvent.setup>) {
	await user.type(await screen.findByLabelText("Adresse email"), "a@b.be");
	await user.click(
		screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
	);
	return (await screen.findByLabelText(
		"Code à 6 chiffres",
	)) as HTMLInputElement;
}

/** Nombre affiché dans le panneau du quota, `null` s'il n'y en a pas. */
function quotaCount(): string | null {
	return document.querySelector("[data-quota-count]")?.textContent ?? null;
}

/** Les six cases décoratives du code, dans l'ordre. */
function codeCells(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>("[data-code-cell]")];
}

describe("popup : cadre et écrans d'accès", () => {
	test("en-tête : logo, « Radarnaque », FR/NL en aria-pressed", async () => {
		background({ "auth/state": () => signedOut });
		render(<App />);
		await screen.findByLabelText("Adresse email");

		const header = screen.getByRole("banner");
		expect(
			within(header).getByRole("heading", { name: "Radarnaque" }),
		).toBeTruthy();
		const logo = header.querySelector("svg");
		expect(logo?.getAttribute("aria-hidden")).toBe("true");
		expect(logo?.getAttribute("width")).toBe("22");
		expect(header.querySelector("img")).toBeNull();
		expect(
			within(header)
				.getByRole("button", { name: "FR" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			within(header)
				.getByRole("button", { name: "NL" })
				.getAttribute("aria-pressed"),
		).toBe("false");
		expect(within(header).getByRole("group", { name: "Langue" })).toBeTruthy();
	});

	test("chargement : squelette visible, « Chargement… » lisible par les lecteurs d'écran seulement", async () => {
		// L'état n'arrive jamais : la popup reste sur le chargement.
		sendToBackground.mockImplementation(() => new Promise(() => {}));
		render(<App />);

		const text = await screen.findByText("Chargement…");
		expect(text.classList.contains("sr-only")).toBe(true);
		const bones = document.querySelectorAll(".rq-skeleton");
		expect(bones).toHaveLength(3);
		for (const bone of bones) {
			expect(bone.className).toContain("bg-bg-3");
			expect(bone.closest("[aria-hidden='true']")).not.toBeNull();
		}
	});

	test("déconnecté : titre signin.title, phrase signin.lead, note signin.note, pilule « Recevoir mon lien de connexion », liens Confidentialité et Formules", async () => {
		background({ "auth/state": () => signedOut });
		render(<App />);
		await screen.findByLabelText("Adresse email");

		expect(
			screen.getByRole("heading", {
				level: 2,
				name: "Repérez les arnaques avant de payer",
			}),
		).toBeTruthy();
		expect(
			screen.getByText(
				"Connectez-vous pour analyser les annonces de 2ememain, 2dehands et Marketplace.",
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				"Un lien et un code vous sont envoyés par email. Pas de mot de passe.",
			),
		).toBeTruthy();
		const pill = screen.getByRole("button", {
			name: "Recevoir mon lien de connexion",
		});
		expect(pill.className).toContain("bg-white");
		expect(pill.className).toContain("w-full");
		const footer = screen.getByRole("contentinfo");
		const privacy = within(footer).getByRole("link", {
			name: "Confidentialité",
		});
		expect(privacy.getAttribute("href")).toBe(`${PUBLIC_URL}/privacy/?lang=fr`);
		const pricing = within(footer).getByRole("link", { name: "Formules" });
		expect(pricing.getAttribute("href")).toBe(`${PUBLIC_URL}/pricing/?lang=fr`);
		for (const link of [privacy, pricing]) {
			expect(link.getAttribute("target")).toBe("_blank");
			expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		}
	});

	test("déconnecté en NL : textes flamands du spec et liens en ?lang=nl", async () => {
		await localePref.setValue("nl");
		background({ "auth/state": () => signedOut });
		render(<App />);
		await screen.findByLabelText("E-mailadres");

		expect(
			screen.getByRole("heading", {
				level: 2,
				name: "Herken oplichting vóór je betaalt",
			}),
		).toBeTruthy();
		const footer = screen.getByRole("contentinfo");
		expect(
			within(footer)
				.getByRole("link", { name: "Formules" })
				.getAttribute("href"),
		).toBe(`${PUBLIC_URL}/pricing/?lang=nl`);
		expect(
			within(footer)
				.getByRole("link", { name: "Privacy" })
				.getAttribute("href"),
		).toBe(`${PUBLIC_URL}/privacy/?lang=nl`);
	});

	test("code envoyé : titre code.title, un seul champ de saisie, six cases aria-hidden qui reflètent « 482 »", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);
		const code = await toCodeStep(user);

		expect(
			screen.getByRole("heading", { level: 2, name: "Vérifiez vos emails" }),
		).toBeTruthy();
		expect(screen.getAllByRole("textbox")).toEqual([code]);
		expect(code.getAttribute("inputmode")).toBe("numeric");
		expect(code.getAttribute("autocomplete")).toBe("one-time-code");

		await user.type(code, "482");

		const cells = codeCells();
		expect(cells).toHaveLength(6);
		expect(cells.map((cell) => cell.textContent)).toEqual([
			"4",
			"8",
			"2",
			"",
			"",
			"",
		]);
		for (const cell of cells)
			expect(cell.closest("[aria-hidden='true']")).not.toBeNull();
		// Le champ a le focus : la case courante (la 4e) porte l'anneau de focus.
		expect(document.activeElement).toBe(code);
		expect(cells[3]?.className).toContain("--focus-ring");
		expect(cells[2]?.className).not.toContain("--focus-ring");
	});

	test("code envoyé : l'anneau de la case courante suit le focus du champ", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);
		const code = await toCodeStep(user);

		expect(codeCells()[0]?.className).toContain("--focus-ring");
		await user.tab();
		expect(document.activeElement).not.toBe(code);
		expect(
			codeCells().some((cell) => cell.className.includes("--focus-ring")),
		).toBe(false);
	});

	test("code collé « 123 456 » : une seule vérification avec « 123456 »", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => ok(null),
			"auth/verify-otp": () => fail("invalid_otp"),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.click(await toCodeStep(user));

		await user.paste("123 456");

		await waitFor(() =>
			expect(requestsOf("auth/verify-otp")).toEqual([
				{ type: "auth/verify-otp", email: "a@b.be", otp: "123456" },
			]),
		);
		await screen.findByText(
			"Code incorrect ou expiré. Vérifiez-le ou demandez un nouvel email.",
		);
		expect(requestsOf("auth/verify-otp")).toHaveLength(1);
		// Le champ garde son étiquette ; vidé après l'échec, les cases aussi.
		expect(screen.getByLabelText("Code à 6 chiffres")).toBeTruthy();
		expect(codeCells().map((cell) => cell.textContent)).toEqual(
			Array(6).fill(""),
		);
	});

	/** Colle `pasted` dans le champ du code ; la vérification reste en attente. */
	async function pasteCode(pasted: string) {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => ok(null),
		});
		const verify = vi.fn();
		const base = sendToBackground.getMockImplementation();
		sendToBackground.mockImplementation((req) => {
			if (req.type === "auth/verify-otp") {
				verify(req);
				return new Promise(() => {});
			}
			return base ? base(req) : Promise.reject(new Error("inattendu"));
		});
		const user = userEvent.setup();
		render(<App />);
		const code = await toCodeStep(user);
		await user.click(code);
		await user.paste(pasted);
		return { code, verify };
	}

	/** Une seule vérification avec `otp` ; les cases reflètent le champ pendant l'envoi. */
	async function expectSingleVerify(
		code: HTMLInputElement,
		verify: ReturnType<typeof vi.fn>,
		otp: string,
	) {
		await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
		expect(verify).toHaveBeenCalledWith({
			type: "auth/verify-otp",
			email: "a@b.be",
			otp,
		});
		expect(code.value).toBe(otp);
		expect(codeCells().map((cell) => cell.textContent)).toEqual([...otp]);
		expect(await screen.findByText("Vérification…")).toBeTruthy();
		expect(screen.getByLabelText("Code à 6 chiffres")).toBe(code);
	}

	test("code : le curseur reste en fin de saisie (focus, clic, flèches, sélection)", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);
		const code = await toCodeStep(user);
		await user.type(code, "482");
		const atEnd = () => [code.selectionStart, code.selectionEnd];

		await user.keyboard("{ArrowLeft}{ArrowLeft}");
		expect(atEnd()).toEqual([3, 3]);

		await user.keyboard("{Home}");
		expect(atEnd()).toEqual([3, 3]);

		await user.pointer({ target: code, offset: 1, keys: "[MouseLeft]" });
		expect(atEnd()).toEqual([3, 3]);

		code.setSelectionRange(0, 2);
		fireEvent.select(code);
		expect(atEnd()).toEqual([3, 3]);

		await user.tab();
		code.setSelectionRange(0, 0);
		await user.click(code);
		expect(atEnd()).toEqual([3, 3]);

		// Le chiffre suivant s'ajoute à la fin : « 4825 », pas « 4582 ».
		await user.keyboard("{ArrowLeft}5");
		expect(code.value).toBe("4825");
		expect(codeCells().map((cell) => cell.textContent)).toEqual([
			"4",
			"8",
			"2",
			"5",
			"",
			"",
		]);
	});

	test("code : « tout sélectionner » puis coller remplace le code à moitié tapé", async () => {
		background({
			"auth/state": () => signedOut,
			"auth/start": () => ok(null),
		});
		const verify = vi.fn();
		const base = sendToBackground.getMockImplementation();
		sendToBackground.mockImplementation((req) => {
			if (req.type === "auth/verify-otp") {
				verify(req);
				return new Promise(() => {});
			}
			return base ? base(req) : Promise.reject(new Error("inattendu"));
		});
		const user = userEvent.setup();
		render(<App />);
		const code = await toCodeStep(user);
		await user.type(code, "12");

		await user.keyboard("{Control>}a{/Control}");
		expect([code.selectionStart, code.selectionEnd]).toEqual([0, 2]);
		await user.paste("654321");

		await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
		expect(verify).toHaveBeenCalledWith({
			type: "auth/verify-otp",
			email: "a@b.be",
			otp: "654321",
		});
		expect(code.value).toBe("654321");
	});

	test("code : « tout sélectionner » puis Retour arrière vide le champ", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);
		const code = await toCodeStep(user);
		await user.type(code, "482");

		code.select();
		fireEvent.select(code);
		expect([code.selectionStart, code.selectionEnd]).toEqual([0, 3]);
		await user.keyboard("{Backspace}");

		expect(code.value).toBe("");
		expect(codeCells().map((cell) => cell.textContent)).toEqual(
			Array(6).fill(""),
		);
	});

	test("7 chiffres collés : les 6 premiers", async () => {
		const { code, verify } = await pasteCode("1234567");
		await expectSingleVerify(code, verify, "123456");
	});

	test.each([["123-456"], ["code : 12a34b56"]])(
		"code collé « %s » : une seule vérification avec « 123456 »",
		async (pasted) => {
			const { code, verify } = await pasteCode(pasted);
			await expectSingleVerify(code, verify, "123456");
		},
	);

	test("injoignable : titre app.unavailableTitle, phrase app.unavailableText, pilule « Réessayer »", async () => {
		background({ "auth/state": () => fail("network") });
		render(<App />);

		expect(
			await screen.findByRole("heading", {
				level: 2,
				name: "Service injoignable",
			}),
		).toBeTruthy();
		expect(
			screen.getByText(
				"Impossible de joindre Radarnaque. Vérifiez votre connexion, puis réessayez.",
			),
		).toBeTruthy();
		const retry = screen.getByRole("button", { name: "Réessayer" });
		expect(retry.className).toContain("bg-white");
		expect(retry.className).toContain("w-full");
	});

	test("zone de messages : erreur sur bg-danger-soft, confirmation sur bg-success-soft, région aria-live", async () => {
		background({ "auth/state": () => signedOut, "auth/start": () => ok(null) });
		const user = userEvent.setup();
		render(<App />);

		await user.type(await screen.findByLabelText("Adresse email"), "x");
		await user.click(
			screen.getByRole("button", { name: "Recevoir mon lien de connexion" }),
		);
		const error = await screen.findByText("Adresse email invalide.");
		expect(error.className).toContain("bg-danger-soft");
		// Hors de l'écran injoignable, le message reste visible.
		expect(error.closest(".sr-only")).toBeNull();
		expect(error.closest("[aria-live='polite']")).not.toBeNull();

		await user.clear(screen.getByLabelText("Adresse email"));
		await toCodeStep(user);
		await user.click(screen.getByRole("button", { name: "Renvoyer l'email" }));
		const resent = await screen.findByText("Email renvoyé.");
		expect(resent.className).toContain("bg-success-soft");
		expect(resent.closest("[aria-live='polite']")).not.toBeNull();
	});
});

/** Un compte d'essai avec ce plan et sans quota ni plafond. */
function accountWith(overrides: Partial<Me>): Me {
	return { ...trialMe, quotas: [], totalCap: null, ...overrides };
}

describe("popup : écran du compte", () => {
	test("connecté (essai, 3) : email, étiquette account.scansLabel, badge « Essai », nombre « 3 »", async () => {
		background({ "auth/state": () => signedIn() });
		render(<App />);

		const email = await screen.findByText("a@b.be");
		expect(email.className).toContain("truncate");
		expect(email.className).toContain("text-text-2");
		const panel = document.querySelector<HTMLElement>("[data-quota]");
		expect(panel?.className).toContain("bg-bg-2");
		expect(panel?.className).toContain("rounded-md");
		const scoped = within(panel as HTMLElement);
		expect(scoped.getByText("Analyses IA restantes")).toBeTruthy();
		expect(scoped.getByText("Essai").className).toContain("bg-accent-soft");
		const count = scoped.getByText("3");
		expect(count.hasAttribute("data-quota-count")).toBe(true);
		expect(count.className).toContain("font-serif");
		expect(count.className).toContain("text-[48px]");
		expect(count.className).toContain("tabular-nums");
	});

	test("connecté illimité : badge plan.unlimited sans nombre", async () => {
		background({
			"auth/state": () =>
				signedIn(accountWith({ role: "admin", plan: null, unlimited: true })),
		});
		render(<App />);

		const badge = await screen.findByText("Administrateur · illimité");
		expect(badge.className).toContain("bg-accent-soft");
		expect(badge.closest("[data-quota]")).not.toBeNull();
		expect(quotaCount()).toBeNull();
		expect(screen.queryByText("Analyses IA restantes")).toBeNull();
	});

	test("sans abonnement : badge plan.none sans nombre", async () => {
		background({
			"auth/state": () => signedIn(accountWith({ plan: null })),
		});
		render(<App />);

		const badge = await screen.findByText("Aucun abonnement actif");
		expect(badge.className).toContain("bg-accent-soft");
		expect(quotaCount()).toBeNull();
		expect(screen.queryByText("Analyses IA restantes")).toBeNull();
	});

	test("aide : account.how avec la pastille miniature (logo et « Analyser ») rendue en nœuds, pas en HTML", async () => {
		background({ "auth/state": () => signedIn() });
		const user = userEvent.setup();
		render(<App />);

		const badge = (await screen.findByText("Analyser")).closest<HTMLElement>(
			"[data-mini-badge]",
		);
		expect(badge).not.toBeNull();
		expect(badge?.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		// Logo statique : pas l'animation de chargement de la pastille.
		expect(badge?.querySelector(".rq-logo--loading")).toBeNull();
		const help = badge?.parentElement as HTMLElement;
		expect(help.textContent).toBe(
			"Ouvrez une annonce sur 2ememain, 2dehands ou Marketplace, puis cliquez sur Analyser à côté du titre.",
		);
		expect(help.innerHTML).not.toContain("{badge}");
		expect(help.innerHTML).not.toContain("&lt;");

		await user.click(screen.getByRole("button", { name: "NL" }));

		const nl = (await screen.findByText("Analyseren")).closest<HTMLElement>(
			"[data-mini-badge]",
		);
		expect(nl?.parentElement?.textContent).toBe(
			"Open een advertentie op 2dehands, 2ememain of Marketplace en klik op Analyseren naast de titel.",
		);
	});

	test("« Voir les formules » pointe vers {PUBLIC_URL}/pricing/?lang=fr (puis nl après bascule) et s'ouvre dans un nouvel onglet (target _blank, rel noopener noreferrer)", async () => {
		background({ "auth/state": () => signedIn() });
		const user = userEvent.setup();
		render(<App />);

		const pricing = await screen.findByRole("link", {
			name: "Voir les formules",
		});
		expect(pricing.getAttribute("href")).toBe(`${PUBLIC_URL}/pricing/?lang=fr`);
		expect(pricing.getAttribute("target")).toBe("_blank");
		expect(pricing.getAttribute("rel")).toBe("noopener noreferrer");
		expect(pricing.className).toContain("bg-white");

		await user.click(screen.getByRole("button", { name: "NL" }));

		const nl = await screen.findByRole("link", { name: "Formules bekijken" });
		expect(nl.getAttribute("href")).toBe(`${PUBLIC_URL}/pricing/?lang=nl`);
		expect(nl.getAttribute("target")).toBe("_blank");
		expect(nl.getAttribute("rel")).toBe("noopener noreferrer");
	});

	test("barre d'actions fixe hors de la zone qui défile ; pied réduit à « Confidentialité »", async () => {
		background({ "auth/state": () => signedIn() });
		render(<App />);

		const pricing = await screen.findByRole("link", {
			name: "Voir les formules",
		});
		const signOut = screen.getByRole("button", { name: "Se déconnecter" });
		const main = screen.getByRole("main");
		expect(main.className).toContain("overflow-y-auto");
		expect(main.contains(pricing)).toBe(false);
		expect(main.contains(signOut)).toBe(false);
		const bar = pricing.parentElement as HTMLElement;
		expect(bar.contains(signOut)).toBe(true);
		expect(bar.className).toContain("border-border-subtle");
		expect(bar.className).toContain("shrink-0");
		const footer = screen.getByRole("contentinfo");
		expect(
			within(footer)
				.getAllByRole("link")
				.map((link) => link.textContent),
		).toEqual(["Confidentialité"]);
	});

	test("suppression dépliée : bouton plein danger, désactivé tant que le mot n'est pas tapé", async () => {
		background({ "auth/state": () => signedIn() });
		const user = userEvent.setup();
		render(<App />);

		const summary = await screen.findByText("Supprimer mon compte");
		expect(summary.tagName).toBe("SUMMARY");
		expect(summary.className).toContain("text-danger");
		await user.click(summary);
		expect(summary.closest("details")?.hasAttribute("open")).toBe(true);

		const button = screen.getByRole("button", {
			name: "Supprimer définitivement",
		}) as HTMLButtonElement;
		for (const token of [
			"bg-danger",
			"text-text-on-light",
			"w-full",
			"h-9",
			"disabled:opacity-40",
		])
			expect(button.className).toContain(token);
		expect(button.disabled).toBe(true);

		await user.type(
			screen.getByLabelText("Tapez SUPPRIMER pour confirmer"),
			"SUPPRIMER",
		);
		expect(button.disabled).toBe(false);
	});

	test("suppression en échec : message sur bg-danger-soft", async () => {
		background({
			"auth/state": () => signedIn(),
			"account/delete": () => fail("unavailable"),
		});
		const user = userEvent.setup();
		render(<App />);
		await user.type(
			await screen.findByLabelText("Tapez SUPPRIMER pour confirmer"),
			"SUPPRIMER",
		);

		await user.click(
			screen.getByRole("button", { name: "Supprimer définitivement" }),
		);

		const failure = await screen.findByRole("alert");
		expect(failure.textContent).toBe(
			"La suppression a échoué, votre compte n'a pas été modifié. Réessayez.",
		);
		expect(failure.className).toContain("bg-danger-soft");
	});
});

describe("i18n", () => {
	test("fr and nl dictionaries have identical keys", () => {
		expect(Object.keys(dictionaries.nl).sort()).toEqual(
			Object.keys(dictionaries.fr).sort(),
		);
		for (const locale of ["fr", "nl"] as const) {
			for (const value of Object.values(dictionaries[locale])) {
				expect(value.trim()).not.toBe("");
			}
		}
	});

	test("parité FR/NL des nouvelles clés de la popup (spec popup §4)", () => {
		const expected: Record<string, [string, string]> = {
			"signin.title": [
				"Repérez les arnaques avant de payer",
				"Herken oplichting vóór je betaalt",
			],
			"signin.lead": [
				"Connectez-vous pour analyser les annonces de 2ememain, 2dehands et Marketplace.",
				"Meld je aan om advertenties op 2dehands, 2ememain en Marketplace te analyseren.",
			],
			"signin.note": [
				"Un lien et un code vous sont envoyés par email. Pas de mot de passe.",
				"Je krijgt een link en een code per e-mail. Geen wachtwoord.",
			],
			"code.title": ["Vérifiez vos emails", "Controleer je e-mail"],
			"footer.pricing": ["Formules", "Formules"],
			"account.how": [
				"Ouvrez une annonce sur 2ememain, 2dehands ou Marketplace, puis cliquez sur {badge} à côté du titre.",
				"Open een advertentie op 2dehands, 2ememain of Marketplace en klik op {badge} naast de titel.",
			],
			"account.scansLabel": ["Analyses IA restantes", "Resterende AI-analyses"],
			"action.pricing": ["Voir les formules", "Formules bekijken"],
			"app.unavailableTitle": ["Service injoignable", "Dienst onbereikbaar"],
			"app.unavailableText": [
				"Impossible de joindre Radarnaque. Vérifiez votre connexion, puis réessayez.",
				"Radarnaque is niet bereikbaar. Controleer je verbinding en probeer opnieuw.",
			],
		};
		for (const [key, [fr, nl]] of Object.entries(expected)) {
			expect(dictionaries.fr[key as MessageKey], key).toBe(fr);
			expect(dictionaries.nl[key as MessageKey], key).toBe(nl);
		}
	});

	test("detectLocale picks nl for Dutch browsers, fr otherwise", () => {
		expect(detectLocale("nl")).toBe("nl");
		expect(detectLocale("nl-BE")).toBe("nl");
		expect(detectLocale("NL-nl")).toBe("nl");
		expect(detectLocale("fr-BE")).toBe("fr");
		expect(detectLocale("en-US")).toBe("fr");
		expect(detectLocale("")).toBe("fr");
	});

	test("t returns the translation for the locale", () => {
		expect(t("fr", "action.signOut")).toBe("Se déconnecter");
		expect(t("nl", "action.signOut")).toBe("Afmelden");
	});
});
