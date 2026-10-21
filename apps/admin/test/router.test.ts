import { describe, expect, it } from "vitest";
import { hrefOf, parseRoute } from "../src/router";

describe("parseRoute", () => {
	it("envoie la racine vers les utilisateurs, avec ou sans barre finale", () => {
		expect(parseRoute("/admin/")).toEqual({ name: "users" });
		expect(parseRoute("/admin")).toEqual({ name: "users" });
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
		]) {
			const route = parseRoute(path);
			expect(parseRoute(hrefOf(route))).toEqual(route);
			expect(hrefOf(parseRoute(hrefOf(route)))).toBe(hrefOf(route));
		}
	});
});
