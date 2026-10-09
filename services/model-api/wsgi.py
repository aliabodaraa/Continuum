"""The model service under a production web server (the images' command):

    gunicorn -c gunicorn.conf.py wsgi:app        (in services/model-api)

Loads what its role needs (MODEL_ROLE: all, inference, trainer) before the first request. `python api.py`
still starts Flask's own server, for local model work only.
"""
import api

app = api.create_server_app()
