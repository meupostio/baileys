// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO
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
// JID HELPERS
// ============================================
function saveJidFromMessage(remoteJid, senderPn) {
  if (!remoteJid) return;
  if (remoteJid.endsWith('@g.us')) return;
  if (remoteJid === 'status@broadcast') return;
  if (remoteJid.endsWith('@newsletter')) return;
  if (remoteJid.endsWith('@broadcast')) return;
  if (remoteJid.endsWith('@lid') && senderPn) {
    const phone = senderPn.replace(/\D/g, '').split('@')[0].split(':')[0];
    const jidToUse = senderPn.includes('@') ? senderPn : `${phone}@s.whatsapp.net`;
    jidMap.set(phone, jidToUse);
    const lid = remoteJid.split('@')[0];
    jidMap.set(lid, jidToUse);
    logger.info(`[JID] Mapeado ${phone} → ${jidToUse} (via senderPn)`);
  } else if (remoteJid.endsWith('@s.whatsapp.net')) {
    const phone = remoteJid.replace(/\D/g, '').split('@')[0].split(':')[0];
    if (!jidMap.has(phone)) jidMap.set(phone, remoteJid);
  }
}

// ============================================
// Resolve @lid → número real consultando o WhatsApp
// Retorna null se não conseguir descobrir
// ============================================
async function resolveLidToPhone(sock, lidJid) {
  if (!lidJid || !lidJid.endsWith('@lid')) return null;
  const lid = lidJid.split('@')[0];

  // 1. Já está no cache?
  if (jidMap.has(lid)) {
    const cached = jidMap.get(lid);
    logger.info(`[LID] Cache hit: ${lid} → ${cached}`);
    return cached;
  }

  // 2. Tenta via store de contatos do socket
  try {
    if (sock.authState?.creds?.me?.lid) {
      // Não é o próprio usuário
    }
    // Busca nos contatos conhecidos do socket
    const contacts = sock.authState?.creds?.contacts || {};
    for (const [id, contact] of Object.entries(contacts)) {
      if (contact?.lid && contact.lid.includes(lid)) {
        const phone = id.split('@')[0];
        const jid = `${phone}@s.whatsapp.net`;
        jidMap.set(lid, jid);
        logger.info(`[LID] Resolvido via contacts: ${lid} → ${jid}`);
        return jid;
      }
    }
  } catch (e) {
    logger.warn(`[LID] Erro ao buscar em contacts: ${e.message}`);
  }

  logger.warn(`[LID] Não foi possível resolver ${lid}`);
  return null;
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
    keepAliveInterval: null,   // ← keep-alive
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

  // Cancela keep-alive
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
    // Identifica como WhatsApp Web oficial — evita invalidação de sessão
    browser: ['WhatsApp Web', 'Chrome', '2.2412.54'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    // Necessário para re-cifrar mensagens sem fechar sessão
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

      // ============================================
      // KEEP-ALIVE — mantém sessão de criptografia
      // ativa enviando presença a cada 3 minutos.
      // Evita o "Aguardando mensagem" por inatividade.
      // ============================================
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
      }, 3 * 60 * 1000); // a cada 3 minutos

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

      // Cancela keep-alive ao desconectar
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
  // Helper: registra par lid<->phone no jidMap
  // ============================================
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
        logger.info(`[${sessionId}] [MAP:${origin}] lid=${lid} → ${jid}`);
      }
    } catch (e) {
      logger.warn(`[${sessionId}] registerLidPhonePair erro: ${e.message}`);
    }
  }

  // ============================================
  // CONTACTS UPSERT — popula jidMap com @lid
  // ============================================
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (contact.id && contact.id.endsWith('@s.whatsapp.net') && contact.lid) {
        registerLidPhonePair(contact.lid, contact.id, 'contacts.upsert');
      }
    }
  });

  // ============================================
  // CONTACTS UPDATE — WhatsApp manda atualizações
  // de lid/pn frequentemente por aqui, não só no upsert
  // ============================================
  sock.ev.on('contacts.update', (updates) => {
    for (const update of updates) {
      if (update.lid && update.id) {
        registerLidPhonePair(update.lid, update.id, 'contacts.update');
      }
    }
  });

  // ============================================
  // MESSAGING-HISTORY.SET — sync inicial traz
  // contatos completos com lid<->pn quando disponível
  // ============================================
  sock.ev.on('messaging-history.set', ({ contacts }) => {
    if (!Array.isArray(contacts)) return;
    for (const contact of contacts) {
      if (contact?.id && contact?.lid) {
        registerLidPhonePair(contact.lid, contact.id, 'history.set');
      }
    }
    if (contacts.length > 0) {
      logger.info(`[${sessionId}] [HISTORY] ${contacts.length} contatos processados, jidMap agora tem ${jidMap.size} entradas`);
    }
  });

  // ============================================
  // MESSAGES UPSERT
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const remoteJid = msg.key.remoteJid || '';

      if (
        remoteJid.endsWith('@g.us') ||
        remoteJid.endsWith('@newsletter') ||
        remoteJid.endsWith('@broadcast') ||
        remoteJid === 'status@broadcast'
      ) {
        logger.info(`[${sessionId}] ⏭️ Ignorado: ${remoteJid}`);
        continue;
      }

      const isFromMe = msg.key.fromMe === true;
      const senderPn = msg.key.senderPn || msg.key.participant || '';

      // ============================================
      // RESOLUÇÃO DE @lid → número real
      // Se o WhatsApp mandou só @lid sem senderPn,
      // tenta descobrir o número real antes do webhook.
      // ============================================
      let effectiveJid = remoteJid;
      let resolvedPhone = null;

      if (remoteJid.endsWith('@lid')) {
        if (senderPn) {
          const phone = senderPn.replace(/\D/g, '').split('@')[0].split(':')[0];
          resolvedPhone = `${phone}@s.whatsapp.net`;
          effectiveJid = resolvedPhone;
          const lid = remoteJid.split('@')[0];
          jidMap.set(lid, resolvedPhone);
          logger.info(`[${sessionId}] [LID] Via senderPn: ${lid} → ${resolvedPhone}`);
        } else {
          resolvedPhone = await resolveLidToPhone(sock, remoteJid);
          if (resolvedPhone) {
            effectiveJid = resolvedPhone;
            logger.info(`[${sessionId}] [LID] Resolvido: ${remoteJid} → ${effectiveJid}`);
          } else {
            logger.warn(`[${sessionId}] [LID] Nao resolvido, mantendo ${remoteJid}`);
          }
        }
      }

      logger.info(`[${sessionId}] 🔍 remoteJid=${remoteJid} effective=${effectiveJid} senderPn=${senderPn} fromMe=${isFromMe}`);

      if (!isFromMe) {
        saveJidFromMessage(remoteJid, senderPn);
      }

      const msgType = Object.keys(msg.message)[0];
      let content = '';
      if (msgType === 'conversation') {
        content = msg.message.conversation;
      } else if (msgType === 'extendedTextMessage') {
        content = msg.message.extendedTextMessage?.text || '';
      }
      logger.info(`[${sessionId}] ${isFromMe ? '📤' : '💬'} ${remoteJid}: ${content}`);

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

      // Envia webhook com JID resolvido (número real quando disponível)
      const webhookKey = {
        ...msg.key,
        remoteJid: effectiveJid,
        originalJid: remoteJid !== effectiveJid ? remoteJid : undefined,
        // Garante que senderPn sempre vai no payload quando disponível
        senderPn: senderPn || msg.key.senderPn || undefined,
        lid: remoteJid.endsWith('@lid') ? remoteJid : undefined,
      };

      await sendWebhook({
        event: 'received-message',
        sessionId,
        instanceId: sessionId,
        data: {
          key: webhookKey,
          message: msg.message,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName,
          fromMe: isFromMe,
          audioBase64,
          audioMimetype,
          resolvedPhone: resolvedPhone ? resolvedPhone.split('@')[0] : null,
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
    logger.error(`Erro /create-session: ${error.message}`, error.stack);
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
// RESOLVE LID → número real
// GET /resolve-lid?sessionId=...&lid=...
// ============================================
app.get('/resolve-lid', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const lidRaw = req.query.lid;
    if (!lidRaw) return res.status(400).json({ error: 'lid é obrigatório' });

    const sessionData = sessions.get(sessionId);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const sock = sessionData.sock;

    // Normaliza: aceita "123@lid" ou só "123"
    const lid = String(lidRaw).replace('@lid', '').replace(/\D/g, '');
    const lidJid = `${lid}@lid`;

    logger.info(`[${sessionId}] [RESOLVE-LID] Buscando ${lid}`);

    // 1. Cache local
    if (jidMap.has(lid)) {
      const cached = jidMap.get(lid);
      const phone = cached.split('@')[0];
      logger.info(`[${sessionId}] [RESOLVE-LID] Cache: ${lid} → ${phone}`);
      return res.json({ phone, jid: cached, source: 'cache' });
    }

    // 2. signalRepository.lidMapping (Baileys 6.7.18+)
    try {
      const lidMapping = sock.signalRepository?.lidMapping;
      if (lidMapping?.getPNForLID) {
        const pn = await lidMapping.getPNForLID(lidJid);
        if (pn) {
          const phone = String(pn).split('@')[0].replace(/\D/g, '');
          const jid = `${phone}@s.whatsapp.net`;
          jidMap.set(lid, jid);
          logger.info(`[${sessionId}] [RESOLVE-LID] lidMapping: ${lid} → ${phone}`);
          return res.json({ phone, jid, source: 'lidMapping' });
        }
      }
    } catch (e) {
      logger.warn(`[${sessionId}] [RESOLVE-LID] lidMapping falhou: ${e.message}`);
    }

    // 3. Store de contatos do socket
    try {
      const contacts = sock.authState?.creds?.contacts || {};
      for (const [id, contact] of Object.entries(contacts)) {
        const contactLid = contact?.lid ? String(contact.lid).replace('@lid', '').replace(/\D/g, '') : null;
        if (contactLid === lid) {
          const phone = id.split('@')[0].replace(/\D/g, '');
          const jid = `${phone}@s.whatsapp.net`;
          jidMap.set(lid, jid);
          logger.info(`[${sessionId}] [RESOLVE-LID] contacts: ${lid} → ${phone}`);
          return res.json({ phone, jid, source: 'contacts' });
        }
      }
    } catch (e) {
      logger.warn(`[${sessionId}] [RESOLVE-LID] contacts falhou: ${e.message}`);
    }

    logger.warn(`[${sessionId}] [RESOLVE-LID] Não encontrado: ${lid}`);
    return res.json({ phone: null, jid: null, source: 'not_found' });
  } catch (error) {
    logger.error(`Erro /resolve-lid: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ON WHATSAPP — verifica se número existe
// POST /on-whatsapp { sessionId, jid|phone }
// ============================================
app.post('/on-whatsapp', async (req, res) => {
  try {
    const { sessionId, jid, phone } = req.body;
    const sid = sessionId || 'default';
    const target = jid || phone;
    if (!target) return res.status(400).json({ error: 'jid ou phone é obrigatório' });

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    const sock = sessionData.sock;

    const cleaned = String(target).replace(/\D/g, '');
    logger.info(`[${sid}] [ON-WHATSAPP] Verificando ${cleaned}`);

    const results = await sock.onWhatsApp(cleaned);
    if (!results || results.length === 0) {
      return res.json({ exists: false, jid: null });
    }

    const first = results[0];
    const resolvedJid = first.jid || first.id;
    const exists = first.exists !== false;

    if (exists && resolvedJid) {
      const p = resolvedJid.split('@')[0].replace(/\D/g, '');
      jidMap.set(p, resolvedJid);
      // Se veio lid junto, mapeia também
      if (first.lid) {
        const l = String(first.lid).replace('@lid', '').replace(/\D/g, '');
        jidMap.set(l, resolvedJid);
      }
    }

    logger.info(`[${sid}] [ON-WHATSAPP] ${cleaned} → exists=${exists} jid=${resolvedJid}`);
    return res.json({ exists, jid: resolvedJid, phone: resolvedJid ? resolvedJid.split('@')[0] : null });
  } catch (error) {
    logger.error(`Erro /on-whatsapp: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

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
