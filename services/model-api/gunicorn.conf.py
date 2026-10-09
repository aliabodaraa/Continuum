# gunicorn settings for the model service (wsgi.py).
import os

bind = f"{os.getenv('MODEL_HOST', '0.0.0.0')}:{os.getenv('MODEL_PORT', '5000')}"
# One process: its model cache serves every request (a second process would load every model again
# and double TensorFlow's memory). Scale with more containers instead; threads serve requests in
# parallel (TensorFlow releases the interpreter lock while it computes). Trainings run in their own
# child processes (api.train_isolated).
workers = 1
worker_class = "gthread"
threads = int(os.getenv("MODEL_THREADS", "8"))
# The worker's heartbeat, not a request deadline (a training request can take minutes; ca-service
# sets the deadlines). Then 30 s to finish the requests in flight on a stop.
timeout = 120
graceful_timeout = 30
keepalive = 5
accesslog = None
errorlog = "-"
