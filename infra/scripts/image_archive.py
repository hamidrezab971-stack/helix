"""Verify the amd64 OCI archive chain without confusing index and config IDs."""
import hashlib
import json
import re
import tarfile


def identity(path, reference_digest):
    with tarfile.open(path) as archive:
        def blob(descriptor, *, decode=True):
            digest = descriptor['digest']
            if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
                raise ValueError('Unsupported OCI blob digest')
            member = archive.getmember('blobs/' + digest.replace(':', '/'))
            if not member.isfile() or member.size != descriptor['size']:
                raise ValueError('OCI blob is missing, linked or has the wrong size')
            with archive.extractfile(member) as stream:
                if decode:
                    value = stream.read()
                    actual = hashlib.sha256(value).hexdigest()
                else:
                    actual = hashlib.file_digest(stream, 'sha256').hexdigest()
            if actual != digest.split(':')[1]:
                raise ValueError('OCI blob integrity failed')
            return json.loads(value) if decode else None

        roots = json.load(archive.extractfile('index.json'))['manifests']
        roots = [r for r in roots if r['digest'] == reference_digest]
        if len(roots) != 1:
            raise ValueError('Archive does not contain the selected immutable reference')
        descriptor = roots[0]
        while True:
            manifest = blob(descriptor)
            if 'layers' in manifest:
                break
            matches = [r for r in manifest['manifests']
                       if r.get('platform', {}).get('architecture') == 'amd64'
                       and r.get('platform', {}).get('os') == 'linux']
            if len(matches) != 1:
                raise ValueError('Exactly one linux/amd64 manifest is required')
            descriptor = matches[0]
        config = blob(manifest['config'])
        if config.get('architecture') != 'amd64' or config.get('os') != 'linux':
            raise ValueError('Unexpected archived runtime platform')
        for layer in manifest['layers']:
            blob(layer, decode=False)
        return {'reference_digest': reference_digest, 'manifest_digest': descriptor['digest'],
                'config_id': manifest['config']['digest']}
