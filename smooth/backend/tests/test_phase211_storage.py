"""Direct image safety tests, runnable without network or a production database."""
import os
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from fastapi import HTTPException
from PIL import Image, PngImagePlugin
from app.services import images


class Phase211StorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.patch = patch.object(images, 'UPLOAD_DIR', self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def photo(self, format, *, metadata=False, size=(80, 120)):
        output = BytesIO()
        options = {}
        if metadata:
            if format == 'PNG':
                info = PngImagePlugin.PngInfo()
                info.add_text('Private note', 'synthetic QA metadata')
                options['pnginfo'] = info
            else:
                exif = Image.Exif()
                exif[274] = 6
                exif[270] = 'synthetic QA metadata'
                options['exif'] = exif
        Image.new('RGB', size, 'coral').save(output, format, **options)
        return output.getvalue()

    def store(self, data):
        return images.store_image(SimpleNamespace(file=BytesIO(data), filename='../../gallery.jpg', content_type='application/octet-stream'))

    def test_clean_originals_are_preserved_for_every_supported_format(self):
        for format in ('JPEG', 'PNG', 'WEBP'):
            with self.subTest(format=format):
                data = self.photo(format)
                saved = self.store(data)
                path = images.image_path(saved['storage_name'])
                self.assertEqual(path.read_bytes(), data)
                self.assertEqual((saved['width'], saved['height']), (80, 120))
                self.assertEqual(saved['size_bytes'], len(data))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn('/', saved['original_name'])
                with Image.open(path) as decoded:
                    decoded.load()
                    self.assertEqual(decoded.format, format)

    def test_metadata_is_removed_and_exif_orientation_is_baked_into_pixels(self):
        for format in ('JPEG', 'PNG', 'WEBP'):
            with self.subTest(format=format):
                saved = self.store(self.photo(format, metadata=True))
                with Image.open(images.image_path(saved['storage_name'])) as decoded:
                    decoded.load()
                    self.assertFalse(decoded.getexif())
                    self.assertFalse(getattr(decoded, 'text', {}))
                    self.assertNotIn('synthetic QA metadata', str(decoded.info))
                    self.assertEqual(decoded.size, (80, 120) if format == 'PNG' else (120, 80))
                    self.assertEqual(decoded.size, (saved['width'], saved['height']))

    def test_invalid_and_oversized_images_never_create_files(self):
        for data, status in ((b'not a photo', 422), (b'x' * (images.MAX_IMAGE_BYTES + 1), 413)):
            with self.assertRaises(HTTPException) as raised:
                self.store(data)
            self.assertEqual(raised.exception.status_code, status)
            self.assertFalse((self.root / 'images').exists())

    def test_symlinked_namespace_cannot_store_outside_uploads(self):
        elsewhere = self.root / 'private'
        elsewhere.mkdir()
        (self.root / 'images').symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(HTTPException) as raised:
            self.store(self.photo('PNG'))
        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_failed_fsync_cleans_new_file(self):
        with patch.object(images.os, 'fsync', side_effect=OSError('synthetic storage failure')):
            with self.assertRaises(HTTPException) as raised:
                self.store(self.photo('PNG'))
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(list((self.root / 'images').iterdir()), [])

    def test_filename_collision_keeps_previous_file(self):
        with patch.object(images, 'uuid4', return_value=SimpleNamespace(hex='a' * 32)):
            saved = self.store(self.photo('PNG'))
            previous = images.image_path(saved['storage_name']).read_bytes()
            with self.assertRaises(HTTPException) as raised:
                self.store(self.photo('PNG', size=(40, 60)))
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(images.image_path(saved['storage_name']).read_bytes(), previous)
