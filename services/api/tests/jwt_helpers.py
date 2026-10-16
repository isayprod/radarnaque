"""Outils de test : paires de clés Ed25519, JWKS et jetons signés."""

import base64
import time
from dataclasses import dataclass
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@dataclass(frozen=True)
class KeyPair:
    kid: str
    private_key: Ed25519PrivateKey

    @classmethod
    def generate(cls, kid: str) -> "KeyPair":
        return cls(kid=kid, private_key=Ed25519PrivateKey.generate())

    def public_jwk(self) -> dict[str, str]:
        raw = self.private_key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        return {
            "kty": "OKP",
            "crv": "Ed25519",
            "x": _b64url(raw),
            "kid": self.kid,
            "alg": "EdDSA",
            "use": "sig",
        }


def make_jwks(*pairs: KeyPair) -> dict[str, Any]:
    return {"keys": [p.public_jwk() for p in pairs]}


def sign(
    pair: KeyPair,
    sub: str,
    iss: str,
    aud: str,
    exp_in: int = 900,
    alg: str = "EdDSA",
) -> str:
    """Signe un jeton. `alg` autre que EdDSA fabrique un jeton forgé (HS256 ou none)."""
    now = int(time.time())
    payload = {"sub": sub, "iss": iss, "aud": aud, "iat": now, "exp": now + exp_in}
    headers = {"kid": pair.kid}
    if alg == "EdDSA":
        return jwt.encode(payload, pair.private_key, algorithm="EdDSA", headers=headers)
    if alg == "none":
        return jwt.encode(payload, None, algorithm="none", headers=headers)
    return jwt.encode(
        payload, "forged-secret-of-at-least-32-bytes!!", algorithm=alg, headers=headers
    )
