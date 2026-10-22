#!/usr/bin/env python3
"""Mint session D1 tạm cho user test của cổng so ảnh (visual gate).

Đi theo mẫu scripts/hb_e2e_test.py: users(email, data, updated_at) +
sessions(token, email, exp-tính-bằng-ms, data, updated_at).

  python3 make_gate_token.py               -> in token ra stdout (chỉ token)
  python3 make_gate_token.py --cleanup T   -> xoá session T

User visual-gate@lethanhdong.one là tài khoản test riêng (plan free,
verified=true, không dữ liệu thật) dành cho chụp ảnh hồi quy. Session
sống 2 giờ rồi tự hết hạn; gate.js xoá ngay sau mỗi lượt chạy.
"""
import json, secrets, sys, time

sys.path.insert(0, "/home/hatch/workspace/skills/cloudflare/bin")
from cf_api import api as cf_api

ACCT = "25b2327e932d26e5487c2ba8ad058932"
D1_ID = "e856db4d-1ee1-42fd-9c1d-1807ca31afb5"
EMAIL = "visual-gate@lethanhdong.one"


def d1(sql, params=None):
    r = cf_api("POST", f"/accounts/{ACCT}/d1/database/{D1_ID}/query",
               {"sql": sql, "params": params or []})
    if not r.get("success"):
        print("D1 FAILED:", json.dumps(r)[:300], file=sys.stderr)
        sys.exit(1)
    return r["result"][0]["results"]


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--cleanup":
        d1("DELETE FROM sessions WHERE token = ?", [sys.argv[2]])
        return
    token = secrets.token_hex(32)
    now = int(time.time() * 1000)
    user = {"email": EMAIL, "role": "user", "dob": None, "ageGroup": "adult",
            "created": now, "plan": "free", "plan_expires": None,
            "plan_history": [], "verified": True}
    d1("INSERT OR REPLACE INTO users (email, data, updated_at) VALUES (?, ?, ?)",
       [EMAIL, json.dumps(user), now])
    d1("INSERT INTO sessions (token, email, exp, data, updated_at) VALUES (?, ?, ?, ?, ?)",
       [token, EMAIL, now + 2 * 3600_000,
        json.dumps({"email": EMAIL, "token": token}), now])
    time.sleep(3)  # chờ D1 replication (như hb_e2e_test)
    print(token)


if __name__ == "__main__":
    main()
