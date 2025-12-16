import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "2mb" }));

// IMPORTANT: pune aici domeniul tău Durable
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://hadeai.agency";
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Proxy către n8n VF reply (evită CORS + îți ascunde webhook-ul din frontend)
 * Body așteptat: { sessionId, userText }
 */
app.post("/vf/reply", async (req, res) => {
  try {
    const { sessionId, userText } = req.body || {};
    if (!sessionId || !userText) return res.status(400).json({ error: "Missing sessionId/userText" });

    const r = await fetch(process.env.N8N_VF_REPLY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, userText })
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "vf_proxy_failed", details: String(e?.message || e) });
  }
});

/**
 * Proxy către n8n D-ID get client key (la fel: evită CORS + ascunzi webhook-ul)
 */
app.post("/did/client-key", async (req, res) => {
  try {
    const r = await fetch(process.env.N8N_DID_GET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || {})
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "did_proxy_failed", details: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on :${port}`));
