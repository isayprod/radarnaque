import logging

import pytest

from radarnaque_api.auth.privileges import Privileges, privileges_of
from radarnaque_api.config import Settings
from radarnaque_api.models import AuthUser

EMAIL = "superuser@radarnaque.test"
BASE = {
    "database_url": "postgres://u:p@h/d",
    "jwks_url": "http://j",
    "jwt_issuer": "i",
    "jwt_audience": "a",
    "internal_api_secret": "s" * 32,
}


def _settings(env: str) -> Settings:
    return Settings(env=env, **BASE)


def _user(role: str) -> AuthUser:
    return AuthUser(id="u1", email=EMAIL, role=role)


ADMIN = Privileges(unlimited=True, all_features=True, rate_limited=True, debug=False)
SUPERUSER = Privileges(unlimited=True, all_features=True, rate_limited=False, debug=True)
ORDINARY = Privileges(unlimited=False, all_features=False, rate_limited=True, debug=False)


@pytest.mark.parametrize(
    ("role", "env", "expected"),
    [
        ("admin", "development", ADMIN),
        ("admin", "test", ADMIN),
        ("admin", "production", ADMIN),
        ("superuser", "development", SUPERUSER),
        ("superuser", "test", SUPERUSER),
        ("superuser", "production", ORDINARY),
        ("user", "development", ORDINARY),
        ("user", "production", ORDINARY),
        # Rôle inconnu : aucun privilège.
        ("root", "development", ORDINARY),
    ],
)
def test_privileges_table(role, env, expected):
    assert privileges_of(_user(role), _settings(env)) == expected


def test_privileges_are_frozen():
    with pytest.raises(AttributeError):
        ADMIN.unlimited = False  # type: ignore[misc]


def test_superuser_in_production_logs_a_warning_without_identity(caplog):
    with caplog.at_level(logging.WARNING, logger="radarnaque.privileges"):
        privileges_of(_user("superuser"), _settings("production"))
    records = [r for r in caplog.records if r.name == "radarnaque.privileges"]
    assert [(r.levelno, r.getMessage()) for r in records] == [
        (logging.WARNING, "rôle superuser ignoré en production")
    ]
    assert EMAIL not in caplog.text and "u1" not in caplog.text


@pytest.mark.parametrize(
    ("role", "env"),
    [("superuser", "development"), ("admin", "production"), ("user", "production")],
)
def test_no_warning_otherwise(caplog, role, env):
    with caplog.at_level(logging.WARNING, logger="radarnaque.privileges"):
        privileges_of(_user(role), _settings(env))
    assert not [r for r in caplog.records if r.name == "radarnaque.privileges"]
