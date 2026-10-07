"""
Two identity scopes, and a guard that stops them being confused.

    RESEARCH  — raw historical user_id. What the frozen baseline measures.
    CANONICAL — tenant_id + principal_id, resolving aliases to one human. What production uses.

Why this module exists
----------------------
`ali` is one person holding two historical ids (1 and 739935229538144), and the principals
registry now records that. That is correct for production continuity: a returning user must
reach their own model whichever path they arrive on.

It is WRONG for the frozen baseline. `baseline-keystroke-v1` measured user_id = 1, which is
121 samples. Resolving aliases would silently make it 243 — a different experiment, reported
under the same name, with no error and no visible symptom. Every published figure
(EER 10.17%, the packet rates, the 99-subject population) would quietly cease to correspond
to what the manuscript claims.

So the rule is stated once, here, and enforced rather than remembered:

    Canonical identity is for production continuity.
    Raw historical identity is for frozen scientific reproducibility.

A baseline script declares its scope on import. If anything then asks for alias resolution,
this raises instead of returning a wider population. Failing loudly is the entire point —
a silent widening is exactly the class of defect the audit was built to catch.

Usage in an evaluation script:

    from identity_scope import ResearchScope
    SCOPE = ResearchScope("baseline-keystroke-v1")
    user_ids = SCOPE.ids_for(1)      # -> [1]   never [1, 739935229538144]
"""
import sqlite3

CA_DB = "/app/ca.db"


class IdentityScopeError(RuntimeError):
    """Raised when a frozen-baseline experiment reaches for canonical resolution."""


class ResearchScope:
    """Raw historical ids only. Alias resolution is refused, not silently ignored."""

    mode = "research"

    def __init__(self, experiment):
        self.experiment = experiment

    def ids_for(self, user_id):
        """The population this experiment measures: exactly the id it was given."""
        return [int(user_id)]

    def resolve_principal(self, *_args, **_kwargs):
        raise IdentityScopeError(
            f"Experiment '{self.experiment}' is RESEARCH-scoped and must address raw historical "
            f"user_ids. It asked for canonical principal resolution, which would fold alias ids "
            f"into the population — e.g. user_id=1 would become 1 + 739935229538144, changing "
            f"121 held-out samples into 243 and invalidating every figure published under this "
            f"baseline. If a canonical-identity experiment is genuinely intended, construct a "
            f"CanonicalScope explicitly and give it a new name; do not reuse a frozen baseline's."
        )


class CanonicalScope:
    """Production scope: aliases resolve to one principal, queries are tenant-scoped."""

    mode = "canonical"

    def __init__(self, tenant_id, db_path=CA_DB):
        self.tenant_id = tenant_id
        self.db_path = db_path

    def _con(self):
        return sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)

    def resolve_principal(self, legacy_user_id):
        """Which principal does this historical id belong to? None if retired/unknown."""
        con = self._con()
        row = con.execute(
            "SELECT principal_id FROM principal_aliases WHERE legacy_user_id=? AND tenant_id=?",
            (int(legacy_user_id), self.tenant_id),
        ).fetchone()
        con.close()
        return row[0] if row else None

    def ids_for(self, principal_id):
        """Every historical id belonging to this principal, for a unified production read."""
        con = self._con()
        rows = con.execute(
            "SELECT legacy_user_id FROM principal_aliases WHERE principal_id=? AND tenant_id=? "
            "ORDER BY legacy_user_id",
            (int(principal_id), self.tenant_id),
        ).fetchall()
        con.close()
        return [r[0] for r in rows]


def assert_research_scope(scope, experiment):
    """Call at the top of a baseline script so the scope is declared, not assumed."""
    if getattr(scope, "mode", None) != "research":
        raise IdentityScopeError(
            f"'{experiment}' must run under ResearchScope. Got mode="
            f"{getattr(scope, 'mode', type(scope).__name__)!r}. Frozen baselines are raw-id scoped."
        )
    return scope
