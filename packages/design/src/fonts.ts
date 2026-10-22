/** Polices embarquées (Fontsource, licence OFL) : une entrée par fichier WOFF2 de `src/fonts/`. */
export type FontFaceSpec = {
	family: "Radarnaque Inter" | "Radarnaque Serif";
	file: string;
	weight: string;
	unicodeRange: string;
};

// Plages reprises des CSS Fontsource (sous-ensembles latin et latin-ext).
const LATIN =
	"U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
	"U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

export const FONT_FACES: readonly FontFaceSpec[] = [
	{
		family: "Radarnaque Inter",
		file: "inter-latin-wght-normal.woff2",
		weight: "400 600",
		unicodeRange: LATIN,
	},
	{
		family: "Radarnaque Inter",
		file: "inter-latin-ext-wght-normal.woff2",
		weight: "400 600",
		unicodeRange: LATIN_EXT,
	},
	{
		family: "Radarnaque Serif",
		file: "instrument-serif-latin-400-normal.woff2",
		weight: "400",
		unicodeRange: LATIN,
	},
	{
		family: "Radarnaque Serif",
		file: "instrument-serif-latin-ext-400-normal.woff2",
		weight: "400",
		unicodeRange: LATIN_EXT,
	},
];
