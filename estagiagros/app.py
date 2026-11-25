#!/usr/bin/env python3
"""Estagiagros: back-end (API REST + arquivos estáticos).
Usa apenas a biblioteca padrão do Python 3.9+ (nada para instalar).

    python app.py --seed         # cria dados de demonstração e inicia o servidor
    python app.py --porta 8000   # inicia o servidor em http://127.0.0.1:8000
"""
import argparse, hashlib, hmac, json, mimetypes, os, re, secrets, sqlite3, sys, time, traceback, unicodedata
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).parent.resolve()
DB = Path(os.environ.get("ESTAGIAGROS_DB", BASE / "estagiagros.db"))
STATIC = BASE / "static"
AREAS = ["Agronomia", "Zootecnia", "Engenharia Florestal", "Medicina Veterinária",
         "Engenharia de Pesca", "Ciências do Solo", "Engenharia Agrícola"]
MODALIDADES = ("Presencial", "Híbrido", "Remoto")
STATUS = ("enviada", "em análise", "aprovada", "recusada")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS usuarios(
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK(tipo IN ('estudante','empresa')),   -- pessoa física | pessoa jurídica
  nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE, senha_hash TEXT NOT NULL,
  curso TEXT, instituicao TEXT, resumo TEXT,                   -- estudante
  cnpj TEXT, cidade TEXT,                                      -- empresa
  criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessoes(
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vagas(
  id INTEGER PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL, area TEXT NOT NULL, cidade TEXT NOT NULL, uf TEXT NOT NULL,
  modalidade TEXT NOT NULL, bolsa INTEGER NOT NULL DEFAULT 0, carga_horaria INTEGER NOT NULL DEFAULT 0,
  descricao TEXT NOT NULL, requisitos TEXT NOT NULL DEFAULT '', beneficios TEXT NOT NULL DEFAULT '',
  ativa INTEGER NOT NULL DEFAULT 1, criada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS candidaturas(
  id INTEGER PRIMARY KEY,
  vaga_id INTEGER NOT NULL REFERENCES vagas(id) ON DELETE CASCADE,
  estudante_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'enviada', criada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(vaga_id, estudante_id));
CREATE TABLE IF NOT EXISTS salvas(
  vaga_id INTEGER NOT NULL REFERENCES vagas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  PRIMARY KEY(vaga_id, usuario_id));
CREATE INDEX IF NOT EXISTS idx_vagas_filtro ON vagas(ativa, area, uf);
CREATE INDEX IF NOT EXISTS idx_vagas_empresa ON vagas(empresa_id);
"""


# ---------- banco, senhas e sessões ----------
@contextmanager
def conectar():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def hash_senha(senha, sal=None):
    sal = sal or secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", senha.encode(), sal, 600_000)
    return sal.hex() + "$" + h.hex()


def confere(senha, guardado):
    try:
        sal, h = guardado.split("$")
        novo = hashlib.pbkdf2_hmac("sha256", senha.encode(), bytes.fromhex(sal), 600_000)
        return hmac.compare_digest(novo.hex(), h)
    except Exception:
        return False


FALSO = hash_senha("senha-falsa")  # iguala o tempo de resposta quando o e-mail não existe
FALHAS = {}                        # (ip, e-mail) -> instantes das tentativas erradas


def nova_sessao(db, uid):
    token = secrets.token_urlsafe(32)
    db.execute("DELETE FROM sessoes WHERE expira_em <= datetime('now')")
    db.execute("INSERT INTO sessoes VALUES(?,?,datetime('now','+7 days'))",
               (hashlib.sha256(token.encode()).hexdigest(), uid))
    return token


def um(db, sql, *args):
    return db.execute(sql, args).fetchone()[0]


# ---------- validação ----------
class Erro(Exception):
    def __init__(self, codigo, msg):
        self.codigo, self.msg = codigo, msg


def texto(d, campo, minimo=1, maximo=200, obrigatorio=True):
    v = d.get(campo)
    if v is None or (isinstance(v, str) and not v.strip()):
        if obrigatorio:
            raise Erro(400, f"Preencha o campo: {campo}")
        return ""
    if not isinstance(v, str):
        raise Erro(400, f"Valor inválido em: {campo}")
    v = v.strip()
    if not minimo <= len(v) <= maximo:
        raise Erro(400, f"O campo {campo} deve ter de {minimo} a {maximo} caracteres")
    return v


def inteiro(d, campo, minimo, maximo):
    try:
        v = int(d.get(campo, 0) or 0)
    except (TypeError, ValueError):
        raise Erro(400, f"Valor inválido em: {campo}")
    if not minimo <= v <= maximo:
        raise Erro(400, f"O campo {campo} deve estar entre {minimo} e {maximo}")
    return v


def ler_vaga(d):
    modalidade = d.get("modalidade")
    if modalidade not in MODALIDADES:
        raise Erro(400, "Modalidade deve ser: " + ", ".join(MODALIDADES))
    area = d.get("area")
    if area not in AREAS:
        raise Erro(400, "Área inválida")
    uf = texto(d, "uf", 2, 2).upper()
    if not uf.isalpha():
        raise Erro(400, "UF inválida")
    return dict(titulo=texto(d, "titulo", 5, 120), area=area, cidade=texto(d, "cidade", 2, 80), uf=uf,
                modalidade=modalidade, bolsa=inteiro(d, "bolsa", 0, 50000),
                carga_horaria=inteiro(d, "carga_horaria", 0, 44), descricao=texto(d, "descricao", 10, 2000),
                requisitos=texto(d, "requisitos", 0, 2000, False), beneficios=texto(d, "beneficios", 0, 2000, False))


def publico(u):
    return {k: u[k] for k in ("id", "tipo", "nome", "email", "curso", "instituicao", "resumo", "cnpj", "cidade")}


def exigir(c, tipo=None):
    if not c.usuario:
        raise Erro(401, "Entre na sua conta para continuar")
    if tipo and c.usuario["tipo"] != tipo:
        raise Erro(403, f"Esta ação é exclusiva de contas de {tipo}")


# ---------- rotas ----------
ROTAS = []


def rota(metodo, padrao):
    rx = re.compile("^" + re.sub(r"<(\w+)>", r"(?P<\1>\\d+)", padrao) + "$")

    def deco(f):
        ROTAS.append((metodo, rx, f))
        return f
    return deco


class Ctx:
    def __init__(self, db, usuario, corpo, query, ip, token_hash):
        self.db, self.usuario, self.corpo, self.query, self.ip, self.token_hash = db, usuario, corpo, query, ip, token_hash


@rota("POST", "/api/registrar")
def registrar(c):
    d = c.corpo
    tipo = d.get("tipo")
    if tipo not in ("estudante", "empresa"):
        raise Erro(400, "Escolha o tipo de conta: estudante ou empresa")
    nome = texto(d, "nome", 2, 120)
    email = texto(d, "email", 5, 160).lower()
    if not EMAIL.match(email):
        raise Erro(400, "E-mail inválido")
    senha = d.get("senha")
    if not isinstance(senha, str) or not 8 <= len(senha) <= 128:
        raise Erro(400, "A senha deve ter de 8 a 128 caracteres")
    curso = instituicao = cnpj = None
    if tipo == "estudante":
        curso = texto(d, "curso", 2, 80)
        instituicao = texto(d, "instituicao", 2, 120, False) or None
    else:
        cnpj = re.sub(r"\D", "", str(d.get("cnpj") or "")) or None
        if cnpj and len(cnpj) != 14:
            raise Erro(400, "O CNPJ deve ter 14 dígitos")
    try:
        cur = c.db.execute("INSERT INTO usuarios(tipo,nome,email,senha_hash,curso,instituicao,cnpj) VALUES(?,?,?,?,?,?,?)",
                           (tipo, nome, email, hash_senha(senha), curso, instituicao, cnpj))
    except sqlite3.IntegrityError:
        raise Erro(409, "Este e-mail já está cadastrado")
    return 201, {"token": nova_sessao(c.db, cur.lastrowid)}


@rota("POST", "/api/login")
def login(c):
    email = str(c.corpo.get("email") or "").strip().lower()
    senha = c.corpo.get("senha")
    chave = (c.ip, email)
    recentes = [t for t in FALHAS.get(chave, []) if time.time() - t < 600]
    FALHAS[chave] = recentes
    if len(recentes) >= 5:
        raise Erro(429, "Muitas tentativas. Tente de novo em alguns minutos")
    u = c.db.execute("SELECT * FROM usuarios WHERE email=?", (email,)).fetchone()
    if not (isinstance(senha, str) and confere(senha, u["senha_hash"] if u else FALSO) and u):
        FALHAS[chave].append(time.time())
        raise Erro(401, "E-mail ou senha incorretos")
    FALHAS.pop(chave, None)
    return {"token": nova_sessao(c.db, u["id"])}


@rota("POST", "/api/logout")
def logout(c):
    if c.token_hash:
        c.db.execute("DELETE FROM sessoes WHERE token_hash=?", (c.token_hash,))
    return {"ok": True}


@rota("GET", "/api/eu")
def eu(c):
    exigir(c)
    u = c.usuario
    if u["tipo"] == "estudante":
        n = um(c.db, "SELECT COUNT(*) FROM candidaturas WHERE estudante_id=?", u["id"])
    else:
        n = um(c.db, "SELECT COUNT(*) FROM candidaturas k JOIN vagas v ON v.id=k.vaga_id WHERE v.empresa_id=?", u["id"])
    return {**publico(u), "candidaturas": n, "salvas": um(c.db, "SELECT COUNT(*) FROM salvas WHERE usuario_id=?", u["id"])}


@rota("PUT", "/api/perfil")
def perfil(c):
    exigir(c)
    d, u = c.corpo, c.usuario
    campos = {"nome": (2, 120, True), "curso": (0, 80, False), "instituicao": (0, 120, False),
              "resumo": (0, 1500, False), "cidade": (0, 80, False)}
    if u["tipo"] == "empresa":
        campos.pop("curso"), campos.pop("instituicao"), campos.pop("resumo")
    else:
        campos.pop("cidade")
    novos = {k: texto(d, k, a, b, ob) or None for k, (a, b, ob) in campos.items() if k in d}
    if novos:
        c.db.execute("UPDATE usuarios SET " + ",".join(f"{k}=?" for k in novos) + " WHERE id=?", (*novos.values(), u["id"]))
    return {"ok": True}


@rota("GET", "/api/filtros")
def filtros(c):
    ufs = [r[0] for r in c.db.execute("SELECT DISTINCT uf FROM vagas WHERE ativa=1 ORDER BY uf")]
    emp = c.db.execute("SELECT u.nome, COUNT(*) AS vagas FROM vagas v JOIN usuarios u ON u.id=v.empresa_id "
                       "WHERE v.ativa=1 GROUP BY u.id ORDER BY vagas DESC, u.nome LIMIT 5").fetchall()
    return {"areas": AREAS, "ufs": ufs, "empresas": [dict(r) for r in emp]}


SEL = """SELECT v.*, u.nome AS empresa,
  CAST(julianday('now')-julianday(v.criada_em) AS INTEGER) AS dias,
  EXISTS(SELECT 1 FROM salvas s WHERE s.vaga_id=v.id AND s.usuario_id=:uid) AS salva,
  EXISTS(SELECT 1 FROM candidaturas k WHERE k.vaga_id=v.id AND k.estudante_id=:uid) AS candidatou
  FROM vagas v JOIN usuarios u ON u.id=v.empresa_id"""


def vaga_json(r):
    d = dict(r)
    d["salva"], d["candidatou"], d["ativa"] = bool(d["salva"]), bool(d["candidatou"]), bool(d["ativa"])
    return d


@rota("GET", "/api/vagas")
def listar_vagas(c):
    q = {k: v[0] for k, v in c.query.items()}
    p = {"uid": c.usuario["id"] if c.usuario else None}
    onde = ["v.ativa=1"]
    if q.get("q"):
        p["q"] = "%" + q["q"][:100].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        onde.append("(v.titulo LIKE :q ESCAPE '\\' OR u.nome LIKE :q ESCAPE '\\' OR v.cidade LIKE :q ESCAPE '\\' OR v.area LIKE :q ESCAPE '\\')")
    for campo, col in (("area", "v.area"), ("modalidade", "v.modalidade"), ("uf", "v.uf")):
        if q.get(campo):
            onde.append(f"{col}=:{campo}")
            p[campo] = q[campo]
    try:
        if q.get("bolsa_min"):
            onde.append("v.bolsa>=:bolsa_min")
            p["bolsa_min"] = int(q["bolsa_min"])
        if q.get("carga_max"):
            onde.append("v.carga_horaria<=:carga_max")
            p["carga_max"] = int(q["carga_max"])
    except ValueError:
        raise Erro(400, "Filtro numérico inválido")
    if q.get("salvas") == "1":
        exigir(c)
        onde.append("EXISTS(SELECT 1 FROM salvas s WHERE s.vaga_id=v.id AND s.usuario_id=:uid)")
    ordem = "v.bolsa DESC, v.criada_em DESC" if q.get("ordem") == "bolsa" else "v.criada_em DESC, v.id DESC"
    linhas = c.db.execute(f"{SEL} WHERE {' AND '.join(onde)} ORDER BY {ordem} LIMIT 200", p).fetchall()
    return [vaga_json(r) for r in linhas]


@rota("GET", "/api/vagas/<id>")
def ver_vaga(c, id):
    uid = c.usuario["id"] if c.usuario else None
    r = c.db.execute(f"{SEL} WHERE v.id=:id AND (v.ativa=1 OR v.empresa_id=:uid)", {"id": id, "uid": uid}).fetchone()
    if not r:
        raise Erro(404, "Vaga não encontrada")
    return vaga_json(r)


@rota("POST", "/api/vagas")
def criar_vaga(c):
    exigir(c, "empresa")
    cur = c.db.execute("INSERT INTO vagas(empresa_id,titulo,area,cidade,uf,modalidade,bolsa,carga_horaria,descricao,requisitos,beneficios) "
                       "VALUES(:e,:titulo,:area,:cidade,:uf,:modalidade,:bolsa,:carga_horaria,:descricao,:requisitos,:beneficios)",
                       {**ler_vaga(c.corpo), "e": c.usuario["id"]})
    return 201, {"id": cur.lastrowid}


def vaga_da_empresa(c, id):
    exigir(c, "empresa")
    r = c.db.execute("SELECT * FROM vagas WHERE id=? AND empresa_id=?", (id, c.usuario["id"])).fetchone()
    if not r:
        raise Erro(404, "Vaga não encontrada")
    return r


@rota("PUT", "/api/vagas/<id>")
def editar_vaga(c, id):
    atual = vaga_da_empresa(c, id)
    ativa = atual["ativa"] if "ativa" not in c.corpo else int(bool(c.corpo["ativa"]))
    c.db.execute("UPDATE vagas SET titulo=:titulo,area=:area,cidade=:cidade,uf=:uf,modalidade=:modalidade,bolsa=:bolsa,"
                 "carga_horaria=:carga_horaria,descricao=:descricao,requisitos=:requisitos,beneficios=:beneficios,ativa=:ativa WHERE id=:id",
                 {**ler_vaga(c.corpo), "ativa": ativa, "id": id})
    return {"ok": True}


@rota("DELETE", "/api/vagas/<id>")
def encerrar_vaga(c, id):
    vaga_da_empresa(c, id)
    c.db.execute("UPDATE vagas SET ativa=0 WHERE id=?", (id,))
    return {"ok": True}


def vaga_aberta(c, id):
    if not c.db.execute("SELECT 1 FROM vagas WHERE id=? AND ativa=1", (id,)).fetchone():
        raise Erro(404, "Vaga não encontrada ou encerrada")


@rota("POST", "/api/vagas/<id>/candidatar")
def candidatar(c, id):
    exigir(c, "estudante")
    vaga_aberta(c, id)
    c.db.execute("INSERT OR IGNORE INTO candidaturas(vaga_id,estudante_id) VALUES(?,?)", (id, c.usuario["id"]))
    return 201, {"ok": True}


@rota("DELETE", "/api/vagas/<id>/candidatar")
def retirar(c, id):
    exigir(c, "estudante")
    c.db.execute("DELETE FROM candidaturas WHERE vaga_id=? AND estudante_id=?", (id, c.usuario["id"]))
    return {"ok": True}


@rota("POST", "/api/vagas/<id>/salvar")
def salvar(c, id):
    exigir(c)
    vaga_aberta(c, id)
    c.db.execute("INSERT OR IGNORE INTO salvas VALUES(?,?)", (id, c.usuario["id"]))
    return 201, {"ok": True}


@rota("DELETE", "/api/vagas/<id>/salvar")
def remover_salva(c, id):
    exigir(c)
    c.db.execute("DELETE FROM salvas WHERE vaga_id=? AND usuario_id=?", (id, c.usuario["id"]))
    return {"ok": True}


@rota("GET", "/api/minhas/candidaturas")
def minhas_candidaturas(c):
    exigir(c, "estudante")
    r = c.db.execute("SELECT k.id, k.status, v.id AS vaga_id, v.titulo, v.ativa, u.nome AS empresa, "
                     "CAST(julianday('now')-julianday(k.criada_em) AS INTEGER) AS dias "
                     "FROM candidaturas k JOIN vagas v ON v.id=k.vaga_id JOIN usuarios u ON u.id=v.empresa_id "
                     "WHERE k.estudante_id=? ORDER BY k.criada_em DESC", (c.usuario["id"],)).fetchall()
    return [dict(x) for x in r]


@rota("GET", "/api/empresa/vagas")
def vagas_da_empresa(c):
    exigir(c, "empresa")
    r = c.db.execute("SELECT v.id, v.titulo, v.area, v.cidade, v.uf, v.ativa, "
                     "(SELECT COUNT(*) FROM candidaturas k WHERE k.vaga_id=v.id) AS candidatos "
                     "FROM vagas v WHERE v.empresa_id=? ORDER BY v.criada_em DESC", (c.usuario["id"],)).fetchall()
    return [dict(x, ativa=bool(x["ativa"])) for x in r]


@rota("GET", "/api/empresa/vagas/<id>/candidatos")
def candidatos(c, id):
    vaga_da_empresa(c, id)
    r = c.db.execute("SELECT k.id, k.status, u.nome, u.email, u.curso, u.instituicao, u.resumo "
                     "FROM candidaturas k JOIN usuarios u ON u.id=k.estudante_id WHERE k.vaga_id=? ORDER BY k.criada_em", (id,)).fetchall()
    return [dict(x) for x in r]


@rota("PATCH", "/api/candidaturas/<id>")
def mudar_status(c, id):
    exigir(c, "empresa")
    status = c.corpo.get("status")
    if status not in STATUS:
        raise Erro(400, "Status deve ser: " + ", ".join(STATUS))
    cur = c.db.execute("UPDATE candidaturas SET status=? WHERE id=? AND vaga_id IN (SELECT id FROM vagas WHERE empresa_id=?)",
                       (status, id, c.usuario["id"]))
    if not cur.rowcount:
        raise Erro(404, "Candidatura não encontrada")
    return {"ok": True}


# ---------- servidor HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "Estagiagros/1.0"

    def enviar(self, codigo, dado=None, bruto=None, tipo="application/json; charset=utf-8"):
        corpo = bruto if bruto is not None else json.dumps(dado, ensure_ascii=False).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                         "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
        if bruto is None:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corpo)

    def estatico(self, caminho):
        arq = (STATIC / ("index.html" if caminho in ("", "/") else caminho.lstrip("/"))).resolve()
        if not arq.is_file() or STATIC.resolve() not in arq.parents:
            return self.enviar(404, {"erro": "Página não encontrada"})
        tipo = mimetypes.guess_type(arq.name)[0] or "application/octet-stream"
        self.enviar(200, bruto=arq.read_bytes(), tipo=tipo + ("; charset=utf-8" if tipo.startswith("text/") else ""))

    def tratar(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return self.estatico(url.path) if self.command == "GET" else self.enviar(405, {"erro": "Método não permitido"})
        try:
            achou = False
            for metodo, rx, f in ROTAS:
                m = rx.match(url.path)
                if not m:
                    continue
                achou = True
                if metodo != self.command:
                    continue
                n = int(self.headers.get("Content-Length") or 0)
                if n > 65536:
                    raise Erro(413, "Requisição grande demais")
                corpo = {}
                if n:
                    corpo = json.loads(self.rfile.read(n))
                    if not isinstance(corpo, dict):
                        raise Erro(400, "O corpo deve ser um objeto JSON")
                with conectar() as db:
                    usuario = th = None
                    auth = self.headers.get("Authorization") or ""
                    if auth.startswith("Bearer "):
                        th = hashlib.sha256(auth[7:].encode()).hexdigest()
                        r = db.execute("SELECT u.* FROM sessoes s JOIN usuarios u ON u.id=s.usuario_id "
                                       "WHERE s.token_hash=? AND s.expira_em > datetime('now')", (th,)).fetchone()
                        usuario = dict(r) if r else None
                    ctx = Ctx(db, usuario, corpo, parse_qs(url.query), self.client_address[0], th)
                    res = f(ctx, **{k: int(v) for k, v in m.groupdict().items()})
                codigo, dado = res if isinstance(res, tuple) else (200, res)
                return self.enviar(codigo, dado)
            raise Erro(405 if achou else 404, "Método não permitido" if achou else "Rota não encontrada")
        except Erro as e:
            self.enviar(e.codigo, {"erro": e.msg})
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.enviar(400, {"erro": "JSON inválido"})
        except Exception:
            traceback.print_exc()
            self.enviar(500, {"erro": "Erro interno do servidor"})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = tratar

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))


# ---------- dados de demonstração ----------
SEED = [
    ("Fazenda Boa Safra", "Estagiário(a) em manejo de culturas anuais", "Agronomia", "Sorriso", "MT", "Presencial", 1800, 30, 1,
     "Acompanhe o monitoramento de pragas, a regulagem de plantadeiras e a coleta de dados de produtividade em soja e milho."),
    ("Cooperativa Vale Verde", "Estagiário(a) em nutrição de ruminantes", "Zootecnia", "Passo Fundo", "RS", "Presencial", 1500, 25, 2,
     "Apoie a formulação de dietas, o controle de ganho de peso e os relatórios técnicos para produtores associados."),
    ("Agro Genética Brasil", "Estágio em melhoramento genético vegetal", "Agronomia", "Uberlândia", "MG", "Híbrido", 2000, 30, 3,
     "Participe de ensaios de campo, análise de dados fenotípicos e rotinas de laboratório de genotipagem."),
    ("Instituto Campo Vivo", "Estagiário(a) em restauração florestal", "Engenharia Florestal", "Campinas", "SP", "Híbrido", 1600, 20, 4,
     "Atue no planejamento de plantios, georreferenciamento de áreas e monitoramento de mudas nativas."),
    ("Clínica VetRural", "Estágio em clínica de grandes animais", "Medicina Veterinária", "Goiânia", "GO", "Presencial", 1400, 30, 5,
     "Acompanhe atendimentos a campo, manejo reprodutivo e protocolos sanitários em fazendas da região."),
    ("LabSolo Agroanálises", "Estagiário(a) em análise de solos e adubação", "Ciências do Solo", "Piracicaba", "SP", "Presencial", 1700, 30, 6,
     "Realize coletas, preparo de amostras e interpretação de laudos para recomendação de calagem e adubação."),
    ("Piscicultura Rio Claro", "Estágio em aquicultura de água doce", "Engenharia de Pesca", "Palmas", "TO", "Presencial", 1500, 30, 8,
     "Apoie o manejo de tanques-rede, a qualidade da água e o controle de conversão alimentar."),
    ("AgroDados Consultoria", "Estagiário(a) em agricultura de precisão", "Agronomia", "Cascavel", "PR", "Remoto", 1900, 20, 9,
     "Processe mapas de produtividade e imagens de drones, gerando recomendações de taxa variável."),
]
REQ = "Estar cursando graduação em ciências agrárias\nDisponibilidade para a carga horária da vaga\nInteresse por atividades práticas e trabalho em equipe"
BEN = "Seguro contra acidentes pessoais\nTermo de compromisso com a instituição de ensino\nAcompanhamento de um profissional da equipe"


def semear(db):
    if um(db, "SELECT COUNT(*) FROM usuarios"):
        return print("O banco já tem dados; seed ignorado.")
    senha = hash_senha("demo12345")
    db.execute("INSERT INTO usuarios(tipo,nome,email,senha_hash,curso,instituicao) VALUES('estudante','Ana Lima','aluna@exemplo.example',?,"
               "'Agronomia','Universidade Federal Rural')", (senha,))
    contas = ["aluna@exemplo.example"]
    for nome, titulo, area, cidade, uf, modal, bolsa, carga, dias, desc in SEED:
        slug = re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode().lower())
        email = f"contato@{slug}.example"
        eid = db.execute("INSERT INTO usuarios(tipo,nome,email,senha_hash,cidade) VALUES('empresa',?,?,?,?)", (nome, email, senha, cidade)).lastrowid
        db.execute("INSERT INTO vagas(empresa_id,titulo,area,cidade,uf,modalidade,bolsa,carga_horaria,descricao,requisitos,beneficios,criada_em) "
                   "VALUES(?,?,?,?,?,?,?,?,?,?,?,datetime('now',?))", (eid, titulo, area, cidade, uf, modal, bolsa, carga, desc, REQ, BEN, f"-{dias} days"))
        contas.append(email)
    print("Contas de demonstração (senha: demo12345):\n  " + "\n  ".join(contas))


def main():
    ap = argparse.ArgumentParser(description="Servidor do Estagiagros")
    ap.add_argument("--seed", action="store_true", help="insere dados de demonstração se o banco estiver vazio")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--porta", type=int, default=8000)
    a = ap.parse_args()
    with conectar() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
        if a.seed:
            semear(db)
    print(f"Estagiagros no ar: http://{a.host}:{a.porta}  (Ctrl+C para parar)")
    try:
        ThreadingHTTPServer((a.host, a.porta), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")


if __name__ == "__main__":
    main()
