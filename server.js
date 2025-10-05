const express = require('express');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';

// Middleware de autenticação
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Função para notificar webhook
async function notifyWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...data })
    });
    console.log('Webhook notified:', event);
  } catch (error) {
    console.error('Error notifying webhook:', error);
  }
}

// Iniciar sessão Baileys
async function startSession() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      connectionStatus = 'connecting';
      console.log('QR Code gerado');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão fechada. Reconectar?', shouldReconnect);
      
      connectionStatus = 'disconnected';
      qrCodeData = null;

      await notifyWebhook('status-updated', {
        status: 'disconnected',
        connected: false
      });

      if (shouldReconnect) {
        setTimeout(() => startSession(), 3000);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp conectado!');
      connectionStatus = 'connected';
      qrCodeData = null;

      const phoneNumber = sock.user?.id?.split(':')[0];
      
      await notifyWebhook('status-updated', {
        status: 'connected',
        connected: true,
        phone: { number: phoneNumber }
      });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    const messageText = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || '';

    console.log('Mensagem recebida:', messageText, 'de', remoteJid);

    await notifyWebhook('message-received', {
      remoteJid,
      messageText,
      instanceId: sock.user?.id
    });
  });
}

// Rotas da API
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Baileys WhatsApp API',
    version: '1.0.0'
  });
});

app.post('/create-session', authenticate, async (req, res) => {
  try {
    if (sock && connectionStatus === 'connected') {
      return res.json({ 
        success: true, 
        message: 'Já conectado',
        status: 'connected'
      });
    }

    await startSession();
    
    // Aguardar QR Code ser gerado
    await new Promise(resolve => setTimeout(resolve, 2000));

    res.json({ 
      success: true, 
      qrcode: qrCodeData,
      status: connectionStatus
    });
  } catch (error) {
    console.error('Erro ao criar sessão:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/qrcode', authenticate, (req, res) => {
  res.json({
    qrcode: qrCodeData,
    status: connectionStatus
  });
});

app.get('/status', authenticate, (req, res) => {
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    phone: sock?.user?.id?.split(':')[0] || null
  });
});

app.post('/send-message', authenticate, async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!sock || connectionStatus !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });

    res.json({ success: true, message: 'Mensagem enviada' });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/disconnect', authenticate, async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    
    connectionStatus = 'disconnected';
    qrCodeData = null;

    res.json({ success: true, message: 'Desconectado' });
  } catch (error) {
    console.error('Erro ao desconectar:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Baileys API rodando na porta ${PORT}`);
});
