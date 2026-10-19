#!/usr/bin/env python3
"""Daily D1 backup to R2. Keeps 7 versions. Runs via cron."""
import sys, os, datetime
try:
    sys.path.insert(0, '/home/hatch/workspace/skills/cloudflare/bin')
    from cf_api import api
except ImportError:
    # GitHub Actions has no VM skill path: use the vendored Bearer-token client.
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'actions'))
    from cf_api_token import api

ACCT = '25b2327e932d26e5487c2ba8ad058932'
D1_ID = 'e856db4d-1ee1-42fd-9c1d-1807ca31afb5'
R2_BUCKET = 'english-lab-auth'
KEEP = 7

def main():
    # Nhan date theo gio VN (VM chay UTC, cron daily@03:00 +07)
    try:
        from zoneinfo import ZoneInfo
        today = datetime.datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    except Exception:
        today = datetime.date.today().isoformat()
    # 1. Export D1 (get all tables; bo _cf_*: bang noi bo Cloudflare,
    # khong SELECT duoc qua API va restore cung bo qua)
    tables_r = api('POST', f'/accounts/{ACCT}/d1/database/{D1_ID}/query',
                   {'sql': "SELECT name, sql FROM sqlite_master WHERE type='table' "
                           "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"})
    if not tables_r.get('success'):
        print("Failed to list tables"); sys.exit(1)
    # Bo shadow tables cua FTS5: du lieu suy bien, restore se tao lai tu
    # CREATE VIRTUAL TABLE + triggers; INSERT truc tiep vao shadow bi 400.
    vtables = [r['name'] for r in tables_r['result'][0]['results']
               if 'VIRTUAL TABLE' in (r.get('sql') or '').upper()]
    skip_names = set(vtables)
    for v in vtables:
        skip_names.update(v + s for s in ('_data', '_idx', '_content', '_docsize', '_config'))
    tables = [r['name'] for r in tables_r['result'][0]['results']
              if r['name'] not in skip_names]

    backup = {'date': today, 'tables': {}}
    skipped = []
    for t in tables:
        try:
            r = api('POST', f'/accounts/{ACCT}/d1/database/{D1_ID}/query',
                    {'sql': f'SELECT * FROM "{t}" LIMIT 10000'})
            if r.get('success'):
                backup['tables'][t] = r['result'][0]['results']
            else:
                skipped.append(t)
        except Exception as e:
            print(f"  skip {t}: {e}")
            skipped.append(t)
    if skipped:
        # That bai LOUD: cron worker thay exit != 0 se biet backup thieu
        print(f"FAIL: skipped tables: {skipped}")
        sys.exit(1)

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
