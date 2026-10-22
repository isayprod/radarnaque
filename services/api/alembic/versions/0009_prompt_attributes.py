"""Prompt `full` qui cite les caractéristiques de l'annonce (`attributes`).

Le message envoyé au LLM porte désormais `attributes` (année, kilométrage, carburant…), absent
de la liste fermée des « Faits fournis » du prompt v1. On ajoute une version qui les cite, au
numéro qui suit la dernière (l'admin a pu en créer entre-temps). Elle n'est activée que si la v1
livrée est encore active : un prompt choisi dans l'admin reste en place. Changer de version
change la clé du cache d'analyses : c'est voulu.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-22
"""

import importlib.util
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"


def _load_0005():
    # Le nom du module commence par un chiffre : on le charge par son chemin.
    path = Path(__file__).with_name("0005_full_scans.py")
    spec = importlib.util.spec_from_file_location("alembic_0005_full_scans", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FULL_PROMPT_V1: str = _load_0005().FULL_PROMPT_V1

# Ajouts au texte de la v1, chacun à un endroit unique. Le texte est figé ici : ne jamais le
# modifier, ajouter une migration à la place.
AMENDMENTS = (
    (
        "(titre, description, faits sur le vendeur,",
        "(titre, description, caractéristiques, faits sur le vendeur,",
    ),
    (
        "catégorie, état, date de publication, lieu, nombre de photos",
        "catégorie, état, caractéristiques (attributes : libellé et valeur affichés par le site, "
        "dans sa langue, par exemple année, kilométrage, carburant, capacité), date de "
        "publication, lieu, nombre de photos",
    ),
)


def _amended(text: str) -> str:
    for old, new in AMENDMENTS:
        if text.count(old) != 1:
            raise RuntimeError(f"passage introuvable ou ambigu dans le prompt v1 : {old!r}")
        text = text.replace(old, new)
    return text


FULL_PROMPT_ATTRIBUTES = _amended(FULL_PROMPT_V1)


# Clé étrangère différée de `scan_kinds` vers `prompt_versions`.
ACTIVE_PROMPT_FK = f"{S}.scan_kinds_active_prompt_version_id_fkey"


def _check_active_prompt_fk() -> None:
    # Vérifie maintenant la clé étrangère différée (voir 0004 : sinon un ALTER TABLE ultérieur de
    # la même transaction échoue avec « pending trigger events »), puis la remet en différé :
    # contrairement à `set constraints all immediate`, les migrations jouées ensuite dans la même
    # transaction (le downgrade de 0005 supprime un prompt avant sa ligne `scan_kinds`) gardent
    # le mode d'origine.
    op.execute(f"set constraints {ACTIVE_PROMPT_FK} immediate")
    op.execute(f"set constraints {ACTIVE_PROMPT_FK} deferred")


def upgrade() -> None:
    bind = op.get_bind()
    # Idempotent : une version au même texte (rejouée après un downgrade qui l'a gardée) est
    # réutilisée.
    prompt_id = bind.execute(
        sa.text(
            f"select id from {S}.prompt_versions where scan_kind = 'full' and system_prompt = :p"
            " order by version limit 1"
        ),
        {"p": FULL_PROMPT_ATTRIBUTES},
    ).scalar()
    if prompt_id is None:
        prompt_id = bind.execute(
            sa.text(
                f"insert into {S}.prompt_versions(scan_kind, version, system_prompt)"
                " select 'full', coalesce(max(version), 0) + 1, :p"
                f" from {S}.prompt_versions where scan_kind = 'full' returning id"
            ),
            {"p": FULL_PROMPT_ATTRIBUTES},
        ).scalar_one()
    bind.execute(
        sa.text(
            f"update {S}.scan_kinds k set active_prompt_version_id = :new"
            f" from {S}.prompt_versions p"
            " where k.code = 'full' and p.id = k.active_prompt_version_id"
            " and p.version = 1 and p.system_prompt = :v1"
        ),
        {"new": prompt_id, "v1": FULL_PROMPT_V1},
    )
    _check_active_prompt_fk()


def downgrade() -> None:
    bind = op.get_bind()
    ids = [
        row[0]
        for row in bind.execute(
            sa.text(
                f"select id from {S}.prompt_versions"
                " where scan_kind = 'full' and system_prompt = :p"
            ),
            {"p": FULL_PROMPT_ATTRIBUTES},
        )
    ]
    if not ids:
        return
    # Version active : on revient à la v1.
    bind.execute(
        sa.text(
            f"update {S}.scan_kinds k set active_prompt_version_id = p.id"
            f" from {S}.prompt_versions p"
            " where k.code = 'full' and k.active_prompt_version_id = any(:ids)"
            " and p.scan_kind = 'full' and p.version = 1"
        ),
        {"ids": ids},
    )
    # Une version référencée par une analyse est conservée (historique) ; l'upgrade suivant la
    # réutilise.
    bind.execute(
        sa.text(
            f"delete from {S}.prompt_versions p where p.id = any(:ids)"
            f" and not exists (select 1 from {S}.analyses a where a.prompt_version_id = p.id)"
        ),
        {"ids": ids},
    )
    _check_active_prompt_fk()
