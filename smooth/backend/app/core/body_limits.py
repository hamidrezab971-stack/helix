"""Bound auth/profile bodies before JSON or multipart parsing, including chunked."""
from fastapi.responses import JSONResponse


class IdentityBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path','')
        if scope['type'] != 'http' or not path.startswith(('/api/auth/', '/api/profiles')):
            return await self.app(scope,receive,send)
        limit = (2 * 1024 * 1024 + 65536) if path.endswith('/photos') else 16384
        chunks, size = [], 0
        headers = dict(scope.get('headers',[]))
        try:
            length = int(headers.get(b'content-length',b'0'))
        except ValueError:
            length = limit+1
        if length <= limit:
            while True:
                message = await receive()
                if message['type']=='http.disconnect':
                    return
                size += len(message.get('body',b''))
                if size > limit:
                    break
                chunks.append(message)
                if not message.get('more_body',False):
                    async def replay():
                        return chunks.pop(0) if chunks else await receive()
                    return await self.app(scope,replay,send)
        await JSONResponse({'detail':'Request is too large.'},status_code=413)(scope,receive,send)
