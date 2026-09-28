"""Matching a posting's terms against a body of text.

One implementation, used for both questions the app asks about those terms:
does a sample sentence contain this term, and does the candidate's profile.
Keeping them in the same place is what stops the two answers drifting apart —
a term counted as covered by one rule and missing by the other would make the
panel contradict itself.

The rule is the one an automated screen uses: the exact string, case
insensitive, on word boundaries. Deliberately unclever — no stemming, no
synonyms, no fuzzy distance. "experiments" does not match "experimentation"
and "reliable" does not match "reliability", because to a screener they are
different strings, and a match this app reports that a screener would not is
worse than no match at all.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from functools import lru_cache


@lru_cache(maxsize=2048)
def _pattern(term: str) -> re.Pattern[str]:
    """Compiled once per term — the same handful are tested against many
    sentences, and against the whole profile, on every generation."""
    return re.compile(
        # Letters and digits either side end the match, so "NLP" is not found
        # inside "NLPipeline"; punctuation does not, so "A/B testing" and
        # "CI/CD" match where they appear.
        r"(?<![0-9A-Za-z])" + re.escape(term) + r"(?![0-9A-Za-z])",
        re.IGNORECASE,
    )


def mentions(haystack: str, term: str) -> bool:
    """Whether `term` appears in `haystack` as a whole term."""
    if not term or not haystack:
        return False
    return _pattern(term).search(haystack) is not None


def present(haystack: str, terms: Iterable[str]) -> list[str]:
    """The terms that appear in `haystack`, in the order given."""
    if not haystack:
        return []
    return [term for term in terms if mentions(haystack, term)]


def missing(haystack: str, terms: Iterable[str]) -> list[str]:
    """The terms that do not appear in `haystack`, in the order given."""
    if not haystack:
        return list(terms)
    return [term for term in terms if not mentions(haystack, term)]
