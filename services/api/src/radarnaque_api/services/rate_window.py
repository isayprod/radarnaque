import time
from collections import defaultdict, deque
from collections.abc import Callable


class SlidingWindowLimiter:
    """Au plus `max_hits` coups par clé sur les `window_s` dernières secondes.

    État en mémoire du processus : un redémarrage le remet à zéro, et plusieurs processus ont
    chacun le leur. Suffisant pour borner les essais d'un administrateur."""

    def __init__(
        self, max_hits: int, window_s: float, now: Callable[[], float] = time.monotonic
    ) -> None:
        self._max_hits = max_hits
        self._window_s = window_s
        self._now = now
        self._hits: defaultdict[str, deque[float]] = defaultdict(deque)

    def hit(self, key: str) -> bool:
        """Compte un coup pour `key`. `False` quand la limite est atteinte : le coup refusé
        n'est pas compté."""
        now = self._now()
        hits = self._hits[key]
        while hits and hits[0] <= now - self._window_s:
            hits.popleft()
        if len(hits) >= self._max_hits:
            return False
        hits.append(now)
        return True
