const dateTime = new Intl.DateTimeFormat("fr-BE", {
	dateStyle: "short",
	timeStyle: "short",
});

/** Date et heure locales (ISO en entrée) ; « — » quand il n'y en a pas. */
export function formatDateTime(iso: string | null): string {
	if (iso === null) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : dateTime.format(date);
}

/** Dollars (la devise des fournisseurs), à 2 décimales ou 4 pour un coût unitaire ; « — » sans valeur. */
export function formatUsd(value: number | null, decimals: 2 | 4 = 2): string {
	if (value === null) return "—";
	const amount = value.toLocaleString("fr-BE", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
	return `${amount} $`;
}
