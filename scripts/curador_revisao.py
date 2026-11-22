"""Revisão explícita das duas notas do catálogo OpenCode."""
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid
from datetime import datetime, timezone, timedelta

NOTAS = ("OpenCode Skills.md", "13 - Referências.md")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check_path(path):
    for part in (path, *path.parents):
        if part.exists() and getattr(part.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"Redirecionamento no caminho: {part}")


def replace(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        tmp = Path(out.name)
        try:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        except BaseException:
            out.close()
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def run(args, vault, state):
    root = state / "revisoes"
    check_path(root)
    now = datetime.now(timezone.utc)
    if args.modo == "revisar":
        source = Path(args.entrada).resolve(strict=True)
        batch = root / uuid.uuid4().hex
        batch.mkdir(parents=True)
        records, diff = {}, []
        for i, name in enumerate(NOTAS):
            target = vault / "referencias" / name
            check_path(target)
            before, after = target.read_bytes(), (source / name).read_bytes()
            if not after.decode("utf-8-sig").startswith("# "):
                raise ValueError(f"Markdown inválido: {name}")
            (batch / f"{i}.original").write_bytes(before)
            (batch / f"{i}.proposta").write_bytes(after)
            records[name] = [digest(before), digest(after)]
            diff.extend(difflib.unified_diff(before.decode("utf-8-sig").splitlines(), after.decode("utf-8-sig").splitlines(), name, name, lineterm=""))
        report = batch / "previa.diff"
        report.write_text("\n".join(diff), encoding="utf-8")
        meta = json.dumps([str(vault), now.isoformat(), records, digest(report.read_bytes())], ensure_ascii=False).encode()
        (batch / "manifesto.json").write_bytes(meta)
        print(f"Prévia: {report}\nBackup e propostas: {batch}\nLote: {batch.name}-{digest(meta)}")
        return
    if not re.fullmatch(r"[a-f0-9]{32}-[a-f0-9]{64}", args.lote or ""):
        raise ValueError("Identificador de revisão inválido")
    ident, checksum = args.lote.split("-")
    batch = root / ident
    check_path(batch)
    meta = (batch / "manifesto.json").read_bytes()
    if digest(meta) != checksum:
        raise ValueError("Manifesto alterado")
    expected, date, records, report_hash = json.loads(meta)
    if expected != str(vault) or now - datetime.fromisoformat(date) > timedelta(hours=24) or digest((batch / "previa.diff").read_bytes()) != report_hash:
        raise ValueError("Prévia expirada, alterada ou de outro vault")
    root.mkdir(parents=True, exist_ok=True)
    lock = root / "confirmacao.lock"
    with lock.open("x"):
        pass
    try:
        pending = []
        for i, name in enumerate(NOTAS):
            path = vault / "referencias" / name
            check_path(path)
            old, new = (batch / f"{i}.original").read_bytes(), (batch / f"{i}.proposta").read_bytes()
            if [digest(old), digest(new)] != records[name] or path.read_bytes() not in (old, new):
                raise ValueError(f"Conflito ou backup inválido: {path}")
            pending.append((path, old, new))
        for path, old, new in pending:
            current = path.read_bytes()
            if current == new:
                continue
            if current != old:
                raise ValueError(f"Conflito: {path}")
            replace(path, new)
            print(f"Atualizado: {path}", flush=True)
        print(f"Backup dos originais: {batch}")
    finally:
        lock.unlink()
