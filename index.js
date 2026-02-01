import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const PORT = 3000;

// 🔹 Memoria temporal (MVP)
const users = {};

// 🔹 Webhook verificación (Meta)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "EAAUMzUbReZB0BQvcf0ZBVC4wBJquksaElfvLn8tkp49EZBxtLHiqL72QY319GJZC1CIPLX2TMWLZBQaaNHqDZCjlJRjZBwiZBCDE5xzcL1TOlhT9kZB2hScPazM7WqwPwefrvOEDPZCzRKzXmg32R49YKJhhNqR9PfAjJhKnYX3DUfCIV8ZADRxf14hF6Ga2ryZCFOFsJAZDZD";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 🔹 Webhook mensajes
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body?.toLowerCase();

    if (!users[from]) {
      users[from] = { step: "saludo" };
    }

    const user = users[from];

    // 🔹 FLUJO DEL BOT
    if (user.step === "saludo") {
      await sendMessage(
        from,
        "👋 ¡Hola! Bienvenido a *Arepas Doña Marleny*.\n\n✍️ Escríbeme tu *nombre y número de teléfono* separados por coma.\nEjemplo:\nJuan Pérez, 3001234567"
      );
      user.step = "datos";
    }

    else if (user.step === "datos") {
      const partes = text.split(",");

      if (partes.length < 2) {
        await sendMessage(
          from,
          "❌ Formato incorrecto.\nEscribe:\nNombre, Teléfono\nEjemplo:\nJuan Pérez, 3001234567"
        );
        return res.sendStatus(200);
      }

      user.nombre = partes[0].trim();
      user.telefono = partes[1].trim();

      await sendMessage(
        from,
        "🫓 *Presentación de productos*\n\n• Telas → paquete x5\n• Mini telas → paquete x5\n• Redondas → paquete x10\n\n¿Qué deseas pedir?\n\n1️⃣ Telas\n2️⃣ Mini telas\n3️⃣ Redondas\n\n✍️ Puedes escribir por ejemplo: 1,2"
      );

      user.step = "productos";
    }

    else if (user.step === "productos") {
      const opciones = text.split(",").map(o => o.trim());

      const mapa = {
        "1": "Telas",
        "2": "Mini telas",
        "3": "Redondas"
      };

      user.productos = opciones.map(o => mapa[o]).filter(Boolean);

      if (user.productos.length === 0) {
        await sendMessage(from, "❌ Opción no válida. Usa 1, 2 o 3.");
        return res.sendStatus(200);
      }

      user.cantidades = {};
      user.productoActual = 0;

      await sendMessage(
        from,
        `¿Cuántos *paquetes* de *${user.productos[0]}* deseas pedir?`
      );

      user.step = "cantidad_por_producto";
    }

    else if (user.step === "cantidad_por_producto") {
      const producto = user.productos[user.productoActual];
      user.cantidades[producto] = text;

      user.productoActual++;

      if (user.productoActual < user.productos.length) {
        await sendMessage(
          from,
          `¿Cuántos *paquetes* de *${user.productos[user.productoActual]}* deseas pedir?`
        );
      } else {
        await sendMessage(
          from,
          "📅 ¿Para qué fecha deseas la entrega?\n\n⚠️ Recuerda: no hoy ni mañana\nEjemplo: 2026-02-05"
        );
        user.step = "fecha";
      }
    }

    else if (user.step === "fecha") {
      if (!fechaValida(text)) {
        await sendMessage(
          from,
          "❌ Fecha no válida.\nDebe ser desde *pasado mañana* y máximo *7 días*."
        );
        return res.sendStatus(200);
      }

      user.fecha = text;

      let resumen = "";
      for (const prod in user.cantidades) {
        resumen += `• ${prod}: ${user.cantidades[prod]} paquetes\n`;
      }

      await axios.post(
  "https://script.google.com/macros/s/AKfycbxUCeph4iNFmHbOjl2PgumsN_QO4G-ARMwDUDRU2LL7ACGCJKvtahT3lhSwz3lJPhk95g/exec",
  {
    nombre: user.nombre,
    telefono: user.telefono,
    pedido: user.cantidades,
    fechaEntrega: user.fecha
  }
);


      await sendMessage(
        from,
        `✅ *Pedido confirmado*\n\n👤 Nombre: ${user.nombre}\n📞 Teléfono: ${user.telefono}\n\n🫓 Pedido:\n${resumen}\n📅 Fecha: ${user.fecha}\n\n🙏 Gracias por tu pedido`
      );

      delete users[from];
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

// 🔹 Enviar mensajes
async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${901596696381094}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer EAAUMzUbReZB0BQuNLoffAibvPtRAZAVhlG9zRK7lspn35gZBgjwU7CpCXVMSzvM6n5F3XarqHboe3W9BFnsPxZCIcLhYeMg6ogcPWnZCXh0uuUNoh65dgplXtZCoB7QzW05urBVk8CiqJ7kDujaPXDc4zPZCn9mZCy6lUp0FK1FlXqjRjm2RHB5na1JtoXbdmTpXbt2ZA9roU2UA0NR4P2WKLwH15B67vCwiZCy4CxQwDkWeNKWh1bCpOs7Ykri0ByMbLIvV1y2ZCsgRHTCgo8GChuvOhv1`
      }
    }
  );
}

// 🔹 Validar fecha
function fechaValida(fechaTexto) {
  const hoy = new Date();
  const fecha = new Date(fechaTexto);

  const min = new Date();
  min.setDate(hoy.getDate() + 2);

  const max = new Date();
  max.setDate(hoy.getDate() + 7);

  return fecha >= min && fecha <= max;
}

app.listen(PORT, () => {
  console.log(`🤖 Bot activo en puerto ${PORT}`);
});
