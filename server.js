import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

const app = express();

// =======================
// ENV
// =======================
const PORT = Number(process.env.PORT || 8080);

// CORS
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://hadeai.agency";

// Voiceflow
// Ex: 68f923843ccaaf1cb3d6b478 (ce ai în URL la /state/<ID>/user/...)
const VF_STATE_ID = process.env.VF_STATE_ID || "";
const VF_API_KEY = process.env.VF_API_KEY || ""; // Bearer token / API key (cum folosești tu acum)
const VF_RUNTIME_BASE = process.env.VF_RUNTIME_BASE || "https://general-runtime.voiceflow.com";

// D-ID
const DID_BASIC_USER = process.env.DID_BASIC_USER || "";
const DID_BASIC_PASS = process.env.DID_BASIC_PASS || "";
const DID_ALLOWED_DOMAIN = process.env.DID_ALLOWED_DOMAIN || "https://hadeai.agency";

// =======================
// Middleware
// =======================
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("combined"));

app.use(
  cors({
    origin: [ALLOWED_ORIGIN],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// =======================
// Health + Root
// =======================
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "hade-avatar-server" });
});

// =======================
// Helpers
// =======================
function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

function didBasicAuthHeader() {
  requireEnv("DID_BASIC_USER", DID_BASIC_USER);
  requireEnv("DID_BASIC_PASS", DID_BASIC_PASS);
  const raw = `${DID_BASIC_USER}:${DID_BASIC_PASS}`;
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${b64}`;
}

function extractVoiceflowReply(traces) {
  // Voiceflow returnează de obicei un array de "traces"
  // noi colectăm toate mesajele text și le concatenăm
  if (!Array.isArray(traces)) return "";

  const parts = [];

  for (const t of traces) {
    if (!t || t.type !== "text") continue;

    // 1) payload.message (cel mai comun)
    if (typeof t?.payload?.message === "string" && t.payload.message.trim()) {
      parts.push(t.payload.message.trim());
      continue;
    }

    // 2) payload.slate.content -> text nodes
    const content = t?.payload?.slate?.content;
    if (Array.isArray(content)) {
      const texts = [];
      for (const block of content) {
        const children = block?.children;
        if (!Array.isArray(children)) continue;
        for (const ch of children) {
          const tx = ch?.text;
          if (typeof tx === "string" && tx.trim()) texts.push(tx.trim());
        }
      }
      if (texts.length) parts.push(texts.join(" "));
    }
  }

  return parts.join("\n").trim();
}

// =======================
// Voiceflow proxy
// POST /vf/reply  { sessionId, userText }
// -> { replyText }
// =======================
app.post("/vf/reply", async (req, res) => {
  try {
    requireEnv("VF_STATE_ID", VF_STATE_ID);
    requireEnv("VF_API_KEY", VF_API_KEY);

    const { sessionId, userText } = req.body || {};

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "sessionId is required (string)" });
    }
    if (!userText || typeof userText !== "string") {
      return res.status(400).json({ error: "userText is required (string)" });
    }

    const url = `${VF_RUNTIME_BASE}/state/${encodeURIComponent(
      VF_STATE_ID
    )}/user/${encodeURIComponent(sessionId)}/interact`;

    const vfBody = {
      request: {
        type: "text",
        payload: userText.trim(),
      },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Dacă tu folosești alt format (ex: API key simplu), spune-mi.
        Authorization: `Bearer ${VF_API_KEY}`,
      },
      body: JSON.stringify(vfBody),
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(r.status).json({
        error: "voiceflow_error",
        status: r.status,
        details: data || { message: "Voiceflow returned non-JSON error" },
      });
    }

    // Voiceflow: data poate fi array direct (traces) sau obiect.
    const traces = Array.isArray(data) ? data : data?.trace || data?.traces || data;

    const replyText = extractVoiceflowReply(traces) || "Îmi pare rău, nu am un răspuns acum.";

    return res.json({ replyText });
  } catch (err) {
    return res.status(500).json({ error: "server_error", message: err.message });
  }
});

// =======================
// D-ID client key (server-side)
// GET /did/client-key -> { clientKey }
// =======================
let cachedClientKey = null;
let cachedAt = 0;

app.get("/did/client-key", async (_req, res) => {
  try {
    // Cache 10 minute ca să nu bați API-ul aiurea
    if (cachedClientKey && Date.now() - cachedAt < 10 * 60 * 1000) {
      return res.json({ clientKey: cachedClientKey, cached: true });
    }

    const authHeader = didBasicAuthHeader();

    // 1) Încearcă GET
    const getR = await fetch("https://api.d-id.com/agents/client-key", {
      method: "GET",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });

    if (getR.ok) {
      const getData = await getR.json().catch(() => ({}));
      const clientKey = getData?.client_key || getData?.clientKey || getData?.key;
      if (clientKey) {
        cachedClientKey = clientKey;
        cachedAt = Date.now();
        return res.json({ clientKey });
      }
    }

    // 2) Dacă nu merge GET, încearcă POST (create)
    const postR = await fetch("https://api.d-id.com/agents/client-key", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        allowed_domains: [DID_ALLOWED_DOMAIN],
      }),
    });

    const postData = await postR.json().catch(() => ({}));

    // Dacă există deja, facem încă un GET și returnăm ce avem
    if (!postR.ok && (postData?.description || "").includes("already exists")) {
      const getR2 = await fetch("https://api.d-id.com/agents/client-key", {
        method: "GET",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
      });
      const getData2 = await getR2.json().catch(() => ({}));
      const clientKey2 = getData2?.client_key || getData2?.clientKey || getData2?.key;
      if (!getR2.ok || !clientKey2) {
        return res.status(502).json({
          error: "did_error",
          message: "Client key exists but could not be fetched",
          details: getData2,
        });
      }
      cachedClientKey = clientKey2;
      cachedAt = Date.now();
      return res.json({ clientKey: clientKey2, note: "fetched_after_exists" });
    }

    if (!postR.ok) {
      return res.status(502).json({
        error: "did_error",
        status: postR.status,
        details: postData,
      });
    }

    const clientKey = postData?.client_key || postData?.clientKey || postData?.key;
    if (!clientKey) {
      return res.status(502).json({
        error: "did_error",
        message: "D-ID did not return a clientKey",
        details: postData,
      });
    }

    cachedClientKey = clientKey;
    cachedAt = Date.now();
    return res.json({ clientKey });
  } catch (err) {
    return res.status(500).json({ error: "server_error", message: err.message });
  }
});

// =======================
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
