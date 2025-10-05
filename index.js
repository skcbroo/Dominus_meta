// index.js esse conta com verificação de nome apos a resposta ()
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
// ====== HISTÓRICO ======
const historicoMensagens = []; // guarda todas as mensagens recebidas

// ====== EXPRESS ======
const app = express();
app.use(express.json());

// ====== HELPERS ======
function normalizarBrasil(numeroRaw) {
  let n = (numeroRaw || "").replace(/\D/g, "");
  if (!n) return "";
  if (!n.startsWith("55")) n = "55" + n;
  return n;
}
function primeiroNomeFormatado(nome) {
  if (!nome) return "Contato";
  const partes = String(nome).trim().split(/\s+/);
  const primeiro = partes[0].toLowerCase();
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1);
}
function extrairPrimeiroNome(s) {
  return String(s || "").trim().split(/\s+/)[0] || "";
}
function normalizaTexto(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}
function nomesConcordam(nomeJson, nomeZap) {
  const norm = (x) =>
    extrairPrimeiroNome(x)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
  if (!nomeJson || !nomeZap) return false;
  return norm(nomeJson) === norm(nomeZap);
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
async function enviarLogADM({ clienteJson, nomeZap, numero, resposta }) {
  if (!ADMIN_NUMBER) {
    console.warn("⚠️ ADMIN_NUMBER não definido no .env");
    return;
  }
  try {
    const textoLog = `📬 *Resposta recebida*
• Nome (JSON): ${clienteJson?.reclamante || "(não informado)"}
• Telefone (JSON): ${clienteJson?.telefone || "(não informado)"}
• Processo: ${clienteJson?.numero_processo || "(não informado)"}
• Nome no WhatsApp: ${nomeZap || "(desconhecido)"}
• Número (WhatsApp): ${numero}
• Resposta: ${resposta || "(vazio)"}`;
    await sendText(ADMIN_NUMBER, textoLog);
    console.log(`📤 Log enviado ao ADM (${ADMIN_NUMBER})`);
  } catch (e) {
    console.error("❌ Falha ao enviar log para ADM:", e.response?.data || e.message);
  }
}

// ====== ESTADO (MAPAS) ======
const clientePorNumero = new Map();    // numeroE164 -> objeto do JSON inteiro
const grupoPorProcesso = new Map();    // numero_processo -> { item, numeros[], idxAtual }

// ====== TENTAR PRÓXIMO NÚMERO QUANDO NOME DIVERGE ======
async function tentarProximoNumeroDoGrupo(proc, skipNumeroAtual) {
  const grupo = grupoPorProcesso.get(proc);
  if (!grupo) return false;

  let idx = grupo.idxAtual;
  while (true) {
    idx += 1;
    if (idx >= grupo.numeros.length) {
      console.log(`🚫 Sem mais números para testar para o processo ${proc}`);
      return false;
    }
    const destino = grupo.numeros[idx];
    if (destino === skipNumeroAtual) continue; // evita reenviar ao mesmo
    grupo.idxAtual = idx;

    // envia template ao próximo candidato
    try {
      const nome = primeiroNomeFormatado(grupo.item.reclamante);
      const resp = await sendTemplate(destino, [nome]);
      console.log(`🔁 Testando próximo número (${destino}) para processo ${proc} →`, resp.data.messages?.[0]?.id);

      // garante mapeamento (respostas futuras caem no mesmo item)
      clientePorNumero.set(destino, grupo.item);
      return true;
    } catch (err) {
      console.error(`❌ Falha ao enviar para próximo número ${destino}`, err.response?.data || err.message);
      // segue tentando o próximo
    }
  }
}

// ====== ENVIO EM MASSA ======
async function enviarMensagemParaNumeros() {
  try {
    const dados = JSON.parse(fs.readFileSync(path.resolve(ARQUIVO), "utf-8"));
    for (let i = 0; i < dados.length; i++) {
      const item = dados[i];
      const nome = primeiroNomeFormatado(item.reclamante) || `Contato ${i + 1}`;

      // pega todos os números do campo telefone
      const setNums = new Set();
      String(item.telefone || "")
        .split(/[,;]+/)
        .map((s) => normalizarBrasil(s.trim()))
        .filter(Boolean)
        .forEach((num) => {
          setNums.add(num);
          // também adiciona versão sem "9" (se existir)
          const sem9 = num.replace(/^55(\d{2})9(\d{8})$/, "55$1$2");
          if (sem9 !== num) setNums.add(sem9);
        });

      const numeros = Array.from(setNums);

      // vincula todos os números ao objeto inteiro (para logs quando responder)
      for (const num of numeros) clientePorNumero.set(num, item);

      // registra grupo por processo (para fallback nº a nº)
      const procKey = item.numero_processo || `idx:${i}`;
      grupoPorProcesso.set(procKey, { item, numeros, idxAtual: 0 });

      // envia ao primeiro candidato (a verificação de nome ocorre ao responder)
      if (numeros[0]) {
        try {
          const resp = await sendTemplate(numeros[0], [nome]);
          console.log(`📤 Template enviado para ${nome} (${numeros[0]}) →`, resp.data.messages?.[0]?.id);
        } catch (err) {
          console.error(`❌ Falha ao enviar para ${nome} (${numeros[0]})`, err.response?.data || err.message);
        }
      }

      // delay entre disparos: 60–120s
      const delay = 60000 + Math.floor(Math.random() * 60001);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } catch (e) {
    console.error("❌ Erro lendo arquivo:", e.message);
  }
}

// ====== WEBHOOK RECEBIMENTO ======
// ====== WEBHOOK RECEBIMENTO ======
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (Array.isArray(value?.messages)) {
      for (const msg of value.messages) {
        const from = msg.from; // E.164 (sem '+')
        let body = "";

        // captura texto/botões/interativos
        if (msg.text?.body) body = msg.text.body;
        if (msg.button?.text) body = msg.button.text;
        if (msg.interactive?.button_reply?.title) body = msg.interactive.button_reply.title;
        if (msg.interactive?.list_reply?.title) body = msg.interactive.list_reply.title;

        const nomeZap = value.contacts?.[0]?.profile?.name || null;
        const clienteJson = clientePorNumero.get(from) || null;

        console.log("📩 Mensagem recebida:", { from, body, nomeZap, vinculadoAoJson: !!clienteJson });

        // historico
        historicoMensagens.push({
          from,
          body,
          nomeZap,
          vinculadoAoJson: !!clienteJson,
          timestamp: new Date().toISOString()
        });
        if (historicoMensagens.length > 1000) historicoMensagens.shift();
        // fim historico

        // 🚫 Se número não está no JSON → ignora (não responde)
        // ====== VIA PASSIVA ======
        if (!clienteJson) {
          console.log("🆕 Lead passivo detectado:", { from, body, nomeZap });

          // checa se já houve interação antes
          const historicoDoNumero = historicoMensagens.filter(m => m.from === from);
          const primeiraMsg = historicoDoNumero.length === 1; // só a inicial

          if (primeiraMsg) {
            // Mensagem inicial de apresentação + pedido de confirmação
            await sendText(
              from,
              `Olá ${primeiroNomeFormatado(nomeZap)}! 👋\n` +
              `Somos especialistas na compra de créditos judiciais trabalhistas.\n\n` +
              `Podemos analisar seu processo e apresentar uma proposta de compra, oferecendo liquidez rápida para você.\n\n` +
              `👉 Gostaria de receber uma proposta? Responda *SIM* ou *NÃO*.`
            );

            await enviarLogADM({
              clienteJson: null,
              nomeZap,
              numero: from,
              resposta: `(lead passivo inicial) → ${body}`,
            });

            continue;
          }

          // Se não é a primeira msg, trata conforme resposta
          if (ehAfirmação(body)) {
            // manda instruções para enviar dados do processo
            await sendText(
              from,
              `Perfeito! ✅ Para agilizar sua proposta, me envie por favor:\n` +
              `• Número do processo\n` +
              `• Seu nome completo\n` +
              `• Valor aproximado a receber`
            );

            await enviarLogADM({
              clienteJson: null,
              nomeZap,
              numero: from,
              resposta: `Lead passivo CONFIRMOU interesse → ${body}`,
            });

          } else if (ehNegacao(body)) {
            await sendText(
              from,
              "Sem problemas 👍. Obrigado pelo contato! Ficamos à disposição caso queira analisar seu processo no futuro."
            );

            await enviarLogADM({
              clienteJson: null,
              nomeZap,
              numero: from,
              resposta: `Lead passivo RECUSOU → ${body}`,
            });

          } else {
            // qualquer outra coisa (áudio, texto solto, emoji, etc.)
            await sendText(
              from,
              "Desculpe, não consegui entender 🤔. Responda apenas *SIM* se quiser receber uma proposta ou *NÃO* para encerrar."
            );

            await enviarLogADM({
              clienteJson: null,
              nomeZap,
              numero: from,
              resposta: `Lead passivo resposta inválida → ${body}`,
            });
          }

          continue; // garante que não caia no fluxo ativo
        }


        // 2) Fluxo normal (SIM / NÃO / outro)
        if (ehAfirmação(body)) {
          await sendText(
            from,
            "Excelente! ✅ Vou encaminhar seus dados para análise. Em breve um analista entrará em contato."
          );
          await enviarLogADM({
            clienteJson,
            nomeZap,
            numero: from,
            resposta: body || "SIM",
          });
        } else if (ehNegacao(body)) {
          await sendText(
            from,
            "Entendo, obrigado pela atenção 🙏. Continuamos à disposição caso mude de ideia."
          );
          await enviarLogADM({
            clienteJson,
            nomeZap,
            numero: from,
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
// ====== ROTA PARA CONSULTAR HISTÓRICO ======
app.get("/mensagens", (_req, res) => {
  res.json(historicoMensagens);
});


// ====== BOOT ======
app.listen(PORT, () => {
  console.log(`🌐 HTTP on :${PORT}`);
  if (!META_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ META_TOKEN e PHONE_NUMBER_ID são obrigatórios no .env.");
  }
});
