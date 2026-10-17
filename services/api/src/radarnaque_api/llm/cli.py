"""Commande `radarnaque-llm` : fournisseurs, modèles et modèle actif par type de scan."""

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import create_engine, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from radarnaque_api.config import DEFAULT_PROVIDERS_FILE, normalize_database_url
from radarnaque_api.llm.providers import ProviderConfig, ProviderError, load_providers
from radarnaque_api.models.reference import Model, ScanKind

KINDS = ("text", "image")
EXIT_OK = 0
EXIT_USAGE = 2


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="radarnaque-llm", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="fournisseurs, modèles en base et modèle actif de chaque type")
    use = sub.add_parser("use", help="active un modèle pour un type de scan (le crée au besoin)")
    use.add_argument("provider")
    use.add_argument("slug")
    use.add_argument("--kind", choices=KINDS, required=True)
    return parser


def _fail(message: str) -> int:
    print(f"radarnaque-llm : {message}", file=sys.stderr)
    return EXIT_USAGE


def _list(session: Session, providers: dict[str, ProviderConfig]) -> int:
    print("Fournisseurs :")
    for code, provider in providers.items():
        has_key = provider.api_key_env is None or bool(os.environ.get(provider.api_key_env))
        key = "oui" if has_key else "non"
        print(
            f"  {code:<12} sortie structurée : {provider.structured_output}, "
            f"coût : {provider.cost_source}, clé: {key}"
        )
    active = dict(session.execute(select(ScanKind.active_model_id, ScanKind.code)).all())
    print("Modèles :")
    for model in session.scalars(select(Model).order_by(Model.provider, Model.slug)):
        notes = [f"actif : {active[model.id]}"] if model.id in active else []
        if model.provider not in providers:
            notes.append("fournisseur inconnu")
        print(f"  {model.provider}/{model.slug}" + (f"  ({', '.join(notes)})" if notes else ""))
    return EXIT_OK


def _use(session: Session, providers: dict[str, ProviderConfig], args: argparse.Namespace) -> int:
    if args.provider not in providers:
        known = ", ".join(providers)
        return _fail(f"fournisseur inconnu : {args.provider} (connus : {known})")
    session.execute(
        insert(Model)
        .values(provider=args.provider, slug=args.slug)
        .on_conflict_do_nothing(index_elements=["provider", "slug"])
    )
    model_id = session.scalars(
        select(Model.id).where(Model.provider == args.provider, Model.slug == args.slug)
    ).one()
    updated = session.execute(
        update(ScanKind).where(ScanKind.code == args.kind).values(active_model_id=model_id)
    )
    if updated.rowcount == 0:
        session.rollback()
        return _fail(f"type de scan absent de la base : {args.kind}")
    session.commit()
    print(f"Modèle actif ({args.kind}) : {args.provider}/{args.slug}")
    return EXIT_OK


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:  # argparse : 2 pour un usage invalide, 0 pour --help
        return exc.code if isinstance(exc.code, int) else EXIT_USAGE
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return _fail("DATABASE_URL absente de l'environnement")
    try:
        url = normalize_database_url(database_url)
        providers = load_providers(Path(os.environ.get("PROVIDERS_FILE", DEFAULT_PROVIDERS_FILE)))
    except (ValueError, ProviderError) as exc:
        return _fail(str(exc))
    engine = create_engine(url)
    try:
        with Session(engine) as session:
            if args.command == "list":
                return _list(session, providers)
            return _use(session, providers, args)
    finally:
        engine.dispose()
