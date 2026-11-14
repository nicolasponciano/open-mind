r"""Curador do Segundo Cérebro.

Modos:
  previa     analisa o lote e grava a prévia fora do vault (nada no vault muda)
  simulacao  analisa e mostra a prévia na tela, sem gravar arquivos
  confirmar  grava somente os itens escolhidos, após revalidar cada item
  rejeitar   descarta uma prévia
  listar     lista prévias pendentes
  auditar    lista notas do curador paradas há 30 dias

Escopo (opcional em previa/simulacao):
  --projeto <slug>  só a nota do projeto cadastrado em projetos/09 - Projetos.md
  --area <pasta>    só dentro de uma área canônica do AGENTS.md

O vault é sempre explícito: --vault <caminho absoluto> (ou a variável de
ambiente CEREBRO_VAULT). Não existe fallback para diretório pessoal.

Estado temporário (fora do vault): %LOCALAPPDATA%\cerebro-curador\.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import unicodedata
import uuid

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

BASE_PADRAO = os.path.join(os.environ.get("LOCALAPPDATA", "."), "cerebro-curador")
PENDENTES_PADRAO = os.path.join(BASE_PADRAO, "pendentes")
FILA_PADRAO = os.path.join(BASE_PADRAO, "fila.jsonl")
LEDGER_PADRAO = os.path.join(BASE_PADRAO, "confirmacoes.jsonl")
LOG_PADRAO = os.path.join(BASE_PADRAO, "alteracoes.log")
APROVADOS_PADRAO = os.path.join(BASE_PADRAO, "aprovados.jsonl")
PASTAS = ["inbox", "diario", "pessoas", "empresas", "clientes", "reunioes", "deals",
          "financas", "projetos", "conteudo", "conhecimento", "pessoal", "referencias"]
PASTAS_BLOQUEADAS = ["arquivo", ".obsidian"]
MAX_NOTAS = 3
MAX_CHARS = 1500
MAX_LINHAS = 40
VALIDADE = datetime.timedelta(hours=24)
LOCK_EXPIRA_S = 600
DIAS_AUDITORIA = 30
HASH_VERSAO = 2
TIPOS_AUTO = {"decisao", "padrao"}
TIPOS_VALIDOS = TIPOS_AUTO | {"contexto"}
STOP = {"de", "da", "do", "das", "dos", "a", "o", "e", "em", "para", "com", "que",
        "um", "uma", "no", "na", "por", "sobre"}
INDICE = re.compile(r"^\d{2}(\.\d+)? - ")
INDICE_AREA = re.compile(r"^\d{2} - ")
LOTE_ID = re.compile(r"^lote-\d{8}-\d{6}-[0-9a-f]{6}$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
LINK_PROJETO = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\][^`\n]*`([^`]+)`")
MARCA_CURADOR = "Origem: curador"
PROJETOS_FALLBACK = {"bug-hunter": "projetos/Agente Bug Hunter.md"}

SENSIVEIS = [
    (re.compile(r"(?i)(api[_-]?key|secret|senha|password|token|bearer)\s*[:=]"), "credencial"),
    (re.compile(r"\bsk-[A-Za-z0-9]{16,}"), "credencial"),
    (re.compile(r"[A-Za-z0-9_\-]{32,}"), "possível chave"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "e-mail"),
    (re.compile(r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b"), "CPF"),
    (re.compile(r"\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b"), "telefone"),
    (re.compile(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b"), "número de cartão"),
    (re.compile(r"-----BEGIN"), "chave privada"),
]
TRANSCRICAO = [
    re.compile(r"(?im)^\s*[*_]*(user|assistant|usuario|usuário|human|ai)[*_]*\s*:"),
    re.compile(r"\[(User|Assistant)\]"),
]


def erro(msg):
    print(f"ERRO: {msg}", file=sys.stderr)
    sys.exit(2)


def agora():
    return datetime.datetime.now()


def norm(texto):
    texto = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in texto if not unicodedata.combining(c)).lower()


def tokens(texto):
    return {t for t in re.split(r"[^a-z0-9]+", norm(texto)) if t and t not in STOP}


def nome_seguro(titulo):
    return re.sub(r'[<>:"/\\|?*]', "", titulo).strip().rstrip(".")


def sensivel(texto):
    for padrao, rotulo in SENSIVEIS:
        if padrao.search(texto):
            return rotulo
    return None


def transcricao(texto):
    return any(p.search(texto) for p in TRANSCRICAO)


def normalizar(pasta):
    return pasta.replace("\\", "/").strip("/")


def pasta_dentro(pasta, base):
    p = normalizar(pasta)
    return p == base or p.startswith(base + "/")


def rel_do(caminho, vault):
    return str(caminho.resolve().relative_to(vault.resolve())).replace("\\", "/")


# --- hash e leitura de bytes -------------------------------------------------
# O hash cobre os bytes originais do arquivo: LF/CRLF, BOM e ausência de
# newline final mudam o hash. Representação: SHA-256 hexadecimal de 64 chars.

def sha_bytes(dados):
    return hashlib.sha256(dados).hexdigest()


def sha_texto(texto):
    return sha_bytes(texto.encode("utf-8"))


def ler_bytes(caminho):
    return caminho.read_bytes()


def ler_texto(caminho):
    return caminho.read_bytes().decode("utf-8-sig")


def sha_arq(caminho):
    if not caminho.is_file():
        return None
    return sha_bytes(ler_bytes(caminho))


# --- escrita preservando fim de linha ---------------------------------------

def detectar_nl(texto):
    if "\r\n" in texto:
        return "\r\n"
    if "\n" in texto:
        return "\n"
    if "\r" in texto:
        return "\r"
    return "\n"


def normalizar_nl(texto, nl):
    return texto.replace("\r\n", "\n").replace("\r", "\n").replace("\n", nl)


def escrever_atomico(caminho, texto, nl="\n"):
    caminho.parent.mkdir(parents=True, exist_ok=True)
    tmp = caminho.with_name(f"{caminho.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_bytes(normalizar_nl(texto, nl).encode("utf-8"))
    os.replace(tmp, caminho)


def anexar_texto(caminho, texto, nl=None):
    """Anexa texto sem traduzir fim de linha e sem colar na última linha."""
    atual = ler_texto(caminho) if caminho.is_file() else ""
    nl = nl or detectar_nl(atual)
    prefixo = "" if not atual or atual.endswith("\n") else nl
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with caminho.open("ab") as f:
        f.write((prefixo + normalizar_nl(texto, nl)).encode("utf-8"))


def anexar_linha(caminho, linha):
    anexar_texto(caminho, linha + "\n")


def encontrar_nota(titulo, notas):
    alvo = norm(titulo).strip()
    tk = tokens(titulo)
    melhor, melhor_score = None, 0.0
    for nota in notas:
        if norm(nota.stem).strip() == alvo:
            return nota
        tn = tokens(nota.stem)
        if not tk or not tn:
            continue
        score = len(tk & tn) / len(tk | tn)
        if score > melhor_score:
            melhor, melhor_score = nota, score
    return melhor if melhor_score >= 0.6 else None


def notas_existentes(vault):
    notas = []
    for arq in vault.rglob("*.md"):
        partes = set(arq.relative_to(vault).parts)
        if ".obsidian" in partes or "arquivo" in partes or INDICE.match(arq.stem):
            continue
        notas.append(arq)
    return notas


def linhas_uteis(texto):
    return {norm(l).strip() for l in texto.splitlines() if l.strip()}


def achar_indice(pasta, vault):
    atual = pasta
    while True:
        if atual.is_dir():
            for arq in atual.glob("*.md"):
                if INDICE.match(arq.stem):
                    return arq
        if atual.resolve() == vault.resolve() or atual.parent == atual:
            return None
        atual = atual.parent


def mapa_projetos(vault):
    mapa = dict(PROJETOS_FALLBACK)
    indice = vault / "projetos" / "09 - Projetos.md"
    if indice.is_file():
        for nota, alias, caminho in LINK_PROJETO.findall(ler_texto(indice)):
            destino = f"projetos/{nota.strip()}.md"
            fontes = [alias, re.split(r"[\\/]", caminho.strip())[-1], pathlib.Path(nota).stem]
            for fonte in fontes:
                slug = re.sub(r"[^a-z0-9]+", "-", norm(fonte)).strip("-")
                if slug:
                    if slug not in mapa:
                        mapa[slug] = destino
                    elif mapa[slug] != destino:
                        mapa[slug] = None
    return mapa


def resolver(c, vault, mapa):
    """Devolve (status, motivo, alvo, eh_arquivo)."""
    pasta = normalizar(c["pasta"])
    partes = pasta.split("/") if pasta else []
    if not partes or ".." in partes or ":" in pasta:
        return "descartada", "caminho inválido", None, False
    if partes[0] in PASTAS_BLOQUEADAS:
        return "descartada", f"{partes[0]}/ não recebe notas novas", None, False
    if partes[0] not in PASTAS:
        return "fila", "destino incerto: pasta fora das áreas do AGENTS.md", None, False
    if partes[0] == "projetos" and len(partes) == 2 and not pasta.lower().endswith(".md"):
        slug = partes[1].lower()
        if slug not in mapa or not mapa[slug] or not (vault / mapa[slug]).is_file():
            return "fila", f"projeto não cadastrado: {partes[1]}", None, False
        return "ok", "", vault / mapa[slug], True
    destino = (vault / pasta).resolve()
    if vault.resolve() not in destino.parents and destino != vault.resolve():
        return "descartada", "caminho inválido", None, False
    if pasta.lower().endswith(".md"):
        if not destino.parent.is_dir():
            return "fila", f"pasta nova {rel_do(destino.parent, vault)}: requer confirmação", None, False
        return "ok", "", destino, True
    if not destino.is_dir():
        return "fila", f"pasta nova {pasta}: requer confirmação", None, False
    return "ok", "", destino, False


def validar(c, projeto, escopo, vault, mapa):
    """Devolve (status, motivo, alvo, eh_arquivo). Segurança vem antes de fila."""
    if not isinstance(c, dict):
        return "descartada", "candidato inválido (não é objeto)", None, False
    if c.get("projeto") and projeto and c["projeto"] != projeto:
        return "descartada", "fora do escopo do projeto", None, False
    for campo in ["titulo", "pasta", "tipo", "confianca", "corpo", "fonte"]:
        if not str(c.get(campo, "")).strip():
            return "descartada", f"campo ausente: {campo}", None, False
    titulo, corpo, fonte = str(c["titulo"]), str(c["corpo"]), str(c["fonte"])
    if c["tipo"] not in TIPOS_VALIDOS:
        return "descartada", f"tipo inválido: {c['tipo']}", None, False
    if c["confianca"] not in ("alta", "baixa"):
        return "descartada", f"confiança inválida: {c['confianca']}", None, False
    if not re.search(r"\d{4}-\d{2}-\d{2}|sess[ãa]o", fonte, re.IGNORECASE):
        return "descartada", "fonte sem referência de sessão (data ou 'sessão')", None, False
    for campo, valor in [("titulo", titulo), ("corpo", corpo), ("fonte", fonte), ("pasta", str(c["pasta"]))]:
        rotulo = sensivel(valor)
        if rotulo:
            return "descartada", f"conteúdo sensível ({rotulo}) no campo {campo}", None, False
    if transcricao(corpo) or transcricao(fonte):
        return "descartada", "parece transcrição do chat", None, False
    if len(corpo) > MAX_CHARS or corpo.count("\n") + 1 > MAX_LINHAS:
        return "descartada", "conteúdo longo demais para nota curta", None, False
    if not nome_seguro(titulo):
        return "descartada", "título inválido", None, False

    status, motivo, alvo, eh_arquivo = resolver(c, vault, mapa)
    if status != "ok":
        return status, motivo, None, False
    if eh_arquivo and INDICE_AREA.match(alvo.stem):
        return "descartada", "índice de área não recebe notas", None, False

    if projeto:
        esperado = mapa.get(projeto)
        if not esperado or not (vault / esperado).is_file():
            return "fila", f"projeto não cadastrado: {projeto}", None, False
        if not eh_arquivo or rel_do(alvo, vault) != esperado:
            return "fila", f"fora do projeto {projeto}: requer revisão", None, False
    if escopo and not pasta_dentro(normalizar(c["pasta"]), escopo):
        return "fila", f"fora do escopo {escopo}: requer revisão", None, False
    if c["confianca"] == "baixa" or c["tipo"] not in TIPOS_AUTO:
        return "fila", "baixa confiança ou sem decisão/padrão explícito", None, False
    return "ok", "", alvo, eh_arquivo


def planejar(candidatos, projeto, escopo, vault, lote_id, limite=MAX_NOTAS):
    mapa = mapa_projetos(vault)
    notas = notas_existentes(vault)
    hoje = agora().date().isoformat()
    plano, alvos, usados = [], set(), 0
    for n, c in enumerate(candidatos, start=1):
        titulo = str(c.get("titulo", "(sem título)")) if isinstance(c, dict) else "(inválido)"
        item = {"numero": n, "titulo": titulo, "c": c}
        status, motivo, alvo, eh_arquivo = validar(c, projeto, escopo, vault, mapa)
        if status != "ok":
            plano.append({**item, "status": status, "motivo": motivo})
            continue
        titulo = c["titulo"].strip()
        arq = alvo if eh_arquivo else alvo / f"{nome_seguro(titulo)}.md"
        acao = "atualizada" if arq.is_file() else "criada"
        if acao == "criada":
            ex = encontrar_nota(titulo, notas)
            if ex is not None:
                if pasta_dentro(rel_do(ex.parent, vault), rel_do(arq.parent, vault)):
                    arq, acao = ex, "atualizada"
                else:
                    plano.append({**item, "status": "fila",
                                  "motivo": f"possível duplicata em {rel_do(ex.parent, vault)}: requer revisão"})
                    continue
        rel = rel_do(arq, vault)
        if rel in alvos:
            plano.append({**item, "status": "fila", "motivo": "mesmo destino de outro item do lote"})
            continue
        if usados >= limite:
            plano.append({**item, "status": "fila", "motivo": f"limite de {limite} notas por sessão atingido"})
            continue
        corpo, fonte = c["corpo"].strip(), c["fonte"].strip()
        indice = None
        if acao == "atualizada":
            if linhas_uteis(corpo) <= linhas_uteis(ler_texto(arq)):
                plano.append({**item, "status": "descartada", "motivo": "já registrado na nota existente"})
                continue
            texto = f"\n## Atualização {hoje}\n\n{corpo}\n\nFonte: {fonte}\n{MARCA_CURADOR} | lote {lote_id}\n"
        else:
            texto = f"# {titulo}\n\n{corpo}\n\nFonte: {fonte}\nData: {hoje}\n{MARCA_CURADOR} | lote {lote_id}\n"
            idx = achar_indice(arq.parent, vault)
            indice = rel_do(idx, vault) if idx else None
        alvos.add(rel)
        usados += 1
        plano.append({**item, "status": "ok", "acao": acao, "alvo": rel, "texto": texto,
                      "antes": sha_arq(arq), "indice": indice, "confianca": c["confianca"]})
    return plano


def renderizar(lote_id, projeto, escopo, plano, expira):
    ok = [p for p in plano if p["status"] == "ok"]
    fila = [p for p in plano if p["status"] == "fila"]
    desc = [p for p in plano if p["status"] == "descartada"]
    linhas = ["# Prévia do curador", "",
              f"Lote: {lote_id}",
              f"Escopo: {escopo or 'automático (áreas do AGENTS.md)'}",
              f"Expira em: {expira:%Y-%m-%d %H:%M}" if expira else "Expira em: (simulação, nada salvo)",
              "",
              f"Para gravar: /cerebro --modo confirmar --lote {lote_id} --itens 1,2",
              f"Para descartar: /cerebro --modo rejeitar --lote {lote_id}",
              "", f"## Gravar ({len(ok)})", ""]
    for p in ok:
        linhas += [f"### {p['numero']}. {p['titulo']}",
                   f"Ação: {'criar' if p['acao'] == 'criada' else 'atualizar'}",
                   f"Destino: {p['alvo']}",
                   f"Confiança: {p['confianca']}",
                   f"> {p['c']['corpo'].strip()}", ""]
    linhas += [f"## Fila, não gravado ({len(fila)})", ""]
    linhas += [f"- {p['numero']}. {p['titulo']}: {p['motivo']}" for p in fila]
    linhas += ["", f"## Descartados ({len(desc)})", ""]
    linhas += [f"- {p['numero']}. {p['motivo']}" for p in desc]
    linhas += ["", "## Proteções verificadas", "",
               "- [x] Sem credenciais, e-mails, telefones ou documentos",
               "- [x] Sem transcrição do chat",
               f"- [x] Limite de {MAX_NOTAS} notas",
               "- [x] Destinos resolvidos no vault real",
               "- [x] Duplicatas verificadas"]
    return "\n".join(linhas)


def caminhos_lote(pendentes, lote_id):
    return pendentes / f"{lote_id}.json", pendentes / f"{lote_id}.md", pendentes / f"{lote_id}.lock"


def registrar_ledger(caminho, lote_id, estado, detalhe=""):
    registro = {"quando": agora().isoformat(timespec="seconds"), "lote": lote_id,
                "estado": estado, "detalhe": detalhe}
    anexar_linha(pathlib.Path(caminho), json.dumps(registro, ensure_ascii=False))


def remover_lote(pendentes, lote_id):
    js, md, _ = caminhos_lote(pendentes, lote_id)
    for caminho in (js, md):
        try:
            caminho.unlink()
        except FileNotFoundError:
            pass
        except PermissionError:
            # No Windows, uma chamada concorrente pode deixar o arquivo em
            # delete-pending. Só ignore se ele já desapareceu; permissão
            # negada em arquivo ainda existente continua sendo erro real.
            if caminho.exists():
                raise
    return True


def limpar_expirados(pendentes, ledger):
    if not pendentes.is_dir():
        return
    for js in pendentes.glob("lote-*.json"):
        try:
            dados = json.loads(js.read_text(encoding="utf-8"))
            expira = datetime.datetime.fromisoformat(dados["expira_em"])
        except (ValueError, KeyError):
            continue
        if agora() > expira:
            lote_id = dados.get("id")
            if not lote_id:
                removido = True
                for caminho in (js, js.with_suffix(".md")):
                    try:
                        caminho.unlink()
                    except FileNotFoundError:
                        pass
                    except PermissionError:
                        if caminho.exists():
                            removido = False
                registrar_ledger(ledger, js.stem,
                                 "expirado-sem-id" if removido else "expiração-pendente",
                                 "lote sem id" if removido else "remoção bloqueada")
                continue
            if remover_lote(pendentes, lote_id):
                registrar_ledger(ledger, lote_id, "expirado")
            else:
                registrar_ledger(ledger, lote_id, "expiração-pendente", "remoção bloqueada")


def ja_aplicado(it, vault):
    alvo = vault / it["alvo"]
    return alvo.is_file() and it["texto"].strip() in ler_texto(alvo)


def aplicar_item(it, vault):
    """Idempotente: repetir após queda não duplica texto nem link."""
    alvo = vault / it["alvo"]
    if it["acao"] == "criada":
        if alvo.is_file():
            if ler_texto(alvo).strip() != it["texto"].strip():
                raise RuntimeError(f"destino já existe com outro conteúdo: {it['alvo']}")
        else:
            escrever_atomico(alvo, it["texto"])
        if it.get("indice"):
            idx = vault / it["indice"]
            atual = ler_texto(idx)
            link = f"- [[{alvo.stem}]]"
            if link not in atual:
                nl = detectar_nl(atual)
                escrever_atomico(idx, atual.rstrip("\r\n") + nl + link + "\n", nl)
    else:
        atual = ler_texto(alvo)
        if it["texto"].strip() not in atual:
            existentes = linhas_uteis(atual)
            novas = []
            for linha in it["texto"].splitlines():
                normalizada = norm(linha).strip()
                if not normalizada:
                    continue
                if normalizada.startswith("## atualizacao"):
                    if normalizada not in existentes:
                        novas.append(linha)
                    continue
                if normalizada not in existentes:
                    novas.append(linha)
            bloco = "\n".join(novas).strip()
            if bloco:
                anexar_texto(alvo, bloco + "\n")
    return sha_arq(alvo)


def registrar_auditoria(caminho, feitos, lote_id):
    agora_s = agora().isoformat(timespec="seconds")
    for it in feitos:
        anexar_linha(pathlib.Path(caminho),
                     f"{agora_s} | {it['acao']} | {it['alvo']} | antes={it['antes']} | "
                     f"depois={it['depois']} | lote={lote_id}")


def revalidar_item(it, dados, vault, mapa):
    """Revalida tudo o que o item depende, imediatamente antes de gravar."""
    status, motivo, _, _ = validar(it["c"], dados["projeto"], dados["escopo"], vault, mapa)
    if status != "ok":
        return motivo or f"item não é mais gravável ({status})"
    alvo = vault / it["alvo"]
    if it["acao"] == "criada" and alvo.is_file() and not ja_aplicado(it, vault):
        return "destino criado por outra sessão desde a prévia"
    if sha_arq(alvo) != it["antes"] and not ja_aplicado(it, vault):
        return "vault mudou desde a prévia"
    return None


def cmd_previa(args, vault, pendentes, ledger, gravar):
    if not args.entrada:
        erro("--entrada é obrigatório")
    limpar_expirados(pendentes, ledger) if gravar else None
    try:
        dados = json.loads(pathlib.Path(args.entrada).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        erro(f"entrada inválida: {e}")
    candidatos = dados.get("candidatos") if isinstance(dados, dict) else None
    if not isinstance(candidatos, list) or not candidatos:
        erro("lote sem candidatos (esperado {\"candidatos\": [...]})")
    escopo = f"projetos" if args.projeto else (normalizar(args.area) if args.area else None)
    lote_id = f"lote-{agora():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}"
    plano = planejar(candidatos, args.projeto, escopo, vault, lote_id)
    if not gravar:
        print(renderizar("(simulação)", args.projeto, escopo, plano, None))
        return
    expira = agora() + VALIDADE
    texto = renderizar(lote_id, args.projeto, escopo, plano, expira)
    js, md, _ = caminhos_lote(pendentes, lote_id)
    escrever_atomico(md, texto)
    registro = {"id": lote_id, "criado_em": agora().isoformat(timespec="seconds"),
                "expira_em": expira.isoformat(timespec="seconds"), "projeto": args.projeto,
                "escopo": escopo, "hash_versao": HASH_VERSAO,
                "md_sha": sha_texto(texto), "itens": plano, "feitos": []}
    escrever_atomico(js, json.dumps(registro, ensure_ascii=False, indent=2))
    print(texto)
    print(f"\nPrévia salva fora do vault: {md}")


def parse_itens(texto):
    try:
        numeros = {int(x) for x in re.split(r"[,\s]+", texto.strip()) if x}
    except ValueError:
        erro(f"--itens inválido: {texto} (ex: 1,3)")
    if not numeros:
        erro("--itens vazio")
    return numeros


def cmd_confirmar(args, vault, pendentes, ledger, log, aprovados, fila):
    if not args.lote or not LOTE_ID.match(args.lote):
        erro("--lote inválido ou ausente")
    if not args.itens:
        erro("confirmação exige --itens (ex: 1,3). Confirmar tudo precisa ser listado explicitamente.")
    limpar_expirados(pendentes, ledger)
    js, md, lock = caminhos_lote(pendentes, args.lote)
    if not js.is_file():
        erro("prévia não encontrada: já usada, rejeitada ou expirada")
    if lock.exists() and time.time() - lock.stat().st_mtime > LOCK_EXPIRA_S:
        lock.unlink()
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        erro("confirmação já em andamento para este lote")
    try:
        dados = json.loads(js.read_text(encoding="utf-8"))
        if dados.get("hash_versao") != HASH_VERSAO:
            if not remover_lote(pendentes, args.lote):
                registrar_ledger(ledger, args.lote, "lote-incompativel-pendente",
                                 "hash antigo; remoção bloqueada")
                erro("lote gerado com hash antigo e não foi possível removê-lo: nova análise necessária")
            registrar_ledger(ledger, args.lote, "lote-incompativel",
                             "hash antigo; lote descartado sem execução")
            erro("lote gerado com versão antiga de hash: descartado, nada foi gravado. Gere nova prévia.")
        if not md.is_file() or sha_arq(md) != dados["md_sha"]:
            if not remover_lote(pendentes, args.lote):
                registrar_ledger(ledger, args.lote, "prévia-alterada-pendente", "remoção bloqueada")
                erro("prévia alterada, mas não foi possível removê-la: nova análise necessária")
            registrar_ledger(ledger, args.lote, "prévia-alterada")
            erro("prévia alterada ou ausente: nova análise necessária")
        itens = {it["numero"]: it for it in dados["itens"]}
        escolhidos = parse_itens(args.itens)
        for n in escolhidos:
            if n not in itens or itens[n]["status"] != "ok":
                erro(f"item {n} não está disponível para gravação")
        if len(escolhidos) > MAX_NOTAS:
            erro(f"máximo de {MAX_NOTAS} notas por confirmação")
        feitos_antes = set(dados.get("feitos", []))
        mapa = mapa_projetos(vault)
        conflitos = []
        for n in sorted(escolhidos - feitos_antes):
            motivo = revalidar_item(itens[n], dados, vault, mapa)
            if motivo:
                conflitos.append(f"{n} ({motivo})")
        if conflitos:
            if not remover_lote(pendentes, args.lote):
                registrar_ledger(ledger, args.lote, "conflito-pendente", "remoção bloqueada")
                erro(f"conflito com o vault atual e prévia não removida: {'; '.join(conflitos)}")
            registrar_ledger(ledger, args.lote, "conflito", "; ".join(conflitos))
            erro(f"conflito com o vault atual, nada gravado: {'; '.join(conflitos)}. Nova análise necessária.")

        feitos = set(feitos_antes)
        gravados = []
        try:
            for n in sorted(escolhidos - feitos_antes):
                it = itens[n]
                if ja_aplicado(it, vault):
                    feitos.add(n)
                    dados["feitos"] = sorted(feitos)
                    escrever_atomico(js, json.dumps(dados, ensure_ascii=False, indent=2))
                    continue
                motivo = revalidar_item(it, dados, vault, mapa)
                if motivo:
                    raise RuntimeError(f"item {n} revalidado antes da gravação: {motivo}")
                depois = aplicar_item(it, vault)
                feitos.add(n)
                gravados.append({**it, "depois": depois})
                dados["feitos"] = sorted(feitos)
                escrever_atomico(js, json.dumps(dados, ensure_ascii=False, indent=2))
        except Exception as e:
            registrar_ledger(ledger, args.lote, "parcial", f"{e}; feitos={sorted(feitos)}")
            erro(f"falha na gravação, lote mantido para retomada: {e}")

        registrar_auditoria(log, gravados, args.lote)
        if gravados:
            anexar_linha(pathlib.Path(aprovados), json.dumps({
                "quando": agora().isoformat(timespec="seconds"), "lote": args.lote,
                "escopo": dados["escopo"] or "automático",
                "arquivos": [g["alvo"] for g in gravados]}, ensure_ascii=False))
        for p in dados["itens"]:
            if p["status"] == "fila":
                anexar_linha(pathlib.Path(fila), json.dumps({
                    "quando": agora().isoformat(timespec="seconds"), "lote": args.lote,
                    "motivo": p["motivo"], "candidato": p["c"]}, ensure_ascii=False))
        if not remover_lote(pendentes, args.lote):
            registrar_ledger(ledger, args.lote, "confirmado-pendente", "gravação feita, remoção bloqueada")
            erro("gravação concluída, mas a prévia continua pendente por bloqueio de arquivo")
        pendentes_fila = [p for p in dados["itens"] if p["status"] == "fila"]
        fora_da_selecao = [n for n, p in itens.items()
                           if p["status"] == "ok" and n not in escolhidos]
        if gravados:
            detalhe = f"itens={sorted(escolhidos)}; gravados={[g['numero'] for g in gravados]}"
        else:
            detalhe = f"itens={sorted(escolhidos)}; nada a gravar (já aplicados)"
        registrar_ledger(ledger, args.lote, "confirmado", detalhe)
        if gravados:
            print(f"Gravado: {len(gravados)} item(ns) do lote {args.lote}")
            for g in gravados:
                print(f"- {g['numero']}. {g['acao']}: {g['alvo']}")
        else:
            print(f"Nada a gravar: os itens selecionados do lote {args.lote} já estavam aplicados.")
        if pendentes_fila or fora_da_selecao:
            avisos = []
            if pendentes_fila:
                avisos.append(f"{len(pendentes_fila)} na fila")
            if fora_da_selecao:
                avisos.append(f"não selecionados: {', '.join(map(str, sorted(fora_da_selecao)))}")
            print(f"Lote NÃO confirmado por inteiro ({'; '.join(avisos)}). "
                  "O lote foi encerrado; gere nova prévia para os pendentes.")
    finally:
        os.close(fd)
        if lock.exists():
            lock.unlink()


def cmd_rejeitar(args, pendentes, ledger):
    if not args.lote or not LOTE_ID.match(args.lote):
        erro("--lote inválido ou ausente")
    js, _, _ = caminhos_lote(pendentes, args.lote)
    if not js.is_file():
        erro("prévia não encontrada: já usada, rejeitada ou expirada")
    if not remover_lote(pendentes, args.lote):
        erro("não foi possível remover a prévia rejeitada; nada foi gravado")
    registrar_ledger(ledger, args.lote, "rejeitado")
    print(f"Prévia {args.lote} rejeitada. Nada foi gravado.")


def cmd_listar(pendentes):
    if not pendentes.is_dir():
        return "Nenhuma prévia pendente."
    linhas = ["# Prévias pendentes", ""]
    for js in sorted(pendentes.glob("lote-*.json")):
        d = json.loads(js.read_text(encoding="utf-8"))
        ok = sum(1 for i in d["itens"] if i["status"] == "ok")
        fila = sum(1 for i in d["itens"] if i["status"] == "fila")
        linhas.append(f"- {d['id']} | gravável: {ok} | fila: {fila} | expira: {d['expira_em']}")
    return "\n".join(linhas) if len(linhas) > 2 else "Nenhuma prévia pendente."


def auditoria(vault, dias):
    limite = agora() - datetime.timedelta(days=dias)
    achados = []
    for arq in vault.rglob("*.md"):
        partes = set(arq.relative_to(vault).parts)
        if ".obsidian" in partes or "arquivo" in partes or INDICE.match(arq.stem):
            continue
        if MARCA_CURADOR not in ler_texto(arq):
            continue
        modificado = datetime.datetime.fromtimestamp(arq.stat().st_mtime)
        if modificado < limite:
            achados.append(f"- {rel_do(arq, vault)} | última alteração {modificado:%Y-%m-%d}")
    linhas = [f"# Auditoria do curador (sem alteração há mais de {dias} dias)", "",
              f"Candidatas a arquivo: {len(achados)}"] + achados
    linhas += ["", "Nenhuma nota foi movida. Revise e mova para arquivo/ manualmente."]
    return "\n".join(linhas)


def exigir_vault(valor):
    if not valor:
        erro("--vault é obrigatório: informe o vault configurado no OpenCode. "
             "Não há fallback para diretório pessoal.")
    caminho = pathlib.Path(valor)
    if not caminho.is_absolute():
        erro(f"--vault deve ser um caminho absoluto: {valor}")
    if not caminho.is_dir():
        erro(f"--vault não aponta para um diretório existente: {valor}")
    return caminho.resolve()


def conferir_estado_fora_vault(vault, caminhos):
    for rotulo, valor in caminhos:
        if not valor:
            continue
        alvo = pathlib.Path(valor).resolve()
        if alvo == vault or vault in alvo.parents:
            erro(f"estado do curador ({rotulo}) não pode ficar dentro do vault: {valor}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--modo", default="previa",
                    choices=["previa", "simulacao", "confirmar", "rejeitar", "listar", "auditar"])
    ap.add_argument("--entrada", default=None, help="JSON com candidatos")
    ap.add_argument("--projeto", default=None, help="slug do projeto cadastrado")
    ap.add_argument("--area", default=None, help="área do vault, ex: conhecimento/wiki")
    ap.add_argument("--lote", default=None, help="id da prévia")
    ap.add_argument("--itens", default=None, help="números da prévia a gravar, ex: 1,3")
    ap.add_argument("--vault", default=os.environ.get("CEREBRO_VAULT"),
                    help="caminho absoluto do vault configurado no OpenCode")
    ap.add_argument("--pendentes", default=PENDENTES_PADRAO)
    ap.add_argument("--fila", default=FILA_PADRAO)
    ap.add_argument("--ledger", default=LEDGER_PADRAO)
    ap.add_argument("--log", default=LOG_PADRAO)
    ap.add_argument("--aprovados", default=APROVADOS_PADRAO)
    args = ap.parse_args()

    if args.projeto and args.area:
        ap.error("use --projeto ou --area, não os dois")
    if args.projeto and not SLUG.match(args.projeto):
        ap.error("slug de projeto inválido")
    if args.area and normalizar(args.area).split("/")[0] not in PASTAS:
        ap.error(f"área inválida: {args.area}")

    vault = None
    if args.modo in ("previa", "simulacao", "confirmar", "auditar"):
        vault = exigir_vault(args.vault)
        conferir_estado_fora_vault(vault, [("pendentes", args.pendentes), ("fila", args.fila),
                                           ("ledger", args.ledger), ("log", args.log),
                                           ("aprovados", args.aprovados)])

    pendentes = pathlib.Path(args.pendentes)
    if args.modo == "auditar":
        print(auditoria(vault, DIAS_AUDITORIA))
    elif args.modo == "listar":
        print(cmd_listar(pendentes))
    elif args.modo == "rejeitar":
        cmd_rejeitar(args, pendentes, args.ledger)
    elif args.modo == "confirmar":
        cmd_confirmar(args, vault, pendentes, args.ledger, args.log, args.aprovados, args.fila)
    elif args.modo == "simulacao":
        cmd_previa(args, vault, pendentes, args.ledger, gravar=False)
    else:
        cmd_previa(args, vault, pendentes, args.ledger, gravar=True)


if __name__ == "__main__":
    main()
