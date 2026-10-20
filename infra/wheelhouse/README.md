Empty default build context. Set WHEELHOUSE_DIR to a private directory containing
the retained runtime wheels and PIP_NO_INDEX=1 to build offline. pip still verifies
every dependency against requirements.lock. This directory must never contain
application environment files, database files, uploads, or credentials.
