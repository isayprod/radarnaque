interface ImportMetaEnv {
	readonly VITE_EXTENSION_ID?: string;
	/** Lien du Chrome Web Store (landing) ; vide : « Bientôt disponible ». */
	readonly VITE_CHROME_STORE_URL?: string;
	/** Origine publique du site (canonical, hreflang, Open Graph) ; repli : https://radarnaque.mostconsult.be. */
	readonly VITE_PUBLIC_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
