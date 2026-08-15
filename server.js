// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO
// Versão consolidada — apenas mudanças confirmadas
// ============================================
const { 
  makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  downloadMediaMessage,
  proto
} = require('@whiskeysockets/baileys');
const express = require('express');
const P = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const sessions = new Map();
const jidMap = new Map();

// ============================================
// CAPTURA ERROS — evita crash do processo
// ============================================
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

const logger = P({ 
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  }
});

// ============================================
// JID HELPERS — igual à versão original que
// identificava números corretamente
// ============================================
function saveJidFromMessage(msgKey) {
  if (!msgKey) return;
  const remoteJid    = msgKey.remoteJid || '';
  const remoteJidAlt = msgKey.remoteJidAlt || '';

  // Ignora grupos, newsletters, broadcasts e status
  if (remoteJid.endsWith('@g.us')) return;
  if (remoteJid.endsWith('@newsletter')) return;
  if (remoteJid.endsWith('@broadcast')) return;
  if (remoteJid === 'status@broadcast') return;

  // Se veio com @lid, temos o JID novo e o número alternativo
  if (remoteJid.endsWith('@lid') && remoteJidAlt) {
    // Extrai o número limpo do Alt (número de telefone real)
    const phone = remoteJidAlt.replace(/\D/g, '').split('@')[0].split(':')[0];
    // Salva: número limpo → jid @lid (é o que o WhatsApp espera agora)
    jidMap.set(phone, remoteJid);
    logger.info(`[JID] Mapeado ${phone} → ${remoteJid} (LID)`);
  } else if (remoteJid.endsWith('@s.whatsapp.net')) {
    // Sistema antigo: salva o número → jid normal
    const phone = remoteJid.replace(/\D/g, '').split('@')[0].split(':')[0];
    // Só salva se ainda não temos mapeamento LID para esse número
    if (!jidMap.has(phone)) {
      jidMap.set(phone, remoteJid);
    }
  }
}

function resolveJid(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '').split('@')[0].split(':')[0];
  if (jidMap.has(cleaned)) {
    const resolved = jidMap.get(cleaned);
    logger.info(`[JID] Resolvido ${cleaned} → ${resolved}`);
    return resolved;
  }
  if (phone.includes('@g.us')) return `${cleaned}@g.us`;
  return `${cleaned}@s.whatsapp.net`;
}

// Registra par lid<->phone vindo de qualquer fonte (contatos, histórico)
function registerLidPhonePair(lidLike, phoneLike, origin) {
  try {
    if (!lidLike || !phoneLike) return;
    const lid = String(lidLike).replace('@lid', '').replace(/\D/g, '');
    const phone = String(phoneLike).replace('@s.whatsapp.net', '').replace(/\D/g, '');
    if (!lid || !phone) return;
    const jid = `${phone}@s.whatsapp.net`;
    const already = jidMap.get(lid);
    jidMap.set(lid, jid);
    jidMap.set(phone, jid);
    if (already !== jid) {
      logger.info(`[MAP:${origin}] lid=${lid} → ${jid}`);
    }
  } catch (e) {
    logger.warn(`registerLidPhonePair erro: ${e.message}`);
  }
}


// ============================================
// AUTH
// ============================================
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    logger.warn(`[AUTH] Tentativa de acesso não autorizado`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
app.use(authenticate);

// ============================================
// WEBHOOK
// ============================================
async function sendWebhook(payload, retries = 3) {
  if (!WEBHOOK_URL) return;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        logger.info(`[WEBHOOK] Enviado com sucesso: ${payload.event}`);
        return;
      }
      logger.warn(`[WEBHOOK] Falha (${response.status}), tentativa ${i + 1}/${retries}`);
    } catch (e) {
      logger.error(`[WEBHOOK] Erro na tentativa ${i + 1}/${retries}:`, e.message);
      if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  logger.error(`[WEBHOOK] Falhou após ${retries} tentativas`);
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const sessionData = {
    sock: null,
    qrCodeData: null,
    qrExpiry: null,
    connectionStatus: 'disconnected',
    authState: null,
    phoneNumber: null,
    reconnectAttempts: 0,
    keepAliveInterval: null,
  };
  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  sessions.set(sessionId, sessionData);
  logger.info(`[${sessionId}] Nova sessão criada`);
  return sessionData;
}

async function cleanupSession(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;
  logger.info(`[${sessionId}] Iniciando cleanup...`);

  if (sessionData.keepAliveInterval) {
    clearInterval(sessionData.keepAliveInterval);
    sessionData.keepAliveInterval = null;
  }

  if (sessionData.sock) {
    try {
      if (sessionData.sock.user) await sessionData.sock.logout();
    } catch (e) {
      logger.warn(`[${sessionId}] Erro logout: ${e.message}`);
    }
    sessionData.sock = null;
  }
  sessionData.qrCodeData = null;
  sessionData.qrExpiry = null;
  sessionData.connectionStatus = 'disconnected';
  sessionData.phoneNumber = null;
  sessionData.reconnectAttempts = 0;
  logger.info(`[${sessionId}] Cleanup concluído`);
}

// ============================================
// CRIAR CONEXÃO WHATSAPP
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  if (sessionData.sock) {
    const isConnected = sessionData.sock.user && sessionData.connectionStatus === 'connected';
    if (isConnected) {
      logger.info(`[${sessionId}] ✅ Socket já conectado: ${sessionData.phoneNumber}`);
      return sessionData;
    }
    await cleanupSession(sessionId);
  }

  sessionData.reconnectAttempts = 0;
  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sessionData.authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  logger.info(`[${sessionId}] Criando socket WhatsApp (versão ${version.join('.')})`);
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR !== false,
    logger: P({ level: 'silent' }),
    // Identifica como WhatsApp Web oficial — evita "Aguardando mensagem"
    browser: ['WhatsApp Web', 'Chrome', '2.2412.54'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
      return { conversation: '' };
    },
  });

  sessionData.sock = sock;

  // ============================================
  // CONNECTION UPDATE
  // ============================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrExpiry = Date.now() + 60000;
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] 📱 QR Code disponível`);
    }

    if (connection === 'open') {
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.reconnectAttempts = 0;
      logger.info(`[${sessionId}] ✅ CONECTADO: ${sessionData.phoneNumber}`);

      // Keep-alive — evita "Aguardando mensagem" por inatividade
      if (sessionData.keepAliveInterval) {
        clearInterval(sessionData.keepAliveInterval);
      }
      sessionData.keepAliveInterval = setInterval(async () => {
        try {
          if (sessionData.connectionStatus === 'connected' && sessionData.sock) {
            await sock.sendPresenceUpdate('available');
            logger.info(`[${sessionId}] 💓 Keep-alive OK`);
          }
        } catch (e) {
          logger.warn(`[${sessionId}] 💔 Keep-alive falhou: ${e.message}`);
        }
      }, 3 * 60 * 1000);

      await sendWebhook({
        event: 'status-updated', sessionId,
        status: 'connected', connected: true,
        phone: { number: sessionData.phoneNumber }
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn(`[${sessionId}] ❌ Conexão fechada (código: ${statusCode})`);

      if (sessionData.keepAliveInterval) {
        clearInterval(sessionData.keepAliveInterval);
        sessionData.keepAliveInterval = null;
      }

      sessionData.connectionStatus = 'disconnected';
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.phoneNumber = null;

      await sendWebhook({
        event: 'status-updated', sessionId,
        status: 'disconnected', connected: false
      });

      if (shouldReconnect && sessionData.reconnectAttempts < 3) {
        sessionData.reconnectAttempts++;
        const delay = 5000 * sessionData.reconnectAttempts;
        logger.info(`[${sessionId}] Reconectando ${sessionData.reconnectAttempts}/3 em ${delay}ms`);
        setTimeout(() => createWhatsAppConnection(sessionId, options), delay);
      } else if (sessionData.reconnectAttempts >= 3) {
        logger.error(`[${sessionId}] Limite de reconexões atingido`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // Fontes ADITIVAS de mapeamento lid<->phone
  // (não bloqueiam nada, só alimentam o cache)
  // ============================================
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.id.endsWith('@s.whatsapp.net') && contact.lid) {
        registerLidPhonePair(contact.lid, contact.id, 'contacts.upsert');
      }
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (update.lid && update.id) {
        registerLidPhonePair(update.lid, update.id, 'contacts.update');
      }
    }
  });

  sock.ev.on('messaging-history.set', ({ contacts }) => {
    if (!Array.isArray(contacts)) return;
    let count = 0;
    for (const contact of contacts) {
      if (contact?.id && contact?.lid) {
        registerLidPhonePair(contact.lid, contact.id, 'history.set');
        count++;
      }
    }
    if (count > 0) {
      logger.info(`[${sessionId}] [HISTORY] ${count} contatos com lid mapeados, cache total: ${jidMap.size}`);
    }
  });

  // ============================================
  // MESSAGES UPSERT
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid || '';

      // Ignora grupos, newsletters, broadcasts e status
      if (
        remoteJid.endsWith('@g.us') ||
        remoteJid.endsWith('@newsletter') ||
        remoteJid.endsWith('@broadcast') ||
        remoteJid === 'status@broadcast'
      ) {
        continue;
      }

      const isFromMe = msg.key.fromMe === true;

      // Salva o mapeamento JID (resolve LID + contato fantasma)
      // Só para mensagens recebidas — igual à versão original
      if (!isFromMe) {
        saveJidFromMessage(msg.key);
      }

      const messageType = Object.keys(msg.message)[0];
      let content = '';
      if (messageType === 'conversation') {
        content = msg.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        content = msg.message.extendedTextMessage?.text || '';
      }

      logger.info(`[${sessionId}] ${isFromMe ? '📤' : '💬'} ${remoteJid}: ${content}`);

      // Download de áudio
      let audioBase64 = null;
      let audioMimetype = null;
      if (msg.message.audioMessage) {
        try {
          const buffer = await downloadMediaMessage(
            msg, 'buffer', {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );
          audioBase64 = buffer.toString('base64');
          audioMimetype = msg.message.audioMessage.mimetype || 'audio/ogg; codecs=opus';
        } catch (e) {
          logger.error(`[${sessionId}] ❌ Erro ao baixar áudio: ${e.message}`);
        }
      }

      // Payload IDÊNTICO ao original — msg.key puro, sem modificação
      await sendWebhook({
        event: 'received-message',
        sessionId,
        instanceId: sessionId,
        data: {
          key: msg.key,
          message: msg.message,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName,
          fromMe: isFromMe,
          audioBase64,
          audioMimetype,
        }
      });
    }
  });

  return sessionData;
}

// ============================================
// ENDPOINTS
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), sessions: sessions.size, knownContacts: jidMap.size });
});

app.post('/create-session', async (req, res) => {
  try {
    const { sessionId, printQR } = req.body;
    const sid = sessionId || 'default';
    const sessionData = await createWhatsAppConnection(sid, { printQR });
    await new Promise(r => setTimeout(r, 3000));
    if (sessionData.connectionStatus === 'connected') {
      return res.json({ success: true, status: 'connected', phone: sessionData.phoneNumber });
    }
    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ success: true, qrcode: qrBase64, status: sessionData.connectionStatus, expiresIn: 60 });
    }
    return res.json({ success: true, status: sessionData.connectionStatus });
  } catch (error) {
    logger.error(`Erro /create-session: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const sessionData = sessions.get(sessionId);
    if (!sessionData) return res.json({ status: 'disconnected' });
    if (sessionData.qrCodeData && sessionData.qrExpiry && Date.now() > sessionData.qrExpiry) {
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
    }
    if (sessionData.connectionStatus === 'connected') {
      return res.json({ status: 'connected', phone: sessionData.phoneNumber });
    }
    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ qrcode: qrBase64, status: sessionData.connectionStatus, expiresIn: Math.max(0, Math.floor((sessionData.qrExpiry - Date.now()) / 1000)) });
    }
    return res.json({ status: sessionData.connectionStatus });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    await cleanupSession(req.body.sessionId || 'default');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/logout', async (req, res) => {
  try {
    await cleanupSession(req.body.sessionId || 'default');
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/session/:sessionId?', async (req, res) => {
  try {
    const sessionId = req.params.sessionId || 'default';
    await cleanupSession(sessionId);
    const authDir = path.join(__dirname, 'auth_info', sessionId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    sessions.delete(sessionId);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios' });
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const sock = sessionData.sock;
    const jid = resolveJid(phone);
    logger.info(`[${sid}] 📤 Enviando para jid=${jid} (phone=${phone})`);
    const result = await sock.sendMessage(jid, { text: message });
    logger.info(`[${sid}] ✅ Enviado para ${jid} (id: ${result?.key?.id})`);
    res.json({ success: true, jid, messageId: result?.key?.id });
  } catch (error) {
    logger.error(`Erro /send-message: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-buttons', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, title, buttons } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'phone, text e buttons são obrigatórios' });
    }
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const jid = resolveJid(phone);
    const nativeButtons = buttons.map(btn => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id })
    }));
    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: nativeButtons })
      })
    };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    logger.info(`[${sid}] 🔘 Botões enviados para ${jid}`);
    res.json({ success: true, jid, type: 'buttons' });
  } catch (error) {
    logger.error(`Erro /send-buttons: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-list', async (req, res) => {
  try {
    const { sessionId, phone, text, title, buttonText, footer, sections } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !sections || !Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: 'phone, text e sections são obrigatórios' });
    }
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const jid = resolveJid(phone);
    const listParams = {
      title: buttonText || 'Ver opções',
      sections: sections.map(section => ({
        title: section.title || '',
        rows: section.rows.map(row => ({ header: '', title: row.title, description: row.description || '', id: row.id }))
      }))
    };
    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify(listParams) }]
        })
      })
    };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    logger.info(`[${sid}] 📋 Menu enviado para ${jid}`);
    res.json({ success: true, jid, type: 'list' });
  } catch (error) {
    logger.error(`Erro /send-list: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-link-button', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, title, buttons } = req.body;
    const sid = sessionId || 'default';
    if (!phone || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'phone, text e buttons são obrigatórios' });
    }
    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const jid = resolveJid(phone);
    const nativeButtons = buttons.map(btn => {
      if (btn.url) return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.text, url: btn.url, merchant_url: btn.url }) };
      if (btn.phoneNumber) return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.text, phone_number: btn.phoneNumber }) };
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.text, id: btn.id || btn.text }) };
    });
    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({ title: title || '', subtitle: '', hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({ buttons: nativeButtons })
      })
    };
    const msg = generateWAMessageFromContent(jid, { viewOnceMessage: { message: interactiveMsg } }, {});
    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    logger.info(`[${sid}] 🔗 Link button enviado para ${jid}`);
    res.json({ success: true, jid, type: 'link_button' });
  } catch (error) {
    logger.error(`Erro /send-link-button: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// RESOLVE LID — versão simples, só cache
// GET ou POST, sempre responde algo previsível
// ============================================
async function handleResolveLid(req, res) {
  try {
    const params = req.method === 'POST' ? req.body : req.query;
    const sessionId = params.sessionId || 'default';
    const lidRaw = params.lid;
    if (!lidRaw) return res.status(400).json({ error: 'lid é obrigatório' });

    const lid = String(lidRaw).replace('@lid', '').replace(/\D/g, '');

    // 1. Cache
    const cached = jidMap.get(lid);
    if (cached) {
      const phone = cached.split('@')[0];
      return res.json({ phone, jid: cached, source: 'cache' });
    }

    // 2. Consulta ATIVA ao WhatsApp via onWhatsApp — só quando o cache falha
    const sessionData = sessions.get(sessionId);
    if (sessionData?.sock && sessionData.connectionStatus === 'connected') {
      try {
        const results = await sessionData.sock.onWhatsApp(`${lid}@lid`);
        const first = results?.[0];
        if (first?.jid && first.jid.endsWith('@s.whatsapp.net')) {
          const phone = first.jid.split('@')[0];
          registerLidPhonePair(lid, first.jid, 'onWhatsApp-active');
          return res.json({ phone, jid: first.jid, source: 'active_query' });
        }
      } catch (e) {
        logger.warn(`[${sessionId}] [RESOLVE-LID] onWhatsApp ativo falhou: ${e.message}`);
      }
    }

    return res.json({ phone: null, jid: null, source: 'not_found' });
  } catch (error) {
    logger.error(`Erro /resolve-lid: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}
app.get('/resolve-lid', handleResolveLid);
app.post('/resolve-lid', handleResolveLid);

app.get('/status', (req, res) => {
  const allSessions = {};
  sessions.forEach((data, sid) => {
    allSessions[sid] = { status: data.connectionStatus, phone: data.phoneNumber, hasQR: !!data.qrCodeData, reconnectAttempts: data.reconnectAttempts };
  });
  res.json({ success: true, uptime: process.uptime(), totalSessions: sessions.size, knownContacts: jidMap.size, sessions: allSessions });
});

app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys rodando na porta ${PORT}`);
  logger.info(`🔐 API Key: ${API_KEY ? '✅' : '❌'}`);
  logger.info(`🪝 Webhook: ${WEBHOOK_URL || 'Não configurado'}`);
});

process.on('SIGINT', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
process.on('SIGTERM', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
