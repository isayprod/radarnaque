// Test de scripts/deploy-landing.mjs, lancé par `node --test` (pnpm test:scripts).
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deployLanding, HEADERS, preparePagesDir } from "./deploy-landing.mjs";

test("preparePagesDir retire /privacy et /auth, garde le reste, ajoute _headers", () => {
	const dir = mkdtempSync(join(tmpdir(), "landing-test-"));
	try {
		for (const sub of ["privacy", "auth/callback", "pricing", "nl"]) {
			mkdirSync(join(dir, sub), { recursive: true });
			writeFileSync(join(dir, sub, "index.html"), "<p>");
		}
		writeFileSync(join(dir, "index.html"), "<p>");
		preparePagesDir(dir);
		assert.equal(existsSync(join(dir, "privacy")), false);
		assert.equal(existsSync(join(dir, "auth")), false);
		assert.equal(existsSync(join(dir, "index.html")), true);
		assert.equal(existsSync(join(dir, "nl/index.html")), true);
		assert.equal(existsSync(join(dir, "pricing/index.html")), true);
		assert.equal(readFileSync(join(dir, "_headers"), "utf8"), HEADERS);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("build en échec : code 1, wrangler jamais appelé", () => {
	const calls = [];
	const code = deployLanding({ env: {} }, (_cmd, args) => {
		calls.push(args[0]);
		return { status: 1 };
	});
	assert.equal(code, 1);
	assert.deepEqual(calls, ["--filter"]);
});

test("--dry-run : build seul, pas d'envoi", () => {
	const calls = [];
	const code = deployLanding({ dryRun: true, env: {} }, (_cmd, args) => {
		calls.push(args[0]);
		return { status: 0 };
	});
	assert.equal(code, 0);
	assert.deepEqual(calls, ["--filter"]);
});

test("envoi : projet radarnaque par défaut, branche de production main", () => {
	const calls = [];
	const code = deployLanding({ env: {} }, (_cmd, args) => {
		calls.push(args);
		return { status: 0 };
	});
	assert.equal(code, 0);
	const deploy = calls[1];
	assert.deepEqual(deploy.slice(0, 3), ["dlx", "wrangler@4", "pages"]);
	assert.equal(deploy[deploy.indexOf("--project-name") + 1], "radarnaque");
	assert.equal(deploy[deploy.indexOf("--branch") + 1], "main");
});
