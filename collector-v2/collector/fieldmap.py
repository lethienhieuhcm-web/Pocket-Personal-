"""Field map: du lieu versioned, khong rai rac trong parser (dac ta §3.3, Q12).

Map mo ta cac truong theo cong, gom: ten chuan, don vi, he so scale
protocol -> don vi chuan, basis, co verified, cach dung, ten cam.
scale=None nghia la CHUA DO — parser GĐ1+ phai doi chieu ban tin tho
truoc khi dung, khong duoc doan.
"""
import json
import os

_MAP_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "field_map.json")

_REQUIRED_KEYS = {"standard", "unit", "scale", "basis", "verified", "use", "evidence"}


def load_map(path=_MAP_PATH):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data


def validate_map(data):
    """Kiem tra cau truc map. Tra ve list loi (rong = dat)."""
    errors = []
    if data.get("version") != 1:
        errors.append("version != 1")
    gates = data.get("gates")
    if not isinstance(gates, dict) or not gates:
        errors.append("thieu gates")
        return errors
    for gate, gdata in gates.items():
        fields = gdata.get("fields")
        if not isinstance(fields, dict) or not fields:
            errors.append(f"{gate}: thieu fields")
            continue
        seen_standard = set()
        for raw, spec in fields.items():
            missing = _REQUIRED_KEYS - set(spec)
            if missing:
                errors.append(f"{gate}/{raw}: thieu key {sorted(missing)}")
            std = spec.get("standard")
            if std in seen_standard:
                errors.append(f"{gate}: standard trung nhau: {std}")
            seen_standard.add(std)
            for forbidden in spec.get("forbidden_names", []):
                if forbidden in seen_standard:
                    errors.append(f"{gate}: ten cam {forbidden} van xuat hien lam ten chuan")
            scale = spec.get("scale")
            if scale is not None and (not isinstance(scale, (int, float)) or scale <= 0):
                errors.append(f"{gate}/{raw}: scale khong hop le: {scale!r}")
    return errors


def apply_scale(raw_value, scale):
    """Gia tri protocol tho * scale. scale=None -> loi ro rang, khong doan."""
    if scale is None:
        raise ValueError("scale CHUA DO — doi chieu ban tin tho truoc khi dung")
    return raw_value * scale


def translate_snapshot(gate, raw_fields, data=None):
    """Doi snapshot tu key raw (file vm-pull / parser) sang ten chuan.

    Tra ve (fields, field_src): truong co thi mang gia tri (KHONG scale lai —
    file raw vm-pull da duoc collector thu scale; scale chi danh cho parser
    ban tin tho GĐ1+); truong khai trong map ma vang thi KHONG co key gia tri
    va field_src[ten] = 'MISSING' (khong dien 0).
    """
    data = data or load_map()
    fields = {}
    field_src = {}
    gdata = data["gates"][gate]
    alias_to_raw = {}
    for raw_code, spec in gdata["fields"].items():
        alias = spec.get("raw_alias")
        if alias:
            alias_to_raw[alias] = raw_code
    for key, value in raw_fields.items():
        if value is None:
            # Gia tri None = truong vang -> MISSING (khong dien 0, khong ghi None).
            continue
        raw_code = alias_to_raw.get(key)
        if raw_code is None:
            # Key khong co trong map: giu nguyen ten, danh dau chua map.
            fields[key] = value
            field_src[key] = "UNMAPPED"
            continue
        spec = gdata["fields"][raw_code]
        fields[spec["standard"]] = value
        field_src[spec["standard"]] = gate
    for raw_code, spec in gdata["fields"].items():
        std = spec["standard"]
        if std not in fields:
            field_src[std] = "MISSING"
    return fields, field_src
