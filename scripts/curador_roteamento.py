"""Prévia e confirmação de um conjunto explícito de movimentos e ajustes Markdown."""
import difflib
import hashlib
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from uuid import uuid4
from curador_revisao import check_path, replace


def sha(data):
    return hashlib.sha256(data).hexdigest()


def auditar(vault):
    """Triagem somente de leitura; referências técnicas continuam classificadas pelo agente."""
    notes = {}
    for p in vault.rglob("*.md"):
        if any(part.startswith(".") for part in p.relative_to(vault).parts):
            continue
        check_path(p)
        notes[p] = p.read_text(encoding="utf-8-sig")
    projects = {p:s for p,s in notes.items() if p.parent == vault/"projetos" and p.name!="09 - Projetos.md"}
    for p,s in notes.items():
        area = p.relative_to(vault).parts[0]
        if area not in ("inbox","conhecimento"):
            continue
        if area=="inbox" and " - Inbox.md" not in p.name:
            kind = "captura para triagem"
        elif re.search(r"^## (Escopo entregue|Entregas do projeto)",s,re.M|re.I):
            kind = "entrega com escopo documentado"
        else:
            continue
        refs=[str(q.relative_to(vault)) for q,body in notes.items() if q!=p and p.stem in body]
        matches=[q for q,body in projects.items() if p.stem in body or (q.stem.split(" - ")[-1].casefold() in s.casefold())]
        dest=str(matches[0].relative_to(vault).with_suffix("")/p.name) if len(matches)==1 else "revisão de projeto"
        print(f"{p.relative_to(vault)} | {kind} | {dest} | referências: {', '.join(refs) or 'nenhuma'}")


def target(vault, rel):
    path = vault / rel
    if Path(rel).is_absolute() or ".." in Path(rel).parts or ":" in rel or path.suffix != ".md" or Path(rel).parts[0] not in {"inbox", "projetos", "conhecimento"}:
        raise ValueError(f"Destino inválido: {rel}")
    check_path(path)
    return path


def run(args, vault, state):
    root = state / "roteamento"
    check_path(root)
    if args.modo == "prever-roteamento":
        batch = root / uuid4().hex
        batch.mkdir(parents=True)
        draft = json.loads(Path(args.entrada).read_text(encoding="utf-8-sig"))
        entries, report, seen = [], [], set()
        for i, op in enumerate(draft):
            src = target(vault, op["origem"]) if op.get("origem") else None
            dst = target(vault, op["destino"])
            paths = {p for p in (src, dst) if p}
            if seen & paths or (dst != src and dst.exists()):
                raise ValueError(f"Colisão: {dst}")
            seen.update(paths)
            before = src.read_bytes() if src else b""
            if src and dst != src and "texto" in op:
                raise ValueError("Movimento deve preservar os bytes")
            after = op["texto"].encode() if "texto" in op else before
            (batch / f"{i}.antes").write_bytes(before)
            (batch / f"{i}.depois").write_bytes(after)
            entries.append([op.get("origem"), op["destino"], sha(before), sha(after)])
            report.extend([f"\n## {op['destino']}",op["motivo"],f"Origem: {op.get('origem') or '(nova nota)'}",f"SHA-256 final: {sha(after)}"])
            if after != before:
                report.extend(["```diff",*difflib.unified_diff(before.decode("utf-8-sig").splitlines(), after.decode("utf-8-sig").splitlines(),lineterm=""),"```"])
        preview = batch / "previa.md"
        preview.write_text("# Prévia de roteamento\n"+"\n".join(report),encoding="utf-8")
        meta = json.dumps([str(vault),datetime.now(timezone.utc).isoformat(),entries,sha(preview.read_bytes())]).encode()
        (batch / "manifesto.json").write_bytes(meta)
        print(preview)
        print(batch.name+"-"+sha(meta))
        return
    if not re.fullmatch("[a-f0-9]{32}-[a-f0-9]{64}",args.lote or ""):
        raise ValueError("Lote inválido")
    ident, sig = args.lote.split("-")
    batch = root / ident
    check_path(batch)
    meta = (batch / "manifesto.json").read_bytes()
    name,date,entries,preview_hash = json.loads(meta)
    if sha(meta)!=sig or name!=str(vault) or datetime.now(timezone.utc)-datetime.fromisoformat(date)>timedelta(days=1) or sha((batch/"previa.md").read_bytes())!=preview_hash:
        raise ValueError("Prévia inválida ou expirada")
    def pending(src,dst,before,after):
        if dst.is_file() and dst.read_bytes()==after and (src==dst or not src or not src.exists()):
            return False
        if (src and (not src.is_file() or src.read_bytes()!=before)) or (src!=dst and dst.exists()):
            raise ValueError(f"Conflito: {dst}")
        return True
    lock = root / "confirmacao.lock"
    with lock.open("x"):
        pass
    try:
        ops=[]
        for i,(origin,dest,old,new) in enumerate(entries):
            src=target(vault,origin) if origin else None
            dst=target(vault,dest)
            before=(batch/f"{i}.antes").read_bytes()
            after=(batch/f"{i}.depois").read_bytes()
            if sha(before)!=old or sha(after)!=new:
                raise ValueError("Backup ou proposta alterada")
            pending(src,dst,before,after)
            ops.append((src,dst,before,after))
        for src,dst,before,after in ops:
            if pending(src,dst,before,after):
                dst.parent.mkdir(parents=True,exist_ok=True)
                if src and src!=dst:
                    src.rename(dst)
                elif src:
                    replace(dst,after)
                else:
                    with dst.open("xb") as f:
                        f.write(after)
            if dst.read_bytes()!=after:
                raise ValueError(f"Verificação falhou: {dst}")
            print(dst)
    finally:
        lock.unlink()
