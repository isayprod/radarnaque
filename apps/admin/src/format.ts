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
