"""Bounded single-process Prometheus text collector; no payloads or identities.

Only fixed series and router templates are accepted. Pure ASGI middleware keeps
streaming and WebSocket behavior intact. No extra listener/thread is started.
"""
from collections import defaultdict
from pathlib import Path
import hmac
import math
import os
import resource
from threading import Lock
from time import monotonic, time


BUCKETS = (.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10)
METHODS = {'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'}
UPLOAD_ROUTES = {
    '/api/conversations/{conversation_id}/messages/image': 'attachment',
    '/api/profiles/me/photos': 'profile',
}
MESSAGE_ROUTES = {
    '/api/conversations/{conversation_id}/messages',
    '/api/conversations/{conversation_id}/messages/image',
}
EVENTS = {'message:new', 'message:edited', 'message:deleted',
          'message:delivered', 'message:read', 'message:reactions'}


class Metrics:
    def __init__(self):
        self.lock = Lock()
        self.requests = defaultdict(int)
        self.durations = {}
        self.uploads = defaultdict(int)
        self.submissions = defaultdict(int)
        self.deliveries = defaultdict(int)
        self.connections = 0
        self.disconnects = 0
        self.started = time()

    def http(self, method, route, status, duration):
        method = method if method in METHODS else 'OTHER'
        status = str(status if 100 <= status <= 599 else 500)
        with self.lock:
            self.requests[method, route, status] += 1
            sample = self.durations.setdefault((method, route), [0, 0., [0]*len(BUCKETS)])
            sample[0] += 1
            sample[1] += duration
            for i, bound in enumerate(BUCKETS):
                sample[2][i] += duration <= bound
            if method == 'POST' and route in UPLOAD_ROUTES:
                self.uploads[UPLOAD_ROUTES[route], 'success' if status.startswith('2') else 'failure'] += 1
            if method == 'POST' and route in MESSAGE_ROUTES:
                self.submissions['success' if status.startswith('2') else 'failure'] += 1

    def connect(self):
        with self.lock:
            self.connections += 1

    def disconnect(self):
        with self.lock:
            self.connections -= 1
            self.disconnects += 1

    def delivery(self, event, outcome):
        if not event.startswith('message:'):
            return
        with self.lock:
            self.deliveries[event if event in EVENTS else 'message:other', outcome] += 1

    def render(self):
        lines = []

        def family(name, kind, help_text):
            lines.extend([f'# HELP {name} {help_text}', f'# TYPE {name} {kind}'])

        def emit(name, value, **labels):
            # Values originate only from allowlists and application route templates.
            escaped = lambda v: str(v).replace('\\', '\\\\').replace('\n', '\\n').replace('"', '\\"')
            suffix = '{' + ','.join(f'{k}="{escaped(v)}"' for k,v in labels.items()) + '}' if labels else ''
            lines.append(f'{name}{suffix} {value}')

        with self.lock:
            family('helix_http_requests_total', 'counter', 'Completed HTTP requests by router template and status.')
            for (method, route, status), count in sorted(self.requests.items()):
                emit('helix_http_requests_total', count, method=method, route=route, status=status)
            family('helix_http_errors_total', 'counter', 'Completed HTTP 4xx and 5xx responses.')
            for (method, route, status), count in sorted(self.requests.items()):
                if status.startswith(('4','5')):
                    emit('helix_http_errors_total', count, method=method, route=route, status=status)
            family('helix_http_request_duration_seconds', 'histogram', 'Seconds until final HTTP response body or exception.')
            for (method, route), (count, total, buckets) in sorted(self.durations.items()):
                for bound, value in zip(BUCKETS, buckets):
                    emit('helix_http_request_duration_seconds_bucket', value, method=method, route=route, le=bound)
                emit('helix_http_request_duration_seconds_bucket', count, method=method, route=route, le='+Inf')
                emit('helix_http_request_duration_seconds_count', count, method=method, route=route)
                emit('helix_http_request_duration_seconds_sum', total, method=method, route=route)
            family('helix_websocket_connections', 'gauge', 'Registered authenticated WebSocket connections.')
            emit('helix_websocket_connections', self.connections)
            family('helix_websocket_disconnects_total', 'counter', 'Authenticated connections removed, once per connection.')
            emit('helix_websocket_disconnects_total', self.disconnects)
            family('helix_message_delivery_total', 'counter', 'Message event frame send attempts to connected sockets; not receipt acknowledgements.')
            for (event, outcome), count in sorted(self.deliveries.items()):
                emit('helix_message_delivery_total', count, event=event, outcome=outcome)
            family('helix_message_submissions_total', 'counter', 'Message API attempts including idempotent replays.')
            for outcome, count in sorted(self.submissions.items()):
                emit('helix_message_submissions_total', count, outcome=outcome)
            family('helix_uploads_total', 'counter', 'Upload API responses, including authentication and validation failures.')
            for (kind, outcome), count in sorted(self.uploads.items()):
                emit('helix_uploads_total', count, kind=kind, outcome=outcome)
        family('process_start_time_seconds', 'gauge', 'Process metrics collector start time since epoch.')
        emit('process_start_time_seconds', self.started)
        usage = resource.getrusage(resource.RUSAGE_SELF)
        family('process_cpu_seconds_total', 'counter', 'Total user and system CPU seconds.')
        emit('process_cpu_seconds_total', usage.ru_utime + usage.ru_stime)
        try:
            pages = Path('/proc/self/statm').read_text().split()
            for name, value in [('process_resident_memory_bytes',int(pages[1])*os.sysconf('SC_PAGE_SIZE')),
                                ('process_virtual_memory_bytes',int(pages[0])*os.sysconf('SC_PAGE_SIZE')),
                                ('process_open_fds', len(list(Path('/proc/self/fd').iterdir()))),
                                ('process_max_fds',resource.getrlimit(resource.RLIMIT_NOFILE)[0])]:
                if math.isfinite(value) and value >= 0:
                    family(name, 'gauge', name.replace('_', ' '))
                    emit(name, value)
        except (OSError, ValueError, IndexError):
            pass
        return ('\n'.join(lines)+'\n').encode()


metrics = Metrics()


class MetricsMiddleware:
    def __init__(self, app, routes):
        self.app = app
        self.routes = routes
        token_file = os.getenv('METRICS_TOKEN_FILE')
        self.token = Path(token_file).read_text().strip().encode() if token_file else b''
        if token_file and len(self.token) < 32:
            raise RuntimeError('Metrics token file must contain at least 32 bytes.')

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        path = scope.get('path', '')
        if path == '/internal' or path.startswith('/internal/'):
            auth = [v for k,v in scope.get('headers', []) if k == b'authorization']
            allowed = (path == '/internal/metrics' and scope['method'] == 'GET' and self.token
                       and len(auth) == 1 and hmac.compare_digest(auth[0], b'Bearer '+self.token))
            body = metrics.render() if allowed else b'Not found'
            await send({'type':'http.response.start', 'status':200 if allowed else 404,
                        'headers':[(b'content-type', b'text/plain; version=0.0.4; charset=utf-8'),
                                   (b'cache-control',b'no-store')]})
            await send({'type':'http.response.body','body':body})
            return
        start, status, duration = monotonic(), 500, None

        async def capture(message):
            nonlocal status, duration
            if message['type'] == 'http.response.start':
                status = message['status']
            await send(message)
            if message['type'] == 'http.response.body' and not message.get('more_body', False):
                duration = monotonic() - start
        try:
            await self.app(scope, receive, capture)
        finally:
            candidate = getattr(scope.get('route'), 'path', '')
            # A static mount, unknown path or arbitrary exception cannot add series.
            route = candidate if candidate in self.routes else 'unmatched'
            metrics.http(scope['method'], route, status, duration if duration is not None else monotonic()-start)
