import { FONT_FACES } from "@radarnaque/design/fonts";

type CreateFontFace = (
	family: string,
	source: string,
	descriptors: FontFaceDescriptors,
) => FontFace;

const defaultCreate: CreateFontFace = (family, source, descriptors) =>
	new FontFace(family, source, descriptors);

const loaded = new WeakSet<FontFaceSet>();

/**
 * Charge les polices de la pastille dans la page : un `@font-face` dans un Shadow DOM est
 * ignoré par Chrome, d'où `FontFace` ajoutée à `document.fonts`. Ne rejette jamais : une CSP
 * de la page hôte peut bloquer `chrome-extension://`, la pile de repli prend alors le relais.
 * Un second appel sur le même ensemble ne fait rien.
 */
export async function loadFonts(
	fonts: FontFaceSet,
	url: (path: string) => string,
	create: CreateFontFace = defaultCreate,
): Promise<void> {
	if (loaded.has(fonts)) return;
	loaded.add(fonts);
	try {
		await Promise.all(
			FONT_FACES.map((spec) => {
				const face = create(
					spec.family,
					`url("${url(`/fonts/${spec.file}`)}")`,
					{
						weight: spec.weight,
						unicodeRange: spec.unicodeRange,
						display: "swap",
					},
				);
				fonts.add(face);
				return face.load();
			}),
		);
	} catch (err) {
		console.debug(`radarnaque: polices indisponibles (${String(err)})`);
	}
}
