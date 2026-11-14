"""Testes do curador com vaults fictícios e estado temporário.

Nenhum teste acessa o vault pessoal nem a configuração global do OpenCode.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest

sys.dont_write_bytecode = True

RAIZ = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = RAIZ / "scripts" / "cerebro_curador.py"
ID_LOTE = re.compile(r"lote-\d{8}-\d{6}-[0-9a-f]{6}")


def carregar_modulo(nome="cerebro_curador_teste"):
    spec = importlib.util.spec_from_file_location(nome, SCRIPT)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def sha(dados: bytes) -> str:
    return hashlib.sha256(dados).hexdigest()


def candidato(titulo, corpo="Decisão registrada.", pasta="conhecimento/wiki",
              tipo="decisao", confianca="alta", fonte="sessão 2026-11-14", **extra):
    dados = {"titulo": titulo, "pasta": pasta, "tipo": tipo, "confianca": confianca,
             "corpo": corpo, "fonte": fonte}
    dados.update(extra)
    return dados


def criar_vault(base: pathlib.Path):
    for pasta in ["inbox", "diario", "pessoas", "empresas", "clientes", "reunioes",
                  "deals", "financas", "projetos", "conteudo", "conhecimento/wiki",
                  "pessoal", "referencias", "arquivo"]:
        (base / pasta).mkdir(parents=True, exist_ok=True)
    (base / "AGENTS.md").write_text("# Vault de teste\n", encoding="utf-8")
    (base / "00 - Open Mind.md").write_text("# Mapa\n", encoding="utf-8")
    (base / "conhecimento" / "wiki" / "03 - Indice.md").write_bytes(b"# Indice\n")


def snapshot(base: pathlib.Path):
    return {str(p.relative_to(base)).replace("\\", "/"): sha(p.read_bytes())
            for p in sorted(base.rglob("*")) if p.is_file()}


class BaseCurador(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="curator-test-"))
        self.vault = self.tmp / "vault"
        criar_vault(self.vault)
        self.estado = self.tmp / "estado"
        self.estado.mkdir()
        self.env = dict(os.environ)
        self.env["LOCALAPPDATA"] = str(self.tmp / "local")
        self.env.pop("CEREBRO_VAULT", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @property
    def estado_args(self):
        return ["--pendentes", str(self.estado / "pendentes"),
                "--fila", str(self.estado / "fila.jsonl"),
                "--ledger", str(self.estado / "ledger.jsonl"),
                "--log", str(self.estado / "alteracoes.log"),
                "--aprovados", str(self.estado / "aprovados.jsonl")]

    def rodar(self, *args, cwd=None):
        return subprocess.run([sys.executable, str(SCRIPT), *self.estado_args, *args],
                              capture_output=True, text=True, encoding="utf-8",
                              env=self.env, cwd=cwd or str(RAIZ))

    def lote_json(self, candidatos, nome="lote-entrada.json"):
        caminho = self.tmp / nome
        caminho.write_text(json.dumps({"candidatos": candidatos}, ensure_ascii=False),
                           encoding="utf-8")
        return caminho

    def previa(self, candidatos, extra=()):
        resultado = self.rodar("--modo", "previa", "--vault", str(self.vault),
                               "--entrada", str(self.lote_json(candidatos)), *extra)
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        return resultado

    def confirmar(self, lote, itens):
        return self.rodar("--modo", "confirmar", "--vault", str(self.vault),
                          "--lote", lote, "--itens", itens)

    def lotes(self):
        pasta = self.estado / "pendentes"
        return sorted(pasta.glob("lote-*.json")) if pasta.is_dir() else []

    def ledger(self):
        caminho = self.estado / "ledger.jsonl"
        if not caminho.is_file():
            return []
        return [json.loads(l) for l in caminho.read_text(encoding="utf-8").splitlines() if l.strip()]

    def args_confirmar(self, lote, itens, projeto=None, escopo=None):
        return types.SimpleNamespace(lote=lote, itens=itens, projeto=projeto, escopo=escopo)


class FluxoBasico(BaseCurador):
    def test_01_previa_cria_arquivos_fora_do_vault(self):
        antes = snapshot(self.vault)
        resultado = self.previa([candidato("Decisão um")])
        self.assertIn("Prévia salva fora do vault", resultado.stdout)
        self.assertEqual(snapshot(self.vault), antes)
        self.assertEqual(len(self.lotes()), 1)
        dados = json.loads(self.lotes()[0].read_text(encoding="utf-8"))
        self.assertEqual(dados["hash_versao"], 2)
        self.assertEqual(len(dados["md_sha"]), 64)

    def test_02_simulacao_sem_escrita(self):
        antes = snapshot(self.vault)
        resultado = self.rodar("--modo", "simulacao", "--vault", str(self.vault),
                               "--entrada", str(self.lote_json([candidato("Decisão simulada")])))
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertIn("Decisão simulada", resultado.stdout)
        self.assertEqual(snapshot(self.vault), antes)
        self.assertEqual(self.lotes(), [])

    def test_03_confirmacao_valida(self):
        lote = ID_LOTE.search(self.previa([candidato("Decisão um")]).stdout).group()
        resultado = self.confirmar(lote, "1")
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        nota = self.vault / "conhecimento" / "wiki" / "Decisão um.md"
        self.assertTrue(nota.is_file())
        self.assertIn("Decisão registrada.", nota.read_text(encoding="utf-8"))
        self.assertIn("Origem: curador", nota.read_text(encoding="utf-8"))
        self.assertEqual(self.lotes(), [])
        self.assertEqual(self.ledger()[-1]["estado"], "confirmado")

    def test_04_rejeitar_lote(self):
        antes = snapshot(self.vault)
        lote = ID_LOTE.search(self.previa([candidato("Decisão um")]).stdout).group()
        resultado = self.rodar("--modo", "rejeitar", "--lote", lote, *self.estado_args)
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertEqual(self.lotes(), [])
        self.assertEqual(snapshot(self.vault), antes)
        self.assertEqual(self.ledger()[-1]["estado"], "rejeitado")

    def test_05_listar_lotes(self):
        lote = ID_LOTE.search(self.previa([candidato("Decisão um")]).stdout).group()
        resultado = self.rodar("--modo", "listar")
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertIn(lote, resultado.stdout)

    def test_06_expiracao_24h(self):
        antes = snapshot(self.vault)
        lote = ID_LOTE.search(self.previa([candidato("Decisão um")]).stdout).group()
        caminho = self.estado / "pendentes" / f"{lote}.json"
        dados = json.loads(caminho.read_text(encoding="utf-8"))
        dados["expira_em"] = "2020-01-01T00:00:00"
        caminho.write_text(json.dumps(dados, ensure_ascii=False), encoding="utf-8")
        resultado = self.confirmar(lote, "1")
        self.assertEqual(resultado.returncode, 2)
        self.assertIn("prévia não encontrada", resultado.stderr)
        self.assertEqual(snapshot(self.vault), antes)
        self.assertIn("expirado", [r["estado"] for r in self.ledger()])

    def test_07_limite_tres_notas(self):
        candidatos = [candidato(f"Decisão numero {n}") for n in range(1, 5)]
        resultado = self.previa(candidatos)
        self.assertIn("## Gravar (3)", resultado.stdout)
        self.assertIn("limite de 3 notas", resultado.stdout)

    def test_08_duplicata(self):
        nota = self.vault / "conhecimento" / "wiki" / "Decisão existente.md"
        nota.write_text("# Decisão existente\r\n\r\nConteúdo prévio.\r\n", encoding="utf-8")
        outra = self.vault / "pessoas" / "Decisão externa.md"
        outra.write_text("# Decisão externa\n\nFora da área.\n", encoding="utf-8")
        resultado = self.previa([candidato("Decisão existente"),
                                 candidato("Decisão externa")])
        self.assertIn("### 1. Decisão existente", resultado.stdout)
        self.assertIn("Ação: atualizar", resultado.stdout)
        self.assertIn("possível duplicata em pessoas", resultado.stdout)
        lote = ID_LOTE.search(resultado.stdout).group()
        self.assertEqual(self.confirmar(lote, "1").returncode, 0)
        self.assertIn("Conteúdo prévio.", nota.read_text(encoding="utf-8"))
        self.assertIn("Origem: curador", nota.read_text(encoding="utf-8"))

    def test_09_alteracao_concorrente_apos_previa(self):
        alvo = self.vault / "conhecimento" / "wiki" / "Decisão um.md"
        lote = ID_LOTE.search(self.previa([candidato("Decisão um")]).stdout).group()
        alvo.write_text("conteúdo criado por outra sessão\n", encoding="utf-8")
        resultado = self.confirmar(lote, "1")
        self.assertEqual(resultado.returncode, 2)
        self.assertIn("conflito", resultado.stderr)
        self.assertEqual(alvo.read_text(encoding="utf-8"), "conteúdo criado por outra sessão\n")
        self.assertEqual(self.lotes(), [])

    def test_15_arquivo_alterado_depois_da_confirmacao_inicial(self):
        nota = self.vault / "conhecimento" / "wiki" / "Decisão alvo.md"
        nota.write_bytes("# Decisão alvo\r\n\r\nVersao inicial.\r\n".encode("utf-8"))
        lote = ID_LOTE.search(self.previa([candidato("Decisão alvo", corpo="Nova linha.")]).stdout).group()
        original = nota.read_bytes()
        nota.write_bytes(original.replace(b"Versao inicial.", b"Versao alterada por fora."))
        resultado = self.confirmar(lote, "1")
        self.assertEqual(resultado.returncode, 2)
        self.assertIn("vault mudou desde a prévia", resultado.stderr)
        self.assertIn(b"Versao alterada por fora.", nota.read_bytes())

    def test_16_bloqueia_sensiveis_e_transcricao(self):
        antes = snapshot(self.vault)
        resultado = self.previa([
            candidato("Vazamento", corpo="Contato: alguem@exemplo.com"),
            candidato("Transcricao", corpo="User: isto e o chat colado"),
        ])
        self.assertIn("conteúdo sensível (e-mail)", resultado.stdout)
        self.assertIn("parece transcrição do chat", resultado.stdout)
        self.assertEqual(snapshot(self.vault), antes)

    def test_17_indice_atualizado(self):
        lote = ID_LOTE.search(self.previa([candidato("Decisão nova")]).stdout).group()
        self.assertEqual(self.confirmar(lote, "1").returncode, 0)
        indice = (self.vault / "conhecimento" / "wiki" / "03 - Indice.md").read_text(encoding="utf-8")
        self.assertIn("- [[Decisão nova]]", indice)

    def test_18_idempotencia_da_confirmacao(self):
        lote = ID_LOTE.search(self.previa([candidato("Decisão um")]).stdout).group()
        self.assertEqual(self.confirmar(lote, "1").returncode, 0)
        nota = self.vault / "conhecimento" / "wiki" / "Decisão um.md"
        primeira = sha(nota.read_bytes())
        repeticao = self.confirmar(lote, "1")
        self.assertEqual(repeticao.returncode, 2)
        self.assertIn("prévia não encontrada", repeticao.stderr)
        self.assertEqual(sha(nota.read_bytes()), primeira)
        self.assertEqual(nota.read_text(encoding="utf-8").count("Decisão registrada."), 1)


class AlteracoesDuranteGravacao(BaseCurador):
    def montar(self, mod, candidatos):
        resultado = self.previa(candidatos)
        lote = ID_LOTE.search(resultado.stdout).group()
        return lote, self.estado / "pendentes" / f"{lote}.json", self.estado / "pendentes" / f"{lote}.md"

    def test_10_alteracao_entre_duas_gravacoes(self):
        mod = carregar_modulo()
        lote, _, _ = self.montar(mod, [candidato("Decisão um"), candidato("Decisão dois")])
        original = mod.aplicar_item
        alvo_dois = self.vault / "conhecimento" / "wiki" / "Decisão dois.md"
        chamadas = {"n": 0}

        def aplicar_com_corrida(it, vault):
            resultado = original(it, vault)
            chamadas["n"] += 1
            if chamadas["n"] == 1:
                alvo_dois.write_text("escrita concorrente\n", encoding="utf-8")
            return resultado

        mod.aplicar_item = aplicar_com_corrida
        with self.assertRaises(SystemExit):
            mod.cmd_confirmar(self.args_confirmar(lote, "1,2"), self.vault,
                              self.estado / "pendentes", self.estado / "ledger.jsonl",
                              self.estado / "alteracoes.log", self.estado / "aprovados.jsonl",
                              self.estado / "fila.jsonl")
        self.assertEqual(alvo_dois.read_text(encoding="utf-8"), "escrita concorrente\n")
        self.assertEqual(len(self.lotes()), 1)
        self.assertIn("parcial", [r["estado"] for r in self.ledger()])
        dados = json.loads(self.lotes()[0].read_text(encoding="utf-8"))
        self.assertEqual(dados["feitos"], [1])

    def test_11_falha_parcial_e_retomada(self):
        mod = carregar_modulo()
        lote, _, _ = self.montar(mod, [candidato("Decisão um"), candidato("Decisão dois")])
        original = mod.aplicar_item

        def falhar_no_segundo(it, vault):
            if it["numero"] == 2:
                raise RuntimeError("falha simulada de disco")
            return original(it, vault)

        mod.aplicar_item = falhar_no_segundo
        with self.assertRaises(SystemExit):
            mod.cmd_confirmar(self.args_confirmar(lote, "1,2"), self.vault,
                              self.estado / "pendentes", self.estado / "ledger.jsonl",
                              self.estado / "alteracoes.log", self.estado / "aprovados.jsonl",
                              self.estado / "fila.jsonl")
        nota_um = self.vault / "conhecimento" / "wiki" / "Decisão um.md"
        self.assertTrue(nota_um.is_file())
        self.assertFalse((self.vault / "conhecimento" / "wiki" / "Decisão dois.md").exists())
        self.assertEqual(len(self.lotes()), 1)
        self.assertIn("parcial", [r["estado"] for r in self.ledger()])

        mod.aplicar_item = original
        mod.cmd_confirmar(self.args_confirmar(lote, "1,2"), self.vault,
                          self.estado / "pendentes", self.estado / "ledger.jsonl",
                          self.estado / "alteracoes.log", self.estado / "aprovados.jsonl",
                          self.estado / "fila.jsonl")
        self.assertEqual(nota_um.read_text(encoding="utf-8").count("Decisão registrada."), 1)
        self.assertTrue((self.vault / "conhecimento" / "wiki" / "Decisão dois.md").is_file())
        self.assertEqual(self.lotes(), [])


class FinsDeLinha(BaseCurador):
    def test_12_preserva_lf(self):
        indice = self.vault / "conhecimento" / "wiki" / "03 - Indice.md"
        indice.write_bytes(b"# Indice\n\n- [[Antiga]]\n")
        lote = ID_LOTE.search(self.previa([candidato("Decisão LF")]).stdout).group()
        self.assertEqual(self.confirmar(lote, "1").returncode, 0)
        for caminho in [indice, self.vault / "conhecimento" / "wiki" / "Decisão LF.md"]:
            dados = caminho.read_bytes()
            self.assertNotIn(b"\r\n", dados, caminho)
        self.assertIn("- [[Decisão LF]]\n".encode("utf-8"), indice.read_bytes())

    def test_13_preserva_crlf(self):
        indice = self.vault / "conhecimento" / "wiki" / "03 - Indice.md"
        indice.write_bytes(b"# Indice\r\n\r\n- [[Antiga]]\r\n")
        nota = self.vault / "conhecimento" / "wiki" / "Decisão CRLF.md"
        nota.write_bytes("# Decisão CRLF\r\n\r\nConteudo antigo.\r\n".encode("utf-8"))
        lote = ID_LOTE.search(self.previa([candidato("Decisão CRLF", corpo="Linha nova CRLF.")]).stdout).group()
        self.assertEqual(self.confirmar(lote, "1").returncode, 0)
        dados = nota.read_bytes()
        self.assertIn(b"Linha nova CRLF.", dados)
        self.assertEqual(dados.count(b"\n"), dados.count(b"\r\n"))
        dados_indice = indice.read_bytes()
        self.assertEqual(dados_indice.count(b"\n"), dados_indice.count(b"\r\n"))


class CaminhosEVault(BaseCurador):
    def test_14_caminho_invalido_ou_fora_do_vault(self):
        sem_vault = self.rodar("--modo", "previa", "--entrada", str(self.lote_json([candidato("X")])))
        self.assertEqual(sem_vault.returncode, 2)
        self.assertIn("--vault é obrigatório", sem_vault.stderr)

        relativo = self.rodar("--modo", "previa", "--vault", "vault", "--entrada",
                              str(self.lote_json([candidato("X")])))
        self.assertEqual(relativo.returncode, 2)
        self.assertIn("caminho absoluto", relativo.stderr)

        inexistente = self.rodar("--modo", "previa", "--vault", str(self.tmp / "nao-existe"),
                                 "--entrada", str(self.lote_json([candidato("X")])))
        self.assertEqual(inexistente.returncode, 2)
        self.assertIn("não aponta para um diretório existente", inexistente.stderr)

        dentro = self.rodar("--modo", "previa", "--vault", str(self.vault),
                            "--entrada", str(self.lote_json([candidato("X")])),
                            "--pendentes", str(self.vault / "conhecimento" / "pendentes"))
        self.assertEqual(dentro.returncode, 2)
        self.assertIn("não pode ficar dentro do vault", dentro.stderr)

        resultado = self.previa([candidato("Fuga", pasta="conhecimento/../../fora")])
        self.assertIn("caminho inválido", resultado.stdout)
        self.assertFalse((self.vault.parent / "fora").exists())

    def test_19_lote_com_hash_antigo_e_incompativel(self):
        antes = snapshot(self.vault)
        lote = ID_LOTE.search(self.previa([candidato("Decisão um")]).stdout).group()
        caminho = self.estado / "pendentes" / f"{lote}.json"
        dados = json.loads(caminho.read_text(encoding="utf-8"))
        dados.pop("hash_versao")
        dados["md_sha"] = dados["md_sha"][:16]
        caminho.write_text(json.dumps(dados, ensure_ascii=False), encoding="utf-8")
        resultado = self.confirmar(lote, "1")
        self.assertEqual(resultado.returncode, 2)
        self.assertIn("versão antiga de hash", resultado.stderr)
        self.assertEqual(snapshot(self.vault), antes)
        self.assertIn("lote-incompativel", [r["estado"] for r in self.ledger()])

    def test_20_vault_explicito_sem_constante(self):
        mod = carregar_modulo("cerebro_curador_sem_constante")
        self.assertFalse(hasattr(mod, "VAULT_PADRAO"))
        outro = self.tmp / "outro-cwd"
        outro.mkdir()
        resultado = self.rodar("--modo", "previa", "--vault", str(self.vault),
                               "--entrada", str(self.lote_json([candidato("Decisão cwd")])),
                               cwd=str(outro))
        self.assertEqual(resultado.returncode, 0, resultado.stderr)
        self.assertIn("Destino: conhecimento/wiki/Decisão cwd.md", resultado.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
