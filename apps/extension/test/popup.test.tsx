import type { Me } from "@radarnaque/shared";
import {
	cleanup,
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
import { detectLocale, dictionaries, t } from "../lib/i18n";
import type { BgRequest, BgResponse } from "../lib/messages";
import { localePref, pendingSignIn, sessionToken } from "../lib/storage";
import { trialMe } from "./helpers";

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

function rowOf(label: string): HTMLElement {
	const row = screen.getByText(label).closest("li");
	if (!row) throw new Error(`ligne introuvable : ${label}`);
	return row;
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
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
		expect(within(rowOf("Scans d'essai restants")).getByText("3")).toBeTruthy();
		expect(screen.queryByText("Analyses texte")).toBeNull();
		expect(screen.queryByText("Analyses avec photos")).toBeNull();
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

		expect(
			await screen.findByText("Service momentanément indisponible. Réessayez."),
		).toBeTruthy();
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
					quotas: [
						{ scanKind: "text", limit: 150, used: 20, remaining: 130 },
						{ scanKind: "image", limit: 0, used: 0, remaining: 0 },
					],
				}),
		});
		render(<App />);
		expect(await screen.findByText("Standard")).toBeTruthy();
		expect(within(rowOf("Analyses texte")).getByText("130")).toBeTruthy();
		expect(screen.queryByText("Scans d'essai restants")).toBeNull();
	});

	test("account view: premium-like (no total cap) shows the two per-kind rows", async () => {
		background({
			"auth/state": () =>
				signedIn({
					...trialMe,
					plan: "premium",
					totalCap: null,
					quotas: [
						{ scanKind: "text", limit: 1000, used: 0, remaining: 1000 },
						{ scanKind: "image", limit: 100, used: 0, remaining: 100 },
					],
				}),
		});
		render(<App />);
		expect(await screen.findByText("Analyses texte")).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(within(rowOf("Analyses texte")).getByText("1000")).toBeTruthy();
		expect(within(rowOf("Analyses avec photos")).getByText("100")).toBeTruthy();
		expect(screen.queryByText("Scans d'essai restants")).toBeNull();
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
		expect(screen.queryByText("Tekstanalyses")).toBeNull();
		expect(screen.queryByText("Analyses met foto's")).toBeNull();
		expect(screen.getByText("Resterende proefscans")).toBeTruthy();
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
