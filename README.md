# 🏍️ Voy Mototaxi — Bot de Verificación Automática por WhatsApp

Bot oficial de **Voy Mototaxi Píritu** para verificar automáticamente números telefónicos vía WhatsApp (Cero costo de SMS, 100% anti-fraude y en tiempo real).

---

## 🚀 ¿Cómo funciona?

1. El usuario en la aplicación móvil de Voy toca **"Verificar número con WhatsApp"**.
2. La app le abre WhatsApp con un mensaje pre-llenado dirigido al número oficial `04128353519` con su código único (ej: `VOY-7492`).
3. Al enviar el mensaje, este bot:
   - Lee el número real de quien envió el mensaje desde los servidores de WhatsApp.
   - Extrae el código `VOY-XXXX`.
   - Consulta Supabase para validar la solicitud.
   - Si coincide, actualiza `is_verified = true` en Supabase y le responde al usuario.
4. La app móvil del usuario recibe la señal de Supabase Realtime y se desbloquea al instante.

---

## 💻 ¿Cómo correrlo localmente en tu computadora?

1. Abre una terminal en esta carpeta:
   ```bash
   npm install
   ```
2. Inicia el bot:
   ```bash
   node index.js
   ```
3. Verás un código QR impreso en la terminal y disponible en tu navegador web en:
   👉 **http://localhost:3000**
4. Abre WhatsApp en tu teléfono (`04128353519`), ve a **Dispositivos vinculados > Vincular un dispositivo** y escanea el código QR.
5. ¡Listo! El bot quedará conectado y responderá automáticamente a todas las solicitudes de verificación.

---

## ☁️ ¿Cómo desplegarlo en Railway (Gratis con los $5 de prueba)?

1. Crea un repositorio en tu **GitHub** (privado o público) y sube esta carpeta:
   ```bash
   git init
   git add .
   git commit -m "Voy WhatsApp Bot"
   git remote add origin https://github.com/TU_USUARIO/voy_whatsapp_bot.git
   git push -u origin main
   ```
2. Entra en [Railway.com](https://railway.com) e inicia sesión con tu GitHub.
3. Haz clic en **+ New Project** > **Deploy from GitHub repo** y selecciona tu repositorio `voy_whatsapp_bot`.
4. En la pestaña **Variables** de Railway, agrega:
   - `SUPABASE_URL`: `https://tdhbsctrutzmmzqzinze.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: *(tu clave service_role)*
   - `OFFICIAL_PHONE`: `584128353519`
5. *(Opcional pero recomendado en Railway)*: Añade un **Volume** persistente montado en `/app/auth_info` para que la sesión de WhatsApp nunca se cierre al reiniciar.
6. Abre el enlace público que te da Railway o revisa los logs de despliegue para escanear el QR una sola vez.

---

## 🔒 Seguridad
- Se utiliza la clave `service_role` de Supabase para poder actualizar el estado de los perfiles y solicitudes sin restricciones de RLS.
- No compartas tu archivo `.env` en repositorios públicos.
