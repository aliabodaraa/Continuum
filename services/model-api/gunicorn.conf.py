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


def post_fork(server, worker):
    """OpenTelemetry, started in the worker (the exporter's thread must belong to the process that serves),
    only when an OTLP endpoint is set (OTEL_EXPORTER_OTLP_ENDPOINT; the Kubernetes overlay with a collector
    sets it; OTEL_SDK_DISABLED=true keeps it off). Every scoring and training request then becomes a span in
    the trace that ca-service started, with the calls to the object store inside it, and the request
    metrics (count, duration by route and status) go to the same collector. Nothing in a span names a
    user's typing or movement: route, status, duration, object keys."""
    if not os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or os.getenv("OTEL_SDK_DISABLED", "").lower() == "true":
        return
    try:
        from opentelemetry import metrics, trace
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.botocore import BotocoreInstrumentor
        from opentelemetry.instrumentation.flask import FlaskInstrumentor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as e:   # the image without the packages: serve without telemetry, say so once
        server.log.warning("[model-api] OpenTelemetry not installed (%s): no traces or metrics", e)
        return
    resource = Resource.create({SERVICE_NAME: os.getenv("OTEL_SERVICE_NAME", f"model-{os.getenv('MODEL_ROLE', 'all')}")})
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())]))
    FlaskInstrumentor().instrument(excluded_urls="/health,/ready")   # the probes make no spans
    BotocoreInstrumentor().instrument()
    server.log.info("[model-api] OpenTelemetry on: %s", os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
