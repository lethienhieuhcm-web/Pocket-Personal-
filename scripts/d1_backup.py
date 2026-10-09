#!/usr/bin/env python3
"""Daily D1 backup to R2. Keeps 7 versions. Runs via cron."""
import sys, os, datetime
sys.path.insert(0, '/home/hatch/workspace/skills/cloudflare/bin')
from cf_api import api

ACCT = '25b2327e932d26e5487c2ba8ad058932'
D1_ID = 'e856db4d-1ee1-42fd-9c1d-1807ca31afb5'
R2_BUCKET = 'english-lab-auth'
KEEP = 7

def main():
    today = datetime.date.today().isoformat()
    # 1. Export D1 (get all tables)
    tables_r = api('POST', f'/accounts/{ACCT}/d1/database/{D1_ID}/query',
                   {'sql': "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"})
    if not tables_r.get('success'):
        print("Failed to list tables"); sys.exit(1)
    tables = [r['name'] for r in tables_r['result'][0]['results']]

    backup = {'date': today, 'tables': {}}
    for t in tables:
        try:
            r = api('POST', f'/accounts/{ACCT}/d1/database/{D1_ID}/query',
                    {'sql': f'SELECT * FROM "{t}" LIMIT 10000'})
            if r.get('success'):
                backup['tables'][t] = r['result'][0]['results']
        except Exception as e:
            print(f"  skip {t}: {e}")

    # 2. Save locally (workspace persists across VM replacements)
    import json, glob
    data = json.dumps(backup, ensure_ascii=False).encode()
    os.makedirs('backups/d1', exist_ok=True)
    key = f'backups/d1/{today}.json'
    with open(key, 'wb') as f:
        f.write(data)
    print(f"Backup: {len(tables)} tables, {len(data)} bytes -> {key}")

    # 3. Cleanup old backups (keep 7)
    olds = sorted(glob.glob('backups/d1/*.json'))
    for old_key in olds[:-KEEP]:
        os.remove(old_key)
        print(f"  deleted old: {old_key}")

if __name__ == '__main__':
    main()
