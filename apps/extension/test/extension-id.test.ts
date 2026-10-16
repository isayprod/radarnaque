import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { extensionIdFromPem } from "../scripts/extension-id.mjs";

// Clé publique de test (aucune valeur secrète). Identifiant attendu calculé à part :
//   openssl pkey -pubin -in pub.pem -outform DER | openssl dgst -sha256 -r \
//     | cut -c1-32 | tr '0-9a-f' 'a-p'
const PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodTUpt3pZBNdZ6511kqM
ExwzXPCqfrth1++b6+DrVUx66kX9LHHnzhvphth6JhEhkLmDVMtgWlaanLDiGHoa
14MvjXcAYe0a6P0wS0hvlqk2WHQikNX5SbOfpUoyaOoLHSKg6YCcc85SdJod+4II
OT5nFUyl1ougo7+wwm7Wf7tuLbnCZTFqi+DSSKvDdwryezgiwfQhXq8NhWhNsMyk
YAJiPr8jm5f5vhyfmjuVRwZdzpIM0spXQ2zC/kwUbRea1v9zevAl8/2uDnlHSTXY
JFvXPtnYWxfe+hm7eMwIKXtWAYD3nfyVV3oEP4DwsE5TK3nS6X7xUV9gElU8bkLd
2wIDAQAB
-----END PUBLIC KEY-----
`;
const EXPECTED_ID = "hbbhpigbhfpkojcfodcbpffbmjehgiba";
const EXPECTED_KEY = PUBLIC_PEM.replace(/-----[^-]+-----|\s/g, "");

describe("extension-id", () => {
	test("derives key and ID from a public PEM", () => {
		expect(extensionIdFromPem(PUBLIC_PEM)).toEqual({
			key: EXPECTED_KEY,
			id: EXPECTED_ID,
		});
	});

	test("a private PEM gives the same result as its public key", () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const fromPrivate = extensionIdFromPem(
			privateKey.export({ type: "pkcs8", format: "pem" }),
		);
		const fromPublic = extensionIdFromPem(
			publicKey.export({ type: "spki", format: "pem" }),
		);
		expect(fromPrivate).toEqual(fromPublic);
		expect(fromPrivate.id).toMatch(/^[a-p]{32}$/);
	});
});
