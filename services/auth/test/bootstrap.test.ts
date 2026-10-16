import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { makeBootstrapClient } from "../src/bootstrap";

let server: Server | undefined;

afterEach(async () => {
	server?.closeAllConnections();
	await new Promise<void>(
		(resolve) => server?.close(() => resolve()) ?? resolve(),
	);
	server = undefined;
});

/** Petit serveur HTTP local ; `respond` décide du statut (ou ne répond jamais). */
async function listen(
	respond: (req: IncomingMessage) => number | "hang",
): Promise<{ url: string; requests: IncomingMessage[] }> {
	const requests: IncomingMessage[] = [];
	server = createServer((req, res) => {
		requests.push(req);
		const status = respond(req);
		if (status === "hang") return;
		res.writeHead(status, { "content-type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, requests };
}

describe("makeBootstrapClient", () => {
	test("POSTs to /api/internal/users/{id}/bootstrap with the shared secret", async () => {
		const api = await listen(() => 200);
		await makeBootstrapClient(api.url, "s".repeat(32))("user/1 é");
		expect(api.requests).toHaveLength(1);
		const [req] = api.requests;
		expect(req.method).toBe("POST");
		expect(req.url).toBe(
			`/api/internal/users/${encodeURIComponent("user/1 é")}/bootstrap`,
		);
		expect(req.headers["x-internal-secret"]).toBe("s".repeat(32));
	});

	test("throws on a non-2xx status", async () => {
		const api = await listen(() => 503);
		await expect(makeBootstrapClient(api.url, "secret")("u1")).rejects.toThrow(
			/503/,
		);
	});

	test("gives up after the timeout", async () => {
		const api = await listen(() => "hang");
		const started = Date.now();
		await expect(
			makeBootstrapClient(api.url, "secret", { timeoutMs: 100 })("u1"),
		).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});
