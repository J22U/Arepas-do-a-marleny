import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔹 Configuración
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const GOOGLE_SHEET_WEBHOOK = process.env.GOOGLE_SHEET_WEBHOOK;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 🔹 Precios y Productos
const PRODUCTOS_INFO = {
  "1": { nombre: "Telas", precio: 5000, desc: "paquete x5" },
  "2": { nombre: "Mini telas", precio: 4000, desc: "paquete x5" },
  "3": { nombre: "Redondas", precio: 6000, desc: "paquete x10" }
};

const users = {};
const timers = {};
const msgIds = new Set();

function obtenerEmoji(numero) {
  const mapping = {
    '0': '0️⃣', '1': '1️⃣', '2': '2️⃣', '3': '3️⃣', '4': '4️⃣',
    '5': '5️⃣', '6': '6️⃣', '7': '7️⃣', '8': '8️⃣', '9': '9️⃣'
  };
  return numero.toString().split('').map(d => mapping[d]).join('');
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
        await sendMessage(from, "⏰ *Sesión finalizada por inactividad.*\n\nSi deseas hacer un pedido, escribe *HOLA* de nuevo.");
      }
    }, 5 * 60 * 1000);

    if (text === "hola" || text === "inicio") delete users[from];
    if (!users[from]) users[from] = { step: "saludo" };
    const user = users[from];

    if (user.step === "saludo") {
      await sendMessage(from, "👋 ¡Hola! Bienvenido a *Arepas Doña Marleny*.\n\n✍️ Escríbeme tu *Nombre, Apellido y Celular separados por una coma*.\n\nEjemplo: Juan Pérez, 3001234567");
      user.step = "datos";
    }

    else if (user.step === "datos") {
      const partes = text.split(",");
      if (partes.length < 2) {
        return await sendMessage(from, "❌ Formato incorrecto. Usa: Nombre, Teléfono");
      }
      user.nombre = partes[0].trim();
      user.telefono = partes[1].trim();
      await mostrarMenuProductos(from);
      user.step = "productos";
    }

    else if (user.step === "productos") {
      const opciones = text.split(",").map(o => o.trim());
      user.seleccion = opciones.filter(o => PRODUCTOS_INFO[o]);

      if (user.seleccion.length === 0) {
        return await sendMessage(from, "❌ Opción no válida. Elige 1, 2 o 3.");
      }

      user.pedido = [];
      user.indiceActual = 0;
      const primerProd = PRODUCTOS_INFO[user.seleccion[0]].nombre;
      await sendMessage(from, `¿Cuántos *paquetes* de *${primerProd}* deseas pedir?`);
      user.step = "cantidades";
    }

    else if (user.step === "cantidades") {
      const cantidad = parseInt(text);
      if (isNaN(cantidad) || cantidad <= 0) {
        return await sendMessage(from, "❌ Por favor, ingresa un número válido de paquetes.");
      }

      const infoProd = PRODUCTOS_INFO[user.seleccion[user.indiceActual]];
      user.pedido.push({
        nombre: infoProd.nombre,
        cantidad: cantidad,
        subtotal: infoProd.precio * cantidad
      });

      user.indiceActual++;

      if (user.indiceActual < user.seleccion.length) {
        const siguienteProd = PRODUCTOS_INFO[user.seleccion[user.indiceActual]].nombre;
        await sendMessage(from, `¿Cuántos *paquetes* de *${siguienteProd}* deseas pedir?`);
      } else {
        await sendMessage(from, "📅 ¿Para qué fecha deseas la entrega?\n\n✅ No se permite *pedido para hoy ni mañana*.\n\nFormato: AAAA-MM-DD\nEjemplo: 2026-02-10");
        user.step = "fecha";
      }
    }

    else if (user.step === "fecha") {
      if (!fechaValida(text)) {
        return await sendMessage(from, "❌ Fecha no válida. Debe ser entre 2 y 7 días a partir de hoy (Formato: AAAA-MM-DD).");
      }
      user.fecha = text;
      await mostrarResumenPedido(from, user);
    }

    else if (user.step === "confirmar") {
      if (text === "si") {
        await sendMessage(from, "⏳ Procesando tu pedido...");
        const exito = await enviarAGoogleSheets(user);
        if (exito) {
          await sendMessage(from, `🎉 *¡Pedido Confirmado!*\n\nGracias ${user.nombre}, estaremos entregando tus arepas el día ${user.fecha}. ¡Buen día!`);
          delete users[from];
          if (timers[from]) clearTimeout(timers[from]);
        } else {
          await sendMessage(from, "❌ Hubo un error al guardar. Escribe *SI* para reintentar.");
        }
      } 
      else if (text === "modificar") {
        user.step = "menu_modificar";
        await sendMessage(from, `¿Qué deseas cambiar?\n\n1️⃣ Cambiar Productos\n2️⃣ Cambiar Fecha\n3️⃣ Reiniciar todo`);
      }
      else if (text === "cancelar") {
        await sendMessage(from, "❌ Pedido cancelado. Escribe *HOLA* para empezar de nuevo.");
        delete users[from];
      }
    }

    else if (user.step === "menu_modificar") {
      if (text === "1") {
        await mostrarMenuProductos(from);
        user.step = "productos";
      } else if (text === "2") {
        await sendMessage(from, "📅 Escribe la nueva fecha (AAAA-MM-DD):");
        user.step = "fecha";
      } else if (text === "3") {
        delete users[from];
        await sendMessage(from, "Escribe *HOLA* para reiniciar.");
      } else {
        await sendMessage(from, "❌ Elige una opción (1-3)");
      }
    }

  } catch (error) {
    console.error("ERROR WEBHOOK:", error.message);
  }
});

// --- FUNCIONES DE APOYO ---

async function mostrarMenuProductos(from) {
  await sendMessage(from, `Escribe el número de los productos que deseas (separados por coma):\n\n🫓 *Nuestros Productos*\n\n1️⃣ Telas (${PRODUCTOS_INFO["1"].desc}) — $${PRODUCTOS_INFO["1"].precio}\n2️⃣ Mini telas (${PRODUCTOS_INFO["2"].desc}) — $${PRODUCTOS_INFO["2"].precio}\n3️⃣ Redondas (${PRODUCTOS_INFO["3"].desc}) — $${PRODUCTOS_INFO["3"].precio}\n\nEjemplo: 1,3`);
}

async function mostrarResumenPedido(from, user) {
  user.step = "confirmar";
  let total = 0;
  let lista = "";
  
  user.pedido.forEach(item => {
    lista += `• ${item.nombre}: ${item.cantidad} pqts - $${item.subtotal}\n`;
    total += item.subtotal;
  });

  await sendMessage(from, `✅ *RESUMEN DE TU PEDIDO*\n\n👤 Cliente: ${user.nombre}\n📞 Teléfono: ${user.telefono}\n📅 Entrega: ${user.fecha}\n\n🫓 *Detalle:*\n${lista}\n💰 *TOTAL A PAGAR: $${total}*\n\n¿Los datos son correctos?\n👍 Responde *SI* para confirmar\n🔄 Responde *MODIFICAR*\n❌ Responde *CANCELAR*`);
}

// 🔹 ESTA ES LA FUNCIÓN QUE CORREGIMOS 🔹
async function enviarAGoogleSheets(user) {
  try {
    // Convertimos el objeto en texto legible para la tabla
    const resumenProductos = user.pedido.map(item => `${item.nombre} (${item.cantidad})`).join(", ");
    const resumenCantidades = user.pedido.map(item => item.cantidad).join(", ");
    const totalVenta = user.pedido.reduce((acc, item) => acc + item.subtotal, 0);

    const res = await axios.post(GOOGLE_SHEET_WEBHOOK, {
      nombre: user.nombre,
      telefono: user.telefono,
      pedido: resumenProductos,   // Texto limpio para Columna D
      paquetes: resumenCantidades, // Texto limpio para Columna E
      total: totalVenta,           // Valor para Columna F
      fechaEntrega: user.fecha     // Fecha para Columna G
    }, { timeout: 8000 });
    return true;
  } catch (e) {
    console.error("Error al enviar a Sheets:", e.message);
    return false;
  }
}

async function sendMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", to, text: { body: text }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  } catch (e) { console.error("Error envío:", e.message); }
}

function fechaValida(fechaTexto) {
  const hoy = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
  hoy.setHours(0, 0, 0, 0);

  const min = new Date(hoy);
  min.setDate(min.getDate() + 2);
  const max = new Date(hoy);
  max.setDate(max.getDate() + 7);

  const fechaParts = fechaTexto.split('-');
  if(fechaParts.length !== 3) return false;
  
  const fecha = new Date(fechaTexto + "T00:00:00");
  return fecha >= min && fecha <= max;
}

app.listen(PORT, () => console.log(`🤖 Bot Doña Marleny en puerto ${PORT}`));