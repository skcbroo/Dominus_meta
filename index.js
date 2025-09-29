
const fs = require("fs");//
const express = require("express");
const axios = require("axios");

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const MONITOR_WINDOW_MS = (Number(process.env.MONITOR_WINDOW_HOURS || 8)) * 60 * 60 * 1000;
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ADMIN_LOG_NUMBER = process.env.ADMIN_LOG_NUMBER;

const TEMPLATE_NAME = "dominus_captacao_inicial";
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || "en";
//const ADMIN_TEMPLATE = process.env.ADMIN_TEMPLATE || "dominus_admin_alerta";

// ====== EXPRESS ======
const app = express();
app.use(express.json());

// ====== HELPERS ======
function normalizaTexto(s) {
    return String(s || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toUpperCase();
}
function ehAfirmação(body) {
    const t = normalizaTexto(body);
    return /^(SIM|S|OK|CLARO|POSSO|QUERO|VAMOS|SIM POR FAVOR|SIM, POR FAVOR|POSITIVO|TA|TÁ|BORA|ENVIA|PODE ENVIAR)$/.test(
        t
    );
}
/** Normaliza número BR para E.164 com DDI 55 (ex: 5561999112233) */
function normalizarBrasil(numeroRaw) {
    let n = (numeroRaw || "").replace(/\D/g, "");
    if (!n.startsWith("55")) n = "55" + n;
    n = n.replace(/^55+0*/, "55");
    return n;
}
function primeiroNomeFormatado(nome) {
    if (!nome) return "Cliente";
    const partes = nome.trim().split(/\s+/);
    const primeiro = partes[0].toLowerCase();
    return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ====== ESTADO DE RASTREIO (para correlacionar resas) ======
/** pending: chave = número do lead (E.164) */
const pending = new Map();

// ====== META WRAPPERS ======
const META_BASE = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
const META_HEADERS = {
    Authorization: `Bearer ${META_TOKEN}`,
    "Content-Type": "application/json",
};

async function sendTemplate(toE164, templateName, params = [], lang = TEMPLATE_LANG) {
    const body = {
        messaging_product: "whatsapp",
        to: toE164,
        type: "template",
        template: {
            name: templateName,
            language: { code: lang },
        },
    };
    if (params.length) {
        body.template.components = [
            {
                type: "body",
                parameters: params.map((v) => ({ type: "text", text: String(v) })),
            },
        ];
    }
    return axios.post(META_BASE, body, { headers: META_HEADERS });
}

async function sendText(toE164, text) {
    return axios.post(
        META_BASE,
        { messaging_product: "whatsapp", to: toE164, type: "text", text: { body: text } },
        { headers: META_HEADERS }
    );
}

// ====== HEALTH ======
app.get("/healthz", (_req, res) => {
    res.json({ ok: true, provider: "meta", pending: pending.size });
});

// ====== WEBHOOK (verificação) ======
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

// ====== WEBHOOK (mensagens recebidas) ======
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // 📦 STATUS DE ENTREGA
    if (Array.isArray(value?.statuses)) {
      for (const st of value.statuses) {
        console.log("📦 STATUS:", {
          id: st.id,
          status: st.status,
          to: st.recipient_id,
          errors: st.errors
        });
      }
    }

    // 💬 MENSAGENS RECEBIDAS
    const messages = value?.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const from = msg.from;
        const body =
          msg.text?.body ||
          msg.button?.text ||
          msg.interactive?.button_reply?.title ||
          "";

        const track = pending.get(from);
        console.log("📩 Mensagem recebida:", { from, body });

        if (!track) continue;

        const agora = Date.now();
        if (agora > track.expireAtMs) {
          pending.delete(from);
          continue;
        }

        const msgTimeMs = (msg.timestamp ? Number(msg.timestamp) : 0) * 1000;
        if (msgTimeMs && msgTimeMs < track.sentAtMs) continue;

  try {
  await sendText(
    from,
    "Olá, sou Daniel, assistente virtual da Dominus, como posso ajudá-lo?"
  );
  console.log("🤖 Resposta automática enviada para", from);
} catch (e) {
  console.warn("Falha ao responder lead:", e.response?.data || e.message);
}


        pending.delete(from);
      }
    }
  } catch (e) {
    console.warn("⚠️ Webhook error:", e.message);
  } finally {
    res.sendStatus(200);
  }
});


// ====== DISPARO EM MASSA ======
/**
 * Estrutura esperada por item em ./teste.json:
 * { reclamante: "Nome", telefone: "6199...,6198...", numero_processo: "0001234-56.2023.5.10.0001" }
 */
function paramsTemplateLead({ nome }) {
    // Template Marketing com 1 variável ({{1}} = nome)
    return [nome || "Cliente"];
}

async function enviarMensagemParaNumeros(resultados) {
    for (let i = 0; i < resultados.length; i++) {
        const item = resultados[i];
        const nome = primeiroNomeFormatado(item.reclamante) || `Contato ${i + 1}`;

        const celulares = String(item.telefone || "")
            .split(/[,;]+/)
            .map((s) => s.trim())
            .filter(Boolean);

        if (!celulares.length) continue;

        let enviado = false;

        for (const numeroRaw of celulares) {
            const numero = normalizarBrasil(numeroRaw);

            try {
                // Disparo inicial: TEMPLATE de Marketing
                const resp = await sendTemplate(numero, TEMPLATE_NAME, paramsTemplateLead({ nome }));
                console.log(`📤 Template enviado para ${nome} em ${numero}`, resp.data);

                // Track para capturar a resposta
                pending.set(numero, {
                    sentAtMs: Date.now(),
                    nome,
                    processo: item.numero_processo,
                    numeroDestino: numero,
                    expireAtMs: Date.now() + MONITOR_WINDOW_MS,
                });

                enviado = true;
                break; // já enviou para um válido
            } catch (err) {
                console.log(
                    `❌ Falha ao enviar template para ${numero}:`,
                    err.response?.data || err.message
                );
            }
        }

        if (!enviado) {
            console.log(`🚫 ${nome} — não foi possível enviar para nenhum número.`);
        }

        // Delay aleatório 10–30s + 10s (para suavizar)
        //  const jitter = Math.floor(Math.random() * (20000 - 10000 + 1)) + 10000;
        //await sleep(jitter + 10000);
    }
}

// ====== BOOT ======
app.listen(PORT, async () => {
    console.log(`🌐 HTTP on :${PORT}`);

    if (!META_TOKEN || !PHONE_NUMBER_ID) {
        console.error("❌ META_TOKEN e PHONE_NUMBER_ID são obrigatórios no .env.");
        return;
    }

    try {
        const dados = JSON.parse(fs.readFileSync("./teste.json", "utf-8"));
        await enviarMensagemParaNumeros(dados);
        console.log("✅ Disparo inicial concluído.");
    } catch (e) {
        console.error("⚠️ Não foi possível ler/enviar ./teste.json:", e.message);
    }
});

// ====== LIMPEZA DE TRACKING ======
setInterval(() => {
    const agora = Date.now();
    for (const [chatId, info] of pending) {
        if (agora >= info.expireAtMs) pending.delete(chatId);
    }
}, 30 * 1000);
