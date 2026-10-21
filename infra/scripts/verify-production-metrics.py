#!/usr/bin/env python3
"""Read actual production Prometheus observations without starting Grafana."""
import argparse
from datetime import datetime, timezone
import json
import math
import re
from pathlib import Path
import subprocess
import time
import urllib.parse
import urllib.request


def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name], timeout=20))[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    app = inspect('helix-production-app')
    prometheus = inspect('helix-production-prometheus-1')
    network = 'helix-production_monitoring'
    address = prometheus['NetworkSettings']['Networks'][network]['IPAddress']
    app_address = app['NetworkSettings']['Networks'][network]['IPAddress']

    def get(path):
        with urllib.request.urlopen('http://' + address + ':9090' + path, timeout=15) as response:
            result = json.load(response)
        if result.get('status') != 'success':
            raise RuntimeError('Prometheus API failed')
        return result['data']

    targets = get('/api/v1/targets')['activeTargets']
    if {t['labels']['job'] for t in targets} != {'helix', 'prometheus', 'node'}:
        raise RuntimeError('Unexpected production scrape inventory')
    if not all(t['health'] == 'up' and not t['lastError'] for t in targets):
        raise RuntimeError('A production scrape target failed')
    helix = next(t for t in targets if t['labels']['job'] == 'helix')
    if helix['scrapeUrl'] != 'http://app:8000/internal/metrics':
        raise RuntimeError('HELIX scrape URL drifted from production service')
    # Match the process identity from the actual container address to its scrape.
    # This also rules out a stale scrape or a different candidate application.
    token = Path('/etc/helix/docker-secrets/metrics_token').read_text().strip()
    request = urllib.request.Request('http://' + app_address + ':8000/internal/metrics',
                                     headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=15) as response:
        text = response.read().decode()
    started = float(re.search(r'^process_start_time_seconds ([^\n]+)$', text, re.M)[1])
    scraped = get('/api/v1/query?query=' + urllib.parse.quote('process_start_time_seconds{job="helix"}'))['result']
    if len(scraped) != 1 or abs(float(scraped[0]['value'][1]) - started) > 0.001:
        raise RuntimeError('Scraped process identity differs from actual production')
    if time.time() - float(scraped[0]['value'][0]) > 60:
        raise RuntimeError('Production process observation is stale')
    inventory = []
    dashboards = Path(__file__).resolve().parents[1] / 'grafana/dashboards'
    for path in sorted(dashboards.glob('*.json')):
        dashboard = json.loads(path.read_text())
        for panel in dashboard['panels']:
            row = {'dashboard': dashboard['uid'], 'panel': panel['title'], 'queries': []}
            for target in panel['targets']:
                expr = target['expr']
                data = get('/api/v1/query?query=' + urllib.parse.quote(expr))
                values = data['result']
                if not values and panel['title'] != 'Active alerts':
                    raise RuntimeError('No production observation for ' + panel['title'])
                for series in values:
                    timestamp, value = series['value']
                    if not math.isfinite(float(value)) or time.time() - float(timestamp) > 60:
                        raise RuntimeError('Non-finite or stale production observation')
                row['queries'].append({'refId': target['refId'], 'expression': expr,
                                       'series': len(values), 'finite': True})
            inventory.append(row)
    if len(inventory) != 26 or sum(len(p['queries']) for p in inventory) != 30:
        raise RuntimeError('Dashboard inventory changed from 26 panels / 30 queries')
    result = {'at': datetime.now(timezone.utc).isoformat(), 'production_container_id': app['Id'],
              'production_image_id': app['Image'], 'production_app_address': app_address,
              'production_process_start_time': started, 'scraped_process_identity_matches': True,
              'prometheus_container_id': prometheus['Id'], 'targets': {t['labels']['job']: t['health'] for t in targets},
              'panel_count': 26, 'query_count': 30, 'panels': inventory,
              'grafana_rendering_verified': False, 'grafana_blocker': 'Security gate; service stopped',
              'empty_active_alerts_is_expected': True}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'panels'}, indent=2))


if __name__ == '__main__':
    main()
