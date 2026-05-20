// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO
// ============================================
// Botões e Menu via interactiveMessage (nativeFlow)
// Mesmo método usado pelas plataformas Evolution API, Z-API, etc.
// ============================================

const { 
  makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
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

const logger = P({ 
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  }
});

// ============================================
// NORMALIZAR JID (corrige contato fantasma)
// ============================================
function normalizeJid(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/\D/g, '');
  cleaned = cleaned.split('@')[0].split(':')[0];
  
  if (cleaned.startsWith('55') && cleaned.length === 12) {
    const ddd = cleaned.substring(2, 4);
    const number = cleaned.substring(4);
    cleaned = `55${ddd}9${number}`;
  }
  
  if (phone.includes('@g.us')) return `${cleaned}@g.us`;
  return `${cleaned}@s.whatsapp.net`;
}

// ============================================
// MIDDLEWARE AUTH
// ============================================
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ============================================
// WEBHOOK
// ============================================
async function sendWebhook(payload, retries = 3) {
  if (!WEBHOOK_URL) return;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (r.ok) { logger.info(`[WEBHOOK] ✅ ${payload.event}`); return; }
    } catch (e) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ============================================
// SESSÕES
// ============================================
async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const sessionData = {
    sock: null, qrCodeData: null, qrExpiry: null,
    connectionStatus: 'disconnected', authState: null,
    phoneNumber: null, reconnectAttempts: 0
  };

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  sessions.set(sessionId, sessionData);
  return sessionData;
}

async function cleanupSession(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;

  if (sessionData.sock) {
    try {
      if (sessionData.sock.user) await sessionData.sock.logout();
    } catch (e) { logger.warn(`Erro logout: ${e.message}`); }
    sessionData.sock = null;
  }
  sessionData.qrCodeData = null;
  sessionData.qrExpiry = null;
  sessionData.connectionStatus = 'disconnected';
  sessionData.phoneNumber = null;
  sessionData.reconnectAttempts = 0;
}

// ============================================
// CONEXÃO WHATSAPP
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  if (sessionData.sock) {
    const isConnected = sessionData.sock.user && sessionData.connectionStatus === 'connected';
    if (isConnected) {
      logger.info(`[${sessionId}] ✅ Já conectado: ${sessionData.phoneNumber}`);
      return sessionData;
    }
    await cleanupSession(sessionId);
  }

  sessionData.reconnectAttempts = 0;
  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sessionData.authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR !== false,
    logger: P({ level: 'warn' }),
    browser: ['Baileys Server', 'Chrome', '121.0.0'],
    syncFullHistory: false
  });

  sessionData.sock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrExpiry = Date.now() + 60000;
      sessionData.connectionStatus = 'qr_ready';
    }

    if (connection === 'open') {
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.reconnectAttempts = 0;
      logger.info(`[${sessionId}] ✅ CONECTADO: ${sessionData.phoneNumber}`);
      
      await sendWebhook({
        event: 'status-updated', sessionId, status: 'connected',
        connected: true, phone: { number: sessionData.phoneNumber }
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      sessionData.connectionStatus = 'disconnected';
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.phoneNumber = null;
      
      await sendWebhook({
        event: 'status-updated', sessionId, status: 'disconnected', connected: false
      });

      if (shouldReconnect && sessionData.reconnectAttempts < 3) {
        sessionData.reconnectAttempts++;
        const delay = 5000 * sessionData.reconnectAttempts;
        setTimeout(() => createWhatsAppConnection(sessionId, options), delay);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // RECEBIMENTO DE MENSAGENS
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = normalizeJid(msg.key.remoteJid);
      const messageType = Object.keys(msg.message)[0];
      let content = '';
      let interactionType = 'text';

      switch (messageType) {
        case 'conversation':
          content = msg.message.conversation;
          break;

        case 'extendedTextMessage':
          content = msg.message.extendedTextMessage.text;
          break;

        // ✅ Resposta de botão antigo
        case 'buttonsResponseMessage':
          content = msg.message.buttonsResponseMessage.selectedButtonId || 
                    msg.message.buttonsResponseMessage.selectedDisplayText || '';
          interactionType = 'button_response';
          break;

        // ✅ Resposta de lista/menu
        case 'listResponseMessage':
          content = msg.message.listResponseMessage.singleSelectReply?.selectedRowId || '';
          interactionType = 'list_response';
          break;

        // ✅ Resposta de template
        case 'templateButtonReplyMessage':
          content = msg.message.templateButtonReplyMessage.selectedId || '';
          interactionType = 'template_response';
          break;

        // ✅ Resposta de interactiveMessage / nativeFlow (formato novo)
        case 'interactiveResponseMessage':
          try {
            const paramsJson = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
            if (paramsJson) {
              const params = JSON.parse(paramsJson);
              content = params.id || params.display_text || JSON.stringify(params);
            }
            interactionType = 'interactive_response';
          } catch (e) {
            logger.error(`Erro ao parsear interactiveResponse: ${e.message}`);
          }
          break;

        case 'imageMessage':
          content = msg.message.imageMessage.caption || '[imagem]';
          interactionType = 'image';
          break;

        case 'audioMessage':
          content = '[áudio]';
          interactionType = 'audio';
          break;

        case 'videoMessage':
          content = msg.message.videoMessage.caption || '[vídeo]';
          interactionType = 'video';
          break;

        case 'documentMessage':
          content = msg.message.documentMessage.fileName || '[documento]';
          interactionType = 'document';
          break;

        default:
          content = `[${messageType}]`;
      }

      logger.info(`[${sessionId}] 💬 ${remoteJid} (${interactionType}): ${content}`);

      await sendWebhook({
        event: 'received-message',
        sessionId,
        instanceId: sessionId,
        data: {
          key: { ...msg.key, remoteJid },
          message: msg.message,
          messageType,
          interactionType,
          content,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName
        }
      });
    }
  });

  return sessionData;
}

// ============================================
// ENDPOINTS BÁSICOS (mantidos)
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), sessions: sessions.size });
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
      return res.json({ qrcode: qrBase64, status: sessionData.connectionStatus,
        expiresIn: Math.max(0, Math.floor((sessionData.qrExpiry - Date.now()) / 1000)) });
    }
    return res.json({ status: sessionData.connectionStatus });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/sessions/:id/qrcode', async (req, res) => {
  req.query.sessionId = req.params.id;
  return app._router.handle(req, res);
});

app.post('/disconnect', async (req, res) => {
  try {
    const sid = req.body.sessionId || 'default';
    await cleanupSession(sid);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/logout', async (req, res) => {
  try {
    const sid = req.body.sessionId || 'default';
    await cleanupSession(sid);
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

// ============================================
// 1. ENVIAR MENSAGEM DE TEXTO
// ============================================
app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const sid = sessionId || 'default';

    if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = normalizeJid(phone);
    await sessionData.sock.sendMessage(jid, { text: message });
    
    logger.info(`[${sid}] ✅ Texto enviado para ${jid}`);
    res.json({ success: true, jid });
  } catch (error) {
    logger.error(`Erro send-message: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 2. ENVIAR BOTÕES (interactiveMessage / nativeFlow)
// ============================================
// Esse é o MESMO FORMATO que Evolution API, Z-API e outras
// plataformas usam para enviar botões sem API oficial.
//
// Payload:
// {
//   "sessionId": "default",
//   "phone": "5511999999999",
//   "text": "Escolha uma opção:",
//   "footer": "Rodapé opcional",
//   "buttons": [
//     { "id": "quero_usar", "text": "Quero usar" },
//     { "id": "nao_quero", "text": "Não quero" },
//     { "id": "talvez", "text": "Talvez depois" }
//   ]
// }
// ============================================
app.post('/send-buttons', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, buttons, title } = req.body;
    const sid = sessionId || 'default';

    if (!phone || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'phone, text e buttons obrigatórios' });
    }

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = normalizeJid(phone);

    // Monta os botões no formato nativeFlow
    const nativeButtons = buttons.map(btn => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({
        display_text: btn.text,
        id: btn.id
      })
    }));

    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: title || '',
          subtitle: '',
          hasMediaAttachment: false
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: nativeButtons
        })
      })
    };

    const msg = generateWAMessageFromContent(jid, {
      viewOnceMessage: { message: interactiveMsg }
    }, {});

    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

    logger.info(`[${sid}] 🔘 Botões enviados para ${jid} (${buttons.length} botões)`);
    res.json({ success: true, jid, type: 'buttons' });
  } catch (error) {
    logger.error(`Erro send-buttons: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 3. ENVIAR MENU/LISTA (modal com opções)
// ============================================
// Payload:
// {
//   "sessionId": "default",
//   "phone": "5511999999999",
//   "text": "ola",
//   "title": "Menu",
//   "buttonText": "Ver opções",
//   "footer": "Rodapé opcional",
//   "sections": [
//     {
//       "title": "Seção 1",
//       "rows": [
//         { "id": "opt_1", "title": "Opção 2", "description": "" },
//         { "id": "opt_2", "title": "Opção 3", "description": "" },
//         { "id": "opt_3", "title": "Opção 4", "description": "" }
//       ]
//     }
//   ]
// }
// ============================================
app.post('/send-list', async (req, res) => {
  try {
    const { sessionId, phone, text, title, buttonText, footer, sections } = req.body;
    const sid = sessionId || 'default';

    if (!phone || !text || !sections || !Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: 'phone, text e sections obrigatórios' });
    }

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = normalizeJid(phone);

    // Formato nativeFlow para listas
    const listParams = {
      title: buttonText || 'Ver opções',
      sections: sections.map(section => ({
        title: section.title || '',
        rows: section.rows.map(row => ({
          header: '',
          title: row.title,
          description: row.description || '',
          id: row.id
        }))
      }))
    };

    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: title || '',
          subtitle: '',
          hasMediaAttachment: false
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: [{
            name: 'single_select',
            buttonParamsJson: JSON.stringify(listParams)
          }]
        })
      })
    };

    const msg = generateWAMessageFromContent(jid, {
      viewOnceMessage: { message: interactiveMsg }
    }, {});

    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

    logger.info(`[${sid}] 📋 Menu enviado para ${jid} (${sections.length} seção(ões))`);
    res.json({ success: true, jid, type: 'list' });
  } catch (error) {
    logger.error(`Erro send-list: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 4. ENVIAR BOTÃO COM LINK
// ============================================
// Payload:
// {
//   "sessionId": "default",
//   "phone": "5511999999999",
//   "text": "talves possa ver",
//   "footer": "",
//   "buttons": [
//     { "text": "agendar", "url": "https://exemplo.com/agendar" }
//   ]
// }
// ============================================
app.post('/send-link-button', async (req, res) => {
  try {
    const { sessionId, phone, text, footer, buttons, title } = req.body;
    const sid = sessionId || 'default';

    if (!phone || !text || !buttons || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'phone, text e buttons obrigatórios' });
    }

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = normalizeJid(phone);

    // Monta botões mistos: link, telefone, ou quick reply
    const nativeButtons = buttons.map(btn => {
      if (btn.url) {
        return {
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({
            display_text: btn.text,
            url: btn.url,
            merchant_url: btn.url
          })
        };
      } else if (btn.phoneNumber) {
        return {
          name: 'cta_call',
          buttonParamsJson: JSON.stringify({
            display_text: btn.text,
            phone_number: btn.phoneNumber
          })
        };
      } else {
        return {
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({
            display_text: btn.text,
            id: btn.id || btn.text
          })
        };
      }
    });

    const interactiveMsg = {
      interactiveMessage: proto.Message.InteractiveMessage.fromObject({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text }),
        footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: footer || '' }),
        header: proto.Message.InteractiveMessage.Header.fromObject({
          title: title || '',
          subtitle: '',
          hasMediaAttachment: false
        }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: nativeButtons
        })
      })
    };

    const msg = generateWAMessageFromContent(jid, {
      viewOnceMessage: { message: interactiveMsg }
    }, {});

    await sessionData.sock.relayMessage(jid, msg.message, { messageId: msg.key.id });

    logger.info(`[${sid}] 🔗 Botões com link enviados para ${jid}`);
    res.json({ success: true, jid, type: 'link_button' });
  } catch (error) {
    logger.error(`Erro send-link-button: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 5. ENDPOINT UNIFICADO /send
// ============================================
// O studio do seu chatbot chama esse endpoint passando o tipo
// Payload:
// {
//   "sessionId": "default",
//   "phone": "5511999999999",
//   "type": "text" | "buttons" | "list" | "link_button",
//   "payload": { ... }
// }
// ============================================
app.post('/send', async (req, res) => {
  try {
    const { sessionId, phone, type, payload } = req.body;
    const sid = sessionId || 'default';

    if (!phone || !type || !payload) {
      return res.status(400).json({ error: 'phone, type e payload obrigatórios' });
    }

    // Reencaminha pro endpoint específico
    req.body = { sessionId: sid, phone, ...payload };

    switch (type) {
      case 'text':
        req.body.message = payload.message || payload.text;
        return app._router.handle({ ...req, url: '/send-message', method: 'POST' }, res);
      
      case 'buttons':
        return app._router.handle({ ...req, url: '/send-buttons', method: 'POST' }, res);
      
      case 'list':
      case 'menu':
        return app._router.handle({ ...req, url: '/send-list', method: 'POST' }, res);
      
      case 'link_button':
      case 'url_button':
        return app._router.handle({ ...req, url: '/send-link-button', method: 'POST' }, res);
      
      default:
        return res.status(400).json({ error: `Tipo "${type}" não suportado` });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STATUS
// ============================================
app.get('/status', (req, res) => {
  const allSessions = {};
  sessions.forEach((data, sid) => {
    allSessions[sid] = {
      status: data.connectionStatus,
      phone: data.phoneNumber,
      hasQR: !!data.qrCodeData,
      reconnectAttempts: data.reconnectAttempts
    };
  });
  res.json({ success: true, uptime: process.uptime(), totalSessions: sessions.size, sessions: allSessions });
});

// ============================================
// SERVIDOR
// ============================================
app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys rodando na porta ${PORT}`);
  logger.info(`📋 Endpoints disponíveis:`);
  logger.info(`   POST /send-message     → Texto`);
  logger.info(`   POST /send-buttons     → Botões (interactiveMessage)`);
  logger.info(`   POST /send-list        → Menu/Lista`);
  logger.info(`   POST /send-link-button → Botão com URL`);
  logger.info(`   POST /send             → Roteador unificado`);
});

process.on('SIGINT', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  for (const [sid] of sessions.entries()) await cleanupSession(sid);
  process.exit(0);
});
