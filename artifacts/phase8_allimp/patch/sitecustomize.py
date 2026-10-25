# Amendment ALL-IMPOSTORS (artifacts/phase8_allimp/AMENDMENT_ALL_IMPOSTORS.md): the ONLY change to the frozen
# experiment code. Every typing experiment takes its KeyRecs pools from population_sweep's two constants
# (ks_common.keyrecs_pools, ar_common.impostor_pool): negatives ids[:NEG_POOL_SIZE], impostors
# ids[NEG_POOL_SIZE:NEG_POOL_SIZE + IMP_POOL_SIZE], frozen at 40 and 40 (impostors = participants 40 to 79).
# ALLIMP_POOLS="NEG:IMP" overrides them for one run, before the experiment imports them:
#   "0:99"   every other participant is an impostor (experiments whose negatives come from Aalto);
#   "40:59"  participants 40 to 98 (experiment KS, whose REF arm learns from participants 0 to 39).
# Each run_target already skips the owner. Loaded by Python at start-up from PYTHONPATH (site.py).
import os

_spec = os.environ.get("ALLIMP_POOLS")
if _spec:
    import population_sweep as _ps
    _neg, _imp = (int(x) for x in _spec.split(":"))
    _ps.NEG_POOL_SIZE, _ps.IMP_POOL_SIZE = _neg, _imp
    print(f"[allimp] population_sweep pools overridden: NEG_POOL_SIZE={_neg}, IMP_POOL_SIZE={_imp}", flush=True)
