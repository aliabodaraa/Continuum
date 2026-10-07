import json
import numpy as np

d = json.load(open('/app/artifacts/xai/population_scores.json'))
u0 = d['perUser'][0]
print("keys in perUser[0]:", list(u0.keys()))
