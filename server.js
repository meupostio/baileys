// ============================================
// SERVIDOR BAILEYS MULTI-USUÁRIO
// ============================================
// CommonJS para Render.com
// ============================================

const { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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

// ============================================
// ESTRUTURA MULTI-USUÁRIO
// ============================================
const sessions = new Map(); // sessionId -> { sock, qrCodeData, connectionStatus, authState, phoneNumber, reconnectAttempts }

// Logger
const logger = P({ 
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

let currentUserId = null;

// ============================================
// MIDDLEWARE DE AUTENTICAÇÃO
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
// FUNÇÃO: Enviar Webhook com Retry
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
      
      const json = await response.json();
      
      logger.warn(`[WEBHOOK] Falha (${response.status}), tentativa ${i + 1}/${retries}: ${JSON.stringify(json, null, 2)}`);
    } catch (e) {
      logger.error(`[WEBHOOK] Erro na tentativa ${i + 1}/${retries}: ${e.message}`, e.message);
      if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  logger.error(`[WEBHOOK] Falhou após ${retries} tentativas`);
}

// ============================================
// FUNÇÃO: Obter ou criar sessão
// ============================================
async function getOrCreateSession(sessionId) {
  if (!sessionId) sessionId = 'default';
  
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const sessionData = {
    sock: null,
    qrCodeData: null,
    qrExpiry: null,
    connectionStatus: 'disconnected',
    authState: null,
    phoneNumber: null,
    reconnectAttempts: 0
  };

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  sessions.set(sessionId, sessionData);
  logger.info(`[${sessionId}] Nova sessão criada`);
  
  return sessionData;
}

// ============================================
// FUNÇÃO: Cleanup seguro de sessão
// ============================================
async function cleanupSession(sessionId) {
  const sessionData = sessions.get(sessionId);
  if (!sessionData) return;

  logger.info(`[${sessionId}] Iniciando cleanup de sessão...`);

  if (sessionData.sock) {
    try {
      if (sessionData.sock.user) {
        await sessionData.sock.logout();
        logger.info(`[${sessionId}] Logout realizado com sucesso`);
      } else {
        logger.warn(`[${sessionId}] Socket não autenticado, pulando logout`);
      }
    } catch (e) {
      logger.warn(`[${sessionId}] Erro ao fazer logout: ${e.message}`);
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
// FUNÇÃO: Criar conexão WhatsApp
// ============================================
async function createWhatsAppConnection(sessionId, options = {}) {
  const sessionData = await getOrCreateSession(sessionId);
  
  // ✅ PROTEÇÃO CRÍTICA: Se já está conectado e autenticado, NÃO recriar
  if (sessionData.sock) {
    const isCurrentlyConnected = sessionData.sock.user && sessionData.connectionStatus === 'connected';
    
    if (isCurrentlyConnected) {
      logger.info(`[${sessionId}] ✅ Socket já conectado e autenticado, mantendo conexão existente`);
      logger.info(`[${sessionId}] 📱 Telefone: ${sessionData.phoneNumber}`);
      return sessionData; // ← NÃO criar nova conexão
    }
    
    // Apenas fazer cleanup se NÃO estiver conectado
    logger.info(`[${sessionId}] Fechando socket anterior (status: ${sessionData.connectionStatus})...`);
    await cleanupSession(sessionId);
  }

  // Resetar tentativas de reconexão
  sessionData.reconnectAttempts = 0;

  const authDir = path.join(__dirname, 'auth_info', sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  sessionData.authState = { state, saveCreds };

  const { version } = await fetchLatestBaileysVersion();
  
  logger.info(`[${sessionId}] Criando novo socket WhatsApp (versão ${version.join('.')})`);
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: options.printQR !== false,
    logger: P({ level: 'warn' }),
    browser: ['Baileys Server', 'Chrome', '121.0.0'],
    syncFullHistory: false
  });

  sessionData.sock = sock;

  // ============================================
  // EVENT: connection.update
  // ============================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code gerado
    if (qr) {
      sessionData.qrCodeData = qr;
      sessionData.qrExpiry = Date.now() + 60000; // 60s
      sessionData.connectionStatus = 'qr_ready';
      logger.info(`[${sessionId}] 📱 QR Code disponível (expira em 60s)`);
    }

    // Conexão aberta (autenticado)
    if (connection === 'open') {
      sessionData.connectionStatus = 'connected';
      sessionData.phoneNumber = sock.user?.id?.split(':')[0] || null;
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.reconnectAttempts = 0;

      logger.info(`[${sessionId}] ✅ CONECTADO: ${sessionData.phoneNumber}`);

      if (sessionId.startsWith('temp-')) {
        try {
          const response = await fetch(
            `${process.env.SUPABASE_URL}/rest/v1/whatsapp_instances?baileys_temp_session=eq.${sessionId}&select=user_id`,
            {
              headers: {
                'apikey': process.env.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
              }
            }
          );
          
          const data = await response.json();
          if (data && data.length > 0) {
            currentUserId = data[0].user_id; // 🎯 Armazenar o userId real
            logger.info(`[${sessionId}] ✅ Mapeado para userId: ${currentUserId}`);
          } else {
            logger.info(`[${sessionId}] ❌ Nenhum userId encontrado para a seção: ${sessionId}.`);
          }
        } catch (error) {
          logger.error(`[${sessionId}] ❌ Erro ao buscar userId:`, error);
        }
      } else {
        currentUserId = sessionId;
      }

      const payload = {
        event: 'connected',
        sessionId: currentUserId || sessionId,
        phone: sessionData.phoneNumber,
        data: {
          connected: true,
          phone: sessionData.phoneNumber 
        }
      };
      // 4. Envie o payload correto para sua função
      await sendWebhook(payload);
    }

    // Conexão fechada
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      logger.warn(`[${sessionId}] ❌ Conexão fechada (código: ${statusCode})`);
      
      sessionData.connectionStatus = 'disconnected';
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
      sessionData.phoneNumber = null;
      
      await sendWebhook({
        event: 'status-updated',
        sessionId: currentUserId || sessionId,
        status: 'disconnected',
        connected: false
      });

      // Reconexão com limite de tentativas
      if (shouldReconnect && sessionData.reconnectAttempts < 3) {
        sessionData.reconnectAttempts++;
        const delay = 5000 * sessionData.reconnectAttempts; // Backoff exponencial
        logger.info(`[${sessionId}] Tentativa de reconexão ${sessionData.reconnectAttempts}/3 em ${delay}ms`);
        setTimeout(() => createWhatsAppConnection(sessionId, options), delay);
      } else if (sessionData.reconnectAttempts >= 3) {
        logger.error(`[${sessionId}] Limite de reconexões atingido (3)`);
      }
    }
  });

  // Salvar credenciais
  sock.ev.on('creds.update', saveCreds);

  // ============================================
  // EVENT: messages.upsert
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

      logger.info(`[${currentUserId || sessionId}] 💬 Mensagem de ${remoteJid}: ${content}`);

      await sendWebhook({
        event: 'received-message',
        sessionId: currentUserId || sessionId,
        instanceId: currentUserId || sessionId,
        data: {
          key: msg.key,
          message: msg.message,
          messageTimestamp: msg.messageTimestamp,
          pushName: msg.pushName
        }
      });
    }
  });

  return sessionData;
}

// =================================================================
// FUNÇÂO lógica de desconexão
// =================================================================
async function handleDisconnect(req, res) {
  try {
    const { sessionId } = req.body;
    const sid = sessionId || 'default';

    logger.info(`[${sid}] Iniciando desconexão...`);

    await cleanupSession(sid);

    res.json({ success: true, message: 'Desconectado com sucesso' });
  } catch (error) {
    logger.error(`Erro ao tentar desconectar a sessão ${sid || ''}:`, error);
    res.status(500).json({ error: error.message });
  }
}

// ============================================
// ENDPOINTS
// ============================================

// 1. Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    sessions: sessions.size 
  });
});

// 2. Criar sessão
app.post('/create-session', async (req, res) => {
  try {
    const { sessionId, reconnect, force, printQR } = req.body;
    const sid = sessionId || 'default';

    logger.info(`[${sid}] POST /create-session`);

    const sessionData = await createWhatsAppConnection(sid, { printQR });
    
    // Aguarda até 3s para gerar QR
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Se já conectado
    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        success: true,
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    // Se tem QR Code
    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({
        success: true,
        qrcode: qrBase64,
        status: sessionData.connectionStatus,
        id: sid,
        expiresIn: 60
      });
    }

    return res.json({
      success: true,
      status: sessionData.connectionStatus,
      message: 'Sessão criada, aguarde QR code'
    });
  } catch (error) {
    logger.error(`Erro em /create-session:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Obter QR Code (compatibilidade)
app.get('/sessions/:id/qrcode', async (req, res, next) => {
  console.log(`[Compatibilidade] Rota /sessions/${req.params.id}/qrcode acessada.`);
  req.query.sessionId = req.params.id;
  console.log('[Compatibilidade] Requisição modificada. Encaminhando...');
  req.url = '/qrcode';
  next();
});

// 3. Obter QR Code (polling)
app.get('/qrcode', async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const sessionData = sessions.get(sessionId);

    if (!sessionData) {
      return res.json({ status: 'disconnected', message: 'Sessão não encontrada' });
    }

    // Verificar expiração do QR
    if (sessionData.qrCodeData && sessionData.qrExpiry && Date.now() > sessionData.qrExpiry) {
      logger.warn(`[${sessionId}] QR Code expirado, limpando...`);
      sessionData.qrCodeData = null;
      sessionData.qrExpiry = null;
    }

    // Se conectado
    if (sessionData.connectionStatus === 'connected') {
      return res.json({
        status: 'connected',
        phone: sessionData.phoneNumber
      });
    }

    // Se tem QR
    if (sessionData.qrCodeData) {
      const qrBase64 = await QRCode.toDataURL(sessionData.qrCodeData);
      return res.json({ 
        qrcode: qrBase64, 
        status: sessionData.connectionStatus,
        expiresIn: Math.max(0, Math.floor((sessionData.qrExpiry - Date.now()) / 1000))
      });
    }

    return res.json({ status: sessionData.connectionStatus });
  } catch (error) {
    logger.error(`Erro em /qrcode:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Desconectar sessão
app.post('/disconnect', async (req, res) => {
  return handleDisconnect(req, res);
});

// 6. Logout (alias de disconnect)
app.post('/logout', async (req, res) => {
  return handleDisconnect(req, res);
});

// 7. Deletar sessão
app.delete('/session/:sessionId?', async (req, res) => {
  try {
    const sessionId = req.params.sessionId || 'default';

    logger.info(`[${sessionId}] DELETE /session`);

    await cleanupSession(sessionId);

    // Remover pasta de autenticação
    const authDir = path.join(__dirname, 'auth_info', sessionId);
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      logger.info(`[${sessionId}] Pasta de autenticação removida`);
    }

    sessions.delete(sessionId);
    
    res.json({ success: true, message: 'Sessão deletada' });
  } catch (error) {
    logger.error(`Erro em /delete-session:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 8. Enviar mensagem
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
    
    logger.info(`[${sid}] ✅ Mensagem enviada para ${phone}`);
    res.json({ success: true, message: 'Mensagem enviada' });
  } catch (error) {
    logger.error(`Erro em /send-message:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 9. Status geral
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

  res.json({
    success: true,
    uptime: process.uptime(),
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
  logger.info(`🔐 API Key configurada: ${API_KEY ? '✅' : '❌'}`);
  logger.info(`🪝 Webhook URL: ${WEBHOOK_URL || 'Não configurado'}`);
});

// Cleanup ao desligar
process.on('SIGINT', async () => {
  logger.info('⚠️ Desligando servidor...');
  for (const [sid] of sessions.entries()) {
    await cleanupSession(sid);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('⚠️ SIGTERM recebido, desligando...');
  for (const [sid] of sessions.entries()) {
    await cleanupSession(sid);
  }
  process.exit(0);
});
