// index.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TEMPLATE_NAME = "contato"; // nome do template aprovado
const LANG = "en"; // idioma do template
const ARQUIVO = process.env.ARQUIVO_JSON || "./teste.json"; // lista de contatos
const ADMIN_NUMBER = process.env.ADMIN_NUMBER; // ex: 5561999887766

const META_BASE = `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages`;
const META_HEADERS = {
  Authorization: `Bearer ${META_TOKEN}`,
  "Content-Type": "application/json",
};

// ====== EXPRESS ======
const app = express();
app.use(express.json());

// ====== HELPERS ======
function normalizarBrasil(numeroRaw) {
  let n = (numeroRaw || "").replace(/\D/g, "");
  if (!n.startsWith("55")) n = "55" + n;
  return n;
}

function primeiroNomeFormatado(nome) {
  if (!nome) return "Contato";
  const partes = nome.trim().split(/\s+/);
  const primeiro = partes[0].toLowerCase();
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}

function normalizaTexto(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function ehAfirmação(body) {
  const t = normalizaTexto(body);
  return (
    /^(S+I*M+|S)$/.test(t) ||
    /^OK+$/.test(t) ||
    t.includes("CLARO") ||
    t.includes("VAMOS") ||
    t.includes("QUERO") ||
    t.includes("POSITIVO") ||
    t.includes("ENVIA") ||
    t.includes("PODE ENVIAR")
  );
}

function ehNegacao(body) {
  const t = normalizaTexto(body);
  return (
    t === "N" ||
    t === "NAO" ||
    t === "NÃO" ||
    t.includes("NAO QUERO") ||
    t.includes("NÃO QUERO") ||
    t.includes("OBRIGADO") ||
    t.includes("DESCARTAR") ||
    t.includes("NAO TENHO INTERESSE") ||
    t.includes("NÃO TENHO INTERESSE")
  );
}

// ====== ENVIO ======
async function sendTemplate(toE164, variables = []) {
  return axios.post(
    META_BASE,
    {
      messaging_product: "whatsapp",
      to: toE164,
      type: "template",
      template: {
        name: TEMPLATE_NAME,
        language: { code: LANG },
        components: [
          {
            type: "body",
            parameters: variables.map((v) => ({ type: "text", text: v })),
          },
        ],
      },
    },
    { headers: META_HEADERS }
  );
}

async function sendText(toE164, text) {
  return axios.post(
    META_BASE,
    {
      messaging_product: "whatsapp",
      to: toE164,
      type: "text",
      text: { body: text },
    },
    { headers: META_HEADERS }
  );
}

// ====== LOG ADM ======
async function enviarLogADM({ nome, numero, processo, resposta }) {
  if (!ADMIN_NUMBER) {
    console.warn("⚠️ ADMIN_NUMBER não definido no .env");
    return;
  }
  try {
    const textoLog = `📬 *Resposta recebida*
• Cliente: ${nome || "(desconhecido)"}
• Número: ${numero}
• Processo: ${processo || "(não informado)"}
• Resposta: ${resposta || "(vazio)"}`;

    await sendText(ADMIN_NUMBER, textoLog);
    console.log(`📤 Log enviado ao ADM (${ADMIN_NUMBER})`);
  } catch (e) {
    console.error("❌ Falha ao enviar log para ADM:", e.response?.data || e.message);
  }
}

// ====== MAPA DE PROCESSOS ======
const processoPorNumero = new Map();

// ====== ENVIO EM MASSA ======
async function enviarMensagemParaNumeros() {
  try {
    const dados = JSON.parse(fs.readFileSync(path.resolve(ARQUIVO), "utf-8"));
    for (let i = 0; i < dados.length; i++) {
      const item = dados[i];
      const nome = primeiroNomeFormatado(item.reclamante) || `Contato ${i + 1}`;
      const celular = item.telefone;
      if (!celular) continue;

      const numero = normalizarBrasil(celular);

      // guarda o processo vinculado ao número
      processoPorNumero.set(numero, item.numero_processo);

      try {
        const resp = await sendTemplate(numero, [nome]);
        console.log(
          `📤 Template enviado para ${nome} (${numero}) →`,
          resp.data.messages[0].id
        );
      } catch (err) {
        console.error(
          `❌ Falha ao enviar para ${nome} (${numero})`,
          err.response?.data || err.message
        );
      }

      const delay = 60000 + Math.floor(Math.random() * 60001);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } catch (e) {
    console.error("❌ Erro lendo arquivo:", e.message);
  }
}

// ====== WEBHOOK RECEBIMENTO ======
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (Array.isArray(value?.messages)) {
      for (const msg of value.messages) {
        const from = msg.from;
        let body = "";

        if (msg.text?.body) body = msg.text.body;
        if (msg.button?.text) body = msg.button.text;
        if (msg.interactive?.button_reply?.title)
          body = msg.interactive.button_reply.title;
        if (msg.interactive?.list_reply?.title)
          body = msg.interactive.list_reply.title;

        console.log("📩 Mensagem recebida:", { from, body });

        const nomeContato = primeiroNomeFormatado(
          value.contacts?.[0]?.profile?.name
        );
        const processo = processoPorNumero.get(from) || null;

        if (ehAfirmação(body)) {
          await sendText(
            from,
            "Excelente! ✅ Vou encaminhar seus dados para análise. Em breve um analista entrará em contato."
          );
          await enviarLogADM({
            nome: nomeContato,
            numero: from,
            processo,
            resposta: body || "SIM",
          });
        } else if (ehNegacao(body)) {
          await sendText(
            from,
            "Entendo, obrigado pela atenção 🙏. Continuamos à disposição caso mude de ideia."
          );
          await enviarLogADM({
            nome: nomeContato,
            numero: from,
            processo,
            resposta: body || "NÃO",
          });
        } else {
          await sendText(
            from,
            "Olá! 😊 Responda apenas *SIM* para receber a proposta ou *NÃO* para encerrar o contato."
          );
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ Webhook error:", e.message);
  } finally {
    res.sendStatus(200);
  }
});

// ====== VERIFICAÇÃO DE WEBHOOK ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== ROTAS HTTP ======
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, provider: "meta" });
});

app.get("/send-all", async (_req, res) => {
  enviarMensagemParaNumeros();
  res.json({ ok: true, started: true });
});

// ====== BOOT ======
app.listen(PORT, () => {
  console.log(`🌐 HTTP on :${PORT}`);
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ META_TOKEN e PHONE_NUMBER_ID são obrigatórios no .env.");
  }
});
