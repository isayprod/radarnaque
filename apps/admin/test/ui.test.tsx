import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../src/api";
import { ActionLog } from "../src/components/ActionLog";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Link } from "../src/components/Link";
import { actionMessage } from "../src/components/ui";
import { formatUsd } from "../src/format";
import { useRoute } from "../src/router";

beforeEach(() => {
	window.history.replaceState(null, "", "/admin/utilisateurs");
});

afterEach(() => {
	cleanup();
});

describe("navigation", () => {
	it("navigate to the current route does not push history", () => {
		const { result } = renderHook(() => useRoute());
		const before = window.history.length;

		act(() => result.current[1]({ name: "users" }));
		expect(window.history.length).toBe(before);

		act(() => result.current[1]({ name: "offer" }));
		expect(window.history.length).toBe(before + 1);
		expect(window.location.pathname).toBe("/admin/offre");
		expect(result.current[0]).toEqual({ name: "offer" });

		act(() => result.current[1]({ name: "offer" }));
		expect(window.history.length).toBe(before + 1);
	});

	it("link navigates on a plain click and keeps the browser default otherwise", async () => {
		function Probe() {
			const [route] = useRoute();
			return (
				<>
					<p data-testid="route">{route.name}</p>
					<Link route={{ name: "analysis", id: 7 }}>Détail</Link>
				</>
			);
		}
		render(<Probe />);
		const link = screen.getByRole("link", { name: "Détail" });
		expect(link.getAttribute("href")).toBe("/admin/analyses/7");

		// Ctrl+clic : pas de navigation interne (nouvel onglet laissé au navigateur). Le
		// faux navigateur suivrait le lien lui-même : on neutralise ce comportement par défaut.
		const stopDefault = (event: Event) => event.preventDefault();
		document.addEventListener("click", stopDefault);
		fireEvent.click(link, { ctrlKey: true });
		expect(screen.getByTestId("route").textContent).toBe("users");
		expect(window.location.pathname).toBe("/admin/utilisateurs");

		await userEvent.setup().click(link);
		document.removeEventListener("click", stopDefault);
		expect(screen.getByTestId("route").textContent).toBe("analysis");
		expect(window.location.pathname).toBe("/admin/analyses/7");
	});
});

function Harness(props: {
	typedConfirmation?: string;
	onConfirm?: () => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Ouvrir
			</button>
			{open && (
				<ConfirmDialog
					title="Titre"
					message="Message"
					confirmLabel="Confirmer"
					typedConfirmation={props.typedConfirmation}
					onConfirm={props.onConfirm ?? (async () => {})}
					onCancel={() => setOpen(false)}
				/>
			)}
		</>
	);
}

describe("boîte de confirmation", () => {
	it("confirm dialog focuses cancel, closes on Escape and restores focus", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const opener = screen.getByRole("button", { name: "Ouvrir" });
		await user.click(opener);

		const dialog = screen.getByRole("dialog");
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Annuler" }),
		);

		// Échap est écouté sur le document, même si le focus est ailleurs.
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it("confirm dialog focuses the typed input when there is one", async () => {
		const user = userEvent.setup();
		render(<Harness typedConfirmation="alice@radarnaque.test" />);
		await user.click(screen.getByRole("button", { name: "Ouvrir" }));
		expect(document.activeElement).toBe(
			screen.getByLabelText(/alice@radarnaque\.test/),
		);
	});

	it("confirm dialog restores focus after Annuler", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const opener = screen.getByRole("button", { name: "Ouvrir" });
		await user.click(opener);
		await user.click(screen.getByRole("button", { name: "Annuler" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it("tab stays inside the dialog", async () => {
		const user = userEvent.setup();
		render(<Harness typedConfirmation="ok" />);
		const opener = screen.getByRole("button", { name: "Ouvrir" });
		await user.click(opener);
		const input = screen.getByLabelText(/ok/);
		const cancel = screen.getByRole("button", { name: "Annuler" });
		const confirm = screen.getByRole("button", { name: "Confirmer" });
		// « Confirmer » est désactivé tant que la saisie n'est pas bonne : Tab saute à « Annuler ».
		expect(document.activeElement).toBe(input);
		await user.tab();
		expect(document.activeElement).toBe(cancel);
		await user.tab();
		expect(document.activeElement).toBe(input);
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(cancel);

		await user.type(input, "ok");
		await user.tab();
		expect(document.activeElement).toBe(cancel);
		await user.tab();
		expect(document.activeElement).toBe(confirm);
		await user.tab();
		expect(document.activeElement).toBe(input);
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(confirm);
		expect(document.activeElement).not.toBe(opener);
	});

	it("tab pulls the focus back when it left the dialog", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.click(screen.getByRole("button", { name: "Ouvrir" }));
		(document.activeElement as HTMLElement).blur();
		await user.tab();
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Annuler" }),
		);
	});

	it("ignores Escape while the action is running and sends once", async () => {
		let release: () => void = () => {};
		const onConfirm = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const user = userEvent.setup();
		render(<Harness onConfirm={onConfirm} />);
		await user.click(screen.getByRole("button", { name: "Ouvrir" }));
		await user.dblClick(screen.getByRole("button", { name: "Confirmer" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);

		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeTruthy();
		release();
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "Annuler" }) as HTMLButtonElement)
					.disabled,
			).toBe(false),
		);
	});
});

describe("actionMessage", () => {
	const conflict = (reason: string, message = "Message de l'API.") =>
		new ApiFailure(409, "conflict", message, { reason });

	it("actionMessage reads details.reason", () => {
		expect(actionMessage(conflict("last_admin"))).toBe(
			"Impossible : c'est le dernier admin.",
		);
		expect(actionMessage(conflict("self"))).toBe(
			"Impossible sur votre propre compte.",
		);
		expect(actionMessage(conflict("stripe"))).toBe("Géré dans Stripe.");
		expect(actionMessage(new ApiFailure(429, "rate_limited"))).toBe(
			"Trop de demandes, réessayez plus tard.",
		);
	});

	it("does not guess from the wording of the message", () => {
		expect(
			actionMessage(
				new ApiFailure(409, "conflict", "Dernier admin, compte propre."),
			),
		).toBe("Dernier admin, compte propre.");
	});

	it("falls back to the API message, then to a generic one", () => {
		expect(actionMessage(conflict("autre", "Ce modèle existe déjà."))).toBe(
			"Ce modèle existe déjà.",
		);
		expect(
			actionMessage(new ApiFailure(404, "not_found", "Compte introuvable.")),
		).toBe("Compte introuvable.");
		expect(actionMessage(new ApiFailure(500, "http_error"))).toBe(
			"L'action a échoué, réessayez.",
		);
		expect(actionMessage(new Error("réseau"))).toBe(
			"L'action a échoué, réessayez.",
		);
	});
});

describe("formatUsd", () => {
	it("formats dollars with 2 decimals, or 4 on request", () => {
		expect(formatUsd(12.345)).toBe("12,35 $");
		expect(formatUsd(0.00123, 4)).toBe("0,0012 $");
		expect(formatUsd(0)).toBe("0,00 $");
	});

	it("shows a dash for null", () => {
		expect(formatUsd(null)).toBe("—");
		expect(formatUsd(null, 4)).toBe("—");
	});
});

describe("journal", () => {
	const action = (code: string, details: Record<string, unknown>) => ({
		id: 1,
		action: code,
		adminUserId: "a1",
		adminEmail: "boss@radarnaque.test",
		targetUserId: null,
		createdAt: "2026-10-21T09:00:00Z",
		details,
	});

	it("labels the offer actions with their plan", () => {
		render(
			<ActionLog
				actions={[
					action("offer.price_set", {
						plan: "standard",
						interval: "month",
						from: 499,
						to: 599,
					}),
					action("offer.quota_set", { plan: "trial", from: 5, to: 8 }),
					action("offer.feature_set", {
						plan: "premium",
						feature: "card_icons",
						from: false,
						to: true,
					}),
					action("offer.max_images_set", { plan: "standard", from: 2, to: 0 }),
					action("offer.total_cap_set", {
						plan: "trial",
						from: null,
						to: 100,
					}),
				]}
			/>,
		);
		const text = document.body.textContent ?? "";
		for (const label of [
			"Prix modifié",
			"Quota modifié",
			"Fonctionnalité modifiée",
			"Photos modifiées",
			"Plafond total modifié",
		]) {
			expect(text).toContain(label);
		}
		const cells = screen.getAllByRole("cell").map((cell) => cell.textContent);
		expect(
			cells.some((c) => /^standard, mois : 4,99\s€ → 5,99\s€$/.test(c ?? "")),
		).toBe(true);
		expect(cells).toContain("trial : 5 → 8");
		expect(cells).toContain("premium, icônes des cartes : non → oui");
		expect(cells).toContain("standard : 2 → 0");
		expect(cells).toContain("trial : aucun → 100");
	});
});
