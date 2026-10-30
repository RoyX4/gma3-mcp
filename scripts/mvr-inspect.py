#!/usr/bin/env python3
"""Bounded read-only MVR inventory. Uses only Python's standard library; never extracts ZIP members."""
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile

MAX_ARCHIVE = 256 * 1024 * 1024
MAX_XML = 16 * 1024 * 1024
MAX_MEMBER = 128 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_OBJECTS = 10000
KINDS = {"Layer", "GroupObject", "Fixture", "SceneObject", "FocusPoint", "Truss", "Support", "VideoScreen", "Projector"}
IDENTITY = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]


def tag(e):
    return e.tag.rsplit("}", 1)[-1]


def child(e, name):
    return next((c for c in e if tag(c) == name), None)


def text(e, name):
    c = child(e, name)
    return (c.text or "").strip() if c is not None else ""


def matrix(e):
    node = child(e, "Matrix")
    if node is None:
        return IDENTITY[:]
    value = "".join((node.text or "").split())
    groups = re.findall(r"\{([^{}]*)\}", value)
    if len(groups) != 4 or "".join("{"+g+"}" for g in groups) != value:
        raise ValueError("Matrix must contain four three-number vectors")
    rows = [[float(v) for v in group.split(",")] for group in groups]
    if any(len(row) != 3 for row in rows) or not all(math.isfinite(v) for row in rows for v in row):
        raise ValueError("Matrix contains invalid or non-finite values")
    # MVR stores basis vectors u/v/w, followed by translation, in millimetres.
    return [rows[0][r] if c == 0 else rows[1][r] if c == 1 else rows[2][r] if c == 2 else rows[3][r]
            for r in range(3) for c in range(4)]


def compose(a, b):
    out = []
    for row in range(3):
        for col in range(4):
            v = sum(a[row*4+k] * b[k*4+col] for k in range(3))
            out.append(v + (a[row*4+3] if col == 3 else 0))
    if not all(math.isfinite(v) for v in out):
        raise ValueError("Transform composition overflowed")
    return out


def canonical(e):
    return [tag(e), sorted(e.attrib.items()), (e.text or "").strip(), [canonical(c) for c in e]]


def nested_gdtf_identity(payload, budget):
    """Hash logical regular ZIP members, never package timestamps or compression metadata."""
    stream = io.BytesIO(payload)
    if not zipfile.is_zipfile(stream):
        return {"contentHashUnavailable": "GDTF asset is not an inspectable ZIP; only raw byte identity is available"}
    with zipfile.ZipFile(stream) as archive:
        entries = archive.infolist()
        budget["entries"] += len(entries)
        budget["bytes"] += sum(info.file_size for info in entries)
        if budget["entries"] > 20000 or budget["bytes"] > MAX_TOTAL:
            raise ValueError("Nested GDTF archives exceed the aggregate entry or 512 MiB uncompressed budget")
        members, seen = [], set()
        for info in entries:
            name = info.filename.replace("\\", "/")
            path = PurePosixPath(name)
            canonical_name = str(path)
            if (not name or name.startswith("/") or ":" in name or ".." in path.parts or "\x00" in name
                    or canonical_name in ("", ".") or canonical_name.casefold() in seen
                    or info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16)
                    or info.file_size > MAX_MEMBER or info.is_dir() and info.file_size != 0):
                raise ValueError("Unsafe, duplicate, encrypted or oversized nested GDTF member")
            seen.add(canonical_name.casefold())
            if not info.is_dir():
                members.append((canonical_name.encode("utf8"), info))
        digest = hashlib.sha256(b"zip-members-sha256-v1\0")
        for name, info in sorted(members, key=lambda member: member[0]):
            digest.update(len(name).to_bytes(8, "big"))
            digest.update(name)
            digest.update(info.file_size.to_bytes(8, "big"))
            with archive.open(info) as member:
                for block in iter(lambda: member.read(1024 * 1024), b""):
                    digest.update(block)
        return {"contentHashKind": "zip-members-sha256-v1", "contentSha256": digest.hexdigest()}


def inspect(path):
    p = Path(path)
    if not p.is_absolute() or p.suffix.lower() != ".mvr":
        raise ValueError("file must be an absolute path to a .mvr file")
    if not p.is_file() or p.stat().st_size > MAX_ARCHIVE:
        raise ValueError("MVR must be a regular file no larger than 256 MiB")
    initial = p.stat()
    archive_hash = hashlib.sha256()
    with p.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            archive_hash.update(block)
    with zipfile.ZipFile(p) as z:
        entries = z.infolist()
        if len(entries) > 20000 or sum(i.file_size for i in entries) > MAX_TOTAL:
            raise ValueError("MVR archive exceeds entry or 512 MiB uncompressed budget")
        seen_names = set()
        for info in entries:
            name = info.filename.replace("\\", "/")
            normalized = PurePosixPath(name)
            if (name.startswith("/") or ":" in name or ".." in normalized.parts or "\x00" in name
                    or name.casefold() in seen_names or info.flag_bits & 1
                    or stat.S_ISLNK(info.external_attr >> 16) or info.file_size > MAX_MEMBER):
                raise ValueError("Unsafe, duplicate, encrypted or oversized MVR archive member")
            seen_names.add(name.casefold())
        info = z.getinfo("GeneralSceneDescription.xml")
        if info.file_size > MAX_XML:
            raise ValueError("MVR scene XML exceeds 16 MiB")
        xml = z.read(info).decode("utf-8-sig")
        if "\x00" in xml or re.search(r"<!\s*(DOCTYPE|ENTITY)\b", xml, re.I):
            raise ValueError("MVR scene XML must be UTF-8 without DTD or entities")
        root = ET.fromstring(xml)
        if tag(root) != "GeneralSceneDescription" or child(root, "Scene") is None:
            raise ValueError("Missing GeneralSceneDescription/Scene")
        if sum(1 for _ in root.iter()) > 100000:
            raise ValueError("MVR scene exceeds XML node budget")
        objects, seen_ids = [], set()

        def walk(e, parent, parent_matrix, depth=0):
            if depth > 128:
                raise ValueError("MVR scene nesting exceeds 128")
            next_parent, world = parent, parent_matrix
            if tag(e) in KINDS:
                uid = str(uuid.UUID(e.attrib.get("uuid", "")))
                if uid in seen_ids:
                    raise ValueError("Duplicate MVR object UUID: " + uid)
                seen_ids.add(uid)
                local = matrix(e)
                world = compose(parent_matrix, local)
                geometry = child(e, "Geometries")
                addresses = []
                address_node = child(e, "Addresses")
                for address in address_node if address_node is not None else []:
                    if tag(address) != "Address":
                        continue
                    number, brk = int((address.text or "").strip()), int(address.attrib.get("break", "0"))
                    if number < 1 or number > 2**32-1 or brk < 0 or brk > 255:
                        raise ValueError("Invalid fixture address or DMX break")
                    addresses.append({"break": brk, "address": number})
                # Address elements are keyed by DMX break; XML order is not a readdressing.
                addresses.sort(key=lambda value: (value["break"], value["address"]))
                objects.append({"uuid": uid, "kind": tag(e), "name": e.attrib.get("name", ""), "parent": parent,
                                "matrix": local, "worldMatrix": world, "fixtureId": text(e, "FixtureID"),
                                "gdtfSpec": text(e, "GDTFSpec"), "gdtfMode": text(e, "GDTFMode"), "addresses": addresses,
                                "geometryHash": hashlib.sha256(json.dumps(canonical(geometry), sort_keys=True).encode()).hexdigest() if geometry is not None else None})
                if len(objects) > MAX_OBJECTS:
                    raise ValueError("MVR scene exceeds 10000 objects")
                next_parent = uid
            for c in e:
                walk(c, next_parent, world, depth+1)

        walk(child(root, "Scene"), None, IDENTITY)
        assets = []
        nested_budget = {"entries": 0, "bytes": 0}
        for item in entries:
            if item.filename == "GeneralSceneDescription.xml" or item.is_dir():
                continue
            digest = hashlib.sha256()
            payload = bytearray() if item.filename.lower().endswith(".gdtf") else None
            with z.open(item) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
                    if payload is not None:
                        payload.extend(block)
            semantic = nested_gdtf_identity(payload, nested_budget) if payload is not None else {}
            assets.append({"name": item.filename, "bytes": item.file_size, "sha256": digest.hexdigest(), **semantic})
        fid_map = {}
        for item in objects:
            if item["kind"] == "Fixture" and item["fixtureId"]:
                fid_map.setdefault(item["fixtureId"], []).append(item["uuid"])
        final = p.stat()
        if (initial.st_dev, initial.st_ino, initial.st_size, initial.st_mtime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
            raise ValueError("MVR changed during inspection; nothing was compared")
        return {"version": root.attrib.get("verMajor", "?")+"."+root.attrib.get("verMinor", "?"),
                "archive": {"file": str(p), "bytes": p.stat().st_size, "sha256": archive_hash.hexdigest(), "members": len(entries)},
                "objects": objects, "assets": assets, "fixtureIdConflicts": {k: v for k, v in fid_map.items() if len(v) > 1},
                "units": {"translation": "millimetres", "matrix": "row-major affine 3 by 4; includes inherited parent transforms in worldMatrix"}}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("one MVR path is required")
        print(json.dumps(inspect(sys.argv[1]), allow_nan=False, separators=(",", ":")))
    except (OSError, ValueError, KeyError, RuntimeError, ET.ParseError, zipfile.BadZipFile, NotImplementedError, RecursionError) as error:
        print("MVR inspection failed: " + str(error), file=sys.stderr)
        sys.exit(1)
