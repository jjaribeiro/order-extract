import { useState, useRef, useCallback } from "react";

// ─── FIELD DEFINITIONS ───────────────────────────────────────────────────────

const HEADER_FIELDS = [
  { key: "cliente",        label: "Cliente" },
  { key: "num_encomenda",  label: "Nº Encomenda" },
  { key: "data_encomenda", label: "Data Encomenda" },
  { key: "compromisso",    label: "Compromisso" },
  { key: "cabimento",      label: "Cabimento" },
  { key: "num_contrato",   label: "Nº Concurso" },
  { key: "nif_cliente",     label: "NIF Cliente" },
  { key: "morada_entrega",  label: "Morada Entrega" },
];

const LINE_FIELDS = [
  { key: "ref_interna",      label: "Ref. Interna" },
  { key: "cod_artigo",       label: "Cód. Artigo Cliente" },
  { key: "ref_cliente",      label: "Ref. Cliente" },
  { key: "designacao",       label: "Designação" },
  { key: "quantidade_total", label: "Qtd Total" },
  { key: "unidade",          label: "Unidade" },
  { key: "preco_unitario",   label: "Preço Unit. s/IVA" },
  { key: "iva",              label: "IVA (%)" },
  { key: "total_sem_iva",    label: "Total s/IVA" },
  { key: "total_com_iva",    label: "Total c/IVA" },
];

// ─── PROMPT ──────────────────────────────────────────────────────────────────

const PROMPT = `Analisa este documento de nota de encomenda e extrai os dados.
Devolve APENAS JSON válido, sem texto adicional, sem markdown.

IMPORTANTE sobre entregas programadas: alguns artigos têm múltiplas datas de entrega parciais
(ex: "entregar 2000 em 2026-01-29 / entregar 1000 em 2026-02-03").
Quando existirem, inclui-as no array "entregas". Se não houver entregas programadas, o array fica vazio.

Formato JSON:
{
  "cliente": "nome do cliente/entidade emissora",
  "num_encomenda": "número da nota de encomenda",
  "data_encomenda": "data da encomenda",
  "compromisso": "número de compromisso se existir, senão null",
  "cabimento": "número de cabimento se existir, senão null",
  "num_contrato": "número de procedimento/contrato/concurso se existir, senão null",
  "nif_cliente": "NIF/número de contribuinte do cliente/entidade emissora se existir, senão null",
  "morada_entrega": "morada/local de entrega indicado no documento se existir, senão null",
  "linhas": [
    {
      "cod_artigo": "código do artigo do cliente",
      "ref_cliente": "referência do fornecedor/cliente se existir (Refª: ...), senão null",
      "designacao": "descrição completa do artigo",
      "quantidade_total": "quantidade total da linha",
      "unidade": "unidade",
      "preco_unitario": "preço unitário sem IVA",
      "iva": "taxa IVA em %",
      "total_sem_iva": "total sem IVA",
      "total_com_iva": "total com IVA se disponível",
      "entregas": [
        { "data": "YYYY-MM-DD", "quantidade": "quantidade desta entrega" }
      ]
    }
  ]
}

Se um campo não existir usa null.`;

// ─── API CALL ─────────────────────────────────────────────────────────────────

async function callClaude(base64, mediaType, apiKey) {
  const isImage = mediaType.startsWith("image/");
  const content = isImage
    ? [{ type: "image", source: { type: "base64", media_type: mediaType, data: base64 } }, { type: "text", text: PROMPT }]
    : [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }, { type: "text", text: PROMPT }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4000, messages: [{ role: "user", content }] })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Erro API: ${res.status}`);
  }

  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("");
  const clean = text.replace(/```json\s*/g, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    let fixed = clean.replace(/,\s*$/, "");
    const opens = (fixed.match(/[\[{]/g) || []).length;
    const closes = (fixed.match(/[\]}]/g) || []).length;
    let diff = opens - closes;
    while (diff > 0) {
      const lastOpen = Math.max(fixed.lastIndexOf("["), fixed.lastIndexOf("{"));
      fixed += fixed[lastOpen] === "[" ? "]" : "}";
      diff--;
    }
    return JSON.parse(fixed);
  }
}

// ─── REFERENCE MATCHING ───────────────────────────────────────────────────────

// Simple but effective: normalize text and check word overlap
function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordOverlapScore(a, b) {
  const wordsA = new Set(normalize(a).split(" ").filter(w => w.length > 2));
  const wordsB = new Set(normalize(b).split(" ").filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let matches = 0;
  for (const w of wordsA) if (wordsB.has(w)) matches++;
  return matches / Math.max(wordsA.size, wordsB.size);
}

function findBestMatch(description, refCliente, refs, threshold = 0.45) {
  if (!refs.length) return null;

  // 1st priority: exact match on client ref field
  if (refCliente) {
    const normalRef = normalize(refCliente);
    const exactRef = refs.find(r => normalize(r.ref) === normalRef);
    if (exactRef) return { ...exactRef, score: 1, matchType: "ref" };
  }

  // 2nd priority: our ref appears anywhere inside the description text
  if (description) {
    const normalDesc = normalize(description);
    const inDesc = refs.find(r => {
      const normalRef = normalize(r.ref);
      return normalRef.length >= 4 && normalDesc.includes(normalRef);
    });
    if (inDesc) return { ...inDesc, score: 1, matchType: "ref_in_desc" };
  }

  // 3rd priority: description word overlap
  if (!description) return null;
  let best = null;
  let bestScore = 0;
  for (const ref of refs) {
    const score = wordOverlapScore(description, ref.design);
    if (score > bestScore) {
      bestScore = score;
      best = ref;
    }
  }
  return bestScore >= threshold ? { ...best, score: bestScore, matchType: "desc" } : null;
}

function parseRefsFromCSV(text) {
  const lines = text.split("\n").filter(l => l.trim());
  const refs = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/[;,\t]/);
    const ref = parts[0]?.trim().replace(/^"|"$/g, "");
    const design = parts[1]?.trim().replace(/^"|"$/g, "");
    if (ref && design) refs.push({ ref, design });
  }
  return refs;
}

// ─── DATA FLATTENING ─────────────────────────────────────────────────────────

function maxDeliveries(extractions) {
  let max = 0;
  for (const ext of extractions)
    for (const linha of (ext.linhas || []))
      max = Math.max(max, (linha.entregas || []).length);
  return max;
}

function buildRows(extractions, refs) {
  const numDeliveries = maxDeliveries(extractions);
  const rows = [];
  for (const ext of extractions) {
    const header = {
      ficheiro: ext._filename,
      cliente: ext.cliente,
      num_encomenda: ext.num_encomenda,
      data_encomenda: ext.data_encomenda,
      compromisso: ext.compromisso,
      cabimento: ext.cabimento,
      num_contrato: ext.num_contrato,
      nif_cliente: ext.nif_cliente,
      morada_entrega: ext.morada_entrega,
    };
    for (const linha of (ext.linhas || [])) {
      // Try to find internal ref
      const match = refs.length > 0 ? findBestMatch(linha.designacao, linha.ref_cliente, refs) : null;
      const row = {
        ...header,
        ref_interna: match ? match.ref : null,
        _ref_missing: !match, // flag for red highlight
        cod_artigo: linha.cod_artigo,
        ref_cliente: linha.ref_cliente,
        designacao: linha.designacao,
        quantidade_total: linha.quantidade_total,
        unidade: linha.unidade,
        preco_unitario: linha.preco_unitario,
        iva: linha.iva,
        total_sem_iva: linha.total_sem_iva,
        total_com_iva: linha.total_com_iva,
      };
      for (let i = 0; i < numDeliveries; i++) {
        const ent = (linha.entregas || [])[i];
        row[`entrega_${i + 1}_data`] = ent?.data ?? null;
        row[`entrega_${i + 1}_qtd`] = ent?.quantidade ?? null;
      }
      rows.push(row);
    }
  }
  return { rows, numDeliveries };
}

function getActiveKeys(rows, numDeliveries) {
  const allKeys = ["ficheiro", ...HEADER_FIELDS.map(f => f.key), ...LINE_FIELDS.map(f => f.key)];
  for (let i = 1; i <= numDeliveries; i++) allKeys.push(`entrega_${i}_data`, `entrega_${i}_qtd`);
  return allKeys.filter(k => k !== "_ref_missing" && rows.some(r => r[k] != null && r[k] !== ""));
}

function getLabel(key) {
  if (key === "ficheiro") return "Ficheiro";
  const found = [...HEADER_FIELDS, ...LINE_FIELDS].find(f => f.key === key);
  if (found) return found.label;
  const m = key.match(/^entrega_(\d+)_(data|qtd)$/);
  if (m) return m[2] === "data" ? `Entrega ${m[1]} Data` : `Entrega ${m[1]} Qtd`;
  return key;
}

function isDeliveryKey(key) { return /^entrega_\d+_(data|qtd)$/.test(key); }
function isHeaderKey(key) { return key === "ficheiro" || HEADER_FIELDS.some(f => f.key === key); }

// ─── EXPORT TO XLSX (using SheetJS via script tag) ────────────────────────────

function downloadXLSX(extractions, refs) {
  const { rows, numDeliveries } = buildRows(extractions, refs);
  const keys = getActiveKeys(rows, numDeliveries);
  const headers = keys.map(k => getLabel(k));

  // Build worksheet data
  const wsData = [headers];
  const redRows = []; // track which rows need red highlight on ref_interna
  rows.forEach((row, ri) => {
    wsData.push(keys.map(k => row[k] ?? ""));
    if (row._ref_missing) redRows.push(ri + 1); // +1 for header row
  });

  const ws = window.XLSX.utils.aoa_to_sheet(wsData);

  // Header style
  for (let c = 0; c < headers.length; c++) {
    const ref = window.XLSX.utils.encode_cell({ r: 0, c });
    if (ws[ref]) ws[ref].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "1E3A5F" } },
      alignment: { horizontal: "center" }
    };
  }

  // Red highlight on ref_interna cell for missing refs
  const refCol = keys.indexOf("ref_interna");
  if (refCol >= 0) {
    redRows.forEach(ri => {
      const ref = window.XLSX.utils.encode_cell({ r: ri, c: refCol });
      if (!ws[ref]) ws[ref] = { v: "", t: "s" };
      ws[ref].s = {
        fill: { fgColor: { rgb: "FFC7CE" } },
        font: { color: { rgb: "9C0006" } }
      };
    });
  }

  ws["!cols"] = wsData[0].map((h, i) => ({
    wch: Math.max(String(h).length, ...wsData.slice(1).map(r => String(r[i] || "").length), 8)
  }));

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Encomendas");
  window.XLSX.writeFile(wb, "encomendas.xlsx");
}

// ─── STATUS ───────────────────────────────────────────────────────────────────

const STATUS_COLOR = { waiting: "#94a3b8", processing: "#d97706", done: "#16a34a", error: "#dc2626" };
const STATUS_TEXT  = { waiting: "aguarda", processing: "a processar…", done: "extraído ✓", error: "erro ✕" };
let uid = 0;

// ─── APP ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [apiKey, setApiKey]           = useState(() => localStorage.getItem("oe_apikey") || "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKeySetup, setShowKeySetup] = useState(() => !localStorage.getItem("oe_apikey"));
  const [items, setItems]             = useState([]);
  const [extractions, setExtractions] = useState([]);
  const [processing, setProcessing]   = useState(false);
  const [dragOver, setDragOver]       = useState(false);
  const [refs, setRefs]               = useState(() => {
    try { return JSON.parse(localStorage.getItem("oe_refs") || "[]"); } catch { return []; }
  });
  const [refsName, setRefsName]       = useState(() => localStorage.getItem("oe_refs_name") || "");
  const [xlsxReady, setXlsxReady]     = useState(false);
  const fileRef  = useRef();
  const refsRef  = useRef();

  // Load SheetJS once
  useState(() => {
    if (window.XLSX) { setXlsxReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js";
    s.onload = () => setXlsxReady(true);
    document.head.appendChild(s);
  });

  const saveApiKey = () => {
    const key = apiKeyInput.trim();
    if (!key.startsWith("sk-")) return alert("A API key deve começar com 'sk-'");
    localStorage.setItem("oe_apikey", key);
    setApiKey(key);
    setShowKeySetup(false);
  };

  // Load references from Excel/CSV
  const handleRefsFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    try {
      if (ext === "xlsx" || ext === "xls") {
        // Use SheetJS to parse Excel
        const buf = await file.arrayBuffer();
        const wb = window.XLSX.read(buf);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const data = window.XLSX.utils.sheet_to_json(ws, { header: 1 });
        const parsed = [];
        for (let i = 1; i < data.length; i++) {
          const ref = String(data[i][0] || "").trim();
          const design = String(data[i][1] || "").trim();
          if (ref && design) parsed.push({ ref, design });
        }
        localStorage.setItem("oe_refs", JSON.stringify(parsed));
        localStorage.setItem("oe_refs_name", file.name);
        setRefs(parsed);
        setRefsName(file.name);
      } else if (ext === "csv") {
        const text = await file.text();
        const parsed = parseRefsFromCSV(text);
        localStorage.setItem("oe_refs", JSON.stringify(parsed));
        localStorage.setItem("oe_refs_name", file.name);
        setRefs(parsed);
        setRefsName(file.name);
      }
    } catch (e) {
      alert("Erro ao carregar referências: " + e.message);
    }
  };

  const handleFileInput = useCallback((e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setItems(prev => [...prev, ...files.map(f => ({ id: ++uid, file: f, status: "waiting" }))]);
    e.target.value = "";
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f =>
      ["application/pdf", "image/png", "image/jpeg"].includes(f.type)
    );
    if (!files.length) return;
    setItems(prev => [...prev, ...files.map(f => ({ id: ++uid, file: f, status: "waiting" }))]);
  }, []);

  const removeItem = (id) => {
    setItems(prev => prev.filter(i => i.id !== id));
    setExtractions(prev => prev.filter(e => e._id !== id));
  };

  const clearAll = () => { setItems([]); setExtractions([]); };

  const updateItem = (id, patch) => setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));

  const processAll = async () => {
    const pending = items.filter(i => i.status === "waiting");
    if (!pending.length || processing) return;
    setProcessing(true);
    for (const item of pending) {
      updateItem(item.id, { status: "processing" });
      try {
        const base64 = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(item.file);
        });
        const data = await callClaude(base64, item.file.type, apiKey);
        data._filename = item.file.name;
        data._id = item.id;
        setExtractions(prev => [...prev.filter(e => e._id !== item.id), data]);
        updateItem(item.id, { status: "done" });
      } catch (err) {
        updateItem(item.id, { status: "error", errorMsg: err.message });
      }
    }
    setProcessing(false);
  };

  const doneCount    = items.filter(i => i.status === "done").length;
  const pendingCount = items.filter(i => i.status === "waiting").length;
  const canProcess   = pendingCount > 0 && !processing && !!apiKey;

  const { rows: previewRows, numDeliveries } = buildRows(extractions, refs);
  const activeKeys = previewRows.length ? getActiveKeys(previewRows, numDeliveries) : [];
  const missingRefCount = previewRows.filter(r => r._ref_missing).length;

  const s = {
    page: { background: "#f1f5f9", minHeight: "100vh", fontFamily: "'Segoe UI', system-ui, sans-serif", color: "#0f172a" },
    wrap: { maxWidth: 1100, margin: "0 auto", padding: "32px 20px", display: "flex", flexDirection: "column", gap: 20 },
    card: { background: "white", border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" },
    cardHeader: { padding: "10px 16px", borderBottom: "1px solid #f1f5f9", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#64748b", display: "flex", justifyContent: "space-between", alignItems: "center" },
    btn: (bg, disabled) => ({ padding: "11px 22px", borderRadius: 7, border: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, background: bg, color: "white", fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 7 }),
  };

  // ── API KEY SETUP ──
  if (showKeySetup) {
    return (
      <div style={{ ...s.page, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: 36, width: 440, boxShadow: "0 4px 24px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 28, marginBottom: 12, textAlign: "center" }}>🔑</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#1e3a5f", marginBottom: 6, textAlign: "center" }}>Configurar API Key</h2>
          <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20, textAlign: "center", lineHeight: 1.5 }}>
            Precisas de uma API key da Anthropic.<br />
            Vai a <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" style={{ color: "#1e3a5f" }}>console.anthropic.com</a> para obter uma.
          </p>
          <input type="password" placeholder="sk-ant-..." value={apiKeyInput}
            onChange={e => setApiKeyInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && saveApiKey()}
            style={{ width: "100%", padding: "10px 14px", border: "1px solid #e2e8f0", borderRadius: 7, fontSize: 13, fontFamily: "monospace", marginBottom: 12, boxSizing: "border-box" }} />
          <button onClick={saveApiKey} style={{ ...s.btn("#1e3a5f", false), width: "100%", justifyContent: "center" }}>
            Guardar e continuar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={s.wrap}>

        {/* HEADER */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 16, borderBottom: "2px solid #1e3a5f" }}>
          <div style={{ background: "#1e3a5f", borderRadius: 8, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📋</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#1e3a5f" }}>OrderExtract</div>
            <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace" }}>// extração de notas de encomenda → PHC</div>
          </div>
          <button onClick={() => { setShowKeySetup(true); setApiKeyInput(""); }}
            style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 6, padding: "5px 10px", fontSize: 11, color: "#94a3b8", cursor: "pointer" }}>
            🔑 API Key
          </button>
        </div>

        {/* REFERENCES PANEL */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <span>Ficheiro de Referências Internas</span>
            {refs.length > 0 && <span style={{ color: "#16a34a" }}>{refs.length} refs carregadas{refsName ? ` · ${refsName}` : ""}</span>}
          </div>
          <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <input ref={refsRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
              onChange={e => { handleRefsFile(e.target.files[0]); e.target.value = ""; }} />
            <button onClick={() => refsRef.current.click()}
              style={{ ...s.btn("#475569", false), padding: "9px 18px", fontSize: 12 }}>
              {refs.length > 0 ? "↑ Atualizar Referências" : "↑ Carregar Referências (Excel/CSV)"}
            </button>
            {refs.length === 0 && (
              <span style={{ fontSize: 12, color: "#94a3b8" }}>
                Sem ficheiro — a coluna "Ref. Interna" ficará em branco
              </span>
            )}
            {refs.length > 0 && (
              <button onClick={() => { localStorage.removeItem("oe_refs"); localStorage.removeItem("oe_refs_name"); setRefs([]); setRefsName(""); }}
                style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 6, padding: "5px 10px", fontSize: 11, color: "#94a3b8", cursor: "pointer" }}>
                Remover
              </button>
            )}
          </div>
        </div>

        {/* DROP ZONE */}
        <div onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{ border: `2px dashed ${dragOver ? "#1e3a5f" : "#cbd5e1"}`, borderRadius: 10, padding: "28px 20px", textAlign: "center", cursor: "pointer", background: dragOver ? "#f0f5ff" : "white", transition: "all 0.15s", userSelect: "none" }}>
          <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" multiple style={{ display: "none" }} onChange={handleFileInput} />
          <div style={{ fontSize: 24, marginBottom: 6 }}>⬆</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#334155" }}>
            {items.length > 0 ? "Adicionar mais documentos" : "Arraste ou clique para carregar documentos"}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace", marginTop: 3 }}>PDF, PNG, JPG — pode selecionar vários de uma vez</div>
        </div>

        {/* FILE LIST */}
        {items.length > 0 && (
          <div style={s.card}>
            <div style={s.cardHeader}>
              <span>Documentos ({items.length})</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {doneCount > 0 && <span style={{ color: "#16a34a", fontSize: 11 }}>{doneCount} extraído{doneCount !== 1 ? "s" : ""}</span>}
                {pendingCount > 0 && <span style={{ color: "#d97706", fontSize: 11 }}>{pendingCount} por processar</span>}
                <button onClick={clearAll} style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 5, cursor: "pointer", fontSize: 11, color: "#94a3b8", padding: "2px 8px" }}>Limpar tudo</button>
              </div>
            </div>
            {items.map(item => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid #f8fafc" }}>
                <span style={{ fontSize: 18 }}>📄</span>
                <span style={{ fontSize: 13, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.file.name}</span>
                {item.status === "error" && item.errorMsg && (
                  <span style={{ fontSize: 11, color: "#dc2626", fontFamily: "monospace", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.errorMsg}>{item.errorMsg}</span>
                )}
                <span style={{ fontSize: 11, fontFamily: "monospace", color: STATUS_COLOR[item.status], flexShrink: 0 }}>{STATUS_TEXT[item.status]}</span>
                <button onClick={() => removeItem(item.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#cbd5e1", fontSize: 13, padding: "3px 6px", borderRadius: 4 }}>✕</button>
              </div>
            ))}
          </div>
        )}

        {/* ACTIONS */}
        {items.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={processAll} disabled={!canProcess} style={s.btn("#1e3a5f", !canProcess)}>
              {processing
                ? <><span style={{ width: 13, height: 13, border: "2px solid rgba(255,255,255,.3)", borderTopColor: "white", borderRadius: "50%", display: "inline-block", animation: "spin .6s linear infinite" }} />A extrair…</>
                : `→ Extrair${pendingCount > 0 ? ` (${pendingCount} pendente${pendingCount !== 1 ? "s" : ""})` : ""}`}
            </button>
            <button onClick={() => downloadXLSX(extractions, refs)} disabled={doneCount === 0 || !xlsxReady}
              style={s.btn("#15803d", doneCount === 0 || !xlsxReady)}>
              ↓ Exportar Excel{doneCount > 0 ? ` (${doneCount})` : ""}
            </button>
            {missingRefCount > 0 && (
              <span style={{ fontSize: 12, color: "#dc2626", fontFamily: "monospace" }}>
                ⚠ {missingRefCount} linha{missingRefCount !== 1 ? "s" : ""} sem ref. interna (a vermelho no Excel)
              </span>
            )}
          </div>
        )}

        {/* PREVIEW TABLE */}
        <div style={s.card}>
          <div style={s.cardHeader}>
            <span>Pré-visualização — 1 linha por artigo</span>
            {previewRows.length > 0 && (
              <span>
                {previewRows.length} linha{previewRows.length !== 1 ? "s" : ""}
                {numDeliveries > 0 ? ` · ${numDeliveries} entrega${numDeliveries > 1 ? "s" : ""} programada${numDeliveries > 1 ? "s" : ""}` : ""}
                {missingRefCount > 0 ? ` · ${missingRefCount} sem ref` : ""}
              </span>
            )}
          </div>
          {previewRows.length > 0 && (
            <div style={{ display: "flex", gap: 16, padding: "8px 16px", borderBottom: "1px solid #f1f5f9", fontSize: 11, flexWrap: "wrap", color: "#64748b" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 12, height: 12, background: "#e0e7ff", borderRadius: 2, display: "inline-block" }} />Cabeçalho</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 12, height: 12, background: "#f0fdf4", borderRadius: 2, display: "inline-block" }} />Artigo</span>
              {numDeliveries > 0 && <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 12, height: 12, background: "#fef9c3", borderRadius: 2, display: "inline-block" }} />Entregas</span>}
              {missingRefCount > 0 && <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 12, height: 12, background: "#ffc7ce", borderRadius: 2, display: "inline-block" }} />Ref. interna em falta</span>}
            </div>
          )}
          {previewRows.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {activeKeys.map(k => (
                      <th key={k} style={{ background: isDeliveryKey(k) ? "#854d0e" : isHeaderKey(k) ? "#312e81" : "#1e3a5f", color: "white", padding: "9px 12px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap", fontFamily: "monospace", fontSize: 10 }}>
                        {getLabel(k)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, ri) => (
                    <tr key={ri}>
                      {activeKeys.map(k => {
                        const isRefMissing = k === "ref_interna" && row._ref_missing;
                        return (
                          <td key={k} style={{
                            padding: "8px 12px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap", fontFamily: "monospace",
                            background: isRefMissing ? "#ffc7ce" : isDeliveryKey(k) ? "#fef9c3" : isHeaderKey(k) ? "#eef2ff" : "#f0fdf4",
                            color: isRefMissing ? "#9c0006" : "#334155"
                          }}>
                            {row[k] ?? ""}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: 48, color: "#cbd5e1", fontSize: 13 }}>Os dados extraídos vão aparecer aqui</div>
          )}
        </div>

      </div>
    </div>
  );
}
