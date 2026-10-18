require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// 1. Inicializar Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'https://tdhbsctrutzmmzqzinze.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseKey) {
  console.error('❌ ERROR: SUPABASE_SERVICE_ROLE_KEY no está definido en el archivo .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 2. Estado Global y Memoria de Mensajes
let currentQR = null;
let currentQRDataUrl = null;
let botStatus = 'Iniciando...';
let connectedNumber = null;
let totalVerifiedCount = 0;
let liveSocket = null;
const botMessageHistory = [];

function addMessageLog({ id, type = 'incoming', sender, phone, text, status = 'info', reason = '', reply = null }) {
  const item = {
    id: id || `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    type,
    sender: sender || phone || 'Usuario',
    phone: phone || '',
    text: text || '',
    status, // 'verified' | 'rejected' | 'invalid' | 'ignored' | 'system'
    reason,
    reply: reply || null
  };
  botMessageHistory.push(item);
  if (botMessageHistory.length > 250) {
    botMessageHistory.shift();
  }
  return item;
}

// 3. Servidor Express & API REST para el Panel de Control
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware CORS abierto para el panel de administración Vite / PyWebview
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// API: Estado en tiempo real del Bot y QR
app.get('/api/status', async (req, res) => {
  if (currentQR && !currentQRDataUrl) {
    try {
      currentQRDataUrl = await QRCode.toDataURL(currentQR);
    } catch (e) {}
  }
  res.json({
    running: true,
    botStatus,
    connectedNumber,
    currentQR,
    qrDataUrl: currentQR ? currentQRDataUrl : null,
    totalVerifiedCount,
    uptimeSeconds: Math.floor(process.uptime()),
    messageCount: botMessageHistory.length,
    timestamp: new Date().toISOString()
  });
});

// API: Historial de mensajes en vivo leídos por el bot
app.get('/api/messages', (req, res) => {
  res.json({
    status: 'ok',
    botStatus,
    connectedNumber,
    totalVerifiedCount,
    messages: botMessageHistory.slice(-100).reverse()
  });
});

// API: Reiniciar conexión del bot
app.post('/api/restart', async (req, res) => {
  try {
    if (liveSocket) {
      try { liveSocket.end(); } catch (e) {}
    }
    botStatus = 'Reiniciando conexión...';
    currentQR = null;
    currentQRDataUrl = null;
    addMessageLog({
      type: 'system',
      sender: 'Sistema',
      text: 'Reinicio de conexión solicitado desde el Panel de Control.',
      status: 'system'
    });
    setTimeout(startWhatsAppBot, 1000);
    res.json({ ok: true, message: 'Bot reiniciándose...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Desvincular sesión y solicitar nuevo QR
app.post('/api/logout', async (req, res) => {
  try {
    if (liveSocket) {
      try { liveSocket.logout(); } catch (e) {}
      try { liveSocket.end(); } catch (e) {}
    }
    const AUTH_DIR = path.join(__dirname, 'auth_info');
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    botStatus = 'Esperando escaneo de QR';
    currentQR = null;
    currentQRDataUrl = null;
    connectedNumber = null;
    addMessageLog({
      type: 'system',
      sender: 'Sistema',
      text: 'Sesión desvinculada por administrador. Generando nuevo código QR...',
      status: 'system'
    });
    setTimeout(startWhatsAppBot, 1000);
    res.json({ ok: true, message: 'Sesión desvinculada. Generando nuevo código QR...' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: Enviar mensaje manual a través del bot desde el panel
app.post('/api/send', async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    if (!liveSocket || botStatus !== 'Conectado') {
      return res.status(400).json({ ok: false, error: 'El bot no está conectado actualmente.' });
    }
    if (!phone || !text) {
      return res.status(400).json({ ok: false, error: 'Faltan parámetros: phone y text son requeridos.' });
    }
    let clean = String(phone).replace(/\D/g, '');
    if (clean.startsWith('0')) clean = '58' + clean.slice(1);
    else if (!clean.startsWith('58')) clean = '58' + clean;

    const jid = `${clean}@s.whatsapp.net`;
    await liveSocket.sendMessage(jid, { text });

    addMessageLog({
      type: 'outgoing',
      sender: 'Administrador (Panel)',
      phone: clean,
      text,
      status: 'verified',
      reason: 'Mensaje enviado manualmente desde el Panel de Control'
    });

    res.json({ ok: true, message: 'Mensaje enviado con éxito a +' + clean });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check para Railway u otros servicios
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    botStatus,
    connectedNumber,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Interfaz web HTML simple
app.get('/', async (req, res) => {
  let qrHtml = '';
  if (currentQR) {
    const qrDataUrl = currentQRDataUrl || await QRCode.toDataURL(currentQR);
    qrHtml = `
      <div style="background: white; padding: 20px; border-radius: 16px; display: inline-block; box-shadow: 0 4px 20px rgba(0,0,0,0.15);">
        <img src="${qrDataUrl}" style="width: 280px; height: 280px;" alt="Código QR WhatsApp" />
        <p style="margin-top: 15px; font-weight: bold; color: #166534; font-size: 14px;">
          📲 Escanea este código desde WhatsApp en tu teléfono:<br/>
          <span style="font-size: 12px; font-weight: normal; color: #4b5563;">
            Abre WhatsApp &gt; Dispositivos vinculados &gt; Vincular un dispositivo.
          </span>
        </p>
      </div>
    `;
  } else if (botStatus === 'Conectado') {
    qrHtml = `
      <div style="background: #ecfdf5; border: 2px solid #10b981; padding: 25px; border-radius: 16px; color: #065f46; max-width: 400px; margin: 0 auto;">
        <h2 style="margin: 0 0 10px 0; font-size: 22px;">✅ Bot Vinculado y Activo</h2>
        <p style="margin: 0; font-size: 16px;">Línea conectada: <b>+${connectedNumber || '04128353519'}</b></p>
        <p style="margin-top: 10px; font-size: 14px; color: #047857;">Esperando mensajes de verificación en tiempo real...</p>
      </div>
    `;
  } else {
    qrHtml = `<p style="color: #6b7280; font-style: italic;">Iniciando y conectando WhatsApp...</p>`;
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Voy Mototaxi - WhatsApp Bot</title>
      <meta http-equiv="refresh" content="${currentQR ? '15' : '30'}">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: white; text-align: center; padding: 40px 20px; margin: 0; }
        .container { max-width: 550px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 24px; border: 1px solid #334155; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .logo { font-size: 45px; margin-bottom: 5px; }
        h1 { color: #FFD700; margin: 5px 0 10px; font-size: 26px; }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: bold; margin-bottom: 25px; background: ${botStatus === 'Conectado' ? '#059669' : '#d97706'}; }
        .stats { margin-top: 25px; padding-top: 20px; border-top: 1px solid #334155; font-size: 14px; color: #94a3b8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">🏍️</div>
        <h1>Voy Mototaxi Píritu</h1>
        <p style="color: #94a3b8; margin-top: 0;">Central de Verificación Automática</p>
        <div class="badge">Estado: ${botStatus}</div>
        <div>${qrHtml}</div>
        <div class="stats">
          <p>Verificaciones automáticas completadas: <b style="color: #FFD700;">${totalVerifiedCount}</b></p>
          <p style="font-size: 12px; color: #64748b;">Sistema activo y sincronizado con Supabase</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🌐 Servidor web de la Central escuchando en http://localhost:${PORT}`);
});

// 4. Conexión del Bot con Baileys
const AUTH_DIR = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`🚀 Iniciando WhatsApp Web Socket (Versión ${version.join('.')} - Latest: ${isLatest})...`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Voy Mototaxi', 'Chrome', '1.0.0'],
    defaultQueryTimeoutMs: undefined,
  });

  liveSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      try {
        currentQRDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {}
      botStatus = 'Esperando escaneo de QR';
      console.log('\n📌 CÓDIGO QR RECIBIDO. Escanéalo en la terminal o en tu panel: http://localhost:5173/verifications');
      QRCode.toString(qr, { type: 'terminal', small: true }, (err, qrStr) => {
        if (!err && qrStr) console.log(qrStr);
      });
      addMessageLog({
        type: 'system',
        sender: 'Sistema',
        text: 'Código QR generado. Listo para escanear desde WhatsApp > Dispositivos vinculados.',
        status: 'system'
      });
    }

    if (connection === 'close') {
      currentQR = null;
      currentQRDataUrl = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      botStatus = `Desconectado (${statusCode || 'error'})`;
      console.log(`⚠️ Conexión cerrada. Código: ${statusCode}. Reconectando: ${shouldReconnect}`);

      addMessageLog({
        type: 'system',
        sender: 'Sistema',
        text: `Conexión cerrada (Código: ${statusCode || 'desconocido'}). Reconectando: ${shouldReconnect}`,
        status: 'system'
      });

      if (shouldReconnect) {
        setTimeout(startWhatsAppBot, 5000);
      } else {
        console.log('❌ Sesión cerrada por el usuario o desvinculada.');
      }
    } else if (connection === 'open') {
      currentQR = null;
      currentQRDataUrl = null;
      botStatus = 'Conectado';
      connectedNumber = sock.user?.id ? sock.user.id.split(':')[0] : 'Conectado';
      console.log(`\n🎉 ¡CONECTADO CON ÉXITO A WHATSAPP!`);
      console.log(`📱 Número de WhatsApp activo: +${connectedNumber}\n`);

      addMessageLog({
        type: 'system',
        sender: 'WhatsApp Central',
        text: `¡Bot conectado con éxito a la línea +${connectedNumber}! Escuchando mensajes en vivo.`,
        status: 'verified'
      });
    }
  });

  // 5. Procesar mensajes entrantes en tiempo real
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        // Ignorar mensajes enviados por el propio bot
        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        // Ignorar grupos o estados
        if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('broadcast')) continue;

        // Extraer texto del mensaje
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          '';

        const cleanText = messageText.trim();
        if (!cleanText) continue;

        // Extraer remitente (resolviendo WhatsApp LID y Phone Number real)
        const isLid = remoteJid.includes('@lid');
        const remoteRaw = remoteJid.split('@')[0].replace(/\D/g, '');
        const senderPnRaw = msg.key?.senderPn ? msg.key.senderPn.split('@')[0].replace(/\D/g, '') : null;
        const participantPnRaw = msg.key?.participantPn ? msg.key.participantPn.split('@')[0].replace(/\D/g, '') : null;
        
        // Posible teléfono escrito en el texto (ej: "Número: 04121207791")
        const textPhoneMatch = cleanText.match(/(?:04\d{9}|584\d{9})/);
        const textPhone = textPhoneMatch ? textPhoneMatch[0].replace(/\D/g, '') : null;

        const displaySender = senderPnRaw || participantPnRaw || textPhone || remoteRaw;
        console.log(`📩 Mensaje entrante de +${displaySender}${isLid ? ' [WhatsApp LID: ' + remoteRaw + ']' : ''}: "${cleanText}"`);

        // Buscar patrón de código VOY-XXXX (ej: VOY-7492)
        const codeMatch = cleanText.match(/VOY-\d{4}/i);

        if (codeMatch) {
          const code = codeMatch[0].toUpperCase();
          await processVerification({ 
            sock, 
            remoteJid, 
            senderRaw: displaySender, 
            extraPhones: [remoteRaw, senderPnRaw, participantPnRaw, textPhone].filter(Boolean), 
            code,
            cleanText
          });
        } else if (process.env.ENABLE_AUTO_WELCOME === 'true' && /hola|buenas|informacion|registro|voy/i.test(cleanText)) {
          await sendWelcomeReply({ sock, remoteJid });
          addMessageLog({
            sender: `+${displaySender}`,
            phone: displaySender,
            text: cleanText,
            status: 'info',
            reason: 'Saludo de bienvenida enviado',
            reply: '👋 ¡Hola! Te has comunicado con la línea oficial de Voy Mototaxi...'
          });
        } else {
          // MODO QUIRÚRGICO: Registrar en el feed del panel para monitoreo pero NO responder nada por privacidad
          addMessageLog({
            sender: `+${displaySender}`,
            phone: displaySender,
            text: cleanText,
            status: 'ignored',
            reason: 'Conversación personal/privada ignorada (Modo Quirúrgico)',
            reply: '(Sin respuesta por privacidad)'
          });
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje entrante:', err);
    }
  });
}

// 6. Procesar y aprobar verificación en Supabase
async function processVerification({ sock, remoteJid, senderRaw, extraPhones = [], code, cleanText }) {
  try {
    console.log(`🔍 Buscando verificación pendiente para código ${code} y emisor +${senderRaw}...`);

    // Crear variantes de todos los teléfonos detectados
    const allCandidates = [senderRaw, ...extraPhones];
    const possiblePhonesSet = new Set();
    for (const ph of allCandidates) {
      if (!ph) continue;
      possiblePhonesSet.add(ph);
      let withoutCountry = ph.startsWith('58') ? ph.slice(2) : ph;
      possiblePhonesSet.add('0' + withoutCountry);
      possiblePhonesSet.add('58' + withoutCountry);
      possiblePhonesSet.add(withoutCountry);
    }
    const possiblePhones = Array.from(possiblePhonesSet);

    // Buscar en phone_verifications por código y teléfono
    let { data: verRow, error: verErr } = await supabase
      .from('phone_verifications')
      .select('*')
      .eq('code', code)
      .in('phone', possiblePhones)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (verErr) {
      console.error('Error consultando Supabase:', verErr);
      return;
    }

    if (!verRow) {
      // Verificar si el código existe pero pertenece a otro número de teléfono registrado
      const { data: mismatchRow } = await supabase
        .from('phone_verifications')
        .select('*')
        .eq('code', code)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (mismatchRow) {
        console.log(`🚫 RECHAZADO: El código ${code} fue solicitado para ${mismatchRow.full_name} (${mismatchRow.phone}), pero fue enviado desde otra línea (+${senderRaw}).`);
        const rejectText = `🚫 *Verificación Rechazada - Voy Mototaxi*\n\nEl código *${code}* fue solicitado para el número *${mismatchRow.phone}*, pero estás enviando el mensaje desde otra línea (+${senderRaw}).\n\n🔒 *Por motivos de seguridad:* Debes enviar el código directamente desde el WhatsApp correspondiente al número que ingresaste en la app.`;
        await sock.sendMessage(remoteJid, { text: rejectText });

        addMessageLog({
          sender: `+${senderRaw}`,
          phone: senderRaw,
          text: cleanText,
          status: 'rejected',
          reason: `Rechazado por seguridad: El código ${code} pertenece a ${mismatchRow.phone}, no a +${senderRaw}`,
          reply: rejectText
        });
        return;
      }

      console.log(`⚠️ Código ${code} no encontrado o inexistente para +${senderRaw}`);
      const invalidText = `⚠️ *Voy Mototaxi*\n\nEl código *${code}* no es válido o ha expirado.\n\nPor favor abre la app de *Voy* en tu teléfono, ingresa tus datos y genera un código nuevo.`;
      await sock.sendMessage(remoteJid, { text: invalidText });

      addMessageLog({
        sender: `+${senderRaw}`,
        phone: senderRaw,
        text: cleanText,
        status: 'invalid',
        reason: `Código ${code} no encontrado en la base de datos o ya expiró`,
        reply: invalidText
      });
      return;
    }

    const now = new Date().toISOString();

    // Si ya estaba verificado
    if (verRow.is_verified) {
      console.log(`ℹ️ El código ${code} ya había sido verificado anteriormente.`);
      const alreadyText = `✅ *Voy Mototaxi*\n\n¡Hola *${verRow.full_name || 'Usuario'}*! Tu número ya se encuentra verificado en nuestro sistema.\n\nPuedes abrir la app de Voy e iniciar sesión con tu teléfono y contraseña.`;
      await sock.sendMessage(remoteJid, { text: alreadyText });

      addMessageLog({
        sender: verRow.full_name || `+${senderRaw}`,
        phone: verRow.phone,
        text: cleanText,
        status: 'verified',
        reason: `El código ${code} ya estaba verificado previamente`,
        reply: alreadyText
      });
      return;
    }

    // 1. Actualizar phone_verifications a is_verified = true
    const { error: updErr } = await supabase
      .from('phone_verifications')
      .update({
        is_verified: true,
        verified_at: now
      })
      .eq('id', verRow.id);

    if (updErr) {
      console.error('Error actualizando phone_verifications:', updErr);
      return;
    }

    // 2. Actualizar profiles si ya existe un perfil asociado
    const targetPhones = Array.from(new Set([...possiblePhones, verRow.phone]));
    await supabase
      .from('profiles')
      .update({
        is_phone_verified: true,
        phone_verified_at: now
      })
      .in('phone', targetPhones);

    totalVerifiedCount++;
    console.log(`🎯 ¡ÉXITO! Usuario ${verRow.full_name} (${verRow.phone}) verificado automáticamente con código ${code}!`);

    // 3. Responder al usuario en WhatsApp
    const replyText = 
`🏍️ *¡HOLA, ${verRow.full_name ? verRow.full_name.toUpperCase() : 'USUARIO'}!*

✅ *¡Tu número ha sido verificado con éxito en Voy Mototaxi!*

🔑 Código validado: *${code}*
📱 Número confirmado: *+${senderRaw}*

📲 *Ya puedes regresar a la aplicación de Voy:*
Tu cuenta se desbloqueará automáticamente en la pantalla de tu teléfono. ¡Bienvenido a la comunidad!

📍 *Voy Mototaxi — Píritu, Anzoátegui*
_Tu viaje rápido, seguro y confiable._`;

    await sock.sendMessage(remoteJid, { text: replyText });

    addMessageLog({
      sender: verRow.full_name || `+${senderRaw}`,
      phone: verRow.phone,
      text: cleanText,
      status: 'verified',
      reason: `✅ Código ${code} verificado con éxito para ${verRow.full_name} (${verRow.phone})`,
      reply: replyText
    });

  } catch (err) {
    console.error('Error en processVerification:', err);
  }
}

// 7. Respuesta de cortesía para otros mensajes
async function sendWelcomeReply({ sock, remoteJid }) {
  const text = 
`👋 ¡Hola! Te has comunicado con la línea oficial de *Voy Mototaxi Píritu*. 🏍️✨

📲 *¿Deseas registrarte como Pasajero o Conductor?*
1. Abre la aplicación *Voy* en tu teléfono.
2. Ingresa tus datos (Nombre, Teléfono y Contraseña).
3. Toca *"Verificar número con WhatsApp"*. El sistema te generará tu código único de activación y te traerá aquí para confirmarlo automáticamente.

💬 Si necesitas soporte con un operador humano, deja tu consulta y te responderemos en breve.`;

  await sock.sendMessage(remoteJid, { text });
}

// Arrancar el bot
startWhatsAppBot().catch((err) => {
  console.error('Error fatal al iniciar bot:', err);
});
