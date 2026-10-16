import pytest

from radarnaque_api.config import Settings

BASE = {
    "jwks_url": "http://j",
    "jwt_issuer": "i",
    "jwt_audience": "a",
    "internal_api_secret": "s",
}


@pytest.mark.parametrize(
    "raw",
    [
        "postgres://u:p@h:5432/d",
        "postgresql://u:p@h:5432/d",
        "postgresql+psycopg://u:p@h:5432/d",
    ],
)
def test_database_url_normalized(raw):
    assert Settings(database_url=raw, **BASE).database_url == "postgresql+psycopg://u:p@h:5432/d"


def test_database_url_rejects_other_schemes():
    with pytest.raises(ValueError):
        Settings(database_url="mysql://u:p@h/d", **BASE)


def test_settings_from_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://u:p@h:5432/d")
    monkeypatch.setenv("JWKS_URL", "http://j")
    monkeypatch.setenv("JWT_ISSUER", "i")
    monkeypatch.setenv("JWT_AUDIENCE", "a")
    monkeypatch.setenv("INTERNAL_API_SECRET", "s")
    monkeypatch.setenv("ENV", "production")
    s = Settings()
    assert s.env == "production"
    assert s.database_url.startswith("postgresql+psycopg://")
    assert s.internal_api_secret.get_secret_value() == "s"
