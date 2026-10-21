import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { SessionProvider, useSession } from "../src/session";

type Handler = (body: unknown) => Response;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const ME = { email: "admin@radarnaque.test", role: "admin" };

// `fetch` remplacé par un faux : routes "METHODE chemin", appels enregistrés.
function fakeFetch(routes: Record<string, Handler>) {
	const calls: string[] = [];
	const mock = vi.fn(async (url: string, init?: RequestInit) => {
		const key = `${init?.method ?? "GET"} ${url}`;
		calls.push(key);
		const handler = routes[key];
		if (!handler) throw new Error(`appel non prévu : ${key}`);
		return handler(init?.body ? JSON.parse(String(init.body)) : undefined);
	});
	vi.stubGlobal("fetch", mock);
	return { calls, mock };
}

function Probe() {
	const session = useSession();
	if (session.status !== "ready") return null;
	return (
		<button
			type="button"
			onClick={() => session.api.get("/api/admin/users").catch(() => {})}
		>
			Charger
		</button>
	);
}

function renderApp() {
	return render(
		<SessionProvider>
			<App />
			<Probe />
		</SessionProvider>,
	);
}

beforeEach(() => {
	window.history.replaceState(null, "", "/admin/");
});

afterEach(() => {
	cleanup();
});

describe("session", () => {
	it("boot without session shows sign-in", async () => {
		const { calls } = fakeFetch({
			"GET /auth/token": () => json({}, 401),
		});
		renderApp();
		expect(await screen.findByLabelText("Adresse email")).toBeTruthy();
		expect(screen.queryByText(/Lien expiré/)).toBeNull();
		expect(calls).toEqual(["GET /auth/token"]);
	});

	it("boot with ?erreur=lien shows the link message", async () => {
		window.history.replaceState(null, "", "/admin/?erreur=lien");
		fakeFetch({ "GET /auth/token": () => json({}, 401) });
		renderApp();
		expect(
			await screen.findByText(
				"Lien expiré ou déjà utilisé. Demandez un nouveau code.",
			),
		).toBeTruthy();
	});

	it("boot with a session shows the shell with the admin email", async () => {
		fakeFetch({
			"GET /auth/token": () => json({ token: "jwt-1" }),
			"GET /api/me": () => json(ME),
		});
		renderApp();
		expect(await screen.findByText("admin@radarnaque.test")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Se déconnecter" })).toBeTruthy();
	});

	it("sign-in by code", async () => {
		let signedIn = false;
		const { calls, mock } = fakeFetch({
			"GET /auth/token": () =>
				signedIn ? json({ token: "jwt-1" }) : json({}, 401),
			"POST /auth/start": () => json({ ok: true }),
			"POST /auth/sign-in/email-otp": () => {
				signedIn = true;
				return json({ ok: true });
			},
			"GET /api/me": () => json(ME),
			"GET /api/admin/users": () => json({ items: [], nextBefore: null }),
			"GET /api/admin/offer": () => json({ plans: [], actions: [] }),
		});
		const user = userEvent.setup();
		// La racine /admin/ est le tableau de bord ; la liste garde ici un appel à observer.
		window.history.replaceState(null, "", "/admin/utilisateurs");
		renderApp();

		await user.type(
			await screen.findByLabelText("Adresse email"),
			"Admin@Radarnaque.test",
		);
		await user.click(screen.getByRole("button", { name: "Recevoir un code" }));

		expect(
			await screen.findByText(
				"Vous pouvez aussi cliquer sur le lien reçu par email.",
			),
		).toBeTruthy();
		await user.type(screen.getByLabelText("Code à 6 chiffres"), "123456");
		await user.click(screen.getByRole("button", { name: "Se connecter" }));

		expect(await screen.findByText("admin@radarnaque.test")).toBeTruthy();
		expect(calls).toEqual([
			"GET /auth/token",
			"POST /auth/start",
			"POST /auth/sign-in/email-otp",
			"GET /auth/token",
			"GET /api/me",
			"GET /api/admin/offer",
			"GET /api/admin/users",
		]);
		const bodyOf = (n: number) =>
			JSON.parse(String(mock.mock.calls[n][1]?.body));
		expect(bodyOf(1)).toEqual({
			email: "admin@radarnaque.test",
			locale: "fr",
			target: "admin",
		});
		expect(bodyOf(2)).toEqual({
			email: "admin@radarnaque.test",
			otp: "123456",
		});
		expect(mock.mock.calls[1][1]?.credentials).toBe("same-origin");
	});

	it("shows the rate limit message and the invalid code message", async () => {
		fakeFetch({
			"GET /auth/token": () => json({}, 401),
			"POST /auth/start": () => json({ error: {} }, 429),
		});
		const user = userEvent.setup();
		renderApp();
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.test");
		await user.click(screen.getByRole("button", { name: "Recevoir un code" }));
		expect(
			await screen.findByText("Trop de demandes, réessayez plus tard."),
		).toBeTruthy();
	});

	it("shows the invalid code message", async () => {
		fakeFetch({
			"GET /auth/token": () => json({}, 401),
			"POST /auth/start": () => json({ ok: true }),
			"POST /auth/sign-in/email-otp": () => json({ code: "INVALID_OTP" }, 400),
		});
		const user = userEvent.setup();
		renderApp();
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.test");
		await user.click(screen.getByRole("button", { name: "Recevoir un code" }));
		await user.type(
			await screen.findByLabelText("Code à 6 chiffres"),
			"000000",
		);
		await user.click(screen.getByRole("button", { name: "Se connecter" }));
		expect(await screen.findByText("Code invalide ou expiré.")).toBeTruthy();
	});

	it("re-enables sign-in with a message when the session is not established after a valid code", async () => {
		fakeFetch({
			"GET /auth/token": () => json({}, 401),
			"POST /auth/start": () => json({ ok: true }),
			"POST /auth/sign-in/email-otp": () => json({ ok: true }),
		});
		const user = userEvent.setup();
		renderApp();
		await user.type(await screen.findByLabelText("Adresse email"), "a@b.test");
		await user.click(screen.getByRole("button", { name: "Recevoir un code" }));
		await user.type(
			await screen.findByLabelText("Code à 6 chiffres"),
			"123456",
		);
		await user.click(screen.getByRole("button", { name: "Se connecter" }));
		expect(
			await screen.findByText("Service indisponible, réessayez plus tard."),
		).toBeTruthy();
		const submit = screen.getByRole("button", {
			name: "Se connecter",
		}) as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
		expect(
			(
				screen.getByRole("button", {
					name: "Changer d'adresse",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false);
	});

	it("ordinary user sees access denied and no admin call", async () => {
		const { calls } = fakeFetch({
			"GET /auth/token": () => json({ token: "jwt-1" }),
			"GET /api/me": () => json({ ...ME, role: "user" }),
			"POST /auth/sign-out": () => json({ success: true }),
		});
		renderApp();
		expect(
			await screen.findByText("Accès réservé aux administrateurs"),
		).toBeTruthy();
		expect(calls.some((c) => c.includes("/api/admin"))).toBe(false);
		expect(screen.getByRole("button", { name: "Se déconnecter" })).toBeTruthy();
	});

	it("sign-out returns to sign-in", async () => {
		const { calls } = fakeFetch({
			"GET /auth/token": () => json({ token: "jwt-1" }),
			"GET /api/me": () => json(ME),
			"POST /auth/sign-out": () => json({ success: true }),
		});
		const user = userEvent.setup();
		renderApp();
		await user.click(
			await screen.findByRole("button", { name: "Se déconnecter" }),
		);
		expect(await screen.findByLabelText("Adresse email")).toBeTruthy();
		expect(calls).toContain("POST /auth/sign-out");
	});

	it("demoted admin mid-session sees access denied", async () => {
		const { calls } = fakeFetch({
			"GET /auth/token": () => json({ token: "jwt-1" }),
			"GET /api/me": () => json(ME),
			"GET /api/admin/users": () =>
				json(
					{ error: { code: "admin_required", message: "", details: {} } },
					403,
				),
		});
		const user = userEvent.setup();
		renderApp();
		await user.click(await screen.findByRole("button", { name: "Charger" }));
		expect(
			await screen.findByText("Accès réservé aux administrateurs"),
		).toBeTruthy();
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Charger" })).toBeNull(),
		);
		// Une seule requête admin, un seul jeton : pas de boucle de nouvelles tentatives.
		expect(calls.filter((c) => c.includes("/api/admin"))).toHaveLength(1);
		expect(calls.filter((c) => c === "GET /auth/token")).toHaveLength(1);
	});
});
