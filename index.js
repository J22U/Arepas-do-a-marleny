import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const GOOGLE_SHEET_WEBHOOK = process.env.GOOGLE_SHEET_WEBHOOK;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const PRODUCTOS_INFO = {
  "1": { nombre: "Telas", precio: 3000, desc: "paquete x5" },
  "2": { nombre: "Mini telas", precio: 3000, desc: "paquete x8" },
  "3": { nombre: "Redondas", precio: 3000, desc: "paquete x10" }
};

const users = {};
const timers = {};
const msgIds = new Set();

// --- NUEVA FUNCIÓN PARA GENERAR FECHAS ---
function generarOpcionesFechas() {
  const fechas = [];
  const hoy = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
  
  // Empezamos desde pasado mañana (hoy + 2 días) hasta hoy + 7 días
  for (let i = 2; i <= 7; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() + i);
    const iso = d.toISOString().split('T')[0];
    const legible = d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
    fechas.push({ iso, legible });
  }
  return fechas;
}

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];

  if (!msg || !msg.id || msgIds.has(msg.id)) return res.sendStatus(200);
  msgIds.add(msg.id);
  setTimeout(() => msgIds.delete(msg.id), 10000);

  res.sendStatus(200);

  try {
    const from = msg.from;
    const text = msg.text?.body?.toLowerCase().trim();
    if (!text) return;

    if (timers[from]) clearTimeout(timers[from]);
    timers[from] = setTimeout(async () => {
      if (users[from]) {
        delete users[from];
        await sendMessage(from, "⏰ *Sesión finalizada por inactividad.*");
      }
    }, 5 * 60 * 1000);

    if (text === "hola" || text === "inicio") delete users[from];
    if (!users[from]) users[from] = { step: "saludo" };
    const user = users[from];

    if (user.step === "saludo") {
      await sendMessage(from, "👋 ¡Hola! Bienvenido a *Arepas Doña Marleny*.\n\n*INFO: SOLO PAGOS EN EFECTIVO*\n\n✍️ Escríbeme tu *Nombre, Apellido y Celular* (ej: Juan Pérez, 3001234567)");
      user.step = "datos";
    }

    else if (user.step === "datos") {
      const partes = text.split(",");
      if (partes.length < 2) return await sendMessage(from, "❌ Formato incorrecto. Usa: Nombre, Teléfono");
      user.nombre = partes[0].trim();
      user.telefono = partes[1].trim();
      
      if (user.modificando) {
          user.modificando = false;
          await mostrarResumenPedido(from, user);
      } else {
          await mostrarMenuProductos(from);
          user.step = "productos";
      }
    }

    else if (user.step === "productos") {
      const opciones = text.split(",").map(o => o.trim());
      user.seleccion = opciones.filter(o => PRODUCTOS_INFO[o]);
      if (user.seleccion.length === 0) return await sendMessage(from, "❌ Elige 1, 2 o 3.");

      user.pedido = [];
      user.indiceActual = 0;
      await sendMessage(from, `¿Cuántos *paquetes* de *${PRODUCTOS_INFO[user.seleccion[0]].nombre}* deseas?`);
      user.step = "cantidades";
    }

    else if (user.step === "cantidades") {
      const cantidad = parseInt(text);
      if (isNaN(cantidad) || cantidad <= 0) return await sendMessage(from, "❌ Ingresa un número válido.");

      const infoProd = PRODUCTOS_INFO[user.seleccion[user.indiceActual]];
      user.pedido.push({ nombre: infoProd.nombre, cantidad, subtotal: infoProd.precio * cantidad });
      user.indiceActual++;

      if (user.indiceActual < user.seleccion.length) {
        await sendMessage(from, `¿Cuántos *paquetes* de *${PRODUCTOS_INFO[user.seleccion[user.indiceActual]].nombre}* deseas?`);
      } else {
        if (user.modificando) {
            user.modificando = false;
            await mostrarResumenPedido(from, user);
        } else {
            await mostrarMenuFechas(from, user);
            user.step = "fecha";
        }
      }
    }

    else if (user.step === "fecha") {
      const seleccion = parseInt(text) - 1;
      if (isNaN(seleccion) || !user.opcionesFechas[seleccion]) {
          return await sendMessage(from, "❌ Opción no válida. Elige un número de la lista.");
      }
      user.fecha = user.opcionesFechas[seleccion].iso;
      user.modificando = false;
      await mostrarResumenPedido(from, user);
    }

    else if (user.step === "confirmar") {
      if (text === "si") {
        await sendMessage(from, "⏳ Procesando...");
        const exito = await enviarAGoogleSheets(user);
        if (exito) {
          await sendMessage(from, `🎉 *¡Pedido Confirmado!*\n\n${user.nombre}, entregaremos el ${user.fecha}.`);
          delete users[from];
        } else {
          await sendMessage(from, "❌ Error al guardar. Escribe *SI* para reintentar.");
        }
      } 
      else if (text === "modificar") {
        user.step = "menu_modificar";
        await sendMessage(from, `¿Qué deseas cambiar?\n\n1️⃣ Productos\n2️⃣ Fecha de entrega\n3️⃣ Mis Datos\n4️⃣ Cancelar`);
      }
      else if (text === "cancelar") {
        await sendMessage(from, "❌ Cancelado.");
        delete users[from];
      }
    }

    else if (user.step === "menu_modificar") {
      user.modificando = true;
      if (text === "1") {
        await mostrarMenuProductos(from);
        user.step = "productos";
      } else if (text === "2") {
        await mostrarMenuFechas(from, user);
        user.step = "fecha";
      } else if (text === "3") {
        await sendMessage(from, "✍️ Escríbeme tus nuevos datos (Nombre, Tel):");
        user.step = "datos";
      } else {
        delete users[from];
        await sendMessage(from, "Escribe *HOLA* para reiniciar.");
      }
    }

  } catch (error) {
    console.error("ERROR WEBHOOK:", error.message);
  }
});

// --- FUNCIONES DE APOYO ACTUALIZADAS ---

async function mostrarMenuFechas(from, user) {
  const fechas = generarOpcionesFechas();
  user.opcionesFechas = fechas; // Guardamos en la sesión del usuario
  
  let menu = "📅 *Selecciona la fecha de entrega:*\n\n";
  fechas.forEach((f, i) => {
    menu += `${i + 1}️⃣ ${f.legible}\n`;
  });
  menu += "\nEscribe solo el número de la opción.";
  await sendMessage(from, menu);
}

async function mostrarMenuProductos(from) {
  await sendMessage(from, `Escribe el número de los productos (ej: 1,3):\n\n1️⃣ Telas - $3000\n2️⃣ Mini telas - $3000\n3️⃣ Redondas - $3000`);
}

async function mostrarResumenPedido(from, user) {
  user.step = "confirmar";
  let total = 0;
  let lista = "";
  user.pedido.forEach(item => {
    lista += `• ${item.nombre}: ${item.cantidad} pqts - $${item.subtotal}\n`;
    total += item.subtotal;
  });

  await sendMessage(from, `✅ *RESUMEN*\n\n👤 Cliente: ${user.nombre}\n📞 Tel: ${user.telefono}\n📅 Entrega: ${user.fecha}\n\n🫓 *Detalle:*\n${lista}\n💰 *TOTAL: $${total}*\n\n¿Correcto? Responde *SI*, *MODIFICAR* o *CANCELAR*`);
}

async function enviarAGoogleSheets(user) {
  try {
    const resumenProd = user.pedido.map(i => `${i.nombre} (${i.cantidad})`).join(", ");
    const resumenCant = user.pedido.map(i => i.cantidad).join(", ");
    const totalVenta = user.pedido.reduce((acc, i) => acc + i.subtotal, 0);

    await axios.post(GOOGLE_SHEET_WEBHOOK, {
      nombre: user.nombre,
      telefono: user.telefono,
      pedido: resumenProd,
      paquetes: resumenCant,
      total: totalVenta,
      fechaEntrega: user.fecha
    }, { timeout: 15000 });
    return true;
  } catch (e) { return false; }
}

async function sendMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", to, text: { body: text }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  } catch (e) { console.error("Error envío:", e.message); }
}

app.listen(PORT, () => console.log(`🤖 Bot activo en puerto ${PORT}`));