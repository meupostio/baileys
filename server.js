/**
 * Baileys multi-sessão — Render (v1.1)
 *
 * O que esta versão faz:
 *  1. Credenciais e chaves Signal persistidas. Dois modos:
 *       - Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY): tabela
 *         public.whatsapp_session_keys. Pode ser um projeto Supabase próprio e
 *         gratuito, só para este servidor.
 *       - Disco (AUTH_DIR): use com um Persistent Disk do Render montado nesse
 *         caminho. Sem Supabase o servidor cai neste modo sozinho e avisa no log —
 *         NUNCA derruba no boot por falta de env.
 *  2. Mensagens enviadas ficam em cache em memória E persistidas (banco ou disco).
 *     É isso que responde ao pedido de reenvio do aparelho do contato e destrava
 *     o "Aguardando mensagem" — inclusive depois de um restart do Render.
 *  3. Uma sessão por sessionId (mutex), reconexão com espera crescente e
 *     tratamento correto de cada motivo de desconexão (515, 440, 401, 403, 500).
 *  4. Falha de decriptação (CIPHERTEXT / Bad MAC) tratada por conversa.
 *  5. Encerramento limpo no SIGTERM (redeploy do Render) para não gerar
 *     "connection replaced" entre a instância velha e a nova.
 *
 * Dependências: express, pino, qrcode, @supabase/supabase-js, @whiskeysockets/baileys
 * Env: PORT, API_KEY, WEBHOOK_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AUTH_DIR (fallback)
 */
const express = require("express");
const P = require("pino");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  WAMessageStubType,
  Browsers,
  BufferJSON,
  proto,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth";

const KEYS_TABLE = "whatsapp_session_keys";
const MSG_TABLE = "whatsapp_message_cache";
const MSG_CACHE_TTL_DAYS = 7;

const logger = P({ level: process.env.LOG_LEVEL || "info" });

/* ------------------------------ supabase (opcional) ------------------------------ */

let db = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  logger.info("[auth] sessões persistidas no Supabase");
} else {
  logger.warn(
    "[auth] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes — sessões e cache de mensagens em disco (%s). " +
      "No Render isto só funciona bem com um Persistent Disk montado em AUTH_DIR; sem disco a sessão se perde a cada restart.",
    AUTH_DIR,
  );
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/health") return next();
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const onlyDigits = (v) => String(v || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/* ---------------------- auth state persistido no banco ---------------------- */

const encode = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));
const decode = (value) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

async function dbReadMany(sessionId, keys) {
  const out = {};
  if (!db || !keys.length) return out;
  const { data, error } = await db
    .from(KEYS_TABLE)
    .select("key,value")
    .eq("session_id", sessionId)
    .in("key", keys);
  if (error) {
    logger.warn({ sessionId, error: error.message }, "[auth] read failed");
    return out;
  }
  for (const row of data || []) {
    try { out[row.key] = decode(row.value); } catch (e) {
      logger.warn({ sessionId, key: row.key, e: e.message }, "[auth] decode failed");
    }
  }
  return out;
}

async function dbRead(sessionId, key) {
  const r = await dbReadMany(sessionId, [key]);
  return r[key] ?? null;
}

async function dbWriteMany(sessionId, rows) {
  if (!db || !rows.length) return;
  const { error } = await db.from(KEYS_TABLE).upsert(rows, { onConflict: "session_id,key" });
  if (error) logger.warn({ sessionId, error: error.message }, "[auth] write failed");
}

async function dbDeleteMany(sessionId, keys) {
  if (!db || !keys.length) return;
  const { error } = await db.from(KEYS_TABLE).delete().eq("session_id", sessionId).in("key", keys);
  if (error) logger.warn({ sessionId, error: error.message }, "[auth] delete failed");
}

async function useSupabaseAuthState(sessionId) {
  const creds = (await dbRead(sessionId, "creds")) || initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const wanted = ids.map((id) => `${type}-${id}`);
      const rows = await dbReadMany(sessionId, wanted);
      const out = {};
      for (const id of ids) {
        let value = rows[`${type}-${id}`];
        if (!value) continue;
        if (type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value);
        out[id] = value;
      }
      return out;
    },
    set: async (data) => {
      const upserts = [];
      const deletes = [];
      const now = nowIso();
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type] || {})) {
          const value = data[type][id];
          const key = `${type}-${id}`;
          if (value) upserts.push({ session_id: sessionId, key, value: encode(value), updated_at: now });
          else deletes.push(key);
        }
      }
      await Promise.all([dbWriteMany(sessionId, upserts), dbDeleteMany(sessionId, deletes)]);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await dbWriteMany(sessionId, [
        { session_id: sessionId, key: "creds", value: encode(creds), updated_at: nowIso() },
      ]);
    },
    // Apaga só a sessão Signal de um contato (chaves "session-<user>.<device>")
    clearSessionFor: async (jid) => {
      const user = String(jid || "").split("@")[0].split(":")[0];
      if (!user) return;
      const { data } = await db
        .from(KEYS_TABLE)
        .select("key")
        .eq("session_id", sessionId)
        .like("key", `session-${user}.%`);
      await dbDeleteMany(sessionId, (data || []).map((r) => r.key));
    },
    wipe: async () => {
      await db.from(KEYS_TABLE).delete().eq("session_id", sessionId);
      await db.from(MSG_TABLE).delete().eq("session_id", sessionId);
    },
  };
}

async function useDiskAuthState(sessionId) {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(AUTH_DIR, String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_"));
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  return {
    state,
    saveCreds,
    clearSessionFor: async (jid) => {
      const user = String(jid || "").split("@")[0].split(":")[0];
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`session-${user}.`)) fs.rmSync(path.join(dir, f), { force: true });
      }
    },
    wipe: async () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const useAuthState = (sessionId) => (db ? useSupabaseAuthState(sessionId) : useDiskAuthState(sessionId));

/* --------------------------- cache de mensagens enviadas --------------------------- */
/* Necessário para responder ao "retry receipt" do aparelho do contato.          */
/* Memória (rápido) + banco (sobrevive a restart).                                */

// Fallback em disco (quando não há Supabase): um arquivo JSON por mensagem.
const fsp = require("fs/promises");
const pathMod = require("path");
const msgDiskDir = (sessionId) =>
  pathMod.join(AUTH_DIR, String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_"), "messages");
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "_");

async function persistSentMessage(sessionId, key, message) {
  if (!key?.id || !message) return;
  if (!db) {
    try {
      const dir = msgDiskDir(sessionId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(pathMod.join(dir, `${safeId(key.id)}.json`), JSON.stringify(encode(message)));
    } catch (e) { logger.warn({ sessionId, e: e.message }, "[msgcache] disk write failed"); }
    return;
  }
  const { error } = await db.from(MSG_TABLE).upsert(
    {
      session_id: sessionId,
      message_id: key.id,
      remote_jid: key.remoteJid || null,
      message: encode(message),
      created_at: nowIso(),
    },
    { onConflict: "session_id,message_id" },
  );
  if (error) logger.warn({ sessionId, error: error.message }, "[msgcache] write failed");
}

async function loadSentMessage(sessionId, id) {
  if (!id) return undefined;
  if (!db) {
    try {
      const raw = await fsp.readFile(pathMod.join(msgDiskDir(sessionId), `${safeId(id)}.json`), "utf8");
      return proto.Message.fromObject(decode(JSON.parse(raw)));
    } catch { return undefined; }
  }
  const { data, error } = await db
    .from(MSG_TABLE)
    .select("message")
    .eq("session_id", sessionId)
    .eq("message_id", id)
    .maybeSingle();
  if (error || !data) return undefined;
  try { return proto.Message.fromObject(decode(data.message)); } catch { return undefined; }
}

async function pruneMessageCache() {
  const cutoffMs = Date.now() - MSG_CACHE_TTL_DAYS * 86400000;
  if (!db) {
    for (const sid of await fsp.readdir(AUTH_DIR).catch(() => [])) {
      const dir = pathMod.join(AUTH_DIR, sid, "messages");
      for (const f of await fsp.readdir(dir).catch(() => [])) {
        const p = pathMod.join(dir, f);
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoffMs) await fsp.rm(p, { force: true }).catch(() => {});
      }
    }
    return;
  }
  const cutoff = new Date(cutoffMs).toISOString();
  const { error } = await db.from(MSG_TABLE).delete().lt("created_at", cutoff);
  if (error) logger.warn({ error: error.message }, "[msgcache] prune failed");
}

/* --------------------------------- estado --------------------------------- */

/** sessionId -> { sock, status, qr, phone, lidMap, msgCache, badMac, auth, attempts, stopped, reconnectTimer } */
const sessions = new Map();
const startLocks = new Map();
let shuttingDown = false;

function getSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sock: null,
      status: "idle",
      qr: null,
      phone: null,
      lidMap: new Map(),
      msgCache: new Map(),
      badMac: new Map(),
      auth: null,
      attempts: 0,
      stopped: false,
      reconnectTimer: null,
      lastDisconnectCode: null,
    };
    sessions.set(sessionId, s);
  }
  return s;
}

function cacheMessage(s, key, message) {
  if (!key?.id || !message) return;
  s.msgCache.set(key.id, message);
  if (s.msgCache.size > 2000) {
    const first = s.msgCache.keys().next().value;
    s.msgCache.delete(first);
  }
}

/* ------------------------------- lid mapping ------------------------------- */

function learnLid(sessionId, lidRaw, phoneRaw) {
  const lid = onlyDigits(lidRaw);
  const phone = onlyDigits(phoneRaw);
  if (!lid || !phone || lid === phone) return;
  if (phone.length < 10 || phone.length > 14) return;
  const s = sessions.get(sessionId);
  if (!s || s.lidMap.get(lid) === phone) return;
  s.lidMap.set(lid, phone);
  postWebhook({ event: "lid-map", sessionId, entries: [{ lid, phone }] });
}

async function resolveLid(sessionId, lidRaw) {
  const lid = onlyDigits(lidRaw);
  const s = sessions.get(sessionId);
  if (!lid || !s) return null;

  const cached = s.lidMap.get(lid);
  if (cached) return cached;

  // Baileys 7.x expõe o mapeamento LID -> PN; no 6.7.x isto simplesmente não existe.
  try {
    const mapping = s.sock?.signalRepository?.lidMapping;
    if (mapping?.getPNForLID) {
      const digits = onlyDigits(await mapping.getPNForLID(`${lid}@lid`));
      if (digits) { learnLid(sessionId, lid, digits); return digits; }
    }
  } catch (e) { logger.warn({ e: e.message }, "[lid] getPNForLID failed"); }

  try {
    for (const [jid, c] of Object.entries(s.sock?.store?.contacts || {})) {
      if (onlyDigits(jid) === lid || onlyDigits(c?.lid) === lid) {
        const digits = onlyDigits(c?.id || c?.jid || jid);
        if (digits && digits.length <= 14) { learnLid(sessionId, lid, digits); return digits; }
      }
    }
  } catch {}
  return null;
}

/* --------------------------------- webhook --------------------------------- */

async function postWebhook(body) {
  if (!WEBHOOK_URL) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (e) { logger.warn({ e: e.message, event: body?.event }, "[webhook] failed"); }
}

/* --------------------------------- sessão ---------------------------------- */

function closeSocket(s) {
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  const sock = s.sock;
  s.sock = null;
  if (!sock) return;
  try { sock.ev?.removeAllListeners?.("connection.update"); } catch {}
  try { sock.ev?.removeAllListeners?.("messages.upsert"); } catch {}
  try { sock.ev?.removeAllListeners?.("creds.update"); } catch {}
  try { sock.ws?.close?.(); } catch {}
  try { sock.end?.(new Error("replaced")); } catch {}
}

function scheduleReconnect(sessionId, s, delayMs) {
  if (s.stopped || shuttingDown) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    startSession(sessionId).catch((e) => logger.warn({ sessionId, e: e.message }, "[reconnect] failed"));
  }, delayMs);
}

async function getWaVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch (e) {
    logger.warn({ e: e.message }, "[version] fetchLatestBaileysVersion falhou, usando padrão");
    return undefined; // Baileys usa a versão embutida
  }
}

async function startSession(sessionId) {
  // mutex: nunca dois sockets para o mesmo sessionId
  if (startLocks.has(sessionId)) return startLocks.get(sessionId);
  const p = (async () => {
    const s = getSession(sessionId);
    s.stopped = false;
    if (s.sock && (s.status === "connected" || s.status === "connecting" || s.status === "qr")) return s;

    closeSocket(s);

    const auth = await useAuthState(sessionId);
    s.auth = auth;
    const version = await getWaVersion();

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, P({ level: "silent" })),
      },
      logger: P({ level: "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      // Responde aos pedidos de reenvio do aparelho do contato ("retry receipt").
      // Sem isto o contato fica em "Aguardando mensagem".
      getMessage: async (key) => {
        const mem = s.msgCache.get(key?.id);
        if (mem) return mem;
        return loadSentMessage(sessionId, key?.id);
      },
    });

    s.sock = sock;
    s.status = "connecting";
    s.qr = null;

    sock.ev.on("creds.update", auth.saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (s.sock !== sock) return; // evento de um socket antigo

      if (qr) {
        s.qr = await QRCode.toDataURL(qr);
        s.status = "qr";
        postWebhook({ event: "status-updated", sessionId, status: "qr_ready", qrcode: s.qr });
      }

      if (connection === "open") {
        s.status = "connected";
        s.qr = null;
        s.attempts = 0;
        s.badMac.clear();
        s.phone = onlyDigits(sock.user?.id);
        if (sock.user?.lid) learnLid(sessionId, sock.user.lid, s.phone);
        logger.info({ sessionId, phone: s.phone }, "[session] conectada");
        postWebhook({ event: "status-updated", sessionId, status: "connected", phone: s.phone });
        const entries = [...s.lidMap].map(([lid, phone]) => ({ lid, phone }));
        if (entries.length) postWebhook({ event: "lid-map", sessionId, entries });
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "";
        s.lastDisconnectCode = code || null;
        closeSocket(s);
        logger.warn({ sessionId, code, reason }, "[session] conexão fechada");

        // 401: o usuário desconectou o aparelho no WhatsApp -> limpa tudo, precisa de novo QR
        if (code === DisconnectReason.loggedOut) {
          s.status = "logged_out";
          postWebhook({ event: "status-updated", sessionId, status: "logged_out" });
          try { await auth.wipe(); } catch {}
          return;
        }
        // 403: número bloqueado/banido pelo WhatsApp -> não adianta reconectar
        if (code === DisconnectReason.forbidden) {
          s.status = "forbidden";
          postWebhook({ event: "status-updated", sessionId, status: "forbidden" });
          postWebhook({ event: "session-error", sessionId, reason: "forbidden", error: reason });
          return;
        }
        // 440: outra instância abriu a mesma sessão (ex.: deploy antigo ainda no ar)
        if (code === DisconnectReason.connectionReplaced) {
          s.status = "replaced";
          postWebhook({ event: "status-updated", sessionId, status: "replaced" });
          logger.warn({ sessionId }, "[session] substituída por outra instância; tentando de novo em 30s");
          scheduleReconnect(sessionId, s, 30000);
          return;
        }
        // 500: credenciais corrompidas -> limpa e pede QR de novo
        if (code === DisconnectReason.badSession) {
          s.status = "bad_session";
          postWebhook({ event: "status-updated", sessionId, status: "bad_session" });
          try { await auth.wipe(); } catch {}
          scheduleReconnect(sessionId, s, 1000);
          return;
        }
        // 515: normal logo após parear o QR -> reconecta imediatamente
        if (code === DisconnectReason.restartRequired) {
          s.status = "restarting";
          scheduleReconnect(sessionId, s, 500);
          return;
        }

        s.status = "disconnected";
        postWebhook({ event: "status-updated", sessionId, status: "disconnected", code: code || null });
        if (s.stopped || shuttingDown) return;
        s.attempts = Math.min((s.attempts || 0) + 1, 6);
        const wait = Math.min(3000 * 2 ** (s.attempts - 1), 60000);
        scheduleReconnect(sessionId, s, wait);
      }
    });

    const learnFromContacts = (list) => {
      for (const c of list || []) if (c?.lid && c?.id) learnLid(sessionId, c.lid, c.id);
    };
    sock.ev.on("contacts.upsert", learnFromContacts);
    sock.ev.on("contacts.set", (d) => learnFromContacts(d?.contacts));
    sock.ev.on("lid-mapping.update", (m) => {
      for (const [lid, pn] of Object.entries(m || {})) learnLid(sessionId, lid, pn);
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (s.sock !== sock) return;
      if (type !== "notify") return;
      for (const msg of messages) {
        const key = msg.key || {};
        const remoteJid = key.remoteJid || "";
        if (remoteJid === "status@broadcast") continue;

        // Só mensagens com conteúdo. Stubs (entrou no grupo, etc.) não vão ao CRM.
        const isCiphertext = msg.messageStubType === WAMessageStubType.CIPHERTEXT;
        if (isCiphertext && remoteJid) {
          await handleDecryptFailure(sessionId, key.participant || remoteJid);
          continue;
        }
        if (!msg.message) continue;

        cacheMessage(s, key, msg.message);
        if (key.fromMe) persistSentMessage(sessionId, key, msg.message);

        if (remoteJid.endsWith("@g.us")) continue;

        const lidCand = [remoteJid, key.participant, key.senderLid]
          .find((j) => String(j || "").endsWith("@lid"));
        const pnCand = [key.senderPn, key.remoteJidAlt, key.participantPn]
          .find((j) => String(j || "").endsWith("@s.whatsapp.net"));
        if (lidCand && pnCand) learnLid(sessionId, lidCand, pnCand);

        let phone = onlyDigits(pnCand || (remoteJid.endsWith("@lid") ? "" : remoteJid));
        if (!phone && lidCand) phone = (await resolveLid(sessionId, lidCand)) || "";

        postWebhook({
          event: key.fromMe ? "message-sent" : "message-received",
          sessionId,
          messageId: key.id,
          data: {
            key,
            message: msg.message,
            pushName: msg.pushName,
            fromMe: !!key.fromMe,
            messageTimestamp: msg.messageTimestamp,
            senderPn: key.senderPn || null,
            remoteJidAlt: key.remoteJidAlt || null,
            participantPn: key.participantPn || null,
            lid: lidCand ? onlyDigits(lidCand) : null,
            phone: phone || null,
          },
        });
      }
    });

    return s;
  })();

  startLocks.set(sessionId, p);
  try {
    return await p;
  } finally {
    startLocks.delete(sessionId);
  }
}

/**
 * Bad MAC / sessão Signal fora de sincronia com um contato específico:
 * o Baileys já pede o reenvio sozinho; se falhar 3 vezes seguidas, apaga só a
 * sessão daquele contato — ela é refeita na próxima mensagem — sem derrubar a conexão.
 */
async function handleDecryptFailure(sessionId, jid) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const count = (s.badMac.get(jid) || 0) + 1;
  s.badMac.set(jid, count);
  logger.warn({ sessionId, jid, count }, "[signal] mensagem não decriptada (ciphertext)");
  if (count < 3) return;
  s.badMac.set(jid, 0);
  try {
    await s.auth?.clearSessionFor?.(jid);
    logger.warn({ sessionId, jid }, "[signal] sessão do contato reiniciada após falhas de decriptação");
    postWebhook({ event: "session-error", sessionId, reason: "bad_mac", jid, error: "Bad MAC" });
  } catch (e) {
    logger.warn({ e: e.message }, "[signal] clearSessionFor failed");
  }
}

/* ------------------------------ erros globais ------------------------------ */

process.on("unhandledRejection", (e) => logger.warn({ e: String(e?.message || e) }, "unhandledRejection"));
process.on("uncaughtException", (e) => logger.error({ e: String(e?.message || e), stack: e?.stack }, "uncaughtException"));

/* --------------------------------- rotas ---------------------------------- */

app.get("/", (_req, res) => res.json({ ok: true }));

app.get("/health", (_req, res) => {
  let known = 0;
  const list = {};
  for (const [id, s] of sessions) {
    known += s.lidMap?.size || 0;
    list[id] = { status: s.status, phone: s.phone || null, attempts: s.attempts, lastCode: s.lastDisconnectCode };
  }
  res.json({
    status: "ok",
    uptime: process.uptime(),
    storage: db ? "supabase" : "disk",
    sessions: sessions.size,
    knownContacts: known,
    detail: list,
  });
});

app.post("/create-session", async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    const s = await startSession(sessionId);
    // dá até ~3s para o QR (ou a reconexão) aparecer antes de responder
    for (let i = 0; i < 15 && s.status === "connecting"; i++) await sleep(200);
    res.json({ sessionId, status: s.status, qrcode: s.qr || null, phone: s.phone || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/qrcode", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  let s = sessions.get(sessionId);
  // Depois de um restart do Render a sessão existe no banco: religa sozinha.
  if (!s) {
    const creds = db ? await dbRead(sessionId, "creds") : null;
    if (!creds) return res.status(404).json({ error: "session not found" });
    s = await startSession(sessionId);
  }
  res.json({ sessionId, status: s.status, qrcode: s.qr || null, phone: s.phone || null });
});

app.get("/status", (req, res) => {
  const s = sessions.get(req.query.sessionId);
  if (!s) return res.status(404).json({ error: "session not found" });
  res.json({ sessionId: req.query.sessionId, status: s.status, phone: s.phone || null, connected: s.status === "connected" });
});

app.post("/logout", async (req, res) => {
  const sessionId = req.body?.sessionId;
  const s = sessions.get(sessionId);
  if (s) s.stopped = true;
  try { await s?.sock?.logout(); } catch {}
  if (s) { closeSocket(s); s.status = "logged_out"; }
  try { await s?.auth?.wipe?.(); } catch {}
  res.json({ success: true });
});

app.delete("/session/:id", async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions.get(sessionId);
  if (s) s.stopped = true;
  try { await s?.sock?.logout(); } catch {}
  if (s) closeSocket(s);
  sessions.delete(sessionId);
  try {
    if (s?.auth?.wipe) await s.auth.wipe();
    else if (db) {
      await db.from(KEYS_TABLE).delete().eq("session_id", sessionId);
      await db.from(MSG_TABLE).delete().eq("session_id", sessionId);
    }
  } catch {}
  res.json({ success: true, deleted: true, exists: false });
});

app.post("/send-message", async (req, res) => {
  const { sessionId, phone, jid, message } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s?.sock || s.status !== "connected") {
    return res.status(409).json({ error: "session not connected", status: s?.status || "unknown" });
  }
  let target = String(jid || phone || "");
  if (!target.includes("@")) target = `${onlyDigits(target)}@s.whatsapp.net`;
  if (!onlyDigits(target)) return res.status(400).json({ error: "phone/jid required" });
  const text = String(message ?? "");
  if (!text.trim()) return res.status(400).json({ error: "message required" });

  try {
    const sent = await s.sock.sendMessage(target, { text });
    if (sent?.key && sent?.message) {
      cacheMessage(s, sent.key, sent.message);
      await persistSentMessage(sessionId, sent.key, sent.message);
    }
    res.json({ success: true, messageId: sent?.key?.id || null, to: target });
  } catch (e) {
    logger.warn({ sessionId, target, e: e.message }, "[send] failed");
    res.status(500).json({ error: e.message });
  }
});

app.get("/lid-map", (req, res) => {
  const s = sessions.get(req.query.sessionId);
  if (!s) return res.json({ entries: [] });
  res.json({ entries: [...s.lidMap].map(([lid, phone]) => ({ lid, phone })) });
});

app.get("/resolve-lid", async (req, res) => {
  const phone = await resolveLid(req.query.sessionId, req.query.lid);
  res.json({ phone, jid: phone ? `${phone}@s.whatsapp.net` : null, source: phone ? "resolved" : "not_found" });
});

app.post("/resolve-lid", async (req, res) => {
  const { sessionId, lid, lids } = req.body || {};
  if (Array.isArray(lids)) {
    const entries = [];
    for (const l of lids) {
      const phone = await resolveLid(sessionId, l);
      if (phone) entries.push({ lid: onlyDigits(l), phone });
    }
    return res.json({ entries });
  }
  const phone = await resolveLid(sessionId, lid);
  res.json({ phone, jid: phone ? `${phone}@s.whatsapp.net` : null, source: phone ? "resolved" : "not_found" });
});

app.post("/on-whatsapp", async (req, res) => {
  const { sessionId, phone } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s?.sock) return res.json({ exists: false });
  try {
    const r = await s.sock.onWhatsApp(`${onlyDigits(phone)}@s.whatsapp.net`);
    res.json({ exists: !!r?.[0]?.exists, jid: r?.[0]?.jid || null, lid: r?.[0]?.lid || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* -------------------------- resume / shutdown --------------------------- */

/* Religa sozinho todas as sessões já pareadas após um restart do Render. */
async function resumeSessions() {
  if (!db) return;
  try {
    const { data, error } = await db.from(KEYS_TABLE).select("session_id").eq("key", "creds");
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      startSession(row.session_id).catch((e) =>
        logger.warn({ sessionId: row.session_id, e: e.message }, "[resume] failed"),
      );
      await sleep(1500);
    }
  } catch (e) {
    logger.warn({ e: e.message }, "[resume] failed — verifique se a tabela existe e as env do Supabase");
  }
}

/* Render manda SIGTERM no redeploy: fecha os sockets para a nova instância assumir limpa. */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "[shutdown] encerrando sessões");
  for (const s of sessions.values()) {
    s.stopped = true;
    closeSocket(s);
  }
  await sleep(500);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen(PORT, () => {
  logger.info(`server on :${PORT}`);
  resumeSessions();
  pruneMessageCache();
  setInterval(pruneMessageCache, 6 * 3600 * 1000).unref();
});
