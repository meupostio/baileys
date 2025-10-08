// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO
// ============================================
// Este arquivo deve ser colocado no Render.com
// Substitui o server.js antigo
// ============================================

import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import P from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'your-secret-key-here';
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// ============================================
// ESTRUTURA MULTI-USUÁRIO
// ============================================
// Map para gerenciar múltiplas sessões
const sessions = new Map(); // user_id -> { sock, qrCodeData, connectionStatus, authState }

// Logger
const logger = P({ level: 'info' });

// ============================================
// MIDDLEWARE DE AUTENTICAÇÃO
// ============================================
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use(authenticate);

// ============================================
// FUNÇÃO: Obter ou criar sessão
// ============================================
async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  // Criar nova sessão
  const sessionData = {
    sock: null,
    qrCodeData: null,
    connectionStatus: 'disconnected',
    authState: null,
    phoneNumber: null
  };

  // Criar pasta de autenticação isolada
  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  sessions.set(sessionId, sessionData);
  logger.info(`[${sessionId}] Nova sessão criada`);
  
  return sessionData;
}

// ============================================
// FUNÇÃO: Criar conexão WhatsApp
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  // Fechar conexão existente se houver
  if (sessionData.sock) {
    try {
      await sessionData.sock.logout();
    } catch (e) {
      logger.warn(`[${sessionId}] Erro ao fazer logout:`, e);
    }
    sessionData.sock = null;
  }

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sessionData.authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR || true,
    logger: P({ level: 'warn' }),
  });

  sessionData.sock = sock;

  // ============================================
  // EVENT: QR Code
  // ============================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] QR Code disponível`);
    }

    if (connection === 'open') {
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      logger.info(`[${sessionId}] Conectado: ${sessionData.phoneNumber}`);
      
      // Notificar webhook
      if (WEBHOOK_URL) {
        try {
          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'status-updated',
              sessionId,
              status: 'connected',
              connected: true,
              phone: { number: sessionData.phoneNumber }
            })
          });
        } catch (e) {
          logger.error(`[${sessionId}] Erro ao notificar webhook:`, e);
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      sessionData.connectionStatus = 'disconnected';
      sessionData.qrCodeData = null;
      sessionData.phoneNumber = null;
      
      logger.warn(`[${sessionId}] Conexão fechada. Reconectar? ${shouldReconnect}`);
      
      // Notificar webhook
      if (WEBHOOK_URL) {
        try {
          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'status-updated',
              sessionId,
              status: 'disconnected',
              connected: false
            })
          });
        } catch (e) {
          logger.error(`[${sessionId}] Erro ao notificar webhook:`, e);
        }
      }

      if (shouldReconnect) {
        // Aguarda 5s antes de reconectar
        setTimeout(() => createWhatsAppConnection(sessionId, options), 5000);
      }
    }
  });

  // Salvar credenciais ao atualizar
  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // EVENT: Mensagens recebidas
  // ============================================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const messageType = Object.keys(msg.message)[0];
      let content = '';

      if (messageType === 'conversation') {
        content = msg.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        content = msg.message.extendedTextMessage.text;
      }

      logger.info(`[${sessionId}] Mensagem recebida de ${remoteJid}: ${content}`);

      // Enviar para webhook
      if (WEBHOOK_URL) {
        try {
          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'received-message',
              sessionId,
              instanceId: sessionId, // Para compatibilidade
              data: {
                key: msg.key,
                message: msg.message,
                messageTimestamp: msg.messageTimestamp,
                pushName: msg.pushName
              }
            })
          });
        } catch (e) {
          logger.error(`[${sessionId}] Erro ao enviar mensagem para webhook:`, e);
        }
      }
    }
  });

  return sessionData;
}

// ============================================
// ENDPOINTS
// ============================================

// 1. Criar sessão
app.post('/create-session', async (req, res) => {
  try {
    const { sessionId, reconnect, force, printQR } = req.body;
    const sid = sessionId || 'default';

    logger.info(`[${sid}] POST /create-session`);

    const sessionData = await createWhatsAppConnection(sid, { printQR });
    
    // Aguarda 2s para gerar QR
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (sessionData.qrCodeData) {
      // Converte QR para base64
      const QRCode = (await import('qrcode')).default;
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      
      return res.json({
        success: true,
        qrcode: qrBase64,
        status: sessionData.connectionStatus
      });
    }

    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        success: true,
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    return res.json({
      success: true,
      status: sessionData.connectionStatus,
      message: 'Sessão criada, aguarde QR code'
    });
  } catch (error) {
    logger.error('Erro em /create-session:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Obter QR Code
app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const sessionData = sessions.get(sessionId);

    if (!sessionData) {
      return res.json({ status: 'disconnected', message: 'Sessão não encontrada' });
    }

    if (sessionData.qrCodeData) {
      const QRCode = (await import('qrcode')).default;
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ qrcode: qrBase64, status: sessionData.connectionStatus });
    }

    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    return res.json({ status: sessionData.connectionStatus });
  } catch (error) {
    logger.error('Erro em /qrcode:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Desconectar sessão
app.post('/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sid = sessionId || 'default';

    logger.info(`[${sid}] POST /disconnect`);

    const sessionData = sessions.get(sid);
    if (sessionData?.sock) {
      await sessionData.sock.logout();
      sessionData.sock = null;
      sessionData.qrCodeData = null;
      sessionData.connectionStatus = 'disconnected';
      sessionData.phoneNumber = null;
    }

    res.json({ success: true, message: 'Desconectado com sucesso' });
  } catch (error) {
    logger.error('Erro em /disconnect:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Deletar sessão
app.delete('/session/:sessionId?', async (req, res) => {
  try {
    const sessionId = req.params.sessionId || 'default';

    logger.info(`[${sessionId}] DELETE /session`);

    const sessionData = sessions.get(sessionId);
    if (sessionData?.sock) {
      try {
        await sessionData.sock.logout();
      } catch (e) {
        logger.warn(`[${sessionId}] Erro ao fazer logout:`, e);
      }
    }

    // Remover pasta de autenticação
    const authDir = path.join(__dirname, 'auth_info', sessionId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }

    sessions.delete(sessionId);
    
    res.json({ success: true, message: 'Sessão deletada' });
  } catch (error) {
    logger.error('Erro em /delete-session:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Enviar mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const sid = sessionId || 'default';

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone e message são obrigatórios' });
    }

    const sessionData = sessions.get(sid);
    if (!sessionData?.sock || sessionData.connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    
    await sessionData.sock.sendMessage(jid, { text: message });
    
    res.json({ success: true, message: 'Mensagem enviada' });
  } catch (error) {
    logger.error('Erro em /send-message:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Status geral
app.get('/status', (req, res) => {
  const allSessions = {};
  sessions.forEach((data, sid) => {
    allSessions[sid] = {
      status: data.connectionStatus,
      phone: data.phoneNumber,
      hasQR: !!data.qrCodeData
    };
  });

  res.json({
    success: true,
    totalSessions: sessions.size,
    sessions: allSessions
  });
});

// ============================================
// SERVIDOR
// ============================================
app.listen(PORT, () => {
  logger.info(`🚀 Servidor Baileys Multi-usuário rodando na porta ${PORT}`);
  logger.info(`📱 Suporte para múltiplas sessões simultâneas`);
});

// Cleanup ao desligar
process.on('SIGINT', async () => {
  logger.info('Desligando servidor...');
  for (const [sid, data] of sessions.entries()) {
    if (data.sock) {
      try {
        await data.sock.logout();
      } catch (e) {
        logger.error(`[${sid}] Erro ao fazer logout:`, e);
      }
    }
  }
  process.exit(0);
});
