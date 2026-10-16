/** Origine du site, de /auth et de /api (`WXT_PUBLIC_URL`, sans barre finale). */
export const PUBLIC_URL: string = new URL(import.meta.env.WXT_PUBLIC_URL)
	.origin;
