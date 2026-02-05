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
  "1": { nombre: "Telas", precio: 3000, desc: "paquete x5" },
  "2": { nombre: "Mini telas", precio: 3000, desc: "paquete x8" },
  "3": { nombre: "Redondas", precio: 3000, desc: "paquete x10" }
};

const users = {};
const timers = {};
const msgIds = new Set();

// --- NUEVA FUNCIÓN PARA GENERAR EL MENÚ DE FECHAS ---
function obtenerOpcionesFechas() {
  const opciones = [];
  const hoy = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
  let diasEncontrados = 0;
  let intentoDiferencia = 2; // Empezamos desde hoy + 2 días

  while (diasEncontrados < 6) {
    const fechaTemp = new Date(hoy);
    fechaTemp.setDate(hoy.getDate() + intentoDiferencia);
    
    // Si no es domingo (0), la agregamos
    if (fechaTemp.getDay() !== 0) {
      const iso = fechaTemp.toISOString().split('T')[0];
      const legible = fechaTemp.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
      opciones.push({ iso, legible });
      diasEncontrados++;
    }
    intentoDiferencia++;
  }
  return opciones;
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
      await sendMessage(from, "👋 ¡Hola! Bienvenido a *Arepas Doña Marleny*.\n\n*INFORMACIÓN IMPORTANTE: SOLO SE RECIBE PAGOS EN EFECTIVO*\n\n✍️ Escríbeme tu *Nombre, Apellido y Celular separados por una coma*.\n\nEjemplo: Juan Pérez, 3001234567");
      user.step = "datos";
    }

    else if (user.step === "datos") {
      const partes = text.split(",");
      if (partes.length < 2) {
        return await sendMessage(from, "❌ Formato incorrecto. Usa: Nombre, Teléfono");
      }
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
        if (user.modificando) {
            user.modificando = false;
            await mostrarResumenPedido(from, user);
        } else {
            // --- CAMBIO AQUÍ: MOSTRAR MENÚ DE FECHAS ---
            const opciones = obtenerOpcionesFechas();
            user.listaFechas = opciones;
            let msgFecha = "📅 *Selecciona la fecha de entrega:*\n\n";
            opciones.forEach((f, i) => {
              msgFecha += `${i + 1}️⃣ ${f.legible}\n`;
            });
            msgFecha += "\nResponde solo con el número de la opción.";
            await sendMessage(from, msgFecha);
            user.step = "fecha";
        }
      }
    }

    else if (user.step === "fecha") {
      const idx = parseInt(text) - 1;
      if (isNaN(idx) || idx < 0 || idx >= user.listaFechas.length) {
        return await sendMessage(from, "❌ Opción no válida. Por favor selecciona un número de la lista.");
      }
      user.fecha = user.listaFechas[idx].iso;
      user.modificando = false;
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
        await sendMessage(from, `¿Qué deseas cambiar?\n\n1️⃣ Cambiar Productos/Cantidades\n2️⃣ Cambiar Fecha de entrega\n3️⃣ Cambiar mis Datos (Nombre/Tel)\n4️⃣ Cancelar todo`);
      }
      else if (text === "cancelar") {
        await sendMessage(from, "❌ Pedido cancelado. Escribe *HOLA* para empezar de nuevo.");
        delete users[from];
      }
    }

    else if (user.step === "menu_modificar") {
      user.modificando = true;
      if (text === "1") {
        await mostrarMenuProductos(from);
        user.step = "productos";
      } else if (text === "2") {
        // --- CAMBIO AQUÍ TAMBIÉN PARA MODIFICAR ---
        const opciones = obtenerOpcionesFechas();
        user.listaFechas = opciones;
        let msgFecha = "📅 *Selecciona la nueva fecha de entrega:*\n\n";
        opciones.forEach((f, i) => {
          msgFecha += `${i + 1}️⃣ ${f.legible}\n`;
        });
        await sendMessage(from, msgFecha);
        user.step = "fecha";
      } else if (text === "3") {
        await sendMessage(from, "✍️ Escríbeme tu nuevo *Nombre, Apellido y Celular* (separados por coma):");
        user.step = "datos";
      } else if (text === "4") {
        delete users[from];
        await sendMessage(from, "Pedido cancelado. Escribe *HOLA* para reiniciar.");
      } else {
        await sendMessage(from, "❌ Elige una opción (1-4)");
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

async function enviarAGoogleSheets(user) {
  try {
    const resumenProductos = user.pedido.map(item => `${item.nombre} (${item.cantidad})`).join(", ");
    const resumenCantidades = user.pedido.map(item => item.cantidad).join(", ");
    const totalVenta = user.pedido.reduce((acc, item) => acc + item.subtotal, 0);
    await axios.post(GOOGLE_SHEET_WEBHOOK, {
      nombre: user.nombre,
      telefono: user.telefono,
      pedido: resumenProductos,
      paquetes: resumenCantidades,
      total: totalVenta,
      fechaEntrega: user.fecha
    }, { timeout: 15000 });
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

// Ya no necesitamos fechaValida para la entrada del usuario, pero la dejo por si la necesitas
function fechaValida(fechaTexto) { return true; }

app.listen(PORT, () => console.log(`🤖 Bot Doña Marleny en puerto ${PORT}`));