import { describe, expect, it } from "vitest";
import { hrefOf, parseRoute } from "../src/router";

describe("parseRoute", () => {
	it("envoie la racine vers le tableau de bord, avec ou sans barre finale", () => {
		expect(parseRoute("/admin/")).toEqual({ name: "dashboard" });
		expect(parseRoute("/admin")).toEqual({ name: "dashboard" });
	});

	it("reconnaît la liste des utilisateurs", () => {
		expect(parseRoute("/admin/utilisateurs")).toEqual({ name: "users" });
	});

	it("reconnaît la fiche d'un utilisateur", () => {
		expect(parseRoute("/admin/utilisateurs/abc")).toEqual({
			name: "user",
			id: "abc",
		});
	});

	it("décode l'identifiant de la fiche", () => {
		expect(parseRoute("/admin/utilisateurs/a%20b")).toEqual({
			name: "user",
			id: "a b",
		});
	});

	it("reconnaît l'écran IA", () => {
		expect(parseRoute("/admin/ia")).toEqual({ name: "ai" });
	});

	it("reconnaît l'écran de l'offre", () => {
		expect(parseRoute("/admin/offre")).toEqual({ name: "offer" });
		expect(parseRoute("/admin/offre/plus")).toEqual({ name: "notFound" });
	});

	it("reconnaît la consultation d'une version de prompt", () => {
		expect(parseRoute("/admin/ia/prompts/12")).toEqual({
			name: "ai",
			promptId: 12,
		});
	});

	it("renvoie notFound pour un identifiant de prompt ou d'analyse invalide", () => {
		for (const path of [
			"/admin/ia/prompts/abc",
			"/admin/ia/prompts/0",
			"/admin/ia/prompts/-3",
			"/admin/ia/prompts/1.5",
			"/admin/ia/prompts/12/plus",
			"/admin/ia/prompts",
			"/admin/ia/autre/12",
			"/admin/analyses/abc",
			"/admin/analyses/0",
			"/admin/analyses/1e3",
			"/admin/analyses/4/plus",
		]) {
			expect(parseRoute(path), path).toEqual({ name: "notFound" });
		}
	});

	it("reconnaît la liste et le détail des analyses", () => {
		expect(parseRoute("/admin/analyses")).toEqual({ name: "analyses" });
		expect(parseRoute("/admin/analyses/42")).toEqual({
			name: "analysis",
			id: 42,
		});
	});

	it("renvoie notFound pour un chemin inconnu", () => {
		expect(parseRoute("/admin/inconnu")).toEqual({ name: "notFound" });
		expect(parseRoute("/admin/utilisateurs/abc/plus")).toEqual({
			name: "notFound",
		});
		expect(parseRoute("/autre")).toEqual({ name: "notFound" });
	});
});

describe("hrefOf", () => {
	it("construit le chemin de chaque route", () => {
		expect(hrefOf({ name: "users" })).toBe("/admin/utilisateurs");
		expect(hrefOf({ name: "user", id: "abc" })).toBe("/admin/utilisateurs/abc");
		expect(hrefOf({ name: "ai" })).toBe("/admin/ia");
		expect(hrefOf({ name: "dashboard" })).toBe("/admin/");
		expect(hrefOf({ name: "offer" })).toBe("/admin/offre");
		expect(hrefOf({ name: "ai", promptId: 12 })).toBe("/admin/ia/prompts/12");
		expect(hrefOf({ name: "analyses" })).toBe("/admin/analyses");
		expect(hrefOf({ name: "analysis", id: 42 })).toBe("/admin/analyses/42");
	});

	it("encode l'identifiant", () => {
		expect(hrefOf({ name: "user", id: "a b/c" })).toBe(
			"/admin/utilisateurs/a%20b%2Fc",
		);
	});

	it("est stable : parseRoute(hrefOf(r)) redonne r", () => {
		for (const path of [
			"/admin/",
			"/admin",
			"/admin/utilisateurs",
			"/admin/utilisateurs/abc",
			"/admin/utilisateurs/a%20b%2Fc",
			"/admin/ia",
			"/admin/ia/prompts/12",
			"/admin/offre",
			"/admin/analyses",
			"/admin/analyses/42",
		]) {
			const route = parseRoute(path);
			expect(parseRoute(hrefOf(route))).toEqual(route);
			expect(hrefOf(parseRoute(hrefOf(route)))).toBe(hrefOf(route));
		}
	});
});
