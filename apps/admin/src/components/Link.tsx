import type { ReactNode } from "react";
import { hrefOf, isPlainLeftClick, type Route, useRoute } from "../router";

const DEFAULT_CLASS =
	"font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

/** Lien interne : `href` réel (nouvel onglet possible), clic simple → navigation sans rechargement. */
export function Link(props: {
	route: Route;
	className?: string;
	"aria-current"?: "page";
	children: ReactNode;
}) {
	const [, navigate] = useRoute();
	return (
		<a
			href={hrefOf(props.route)}
			aria-current={props["aria-current"]}
			onClick={(event) => {
				if (!isPlainLeftClick(event)) return;
				event.preventDefault();
				navigate(props.route);
			}}
			className={props.className ?? DEFAULT_CLASS}
		>
			{props.children}
		</a>
	);
}
