import React, { useState, useEffect, useMemo, useCallback, useRef, memo, useContext, createContext } from "react";
import {
  Search, Plus, Printer, Trash2, CheckCircle2, Clock, CircleDashed,
  Star, X, Loader2, List, Map as MapIcon, Ban, MapPin,
  BarChart3, ChevronRight, ChevronLeft, TrendingUp, CalendarDays, CalendarClock,
  Lock, Unlock, LogOut, Upload, Shield, ScrollText, Activity, User,
} from "lucide-react";
import { LOTS_DATA, QUADRAS, RUAS, BOULEVARDS, QUADRA_BORDERS, SVG_SIZE } from "./src/data/lotsData";
import {
  SUPA_ON, loadAll, saveUnidade, removeUnidade, savePin, removePin, subscribe, saveAllData,
  saveLog, loadLogs,
} from "./src/lib/supabase";

const PAGE_SIZE = 40; // rows rendered at once — key performance knob

// ---- Brand palette ----
const BRAND = {
  ink: "#232323", inkSoft: "#6B6862",
  yellow: "#F2B705",
  olive: "#5C6B33", oliveBg: "#E7E9D6",
  terracotta: "#BF4B34", terracottaBg: "#F5E1DA",
  amber: "#B47F1F", amberBg: "#F4E7CD",
  steel: "#3D6B8E", steelBg: "#D6E8F4",
  paper: "#FFFFFF", bg: "#F7F6F1", border: "#E7E3D6",
};

const STATUS = {
  pendente:   { label: "Pendente",   color: BRAND.terracotta, bg: BRAND.terracottaBg, icon: CircleDashed },
  agendado:   { label: "Agendado",   color: BRAND.amber,      bg: BRAND.amberBg,      icon: Clock        },
  concluido:  { label: "Concluído",  color: BRAND.olive,      bg: BRAND.oliveBg,      icon: CheckCircle2 },
  dispensado: { label: "Dispensado", color: BRAND.steel,      bg: BRAND.steelBg,      icon: Ban          },
};

// SVG fill colors per status
const STATUS_FILL = {
  pendente:   "#BF4B34",
  agendado:   "#E8A800",
  concluido:  "#5C6B33",
  dispensado: "#3D6B8E",
};

const STORAGE_KEY      = "hidrometro-unidades-v3";
const STORAGE_KEY_PINS = "hidrometro-pins-v1";
const STORAGE_KEY_LOGS = "hidrometro-logs-v1";
const SESSION_KEY_EDIT = "hidrometro-edit-ativo";
const SESSION_KEY_ROLE = "hidrometro-edit-role";

// Usuárias autorizadas a editar (Nayara e Erika) + o Admin (auditoria).
// As senhas vêm de variável de ambiente (chaves privadas):
//   VITE_PASS_NAYARA · VITE_PASS_ERIKA · VITE_PASS_ADMIN
// Os valores abaixo são apenas fallback de desenvolvimento — troque em produção
// (defina no .env.local em desenvolvimento e nas Environment Variables do Vercel em produção).
// role: "editor" = edita os hidrômetros | "admin" = edita + acessa o módulo de Logs.
const EDITORS = [
  { user: "nayara", name: "Nayara", pass: import.meta.env?.VITE_PASS_NAYARA || "nayara2026", role: "editor" },
  { user: "erika",  name: "Erika",  pass: import.meta.env?.VITE_PASS_ERIKA  || "erika2026",  role: "editor" },
  { user: "admin",  name: "Admin",  pass: import.meta.env?.VITE_PASS_ADMIN  || "admin2026",  role: "admin"  },
];
function findEditor(user, pass) {
  const u = String(user).trim().toLowerCase();
  return EDITORS.find(e => e.user === u && e.pass === pass) || null;
}

// Rótulos legíveis dos campos, para descrever o que mudou em cada edição no log.
const FIELD_LABELS = {
  status: "Status", dataAgendada: "Data agendada", dataConcluida: "Data concluída",
  obs: "Observação", prioridade: "Prioridade", numero: "Número", quadra: "Quadra",
  rua: "Rua", label: "Rótulo", area: "Área", x: "Posição", y: "Posição",
};
// Converte um "patch" (campos alterados) em texto para o log de auditoria.
function describePatch(patch) {
  const parts = Object.entries(patch || {}).map(([k, v]) => {
    const label = FIELD_LABELS[k] || k;
    if (k === "status") return `${label} → ${STATUS[v]?.label || v}`;
    if (k === "prioridade") return `${label} → ${v ? "sim" : "não"}`;
    if (v === "" || v == null) return `${label} limpado(a)`;
    return `${label} → ${v}`;
  });
  return parts.join("; ") || "sem alterações";
}

// Contexto de permissão: true = pode editar; false = somente leitura
const EditContext = createContext(false);
function useCanEdit() { return useContext(EditContext); }

// Fast lookups from LOTS_DATA
const LOT_BY_SVGID = new Map(LOTS_DATA.map(l => [l.svgId, l]));
const LOT_BY_KEY   = new Map(LOTS_DATA.map(l => [`${l.quadra}|${l.numero}`, l]));

// Cross-relationship between quadras and vias (para filtros que se obedecem)
const QUADRA_TO_RUAS = {};
const RUA_TO_QUADRAS = {};
LOTS_DATA.forEach(l => {
  if (l.quadra && l.rua) {
    (QUADRA_TO_RUAS[l.quadra] ||= new Set()).add(l.rua);
    (RUA_TO_QUADRAS[l.rua]   ||= new Set()).add(l.quadra);
  }
});

const ALL_VIAS = [...RUAS, ...BOULEVARDS];
const CONDOMINIAL = "condominial"; // valor especial de quadraFilter / pin.area

// Lote mais próximo de um ponto do SVG → sugere a quadra de um pin
function nearestQuadra(x, y, maxDist = 14) {
  let best = null, bestD = Infinity;
  for (const l of LOTS_DATA) {
    if (l.cx == null) continue;
    const d = Math.hypot(l.cx - x, l.cy - y);
    if (d < bestD) { bestD = d; best = l; }
  }
  return bestD <= maxDist ? best.quadra : CONDOMINIAL;
}

function uid() { return `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

function displayName(u) {
  if (u.quadra && u.numero) return `Qd. ${u.quadra}  Lote ${u.numero}`;
  if (u.numero)             return `Lote ${u.numero}`;
  return `Unidade ${u.id}`;
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Percentual concluído com 2 casas decimais (string). base = lotes que serão trocados.
function pctStr(concluido, base) {
  if (!base || base <= 0) return "0,00";
  return (concluido / base * 100).toFixed(2).replace(".", ",");
}

// ---- Helpers de data / agregação temporal (para o dashboard) --------------
const MESES_ABREV = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const DIAS_ABREV  = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function parseISO(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function startOfDay(dt) { return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); }
function endOfDay(dt)   { return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 23, 59, 59, 999); }
function addDays(dt, n) { const d = new Date(dt); d.setDate(d.getDate() + n); return d; }
function mondayOf(dt)   { const d = startOfDay(dt); return addDays(d, -((d.getDay() + 6) % 7)); }
function sameOrBefore(a, b) { return a.getTime() <= b.getTime(); }

// Gera "baldes" (buckets) de um nível dentro de um intervalo.
// level: "dia" | "semana" | "mes". scopedIndex nomeia semanas como "Sem N".
function genBuckets(level, start, end, scoped) {
  const out = [];
  if (level === "dia") {
    let d = startOfDay(start);
    while (sameOrBefore(d, end)) {
      out.push({ level, start: startOfDay(d), end: endOfDay(d),
        label: `${DIAS_ABREV[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}` });
      d = addDays(d, 1);
    }
  } else if (level === "semana") {
    let ws = mondayOf(start), i = 1;
    while (sameOrBefore(ws, end)) {
      const we = endOfDay(addDays(ws, 6));
      out.push({ level, start: ws, end: we,
        label: scoped ? `Sem ${i}` : `${String(ws.getDate()).padStart(2, "0")}/${String(ws.getMonth() + 1).padStart(2, "0")}` });
      ws = addDays(ws, 7); i++;
    }
  } else { // mes
    let d = new Date(start.getFullYear(), start.getMonth(), 1);
    const showYear = start.getFullYear() !== end.getFullYear();
    while (sameOrBefore(d, end)) {
      const me = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      out.push({ level, start: new Date(d), end: me,
        label: MESES_ABREV[d.getMonth()] + (showYear ? `/${String(d.getFullYear()).slice(2)}` : "") });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
  }
  return out;
}

function childLevel(level) { return level === "mes" ? "semana" : level === "semana" ? "dia" : null; }

function formatDatePT(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function sortUnits(a, b) {
  if (a.prioridade !== b.prioridade) return a.prioridade ? -1 : 1;
  const qa = (a.quadra || ""), qb = (b.quadra || "");
  if (qa !== qb) return qa.localeCompare(qb);
  const na = parseInt(a.numero, 10), nb = parseInt(b.numero, 10);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a.numero).localeCompare(String(b.numero));
}

function buildSeed() {
  return LOTS_DATA.map(lot => ({
    id:           lot.svgId,
    svgId:        lot.svgId,
    numero:       lot.numero,
    quadra:       lot.quadra,
    rua:          lot.rua || "",
    viaTipo:      lot.viaTipo || "",
    prioridade:   false,
    status:       "pendente",
    dataAgendada: "",
    dataConcluida:"",
    obs:          "",
  }));
}

// Migrate units saved with an older schema to the current one
function migrateUnit(u) {
  let svgId = u.svgId;
  let quadra = u.quadra || u.letra || "";
  if (!svgId && u.numero) {
    const lot = LOT_BY_KEY.get(`${quadra}|${u.numero}`) ||
                LOTS_DATA.find(l => l.numero === String(u.numero));
    if (lot) { svgId = lot.svgId; quadra = lot.quadra; }
  }
  const lot = svgId ? LOT_BY_SVGID.get(svgId) : null;
  return {
    id: u.id || uid(),
    svgId,
    numero: u.numero,
    quadra,
    rua: u.rua || lot?.rua || "",
    viaTipo: u.viaTipo || lot?.viaTipo || "",
    prioridade: !!u.prioridade,
    status: u.status || "pendente",
    dataAgendada: u.dataAgendada || "",
    dataConcluida: u.dataConcluida || "",
    obs: u.obs || "",
  };
}

// ---------------------------------------------------------------------------
export default function App() {
  const [units, setUnits]               = useState(null);
  const [pins, setPins]                 = useState([]);
  const [query, setQuery]               = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [quadraFilter, setQuadraFilter] = useState("todas");
  const [viaFilter, setViaFilter]       = useState("todas"); // "todas" | rua string
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [showAdd, setShowAdd]           = useState(false);
  const [printMode, setPrintMode]       = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [saving, setSaving]             = useState(false);
  const [view, setView]                 = useState("lista");
  const [selectedMapUnitId, setSelectedMapUnitId] = useState(null);
  // ── Controle de acesso (editor / admin) ─────────────────────────────────────
  const [editor, setEditor] = useState(() => {
    try { return sessionStorage.getItem(SESSION_KEY_EDIT) || null; } catch { return null; }
  });
  const [editorRole, setEditorRole] = useState(() => {
    try { return sessionStorage.getItem(SESSION_KEY_ROLE) || null; } catch { return null; }
  });
  const canEdit = !!editor;
  const isAdmin = editorRole === "admin";
  const [showLogin, setShowLogin] = useState(false);
  const [syncStatus, setSyncStatus] = useState("idle"); // "idle" | "saving" | "ok" | "error"

  // ── Logs de auditoria (quem editou o quê e quando) ──────────────────────────
  const [logs, setLogs] = useState([]);
  // Ref sempre com o nome atual — os handlers de edição (memoizados) leem daqui.
  const editorRef = useRef(editor);
  useEffect(() => { editorRef.current = editor; }, [editor]);

  const logAction = useCallback((acao, alvo, detalhe) => {
    const entry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      editor: editorRef.current || "sistema",
      acao,
      alvo: alvo || "",
      detalhe: detalhe || "",
      criadoEm: new Date().toISOString(),
    };
    setLogs(prev => [entry, ...prev].slice(0, 2000));
    if (SUPA_ON) {
      saveLog(entry).then(r => r?.error && console.warn("[Supabase] log:", r.error.message));
    } else {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_LOGS);
        const arr = raw ? JSON.parse(raw) : [];
        arr.unshift(entry);
        localStorage.setItem(STORAGE_KEY_LOGS, JSON.stringify(arr.slice(0, 2000)));
      } catch { /* ignore */ }
    }
  }, []);

  const enterEdit = useCallback((name, role = "editor") => {
    setEditor(name);
    setEditorRole(role);
    try {
      sessionStorage.setItem(SESSION_KEY_EDIT, name);
      sessionStorage.setItem(SESSION_KEY_ROLE, role);
    } catch { /* ignore */ }
    editorRef.current = name;
    logAction("login", null, `${name} entrou no modo edição${role === "admin" ? " (admin)" : ""}`);
  }, [logAction]);
  const exitEdit = useCallback(() => {
    logAction("logout", null, `${editorRef.current || "Editor"} saiu do modo edição`);
    setEditor(null);
    setEditorRole(null);
    try {
      sessionStorage.removeItem(SESSION_KEY_EDIT);
      sessionStorage.removeItem(SESSION_KEY_ROLE);
    } catch { /* ignore */ }
  }, [logAction]);

  const handleSaveAll = useCallback(async () => {
    if (!SUPA_ON || syncStatus === "saving") return;
    setSyncStatus("saving");
    try {
      await saveAllData(units || [], pins || []);
      setSyncStatus("ok");
      setTimeout(() => setSyncStatus("idle"), 2500);
    } catch (e) {
      console.error("[Supabase] saveAll:", e);
      setSyncStatus("error");
      setTimeout(() => setSyncStatus("idle"), 3000);
    }
  }, [units, pins, syncStatus]);

  // ── Carregar dados (Supabase quando ativo; senão localStorage) ──────────────
  useEffect(() => {
    let cleanup;
    (async () => {
      if (SUPA_ON) {
        try {
          const { units: U, pins: P } = await loadAll();
          setUnits(U.length ? U : buildSeed());
          setPins(P);
          try { setLogs(await loadLogs()); } catch { /* logs indisponíveis */ }
          cleanup = subscribe(async (tbl) => {
            try {
              if (tbl === "logs") { setLogs(await loadLogs()); return; }
              const fresh = await loadAll();
              if (tbl === "unidades") setUnits(fresh.units.length ? fresh.units : buildSeed());
              else setPins(fresh.pins);
            } catch { /* ignore */ }
          });
          return;
        } catch (e) {
          console.warn("[Supabase] indisponível, usando localStorage:", e?.message || e);
        }
      }
      try {
        const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("hidrometro-unidades-v2");
        setUnits(raw ? JSON.parse(raw).map(migrateUnit) : buildSeed());
      } catch { setUnits(buildSeed()); }
      try {
        const rawP = localStorage.getItem(STORAGE_KEY_PINS);
        if (rawP) setPins(JSON.parse(rawP));
      } catch { /* ignore */ }
      try {
        const rawL = localStorage.getItem(STORAGE_KEY_LOGS);
        if (rawL) setLogs(JSON.parse(rawL));
      } catch { /* ignore */ }
    })();
    return () => cleanup?.();
  }, []);

  // Persist units — só no localStorage quando o Supabase NÃO está ativo
  useEffect(() => {
    if (units === null || SUPA_ON) return;
    setSaving(true);
    const t = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(units));
      setSaving(false);
    }, 400);
    return () => clearTimeout(t);
  }, [units]);

  useEffect(() => {
    if (SUPA_ON) return;
    localStorage.setItem(STORAGE_KEY_PINS, JSON.stringify(pins));
  }, [pins]);

  const updateUnit = useCallback((id, patch) => {
    setUnits(prev => {
      const next = prev.map(u => u.id === id ? { ...u, ...patch } : u);
      const u = next.find(x => x.id === id);
      if (u) {
        if (SUPA_ON) saveUnidade(u).then(r => r?.error && console.warn("[Supabase] update:", r.error.message));
        logAction("editar", `Lote ${u.numero || "?"} · Q${u.quadra || "?"}`, describePatch(patch));
      }
      return next;
    });
  }, [logAction]);

  const addUnit = useCallback((lot) => {
    setUnits(prev => {
      if (lot.svgId && prev.some(u => u.svgId === lot.svgId)) return prev;
      const novo = {
        id: uid(), svgId: lot.svgId || "", numero: lot.numero, quadra: lot.quadra,
        rua: lot.rua || "", viaTipo: lot.viaTipo || "",
        prioridade: !!lot.prioridade, status: "pendente",
        dataAgendada: "", dataConcluida: "", obs: "",
      };
      if (SUPA_ON) saveUnidade(novo).then(r => r?.error && console.warn("[Supabase] add:", r.error.message));
      logAction("adicionar", `Lote ${novo.numero || "?"} · Q${novo.quadra || "?"}`, "Nova troca adicionada");
      return [...prev, novo];
    });
  }, [logAction]);

  const deleteUnit = useCallback((id) => {
    setUnits(prev => {
      const u = prev.find(x => x.id === id);
      if (u) logAction("remover", `Lote ${u.numero || "?"} · Q${u.quadra || "?"}`, "Troca removida");
      return prev.filter(x => x.id !== id);
    });
    if (SUPA_ON) removeUnidade(id).then(r => r?.error && console.warn("[Supabase] delete:", r.error.message));
  }, [logAction]);

  // ── Pins ──────────────────────────────────────────────────────────────────
  const addPin = useCallback((pin) => {
    const novo = { id: `p_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, ...pin };
    setPins(prev => [...prev, novo]);
    if (SUPA_ON) savePin(novo).then(r => r?.error && console.warn("[Supabase] pin add:", r.error.message));
    logAction("adicionar", `Pin ${novo.label || "sem rótulo"}`, "Novo pin no mapa");
  }, [logAction]);
  const updatePin = useCallback((id, patch) => {
    setPins(prev => {
      const next = prev.map(p => p.id === id ? { ...p, ...patch } : p);
      const p = next.find(x => x.id === id);
      if (p) {
        if (SUPA_ON) savePin(p).then(r => r?.error && console.warn("[Supabase] pin update:", r.error.message));
        logAction("editar", `Pin ${p.label || "sem rótulo"}`, describePatch(patch));
      }
      return next;
    });
  }, [logAction]);
  const deletePin = useCallback((id) => {
    setPins(prev => {
      const p = prev.find(x => x.id === id);
      if (p) logAction("remover", `Pin ${p.label || "sem rótulo"}`, "Pin removido");
      return prev.filter(x => x.id !== id);
    });
    if (SUPA_ON) removePin(id).then(r => r?.error && console.warn("[Supabase] pin delete:", r.error.message));
  }, [logAction]);

  // Se o admin sair (ou perder o papel), não deixa a view de Logs aberta
  useEffect(() => {
    if (!isAdmin && view === "logs") setView("lista");
  }, [isAdmin, view]);

  // Ao trocar de quadra, se a via atual não existe nela, volta via para "todas" (e vice-versa)
  const selectQuadra = useCallback((q) => {
    setQuadraFilter(q);
    if (q !== "todas" && q !== CONDOMINIAL && viaFilter !== "todas" && !QUADRA_TO_RUAS[q]?.has(viaFilter))
      setViaFilter("todas");
  }, [viaFilter]);

  const selectVia = useCallback((r) => {
    setViaFilter(r);
    if (r !== "todas" && quadraFilter !== "todas" && quadraFilter !== CONDOMINIAL && !RUA_TO_QUADRAS[r]?.has(quadraFilter))
      setQuadraFilter("todas");
  }, [quadraFilter]);

  // Opções de quadra/via visíveis obedecem à seleção oposta (não mostra filtro vazio)
  const visibleQuadras = useMemo(
    () => viaFilter === "todas" ? QUADRAS : QUADRAS.filter(q => RUA_TO_QUADRAS[viaFilter]?.has(q)),
    [viaFilter]
  );
  const visibleVias = useMemo(
    () => (quadraFilter === "todas" || quadraFilter === CONDOMINIAL)
      ? ALL_VIAS
      : ALL_VIAS.filter(r => QUADRA_TO_RUAS[quadraFilter]?.has(r)),
    [quadraFilter]
  );

  const filtered = useMemo(() => {
    if (!units) return [];
    setVisibleCount(PAGE_SIZE); // reset pagination when filters change
    if (quadraFilter === CONDOMINIAL) return []; // só pins condominiais nessa visão
    return units
      .filter(u => statusFilter === "todos"  ? true : u.status === statusFilter)
      .filter(u => quadraFilter === "todas"  ? true : u.quadra === quadraFilter)
      .filter(u => viaFilter    === "todas"  ? true : u.rua === viaFilter)
      .filter(u => priorityOnly             ? u.prioridade : true)
      .filter(u => {
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        return String(u.numero).toLowerCase().includes(q) ||
               String(u.quadra).toLowerCase().includes(q) ||
               String(u.rua).toLowerCase().includes(q);
      })
      .sort(sortUnits);
  }, [units, statusFilter, quadraFilter, viaFilter, priorityOnly, query]);

  // Pins também entram na lista, respeitando os filtros aplicáveis
  const filteredPins = useMemo(() => {
    return pins
      .filter(p => statusFilter === "todos" ? true : p.status === statusFilter)
      .filter(p => {
        if (quadraFilter === "todas") return true;
        if (quadraFilter === CONDOMINIAL) return (p.area || CONDOMINIAL) === CONDOMINIAL;
        return p.area === quadraFilter;
      })
      .filter(p => viaFilter === "todas")   // pins não têm rua
      .filter(p => !priorityOnly)
      .filter(p => {
        if (!query.trim()) return true;
        return String(p.label || "").toLowerCase().includes(query.trim().toLowerCase());
      });
  }, [pins, statusFilter, quadraFilter, viaFilter, priorityOnly, query]);

  const counts = useMemo(() => {
    if (!units) return { total: 0, pendente: 0, agendado: 0, concluido: 0, dispensado: 0, base: 0, prioridadePendente: 0 };
    const c = { total: units.length, pendente: 0, agendado: 0, concluido: 0, dispensado: 0, prioridadePendente: 0 };
    units.forEach(u => {
      if (c[u.status] !== undefined) c[u.status]++;
      if (u.prioridade && u.status !== "concluido" && u.status !== "dispensado") c.prioridadePendente++;
    });
    c.base = c.total - c.dispensado; // lotes que de fato serão trocados
    return c;
  }, [units]);

  // Unidade selecionada no mapa — derivada do estado atual (sempre "viva", não um snapshot)
  const selectedMapUnit = useMemo(
    () => units?.find(u => u.id === selectedMapUnitId) || null,
    [units, selectedMapUnitId]
  );

  if (units === null) {
    return (
      <div style={styles.loadingScreen}>
        <Loader2 className="animate-spin" size={28} color="#232323" />
        <p style={{ fontFamily: "'Poppins', monospace", color: "#6B6862", marginTop: 12 }}>
          carregando cadastro...
        </p>
      </div>
    );
  }

  if (printMode) {
    return <ReportView units={units} counts={counts} onClose={() => setPrintMode(false)} />;
  }

  return (
   <EditContext.Provider value={canEdit}>
    <div style={styles.page}>
      <GlobalStyle />
      <TitleBlock
        counts={counts}
        saving={saving}
        showStats={view === "lista" || view === "mapa"}
        canEdit={canEdit}
        editorName={editor}
        onEnterEdit={() => setShowLogin(true)}
        onExitEdit={exitEdit}
        syncStatus={syncStatus}
        onSaveAll={handleSaveAll}
      />

      {/* View toggle */}
      <div className="view-switch" style={styles.viewSwitch}>
        <button
          style={{ ...styles.viewBtn, ...(view === "lista" ? styles.viewBtnActive : {}) }}
          onClick={() => setView("lista")}
        >
          <List size={14} /> Lista
        </button>
        <button
          style={{ ...styles.viewBtn, ...(view === "mapa" ? styles.viewBtnActive : {}) }}
          onClick={() => setView("mapa")}
        >
          <MapIcon size={14} /> Mapa
        </button>
        <button
          style={{ ...styles.viewBtn, ...(view === "dashboard" ? styles.viewBtnActive : {}) }}
          onClick={() => setView("dashboard")}
        >
          <BarChart3 size={14} /> Dashboard
        </button>
        <button
          style={{ ...styles.viewBtn, ...(view === "calendario" ? styles.viewBtnActive : {}) }}
          onClick={() => setView("calendario")}
        >
          <CalendarDays size={14} /> Calendário
        </button>
        {isAdmin && (
          <button
            style={{ ...styles.viewBtn, ...(view === "logs" ? styles.viewBtnActive : {}) }}
            onClick={() => setView("logs")}
            title="Auditoria — acesso exclusivo do admin"
          >
            <Shield size={14} /> Logs
          </button>
        )}
      </div>

      {view === "logs" && isAdmin ? (
        <AdminLogs logs={logs} />
      ) : view === "dashboard" ? (
        <Dashboard units={units} counts={counts} />
      ) : view === "calendario" ? (
        <Calendar units={units} />
      ) : view === "lista" ? (
        <>
          <div style={styles.toolbar}>
            {/* Search */}
            <div style={styles.searchBox}>
              <Search size={16} color="#6B6862" />
              <input
                style={styles.searchInput}
                placeholder="buscar por lote, quadra ou rua..."
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>

            {/* Status filters */}
            <div style={styles.filterRow}>
              {["todos", "pendente", "agendado", "concluido", "dispensado"].map(f => (
                <button
                  key={f}
                  className="chip"
                  onClick={() => setStatusFilter(f)}
                  style={{ ...styles.filterChip, ...(statusFilter === f ? styles.filterChipActive : {}) }}
                >
                  {f === "todos" ? "Todos" : STATUS[f].label}
                </button>
              ))}
              <button
                className="chip"
                onClick={() => setPriorityOnly(v => !v)}
                style={{ ...styles.filterChip, ...(priorityOnly ? styles.filterChipActive : {}) }}
              >
                <Star size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                Prioridade
              </button>
            </div>

            {/* Quadra filters */}
            <div style={styles.filterRow}>
              <span style={styles.filterGroupLabel}>Quadra:</span>
              <button
                className="chip"
                onClick={() => selectQuadra("todas")}
                style={{ ...styles.filterChip, ...(quadraFilter === "todas" ? styles.filterChipActive : {}) }}
              >
                Todas
              </button>
              {visibleQuadras.map(q => (
                <button
                  key={q}
                  className="chip"
                  onClick={() => selectQuadra(q)}
                  style={{ ...styles.filterChip, ...(quadraFilter === q ? styles.filterChipActive : {}) }}
                >
                  {q}
                </button>
              ))}
              <button
                className="chip"
                onClick={() => selectQuadra(CONDOMINIAL)}
                style={{ ...styles.filterChip, ...(quadraFilter === CONDOMINIAL ? styles.filterChipActive : {}) }}
                title="Pins em áreas comuns / equipamentos condominiais"
              >
                Equip. condominiais
              </button>
            </div>

            {/* Rua / Boulevard filters */}
            <div style={styles.filterRow}>
              <span style={styles.filterGroupLabel}>Via:</span>
              <button
                className="chip"
                onClick={() => selectVia("todas")}
                style={{ ...styles.filterChip, ...(viaFilter === "todas" ? styles.filterChipActive : {}) }}
              >
                Todas
              </button>
              {visibleVias.map(r => (
                <button
                  key={r}
                  className="chip"
                  onClick={() => selectVia(r)}
                  style={{ ...styles.filterChip, ...(viaFilter === r ? styles.filterChipActive : {}) }}
                >
                  {r}
                </button>
              ))}
            </div>

            <div style={styles.actionRow}>
              {canEdit && (
                <button style={styles.btnGhost} onClick={() => setShowAdd(true)}>
                  <Plus size={15} /> Adicionar troca
                </button>
              )}
              <button style={styles.btnPrimary} onClick={() => setPrintMode(true)}>
                <Printer size={15} /> Gerar PDF
              </button>
            </div>
          </div>

          <div style={styles.list}>
            {filtered.length === 0 && filteredPins.length === 0 && (
              <div style={styles.emptyState}>
                <p style={{ margin: 0, fontFamily: "'Poppins', monospace", color: "#6B6862" }}>
                  nenhuma unidade encontrada com esses filtros.
                </p>
              </div>
            )}
            {filteredPins.map(p => (
              <PinRow key={p.id} pin={p} onUpdate={updatePin} onDelete={deletePin} />
            ))}
            {filtered.slice(0, visibleCount).map(u => (
              <UnitRow key={u.id} unit={u} onUpdate={updateUnit} onDelete={deleteUnit} />
            ))}
            {visibleCount < filtered.length && (
              <button
                style={styles.loadMoreBtn}
                onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
              >
                Carregar mais {Math.min(PAGE_SIZE, filtered.length - visibleCount)} lotes
                <span style={styles.loadMoreCount}> ({visibleCount} de {filtered.length})</span>
              </button>
            )}
          </div>
        </>
      ) : (
        <MapView
          units={units}
          pins={pins}
          onUpdate={updateUnit}
          selectedUnit={selectedMapUnit}
          onSelectUnit={(u) => setSelectedMapUnitId(u ? u.id : null)}
          onAddPin={addPin}
          onUpdatePin={updatePin}
          onDeletePin={deletePin}
        />
      )}

      {showAdd && canEdit && (
        <AddModal
          onClose={() => setShowAdd(false)}
          onAdd={addUnit}
          existingSvgIds={new Set(units.map(u => u.svgId).filter(Boolean))}
        />
      )}

      {showLogin && (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onSuccess={(ed) => { enterEdit(ed.name, ed.role); setShowLogin(false); }}
        />
      )}
    </div>
   </EditContext.Provider>
  );
}

// ---------------------------------------------------------------------------
function LoginModal({ onClose, onSuccess }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [erro, setErro] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (busy) return;
    const ed = findEditor(user, pass);
    if (ed) onSuccess(ed);
    else setErro(true);
  };

  return (
    <ModalShell title="Entrar no modo edição" onClose={onClose}>
      <p style={{ fontSize: 12.5, color: "#6B6862", margin: "0 0 6px" }}>
        Somente pessoas autorizadas podem editar. Informe login e senha.
      </p>
      <label style={styles.fieldLabel}>Login</label>
      <input
        style={styles.modalInput}
        value={user}
        autoFocus
        autoCapitalize="none"
        placeholder="nayara, erika ou admin"
        onChange={e => { setUser(e.target.value); setErro(false); }}
        onKeyDown={e => e.key === "Enter" && submit()}
      />
      <label style={styles.fieldLabel}>Senha</label>
      <input
        style={styles.modalInput}
        type="password"
        value={pass}
        placeholder="senha"
        onChange={e => { setPass(e.target.value); setErro(false); }}
        onKeyDown={e => e.key === "Enter" && submit()}
      />
      {erro && (
        <p style={{ fontSize: 12.5, color: BRAND.terracotta, fontWeight: 600, margin: "8px 0 0" }}>
          Login ou senha incorretos.
        </p>
      )}
      <button style={styles.btnPrimaryFull} onClick={submit} disabled={busy}>
        <Unlock size={15} style={{ verticalAlign: -3, marginRight: 4 }} /> {busy ? "Entrando…" : "Entrar"}
      </button>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
function TitleBlock({ counts, saving, showStats = true, canEdit, editorName, onEnterEdit, onExitEdit, syncStatus = "idle", onSaveAll }) {
  // Percentual considerando apenas lotes que serão trocados (exclui dispensados)
  const pct = pctStr(counts.concluido, counts.base);
  const pctNum = counts.base > 0 ? (counts.concluido / counts.base) * 100 : 0;
  const saveLabel = syncStatus === "saving" ? "Salvando…" : syncStatus === "ok" ? "Salvo!" : syncStatus === "error" ? "Erro!" : "Salvar";
  const saveBg = syncStatus === "ok" ? "#2e7d32" : syncStatus === "error" ? "#c0392b" : "#1a73e8";
  return (
    <div className="hero" style={styles.hero}>
      <div className="hero-top-row" style={styles.heroTopRow}>
        <div style={styles.heroBrand}>
          <div style={styles.heroMonogram}>
            <img src="/logo-vm.png" alt="Viana e Moura" style={styles.heroLogoImg} />
          </div>
          <div style={styles.heroBrandText}>
            <span style={styles.heroBrandName}>Viana e Moura</span>
            <span style={styles.heroBrandSub}>Construções</span>
          </div>
        </div>
        <div className="hero-top-right" style={styles.heroTopRight}>
          {canEdit && SUPA_ON && (
            <button
              style={{ ...styles.editOnBtn, background: saveBg, borderColor: saveBg, marginRight: 4 }}
              onClick={onSaveAll}
              disabled={syncStatus === "saving"}
              title="Salvar todas as alterações no servidor"
            >
              {syncStatus === "saving"
                ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
                : syncStatus === "ok"
                  ? <CheckCircle2 size={13} />
                  : <Upload size={13} />}
              {" "}{saveLabel}
            </button>
          )}
          {canEdit ? (
            <button style={styles.editOnBtn} onClick={onExitEdit} title="Sair do modo edição (voltar a somente leitura)">
              <Unlock size={13} /> {editorName ? `Edição · ${editorName}` : "Edição ativa"}
              <LogOut size={13} style={{ marginLeft: 4, opacity: 0.85 }} />
            </button>
          ) : (
            <button style={styles.editOffBtn} onClick={onEnterEdit} title="Entrar no modo edição">
              <Lock size={13} /> Somente leitura
            </button>
          )}
        </div>
      </div>
      <h1 className="hero-title" style={styles.heroTitle}>Recanto das Oliveiras</h1>
      <p style={{ ...styles.heroSubtitle, marginBottom: showStats ? 16 : 0 }}>
        Controle de substituição de hidrômetros · Gleba 06
      </p>
      {showStats && (
        <>
          <div style={styles.heroStatsRow}>
            <StatPill label="Total"       value={counts.total}      color="#F7F6F1" />
            <StatPill label="Pendentes"   value={counts.pendente}   color={BRAND.terracotta} />
            <StatPill label="Agendados"   value={counts.agendado}   color={BRAND.yellow} />
            <StatPill label="Concluídos"  value={counts.concluido}  color={BRAND.olive} />
            <StatPill label="Dispensados" value={counts.dispensado} color={BRAND.steel} />
          </div>
          <div style={styles.progressWrap}>
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${pctNum}%` }} />
            </div>
            <span style={styles.progressLabel}>
              {pct}% trocado · {counts.concluido}/{counts.base} a trocar
              {counts.dispensado > 0 && ` · ${counts.dispensado} dispensados fora do cálculo`}
            </span>
          </div>
          {counts.prioridadePendente > 0 && (
            <div style={styles.priorityBanner}>
              <Star size={13} color="#F0C9BC" fill="#F0C9BC" />
              {counts.prioridadePendente} unidade(s) prioritária(s) pendente(s)
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div style={styles.statPill}>
      <span style={{ ...styles.statValue, color }}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared status selector — also handles the completion-date default.
// Em somente leitura, mostra apenas o status atual como selo (badge).
function StatusSelector({ unit, onUpdate, readOnly }) {
  if (readOnly) {
    const st = STATUS[unit.status] || STATUS.pendente;
    const SIcon = st.icon;
    return (
      <div style={{ ...styles.lotStatusBadge, background: st.bg, color: st.color, borderColor: st.color }}>
        <SIcon size={14} /> {st.label}
      </div>
    );
  }
  const setStatus = (key) => {
    const patch = { status: key };
    if (key === "concluido" && !unit.dataConcluida) patch.dataConcluida = todayISO();
    onUpdate(unit.id, patch);
  };
  return (
    <div style={styles.statusSelector}>
      {Object.entries(STATUS).map(([key, s]) => {
        const active = unit.status === key;
        const SIcon = s.icon;
        return (
          <button
            key={key}
            onClick={() => setStatus(key)}
            style={{
              ...styles.statusBtn,
              borderColor: active ? s.color : "#E7E3D6",
              background:  active ? s.bg : "transparent",
              color:       active ? s.color : "#6B6862",
            }}
          >
            <SIcon size={13} /> {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
const UnitRow = memo(function UnitRow({ unit, onUpdate, onDelete }) {
  const canEdit = useCanEdit();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const st = STATUS[unit.status];
  // Lotes-padrão do cadastro (planilha) não podem ser excluídos — só avulsos
  const isCadastro = LOT_BY_SVGID.has(unit.svgId);

  return (
    <div style={{ ...styles.row, borderLeftColor: st.color }}>
      <div style={styles.rowHeader}>
        <div style={styles.rowTitleGroup}>
          {unit.prioridade && <Star size={13} color="#BF4B34" fill="#BF4B34" />}
          <span style={styles.rowTitle}>{displayName(unit)}</span>
          {unit.rua && <span style={styles.rowVia}>{unit.rua}</span>}
        </div>
        {canEdit && !isCadastro && (
          <button
            onClick={() => confirmDelete ? onDelete(unit.id) : setConfirmDelete(true)}
            onBlur={() => setConfirmDelete(false)}
            style={{ ...styles.iconBtn, color: confirmDelete ? "#BF4B34" : "#9A9488" }}
            title="remover"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <StatusSelector unit={unit} onUpdate={onUpdate} readOnly={!canEdit} />

      {unit.status === "agendado" && (
        <div style={styles.dateRow}>
          <span style={styles.dateLabel}>data agendada:</span>
          <input
            type="date"
            style={styles.dateInput}
            value={unit.dataAgendada}
            disabled={!canEdit}
            onChange={e => onUpdate(unit.id, { dataAgendada: e.target.value })}
          />
        </div>
      )}

      {unit.status === "concluido" && (
        <div style={styles.dateRow}>
          <span style={styles.dateLabel}>data de conclusão:</span>
          <input
            type="date"
            style={styles.dateInput}
            value={unit.dataConcluida}
            disabled={!canEdit}
            onChange={e => onUpdate(unit.id, { dataConcluida: e.target.value })}
          />
        </div>
      )}

      {(canEdit || unit.obs) && (
        <input
          style={styles.obsInput}
          placeholder="observações (opcional)"
          value={unit.obs}
          readOnly={!canEdit}
          onChange={e => onUpdate(unit.id, { obs: e.target.value })}
        />
      )}

      {canEdit && (
        <label style={styles.priorityRow}>
          <input
            type="checkbox"
            checked={unit.prioridade}
            onChange={e => onUpdate(unit.id, { prioridade: e.target.checked })}
          />
          Prioridade
        </label>
      )}
    </div>
  );
}); // end memo(UnitRow)

// ---------------------------------------------------------------------------
const PinRow = memo(function PinRow({ pin, onUpdate, onDelete }) {
  const canEdit = useCanEdit();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const st = STATUS[pin.status] || STATUS.pendente;
  const areaLabel = (!pin.area || pin.area === CONDOMINIAL) ? "Equip. condominial" : `Qd. ${pin.area}`;

  return (
    <div style={{ ...styles.row, borderLeftColor: st.color, background: "#FFFDF3" }}>
      <div style={styles.rowHeader}>
        <div style={styles.rowTitleGroup}>
          <MapPin size={14} color="#B47F1F" />
          <span style={styles.rowTitle}>{pin.label || "Pin sem nome"}</span>
          <span style={styles.rowVia}>{areaLabel}</span>
          <span style={styles.pinTag}>PIN</span>
        </div>
        {canEdit && (
          <button
            onClick={() => confirmDelete ? onDelete(pin.id) : setConfirmDelete(true)}
            onBlur={() => setConfirmDelete(false)}
            style={{ ...styles.iconBtn, color: confirmDelete ? "#BF4B34" : "#9A9488" }}
            title="remover"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <StatusSelector unit={pin} onUpdate={onUpdate} readOnly={!canEdit} />

      {pin.status === "concluido" && (
        <div style={styles.dateRow}>
          <span style={styles.dateLabel}>data de conclusão:</span>
          <input
            type="date"
            style={styles.dateInput}
            value={pin.dataConcluida || ""}
            disabled={!canEdit}
            onChange={e => onUpdate(pin.id, { dataConcluida: e.target.value })}
          />
        </div>
      )}

      {(canEdit || pin.obs) && (
        <input
          style={styles.obsInput}
          placeholder="observações (opcional)"
          value={pin.obs || ""}
          readOnly={!canEdit}
          onChange={e => onUpdate(pin.id, { obs: e.target.value })}
        />
      )}
    </div>
  );
}); // end memo(PinRow)

// ---------------------------------------------------------------------------
function MapView({ units, pins, onUpdate, selectedUnit, onSelectUnit, onAddPin, onUpdatePin, onDeletePin }) {
  const canEdit = useCanEdit();
  const wrapperRef   = useRef(null);   // clipping viewport — receives events
  const containerRef = useRef(null);   // transformed inner div
  const svgHostRef   = useRef(null);   // holds the injected SVG
  const svgElRef     = useRef(null);
  const [svgReady, setSvgReady]   = useState(false);
  const [tf, setTf]               = useState({ x: 0, y: 0, s: 1 });
  const [pinMode, setPinMode]     = useState(false);
  const [draftPin, setDraftPin]   = useState(null); // { x, y }
  const [selectedPin, setSelectedPin] = useState(null);
  const [showQuadras, setShowQuadras] = useState(true);
  const dragging    = useRef(false);
  const didDrag     = useRef(false);
  const lastPt      = useRef({ x: 0, y: 0 });
  const lastTouches = useRef(null);

  const unitBySvgId = useMemo(
    () => new Map(units.filter(u => u.svgId).map(u => [u.svgId, u])),
    [units]
  );

  // ── Load SVG once ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/planta.svg")
      .then(r => r.text())
      .then(text => {
        if (!svgHostRef.current) return;
        svgHostRef.current.innerHTML = text;
        const svgEl = svgHostRef.current.querySelector("svg");
        if (!svgEl) return;
        svgElRef.current = svgEl;
        const w = svgEl.getAttribute("width");
        const h = svgEl.getAttribute("height");
        if (w && h && !svgEl.getAttribute("viewBox"))
          svgEl.setAttribute("viewBox", `0 0 ${parseFloat(w)} ${parseFloat(h)}`);
        svgEl.style.width  = "100%";
        svgEl.style.height = "auto";
        svgEl.style.display = "block";
        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");
        ["g2055", "g13051"].forEach(id => {
          const el = svgEl.getElementById(id);
          if (el) el.style.pointerEvents = "none";
        });
        // Boost lot-number label readability
        svgEl.querySelectorAll("#g2055 text, #g13051 text").forEach(el => {
          const raw = el.style.fontSize || el.getAttribute("font-size") || "2";
          const sz  = parseFloat(raw) || 2;
          el.style.fontSize   = `${sz * 3}px`;
          el.style.fontWeight = "bold";
          el.style.fill       = "#ffffff";
          el.style.paintOrder = "stroke";
          el.style.stroke     = "rgba(0,0,0,0.65)";
          el.style.strokeWidth = `${sz * 1.2}px`;
          el.style.strokeLinejoin = "round";
        });
        setSvgReady(true);
      });
  }, []);

  // ── Paint lots whenever units change (batched via rAF) ────────────────────
  useEffect(() => {
    if (!svgReady || !svgElRef.current) return;
    const raf = requestAnimationFrame(() => {
      svgElRef.current?.querySelectorAll("path.casa").forEach(path => {
        const unit = unitBySvgId.get(path.id);
        // Divisória entre lotes: linha fina e clara em todos os lotes
        if (unit) {
          path.style.fill        = STATUS_FILL[unit.status];
          path.style.fillOpacity = "0.78";
          path.style.cursor      = pinMode ? "crosshair" : "pointer";
          path.style.stroke      = unit.prioridade ? "#FF0000" : "rgba(35,35,35,0.45)";
          path.style.strokeWidth = unit.prioridade ? "1.2" : "0.35";
        } else {
          path.style.fill        = "#cccccc";
          path.style.fillOpacity = "0.25";
          path.style.cursor      = "default";
          path.style.stroke      = "rgba(35,35,35,0.28)";
          path.style.strokeWidth = "0.35";
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [svgReady, unitBySvgId, pinMode]);

  // ── Wheel zoom toward cursor ───────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const rect   = wrapperRef.current.getBoundingClientRect();
    const cx     = e.clientX - rect.left;
    const cy     = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setTf(t => {
      const ns = Math.max(0.25, Math.min(12, t.s * factor));
      const k  = ns / t.s;
      return { s: ns, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
    });
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // ── Pointer drag pan ──────────────────────────────────────────────────────
  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragging.current  = true;
    didDrag.current   = false;
    lastPt.current    = { x: e.clientX, y: e.clientY };
    wrapperRef.current?.setPointerCapture(e.pointerId);
    wrapperRef.current.style.cursor = "grabbing";
  }, []);

  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPt.current.x;
    const dy = e.clientY - lastPt.current.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag.current = true;
    lastPt.current = { x: e.clientX, y: e.clientY };
    setTf(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    if (wrapperRef.current) wrapperRef.current.style.cursor = pinMode ? "crosshair" : "grab";
  }, [pinMode]);

  // ── Touch pinch-zoom + single-finger pan ──────────────────────────────────
  const onTouchStart = useCallback((e) => {
    lastTouches.current = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }));
  }, []);

  const onTouchMove = useCallback((e) => {
    e.preventDefault();
    const cur  = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }));
    const prev = lastTouches.current;
    if (!prev?.length) { lastTouches.current = cur; return; }
    if (cur.length === 1 && prev.length === 1) {
      const dx = cur[0].x - prev[0].x, dy = cur[0].y - prev[0].y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) didDrag.current = true;
      setTf(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
    } else if (cur.length === 2 && prev.length >= 2) {
      const pd = Math.hypot(prev[0].x - prev[1].x, prev[0].y - prev[1].y) || 1;
      const nd = Math.hypot(cur[0].x  - cur[1].x,  cur[0].y  - cur[1].y);
      const factor = nd / pd;
      const rect = wrapperRef.current.getBoundingClientRect();
      const cx = (cur[0].x + cur[1].x) / 2 - rect.left;
      const cy = (cur[0].y + cur[1].y) / 2 - rect.top;
      setTf(t => {
        const ns = Math.max(0.25, Math.min(12, t.s * factor));
        const k  = ns / t.s;
        return { s: ns, x: cx - (cx - t.x) * k, y: cy - (cy - t.y) * k };
      });
    }
    lastTouches.current = cur;
  }, []);

  const onTouchEnd = useCallback(() => { lastTouches.current = null; }, []);

  // Map client coords → SVG user coords (uses rendered rect, so CSS transform ok)
  const clientToSvg = useCallback((clientX, clientY) => {
    const host = svgHostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (clientX - rect.left) / rect.width  * SVG_SIZE.w,
      y: (clientY - rect.top)  / rect.height * SVG_SIZE.h,
    };
  }, []);

  // ── Click on lot / place pin ──────────────────────────────────────────────
  const handleClick = useCallback((e) => {
    if (didDrag.current) { didDrag.current = false; return; }
    if (pinMode) {
      const p = clientToSvg(e.clientX, e.clientY);
      if (p) setDraftPin(p);
      return;
    }
    // elementFromPoint ignora a camada de overlay (pointer-events:none) e é robusto
    // mesmo quando o setPointerCapture redireciona o alvo do evento de clique.
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    // Clique num pin → abre edição do pin (permite mudar status pelo mapa)
    const pinEl = hit?.closest?.("[data-pin-id]");
    if (pinEl) {
      const pin = pins.find(p => p.id === pinEl.getAttribute("data-pin-id"));
      if (pin) { setSelectedPin(pin); return; }
    }
    const path = hit?.closest?.("path.casa") || e.target.closest?.("path.casa");
    if (!path) { onSelectUnit(null); return; }
    const unit = unitBySvgId.get(path.id);
    if (unit) onSelectUnit(unit);
  }, [unitBySvgId, onSelectUnit, pinMode, clientToSvg, pins]);

  const resetView = () => setTf({ x: 0, y: 0, s: 1 });

  return (
    <div style={styles.mapWrap}>
      {/* Legend + controls */}
      <div style={styles.mapLegend}>
        {Object.entries(STATUS).map(([key, s]) => (
          <div key={key} style={styles.legendItem}>
            <span style={{ ...styles.legendSwatch, background: STATUS_FILL[key] }} />
            {s.label}
          </div>
        ))}
        <div style={styles.legendItem}>
          <span style={{ ...styles.legendSwatch, background: "#cccccc", opacity: 0.4 }} />
          Não cadastrado
        </div>
        <div style={styles.mapControls}>
          <button
            style={{ ...styles.mapToggleBtn, ...(showQuadras ? styles.mapToggleActive : {}) }}
            onClick={() => setShowQuadras(v => !v)}
            title="Mostrar/ocultar contorno das quadras"
          >
            Quadras
          </button>
          {canEdit && (
            <button
              style={{ ...styles.mapToggleBtn, ...(pinMode ? styles.mapPinActive : {}) }}
              onClick={() => setPinMode(v => !v)}
              title="Clique no mapa para adicionar um pin"
            >
              <MapPin size={13} /> {pinMode ? "Clique no mapa…" : "Adicionar pin"}
            </button>
          )}
          <button style={styles.mapResetBtn} onClick={resetView} title="Resetar zoom e posição">
            ⟳ Reset
          </button>
        </div>
      </div>

      {/* Viewport */}
      <div
        ref={wrapperRef}
        style={{ ...styles.mapViewport, cursor: pinMode ? "crosshair" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={handleClick}
      >
        <div
          ref={containerRef}
          style={{
            position: "absolute",
            top: 0, left: 0,
            width: "100%",
            transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.s})`,
            transformOrigin: "0 0",
            willChange: "transform",
            userSelect: "none",
          }}
        >
          {/* Injected map SVG */}
          <div ref={svgHostRef} style={{ width: "100%" }} />

          {/* Overlay: quadra outlines + labels + pins (shares SVG coord system) */}
          {svgReady && (
            <svg
              viewBox={`0 0 ${SVG_SIZE.w} ${SVG_SIZE.h}`}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "auto", pointerEvents: "none" }}
            >
              {showQuadras && Object.entries(QUADRA_BORDERS).map(([q, segs]) => (
                <g key={q} stroke="#232323" strokeWidth="1.1" strokeLinecap="round" opacity="0.95">
                  {segs.map((s, i) => (
                    <line key={i} x1={s[0][0]} y1={s[0][1]} x2={s[1][0]} y2={s[1][1]} />
                  ))}
                </g>
              ))}
              {/* Pins */}
              {pins.map(p => {
                const color = p.status ? STATUS_FILL[p.status] : "#232323";
                return (
                  <g
                    key={p.id}
                    data-pin-id={p.id}
                    transform={`translate(${p.x},${p.y})`}
                    style={{ pointerEvents: "auto", cursor: "pointer" }}
                    onClick={(ev) => { ev.stopPropagation(); setSelectedPin(p); }}
                  >
                    {/* alvo de toque invisível maior, para facilitar no celular */}
                    <circle cx="0" cy="-8" r="9" fill="transparent" />
                    <path d="M0,0 C-4,-9 -6,-13 0,-16 C6,-13 4,-9 0,0 Z" fill={color} stroke="#fff" strokeWidth="0.8" />
                    <circle cx="0" cy="-11" r="2.4" fill="#fff" />
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>

      {selectedUnit && (
        <LotDetail unit={selectedUnit} onUpdate={onUpdate} onClose={() => onSelectUnit(null)} readOnly={!canEdit} />
      )}

      {draftPin && canEdit && (
        <PinModal
          mode="new"
          initial={{ x: draftPin.x, y: draftPin.y, label: "", status: "pendente", obs: "",
                     area: nearestQuadra(draftPin.x, draftPin.y) }}
          onClose={() => setDraftPin(null)}
          onSave={(data) => { onAddPin(data); setDraftPin(null); setPinMode(false); }}
        />
      )}

      {selectedPin && (
        <PinModal
          mode="edit"
          readOnly={!canEdit}
          initial={selectedPin}
          onClose={() => setSelectedPin(null)}
          onSave={(data) => { onUpdatePin(selectedPin.id, data); setSelectedPin(null); }}
          onDelete={() => { onDeletePin(selectedPin.id); setSelectedPin(null); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function LotDetail({ unit, onUpdate, onClose, readOnly }) {
  const st = STATUS[unit.status] || STATUS.pendente;
  const StIcon = st.icon;
  return (
    <div style={styles.modalBackdropTop} onClick={onClose}>
      <div style={styles.lotDetailCard} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>
            {unit.prioridade && "★ "}{displayName(unit)}
            {unit.rua && <span style={styles.modalSubtitle}> · {unit.rua}</span>}
          </span>
          <button style={styles.iconBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          {readOnly && <p style={styles.readOnlyNote}><Lock size={12} /> Somente leitura</p>}
          {/* Selo de status que muda ao vivo conforme você clica */}
          <div style={{ ...styles.lotStatusBadge, background: st.bg, color: st.color, borderColor: st.color }}>
            <StIcon size={16} /> {st.label}
          </div>
          {!readOnly && <StatusSelector unit={unit} onUpdate={onUpdate} />}
          {unit.status === "agendado" && (
            <div style={{ ...styles.dateRow, marginTop: 10 }}>
              <span style={styles.dateLabel}>data agendada:</span>
              <input
                type="date"
                style={styles.dateInput}
                value={unit.dataAgendada}
                disabled={readOnly}
                onChange={e => onUpdate(unit.id, { dataAgendada: e.target.value })}
              />
            </div>
          )}
          {unit.status === "concluido" && (
            <div style={{ ...styles.dateRow, marginTop: 10 }}>
              <span style={styles.dateLabel}>data de conclusão:</span>
              <input
                type="date"
                style={styles.dateInput}
                value={unit.dataConcluida}
                disabled={readOnly}
                onChange={e => onUpdate(unit.id, { dataConcluida: e.target.value })}
              />
            </div>
          )}
          {(!readOnly || unit.rua) && (
            <>
              <label style={styles.fieldLabel}>Rua / Boulevard</label>
              <input
                style={styles.modalInput}
                value={unit.rua}
                placeholder="ex.: Rua 1, Boulevard 3"
                readOnly={readOnly}
                onChange={e => onUpdate(unit.id, { rua: e.target.value })}
              />
            </>
          )}
          {(!readOnly || unit.obs) && (
            <>
              <label style={styles.fieldLabel}>Observações</label>
              <input
                style={styles.modalInput}
                value={unit.obs}
                readOnly={readOnly}
                onChange={e => onUpdate(unit.id, { obs: e.target.value })}
              />
            </>
          )}
          {!readOnly && (
            <label style={{ ...styles.checkboxRow, marginTop: 10 }}>
              <input
                type="checkbox"
                checked={unit.prioridade}
                onChange={e => onUpdate(unit.id, { prioridade: e.target.checked })}
              />
              Marcar como prioridade
            </label>
          )}
          <button style={styles.btnPrimaryFull} onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function PinModal({ mode, initial, onClose, onSave, onDelete, readOnly }) {
  const [label, setLabel]   = useState(initial.label || "");
  const [status, setStatus] = useState(initial.status || "pendente");
  const [obs, setObs]       = useState(initial.obs || "");
  const [area, setArea]     = useState(initial.area || CONDOMINIAL);

  const save = () => onSave({ x: initial.x, y: initial.y, label: label.trim(), status, obs: obs.trim(), area });
  const areaLabel = area === CONDOMINIAL ? "Equipamento condominial / área comum" : `Quadra ${area}`;
  const st = STATUS[status] || STATUS.pendente;

  return (
    <ModalShell title={readOnly ? "Pin" : mode === "new" ? "Novo pin no mapa" : "Editar pin"} onClose={onClose}>
      {readOnly && <p style={styles.readOnlyNote}><Lock size={12} /> Somente leitura</p>}

      <label style={styles.fieldLabel}>Identificação</label>
      <input
        style={styles.modalInput}
        value={label}
        autoFocus={!readOnly}
        readOnly={readOnly}
        placeholder="ex.: Registro geral, Cavalete, Vazamento…"
        onChange={e => setLabel(e.target.value)}
      />

      <label style={styles.fieldLabel}>Área</label>
      {readOnly ? (
        <input style={styles.modalInput} value={areaLabel} readOnly />
      ) : (
        <select style={styles.modalSelect} value={area} onChange={e => setArea(e.target.value)}>
          <option value={CONDOMINIAL}>Equipamento condominial / área comum</option>
          {QUADRAS.map(q => <option key={q} value={q}>Quadra {q}</option>)}
        </select>
      )}

      <label style={styles.fieldLabel}>Status</label>
      {readOnly ? (
        <div style={{ ...styles.lotStatusBadge, background: st.bg, color: st.color, borderColor: st.color }}>
          <st.icon size={14} /> {st.label}
        </div>
      ) : (
        <div style={styles.statusSelector}>
          {Object.entries(STATUS).map(([key, s]) => {
            const active = status === key;
            const SIcon = s.icon;
            return (
              <button
                key={key}
                onClick={() => setStatus(key)}
                style={{
                  ...styles.statusBtn,
                  borderColor: active ? s.color : "#E7E3D6",
                  background:  active ? s.bg : "transparent",
                  color:       active ? s.color : "#6B6862",
                }}
              >
                <SIcon size={13} /> {s.label}
              </button>
            );
          })}
        </div>
      )}

      {(!readOnly || obs) && (
        <>
          <label style={styles.fieldLabel}>Observações</label>
          <input
            style={styles.modalInput}
            value={obs}
            readOnly={readOnly}
            placeholder="detalhes (opcional)"
            onChange={e => setObs(e.target.value)}
          />
        </>
      )}

      {readOnly ? (
        <button style={styles.btnPrimaryFull} onClick={onClose}>OK</button>
      ) : (
        <>
          <button style={styles.btnPrimaryFull} onClick={save}>
            {mode === "new" ? "Adicionar pin" : "Salvar alterações"}
          </button>
          {mode === "edit" && (
            <button style={styles.btnDangerFull} onClick={onDelete}>
              <Trash2 size={14} /> Remover pin
            </button>
          )}
        </>
      )}
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
function AddModal({ onClose, onAdd, existingSvgIds }) {
  const [selectedQuadra, setSelectedQuadra] = useState("");
  const [numero,         setNumero]         = useState("");
  const [rua,            setRua]            = useState("");
  const [prioridade,     setPrioridade]     = useState(false);

  // Try to match a known lot from quadra + numero (fills svgId + rua automatically)
  const matchedLot = useMemo(() => {
    if (!numero.trim()) return null;
    if (selectedQuadra) return LOT_BY_KEY.get(`${selectedQuadra}|${numero.trim()}`) || null;
    return LOTS_DATA.find(l => l.numero === numero.trim()) || null;
  }, [selectedQuadra, numero]);

  // Auto-suggest rua from the matched lot (unless user typed one)
  const effectiveRua = rua.trim() || matchedLot?.rua || "";
  const alreadyExists = matchedLot && existingSvgIds.has(matchedLot.svgId);

  const submit = () => {
    if (!numero.trim()) return;
    onAdd({
      svgId:   matchedLot?.svgId || "",
      numero:  numero.trim(),
      quadra:  selectedQuadra || matchedLot?.quadra || "",
      rua:     effectiveRua,
      viaTipo: matchedLot?.viaTipo || (/boulevard/i.test(effectiveRua) ? "boulevard" : effectiveRua ? "rua" : ""),
      prioridade,
    });
    onClose();
  };

  return (
    <ModalShell title="Adicionar troca de hidrômetro" onClose={onClose}>
      <label style={styles.fieldLabel}>Quadra</label>
      <select
        style={styles.modalSelect}
        value={selectedQuadra}
        onChange={e => setSelectedQuadra(e.target.value)}
      >
        <option value="">— sem quadra / avulso —</option>
        {QUADRAS.map(q => <option key={q} value={q}>Quadra {q}</option>)}
      </select>

      <label style={styles.fieldLabel}>Lote *</label>
      <input
        style={styles.modalInput}
        value={numero}
        placeholder="digite o número do lote"
        onChange={e => setNumero(e.target.value)}
        autoFocus
      />
      {matchedLot && (
        <p style={{ fontSize: 12, color: BRAND.olive, margin: "4px 0 0" }}>
          ✓ Lote encontrado no cadastro{matchedLot.rua ? ` · ${matchedLot.rua}` : ""}
          {alreadyExists && " — já está na lista (será ignorado)."}
        </p>
      )}
      {numero.trim() && !matchedLot && (
        <p style={{ fontSize: 12, color: BRAND.amber, margin: "4px 0 0" }}>
          Lote não encontrado no cadastro — será adicionado como avulso (sem pintura no mapa).
        </p>
      )}

      <label style={styles.fieldLabel}>Rua / Boulevard</label>
      <input
        style={styles.modalInput}
        value={rua}
        placeholder={matchedLot?.rua ? `${matchedLot.rua} (do cadastro)` : "ex.: Rua 1, Boulevard 3"}
        onChange={e => setRua(e.target.value)}
      />

      <label style={{ ...styles.checkboxRow, marginTop: 12 }}>
        <input type="checkbox" checked={prioridade} onChange={e => setPrioridade(e.target.checked)} />
        Prioridade (morador vai se mudar)
      </label>

      <button style={styles.btnPrimaryFull} onClick={submit} disabled={!numero.trim() || alreadyExists}>
        {numero.trim()
          ? `Adicionar Lote ${numero.trim()}${selectedQuadra ? ` — Qd. ${selectedQuadra}` : ""}`
          : "Adicionar lote"}
      </button>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
function ModalShell({ title, onClose, children }) {
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{title}</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aggregate units by a key function → counts + percentage trocado
function aggregate(units, keyFn) {
  const map = new Map();
  units.forEach(u => {
    const key = keyFn(u);
    if (key == null || key === "") return;
    if (!map.has(key)) map.set(key, { key, total: 0, pendente: 0, agendado: 0, concluido: 0, dispensado: 0 });
    const g = map.get(key);
    g.total++;
    if (g[u.status] !== undefined) g[u.status]++;
  });
  return [...map.values()].map(g => {
    const base = g.total - g.dispensado;
    return { ...g, base, pct: pctStr(g.concluido, base) };
  });
}

function ReportView({ units, counts, onClose }) {
  useEffect(() => {
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, []);

  const pct = pctStr(counts.concluido, counts.base);

  const byQuadra = useMemo(
    () => aggregate(units, u => u.quadra).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    [units]
  );
  const byVia = useMemo(() => {
    const ruaOrder = (k) => (/boulevard/i.test(k) ? 1000 : 0) + (parseInt(String(k).replace(/\D/g, "")) || 0);
    return aggregate(units, u => u.rua).sort((a, b) => ruaOrder(a.key) - ruaOrder(b.key));
  }, [units]);

  return (
    <div style={styles.reportPage}>
      <GlobalStyle />
      <div className="no-print" style={styles.reportToolbar}>
        <button style={styles.btnGhost} onClick={onClose}><X size={15} /> Voltar</button>
        <button style={styles.btnPrimary} onClick={() => window.print()}><Printer size={15} /> Imprimir / Salvar PDF</button>
      </div>
      <div style={styles.reportSheet}>
        <div style={styles.reportBrandRow}>
          <span style={styles.reportMonogram}><img src="/logo-vm.png" alt="Viana e Moura" style={styles.reportLogoImg} /></span>
          <span style={styles.reportBrandLabel}>Viana e Moura · Construções</span>
        </div>
        <div style={styles.reportHeader}>
          <div>
            <h1 style={styles.reportTitle}>Recanto das Oliveiras</h1>
            <p style={styles.reportSub}>
              Resumo de substituição de hidrômetros · Gleba 06 · {formatDatePT(todayISO())}
            </p>
          </div>
          <div style={styles.reportStampBox}>
            <div style={styles.reportStampBig}>{pct}%</div>
            <div style={styles.reportStampCaption}>trocado (excl. dispensados)</div>
          </div>
        </div>

        {/* Executive summary for the board */}
        <div style={styles.reportSummaryBox}>
          <p style={styles.reportSummaryTitle}>Resumo</p>
          <ul style={styles.reportSummaryList}>
            <li>Foram trocados, de forma geral, <b>{counts.concluido}</b> hidrômetros.</li>
            <li>Há <b>{counts.pendente}</b> pendentes.</li>
            <li><b>{counts.agendado}</b> agendados.</li>
            <li><b>{counts.concluido}</b> foram colocados (concluídos).</li>
            <li>Percentual concluído: <b>{pct}%</b> dos {counts.base} lotes a trocar.</li>
            <li><b>{counts.dispensado}</b> foram dispensados (fora do cálculo).</li>
          </ul>
        </div>

        <ReportTable title="Por quadra" rows={byQuadra} labelPrefix="Qd. " />
        <ReportTable title="Por rua / boulevard" rows={byVia} />
      </div>
    </div>
  );
}

function ReportTable({ title, rows, labelPrefix = "" }) {
  return (
    <div style={styles.reportSection}>
      <div style={{ ...styles.reportSectionHeader, borderColor: BRAND.ink }}>
        <span style={{ ...styles.reportSectionTitle, color: BRAND.ink }}>{title.toUpperCase()}</span>
      </div>
      <table style={styles.reportTableEl}>
        <thead>
          <tr>
            <th style={styles.thLeft}>Local</th>
            <th style={styles.th}>A trocar</th>
            <th style={styles.th}>Trocados</th>
            <th style={styles.th}>Pend.</th>
            <th style={styles.th}>Agend.</th>
            <th style={styles.th}>Disp.</th>
            <th style={styles.th}>% troc.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td style={styles.tdLeft}>{labelPrefix}{r.key}</td>
              <td style={styles.td}>{r.base}</td>
              <td style={{ ...styles.td, color: BRAND.olive, fontWeight: 700 }}>{r.concluido}</td>
              <td style={styles.td}>{r.pendente}</td>
              <td style={styles.td}>{r.agendado}</td>
              <td style={{ ...styles.td, color: BRAND.steel }}>{r.dispensado}</td>
              <td style={{ ...styles.td, fontWeight: 700 }}>{r.pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
const MESES_FULL = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
function fmtDM(dt) { return `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}`; }
function bucketFullLabel(b) {
  if (b.level === "mes")    return `${MESES_FULL[b.start.getMonth()]} ${b.start.getFullYear()}`;
  if (b.level === "semana") return `Semana de ${fmtDM(b.start)}`;
  return b.label;
}

function Dashboard({ units, counts }) {
  const [mode, setMode]   = useState("mes");   // toggle raiz: dia | semana | mes
  const [drill, setDrill] = useState([]);       // pilha de baldes em que se entrou
  const [panel, setPanel] = useState(null);     // { title, items } — bottom-sheet de lotes

  const today = useMemo(() => startOfDay(new Date()), []);

  const done = useMemo(
    () => units.filter(u => u.status === "concluido" && u.dataConcluida)
               .map(u => ({ date: parseISO(u.dataConcluida), u })),
    [units]
  );
  const countIn = useCallback((s, e) => done.reduce((n, x) => n + (x.date >= s && x.date <= e ? 1 : 0), 0), [done]);
  const itemsIn = useCallback((s, e) => done.filter(x => x.date >= s && x.date <= e).map(x => x.u).sort(sortUnits), [done]);

  // Nível e intervalo ativos (raiz = mode; drilled = filho do último balde)
  const { level, rStart, rEnd, scoped } = useMemo(() => {
    if (drill.length === 0) {
      if (mode === "dia")    return { level: "dia",    rStart: addDays(today, -6), rEnd: endOfDay(today), scoped: false };
      if (mode === "semana") return { level: "semana", rStart: mondayOf(addDays(today, -77)), rEnd: endOfDay(today), scoped: false };
      return { level: "mes", rStart: new Date(today.getFullYear(), today.getMonth() - 11, 1), rEnd: endOfDay(today), scoped: false };
    }
    const last = drill[drill.length - 1];
    return { level: childLevel(last.level), rStart: last.start, rEnd: last.end, scoped: true };
  }, [mode, drill, today]);

  const buckets = useMemo(
    () => genBuckets(level, rStart, rEnd, scoped).map(b => ({ ...b, count: countIn(b.start, b.end) })),
    [level, rStart, rEnd, scoped, countIn]
  );

  const onBucket = (b) => {
    if (b.level === "dia") setPanel({ title: `Concluídos · ${b.label}`, items: itemsIn(b.start, b.end) });
    else setDrill(d => [...d, b]);
  };

  const crumbs = [
    { label: mode === "dia" ? "Diário" : mode === "semana" ? "Semanal" : "Mensal" },
    ...drill.map(d => ({ label: bucketFullLabel(d) })),
  ];

  // Comparativos
  const doneToday = countIn(today, endOfDay(today));
  const wkStart   = mondayOf(today);
  const doneWeek  = countIn(wkStart, endOfDay(today));
  const moStart   = new Date(today.getFullYear(), today.getMonth(), 1);
  const doneMonth = countIn(moStart, endOfDay(today));

  // Ritmo & estimativa (média/dia dos últimos 14 dias)
  const last14  = countIn(addDays(today, -13), endOfDay(today));
  const ritmo   = last14 / 14;
  const faltam  = Math.max(0, counts.base - counts.concluido);
  const diasRest = ritmo > 0 ? Math.ceil(faltam / ritmo) : null;
  const dataFim  = diasRest != null ? addDays(today, diasRest) : null;

  const byQuadra = useMemo(
    () => aggregate(units, u => u.quadra).sort((a, b) => String(a.key).localeCompare(String(b.key))),
    [units]
  );
  const byVia = useMemo(() => {
    const o = (k) => (/boulevard/i.test(k) ? 1000 : 0) + (parseInt(String(k).replace(/\D/g, "")) || 0);
    return aggregate(units, u => u.rua).sort((a, b) => o(a.key) - o(b.key));
  }, [units]);

  return (
    <div style={styles.dashWrap}>
      {/* KPIs */}
      <div style={styles.dashKpiGrid}>
        <DashKpi label="Total"       value={counts.total}      color="#6B6862" />
        <DashKpi label="Concluídos"  value={counts.concluido}  color={BRAND.olive}      sub={`${pctStr(counts.concluido, counts.base)}%`} />
        <DashKpi label="Agendados"   value={counts.agendado}   color={BRAND.amber} />
        <DashKpi label="Pendentes"   value={counts.pendente}   color={BRAND.terracotta} />
        <DashKpi label="Dispensados" value={counts.dispensado} color={BRAND.steel} />
      </div>

      {/* Evolução com toggle + drill-through */}
      <div style={styles.dashCard}>
        <div style={styles.dashCardHead}>
          <span style={styles.dashCardTitle}><TrendingUp size={15} /> Evolução das conclusões</span>
          <div style={styles.dashToggle}>
            {[["dia", "Dia"], ["semana", "Semana"], ["mes", "Mês"]].map(([m, l]) => (
              <button
                key={m}
                className="chip"
                onClick={() => { setMode(m); setDrill([]); }}
                style={{ ...styles.dashToggleBtn, ...(mode === m && drill.length === 0 ? styles.dashToggleActive : {}) }}
              >{l}</button>
            ))}
          </div>
        </div>

        <div style={styles.dashCrumbs}>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight size={12} color="#B9B39C" />}
              <button
                className="chip"
                style={{ ...styles.crumbBtn, ...(i === crumbs.length - 1 ? styles.crumbActive : {}) }}
                onClick={() => setDrill(drill.slice(0, i))}
              >{c.label}</button>
            </React.Fragment>
          ))}
        </div>
        <p style={styles.dashHint}>
          {level === "dia" ? "toque num dia para ver os lotes concluídos" : "toque numa barra para detalhar o período"}
        </p>

        <MiniBarChart buckets={buckets} onBucket={onBucket} color={BRAND.olive} />
      </div>

      {/* Comparativos periódicos */}
      <div style={styles.dashCompGrid}>
        <CompCard title="Hoje"        value={doneToday} caption="concluídos hoje" />
        <CompCard title="Esta semana" value={doneWeek}  caption={`desde ${fmtDM(wkStart)}`} />
        <CompCard title="Este mês"    value={doneMonth} caption={MESES_FULL[today.getMonth()]} />
      </div>

      {/* Estimativa de conclusão */}
      <div style={styles.dashCard}>
        <span style={styles.dashCardTitle}><CalendarDays size={15} /> Estimativa de conclusão</span>
        <div style={styles.estGrid}>
          <Est label="Ritmo (14 dias)"  value={`${ritmo.toFixed(1).replace(".", ",")}/dia`} />
          <Est label="Faltam trocar"    value={faltam} />
          <Est label="Dias restantes"   value={diasRest != null ? diasRest : "—"} />
          <Est label="Previsão de fim"  value={dataFim ? formatDatePT(dataFim.toISOString().slice(0, 10)) : "sem ritmo"} highlight />
        </div>
      </div>

      {/* Performance por quadra / via */}
      <PerfSection
        title="Performance por quadra" rows={byQuadra} prefix="Qd. "
        onRow={(r) => setPanel({ title: `Quadra ${r.key}`, items: units.filter(u => u.quadra === r.key).sort(sortUnits) })}
      />
      <PerfSection
        title="Performance por rua / boulevard" rows={byVia}
        onRow={(r) => setPanel({ title: r.key, items: units.filter(u => u.rua === r.key).sort(sortUnits) })}
      />

      {panel && <LotPanel title={panel.title} items={panel.items} onClose={() => setPanel(null)} />}
    </div>
  );
}

function DashKpi({ label, value, color, sub }) {
  return (
    <div style={styles.dashKpi}>
      <span style={{ ...styles.dashKpiValue, color }}>{value}</span>
      <span style={styles.dashKpiLabel}>{label}</span>
      {sub && <span style={{ ...styles.dashKpiSub, color }}>{sub}</span>}
    </div>
  );
}

function CompCard({ title, value, caption }) {
  return (
    <div style={styles.compCard}>
      <span style={styles.compTitle}>{title}</span>
      <span style={styles.compValue}>{value}</span>
      <span style={styles.compCaption}>{caption}</span>
    </div>
  );
}

function Est({ label, value, highlight }) {
  return (
    <div style={styles.estItem}>
      <span style={styles.estLabel}>{label}</span>
      <span style={{ ...styles.estValue, ...(highlight ? styles.estValueHi : {}) }}>{value}</span>
    </div>
  );
}

function MiniBarChart({ buckets, onBucket, color }) {
  const max = Math.max(1, ...buckets.map(b => b.count));
  const H = 148;
  const allZero = buckets.every(b => b.count === 0);
  return (
    <>
      {allZero && (
        <p style={styles.dashEmpty}>
          Ainda não há conclusões com data neste período. Marque lotes como “Concluído” (com data) para alimentar o gráfico.
        </p>
      )}
      <div style={styles.chartScroll}>
        <div style={styles.chartRow}>
          {buckets.map((b, i) => {
            const h = b.count > 0 ? Math.max(5, Math.round((b.count / max) * H)) : 0;
            const disabled = b.level === "dia" && b.count === 0;
            return (
              <button
                key={i}
                className="chip"
                onClick={() => !disabled && onBucket(b)}
                disabled={disabled}
                style={{ ...styles.chartCol, cursor: disabled ? "default" : "pointer" }}
              >
                <span style={styles.chartVal}>{b.count > 0 ? b.count : ""}</span>
                <div style={{ ...styles.chartBarWrap, height: H }}>
                  <div style={{ width: "100%", height: h, background: color, borderRadius: "4px 4px 0 0" }} />
                </div>
                <span style={styles.chartLbl}>{b.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function PerfSection({ title, rows, prefix = "", onRow }) {
  const maxBase = Math.max(1, ...rows.map(r => r.base));
  return (
    <div style={styles.dashCard}>
      <span style={styles.dashCardTitle}><BarChart3 size={15} /> {title}</span>
      <div style={{ marginTop: 10 }}>
        {rows.map(r => (
          <button key={r.key} className="chip" onClick={() => onRow(r)} style={styles.perfRow}>
            <span style={styles.perfLabel}>{prefix}{r.key}</span>
            <div style={styles.perfBarTrack}>
              <div style={{ ...styles.perfBarFill, width: `${r.base > 0 ? (r.concluido / r.base) * 100 : 0}%` }} />
            </div>
            <span style={styles.perfPct}>{r.pct}%</span>
            <span style={styles.perfCount}>{r.concluido}/{r.base}</span>
            <ChevronRight size={14} color="#B9B39C" />
          </button>
        ))}
      </div>
    </div>
  );
}

function LotPanel({ title, items, onClose }) {
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.modalCard} onClick={e => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{title} · {items.length}</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>
          {items.length === 0 && <p style={styles.dashEmpty}>Nenhum lote neste período.</p>}
          {items.map(u => {
            const st = STATUS[u.status] || STATUS.pendente;
            return (
              <div key={u.id} style={styles.panelRow}>
                <span style={{ ...styles.panelDot, background: st.color }} />
                <span style={styles.panelName}>{u.prioridade && "★ "}{displayName(u)}</span>
                {u.rua && <span style={styles.panelVia}>{u.rua}</span>}
                <span style={styles.panelStatus}>
                  {st.label}{u.dataConcluida ? ` · ${formatDatePT(u.dataConcluida)}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Rótulo compacto do lote para caber na célula do calendário
function shortLot(u) { return u.quadra ? `${u.quadra}-${u.numero}` : `${u.numero}`; }
const CAL_MAX_CHIPS = 4; // quantos lotes mostrar por dia antes do "+N"

function Calendar({ units }) {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [panel, setPanel]   = useState(null);

  // Agendados agrupados por data (YYYY-MM-DD)
  const byDate = useMemo(() => {
    const map = new Map();
    units.forEach(u => {
      if (u.status === "agendado" && u.dataAgendada) {
        if (!map.has(u.dataAgendada)) map.set(u.dataAgendada, []);
        map.get(u.dataAgendada).push(u);
      }
    });
    return map;
  }, [units]);

  const monthStart = new Date(cursor.y, cursor.m, 1);
  const gridStart  = addDays(monthStart, -monthStart.getDay()); // domingo
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);

  const monthTotal = useMemo(() => {
    let n = 0;
    byDate.forEach((arr, iso) => {
      const d = parseISO(iso);
      if (d.getFullYear() === cursor.y && d.getMonth() === cursor.m) n += arr.length;
    });
    return n;
  }, [byDate, cursor]);

  const goMonth = (delta) => setCursor(c => {
    const d = new Date(c.y, c.m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const goToday = () => setCursor({ y: today.getFullYear(), m: today.getMonth() });

  const todayIso = isoLocal(today);

  return (
    <div style={styles.calWrap}>
      <div style={styles.calHeader}>
        <div style={styles.calNav}>
          <button style={styles.calNavBtn} onClick={() => goMonth(-1)} title="Mês anterior"><ChevronLeft size={18} /></button>
          <span style={styles.calTitle}>{MESES_FULL[cursor.m]} {cursor.y}</span>
          <button style={styles.calNavBtn} onClick={() => goMonth(1)} title="Próximo mês"><ChevronRight size={18} /></button>
        </div>
        <button style={styles.calTodayBtn} onClick={goToday}>Hoje</button>
      </div>

      <div style={styles.calSummary}>
        <CalendarClock size={14} color={BRAND.amber} />
        {monthTotal > 0
          ? <span><b>{monthTotal}</b> lote(s) agendado(s) em {MESES_FULL[cursor.m]}</span>
          : <span>Nenhum lote agendado em {MESES_FULL[cursor.m]}</span>}
      </div>

      <div style={styles.calGrid}>
        {WEEKDAYS.map(w => <div key={w} style={styles.calWeekday}>{w}</div>)}
        {cells.map((d, i) => {
          const iso = isoLocal(d);
          const inMonth = d.getMonth() === cursor.m;
          const list = byDate.get(iso) || [];
          const isToday = iso === todayIso;
          const has = list.length > 0;
          return (
            <button
              key={i}
              onClick={() => has && setPanel({ title: `Agendados · ${formatDatePT(iso)}`, items: [...list].sort(sortUnits) })}
              disabled={!has}
              style={{
                ...styles.calCell,
                ...(inMonth ? {} : styles.calCellMuted),
                ...(isToday ? styles.calCellToday : {}),
                cursor: has ? "pointer" : "default",
              }}
            >
              <span style={{ ...styles.calDayNum, ...(isToday ? styles.calDayNumToday : {}) }}>{d.getDate()}</span>
              {has && (
                <span style={styles.calLotList}>
                  {list.slice(0, CAL_MAX_CHIPS).map(u => {
                    const s = STATUS[u.status] || STATUS.agendado;
                    return (
                      <span key={u.id} style={styles.calLotChip} title={displayName(u)}>{shortLot(u)}</span>
                    );
                  })}
                  {list.length > CAL_MAX_CHIPS && (
                    <span style={styles.calLotMore}>+{list.length - CAL_MAX_CHIPS} mais</span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p style={styles.calHint}>Toque num dia com agendamentos para ver os lotes.</p>

      {panel && <LotPanel title={panel.title} items={panel.items} onClose={() => setPanel(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap');
      * { box-sizing: border-box; }
      body { margin: 0; }
      input, textarea, button, select { font-family: 'Inter', sans-serif; }
      input:focus, textarea:focus, select:focus { outline: 2px solid #F2B705; outline-offset: 1px; }
      button:focus-visible { outline: 2px solid #F2B705; outline-offset: 2px; }
      /* Chips de filtro: sem contorno escuro ao clicar; contorno claro só no teclado */
      .chip:focus { outline: none; }
      .chip:focus-visible { outline: 2px solid #DAD5C5; outline-offset: 1px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      html, body { max-width: 100vw; overflow-x: hidden; }
      /* Safe area: empurra o cabeçalho abaixo da barra de status do iPhone (Dynamic Island / notch) */
      .hero { padding-top: max(18px, calc(env(safe-area-inset-top) + 8px)) !important; }
      @media (max-width: 480px) {
        /* Hero: empilha marca e botões em telas pequenas, alinhados à esquerda */
        .hero-top-row { flex-direction: column !important; align-items: flex-start !important; gap: 10px; }
        .hero-top-right { width: 100% !important; justify-content: flex-start !important; flex-wrap: wrap; }
        /* Título menor no celular */
        .hero-title { font-size: 20px !important; }
        /* Tabs de view: rolagem horizontal se não couberem */
        .view-switch { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 4px; }
        .view-switch::-webkit-scrollbar { display: none; }
        /* Filtros: uma coluna */
        .filter-row { flex-direction: column; }
      }
      @media print {
        .no-print { display: none !important; }
        body { background: white; }
      }
    `}</style>
  );
}

// ---------------------------------------------------------------------------
// Módulo de AUDITORIA — exclusivo do admin. Painel de indicadores + tabela de logs.
const ACAO_META = {
  login:     { label: "Login",     color: BRAND.steel,      bg: BRAND.steelBg },
  logout:    { label: "Logout",    color: BRAND.inkSoft,    bg: "#EDEBE3" },
  adicionar: { label: "Adicionar", color: BRAND.olive,      bg: BRAND.oliveBg },
  editar:    { label: "Editar",    color: BRAND.amber,      bg: BRAND.amberBg },
  remover:   { label: "Remover",   color: BRAND.terracotta, bg: BRAND.terracottaBg },
};

function fmtLogDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function AcaoBadge({ acao }) {
  const m = ACAO_META[acao] || { label: acao || "—", color: BRAND.inkSoft, bg: "#EDEBE3" };
  return (
    <span style={{ ...styles.logBadge, color: m.color, background: m.bg }}>{m.label}</span>
  );
}

function AdminLogs({ logs }) {
  const [fEditor, setFEditor] = useState("todos");
  const [fAcao, setFAcao]     = useState("todas");
  const [q, setQ]            = useState("");
  const [shown, setShown]    = useState(120);

  const editores = useMemo(
    () => Array.from(new Set(logs.map(l => l.editor).filter(Boolean))).sort(),
    [logs]
  );

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return logs.filter(l =>
      (fEditor === "todos" || l.editor === fEditor) &&
      (fAcao === "todas" || l.acao === fAcao) &&
      (!qq || `${l.alvo} ${l.detalhe} ${l.editor}`.toLowerCase().includes(qq))
    );
  }, [logs, fEditor, fAcao, q]);

  // Indicadores do painel-resumo
  const hojeStr = new Date().toDateString();
  const hoje    = logs.filter(l => new Date(l.criadoEm).toDateString() === hojeStr).length;
  const edicoes = logs.filter(l => l.acao === "editar").length;
  const ultima  = logs[0]?.criadoEm ? fmtLogDate(logs[0].criadoEm) : "—";

  const porEditor = useMemo(() => {
    const m = {};
    logs.forEach(l => { if (l.editor && l.editor !== "sistema") m[l.editor] = (m[l.editor] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [logs]);
  const porAcao = useMemo(() => {
    const m = {};
    logs.forEach(l => { m[l.acao] = (m[l.acao] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [logs]);

  const maxEditor = porEditor[0]?.[1] || 1;

  return (
    <div style={styles.dashWrap}>
      {/* Cabeçalho do módulo */}
      <div style={styles.logsHeader}>
        <Shield size={18} color={BRAND.olive} />
        <div>
          <div style={styles.logsTitle}>Logs de auditoria</div>
          <div style={styles.logsSubtitle}>Registro de quem editou o quê, quando e em que horário · acesso exclusivo do admin</div>
        </div>
      </div>

      {/* Painel-resumo — indicadores */}
      <div style={styles.dashKpiGrid}>
        <DashKpi label="Registros"      value={logs.length} color="#6B6862" />
        <DashKpi label="Hoje"           value={hoje}        color={BRAND.olive} />
        <DashKpi label="Edições"        value={edicoes}     color={BRAND.amber} />
        <DashKpi label="Usuários"       value={porEditor.length} color={BRAND.steel} />
      </div>
      <div style={styles.logsLastRow}>
        <Clock size={13} color="#9A9488" /> Última atividade: <strong style={{ color: "#232323" }}>{ultima}</strong>
      </div>

      {/* Distribuição por editor e por ação */}
      <div style={styles.logsSplit}>
        <div style={styles.dashCard}>
          <span style={styles.dashCardTitle}><User size={15} /> Atividade por usuário</span>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {porEditor.length === 0 && <span style={styles.logsEmpty}>Sem registros ainda.</span>}
            {porEditor.map(([nome, n]) => (
              <div key={nome} style={styles.logBarRow}>
                <span style={styles.logBarName}>{nome}</span>
                <div style={styles.logBarTrack}>
                  <div style={{ ...styles.logBarFill, width: `${(n / maxEditor) * 100}%` }} />
                </div>
                <span style={styles.logBarVal}>{n}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={styles.dashCard}>
          <span style={styles.dashCardTitle}><Activity size={15} /> Ações registradas</span>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {porAcao.length === 0 && <span style={styles.logsEmpty}>Sem registros ainda.</span>}
            {porAcao.map(([acao, n]) => (
              <div key={acao} style={styles.logAcaoRow}>
                <AcaoBadge acao={acao} />
                <span style={styles.logBarVal}>{n}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div style={styles.logsFilters}>
        <div style={styles.searchBox}>
          <Search size={16} color="#6B6862" />
          <input
            style={styles.searchInput}
            placeholder="buscar por lote, detalhe ou usuário..."
            value={q}
            onChange={e => { setQ(e.target.value); setShown(120); }}
          />
        </div>
        <select style={styles.logsSelect} value={fEditor} onChange={e => { setFEditor(e.target.value); setShown(120); }}>
          <option value="todos">Todos os usuários</option>
          {editores.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <select style={styles.logsSelect} value={fAcao} onChange={e => { setFAcao(e.target.value); setShown(120); }}>
          <option value="todas">Todas as ações</option>
          {Object.keys(ACAO_META).map(a => <option key={a} value={a}>{ACAO_META[a].label}</option>)}
        </select>
      </div>

      {/* Tabela de logs */}
      <div style={styles.dashCard}>
        <div style={styles.dashCardHead}>
          <span style={styles.dashCardTitle}><ScrollText size={15} /> Registros</span>
          <span style={styles.logsCount}>{filtered.length} registro(s)</span>
        </div>
        <div style={styles.logsTableWrap}>
          <table style={styles.logsTable}>
            <thead>
              <tr>
                <th style={styles.logsTh}>Data / Hora</th>
                <th style={styles.logsTh}>Usuário</th>
                <th style={styles.logsTh}>Ação</th>
                <th style={styles.logsTh}>Alvo</th>
                <th style={styles.logsTh}>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5} style={styles.logsTdEmpty}>Nenhum registro encontrado.</td></tr>
              )}
              {filtered.slice(0, shown).map(l => (
                <tr key={l.id} style={styles.logsTr}>
                  <td style={{ ...styles.logsTd, whiteSpace: "nowrap", color: "#6B6862" }}>{fmtLogDate(l.criadoEm)}</td>
                  <td style={{ ...styles.logsTd, fontWeight: 600 }}>{l.editor}</td>
                  <td style={styles.logsTd}><AcaoBadge acao={l.acao} /></td>
                  <td style={styles.logsTd}>{l.alvo || "—"}</td>
                  <td style={{ ...styles.logsTd, color: "#6B6862" }}>{l.detalhe || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown < filtered.length && (
          <button style={styles.loadMoreBtn} onClick={() => setShown(v => v + 120)}>
            Carregar mais {Math.min(120, filtered.length - shown)}
            <span style={styles.loadMoreCount}> ({shown} de {filtered.length})</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
const styles = {
  page:         { minHeight: "100vh", background: "#F7F6F1", fontFamily: "'Inter', sans-serif", paddingBottom: 40 },
  loadingScreen:{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#F7F6F1" },

  hero:         { background: "#232323", backgroundImage: "radial-gradient(circle at 100% 0%, #33331f 0%, #232323 55%)", color: "#F7F6F1", padding: "18px 18px 20px", borderBottom: "4px solid #F2B705" },
  heroTopRow:   { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  heroBrand:    { display: "flex", alignItems: "center", gap: 9 },
  heroMonogram: { width: 38, height: 38, borderRadius: 8, background: "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", padding: 4, overflow: "hidden" },
  heroLogoImg:  { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" },
  heroBrandText:{ display: "flex", flexDirection: "column", lineHeight: 1.1 },
  heroBrandName:{ fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 13.5, color: "#F7F6F1" },
  heroBrandSub: { fontSize: 9.5, letterSpacing: 2, textTransform: "uppercase", color: "#B9B39C" },
  heroSyncTag:  { fontSize: 10, color: "#C9C4B4", border: "1px solid #45443C", borderRadius: 20, padding: "3px 10px" },
  heroTopRight: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },
  editOffBtn:   { display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "#C9C4B4", background: "rgba(255,255,255,0.06)", border: "1px solid #45443C", borderRadius: 20, padding: "5px 12px", cursor: "pointer" },
  editOnBtn:    { display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "#232323", background: "#F2B705", border: "1px solid #F2B705", borderRadius: 20, padding: "5px 12px", cursor: "pointer" },
  heroTitle:    { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 25, margin: "0 0 3px", letterSpacing: 0.2 },
  heroSubtitle: { fontSize: 12.5, color: "#C9C4B4", margin: "0 0 16px" },
  heroStatsRow: { display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginBottom: 12 },
  statPill:     { display: "flex", flexDirection: "column", minWidth: 44 },
  statValue:    { fontFamily: "'Poppins', sans-serif", fontSize: 19, fontWeight: 700, lineHeight: 1 },
  statLabel:    { fontSize: 9.5, color: "#B9B39C", marginTop: 3, letterSpacing: 0.5, textTransform: "uppercase" },
  progressWrap: { display: "flex", flexDirection: "column", gap: 5 },
  progressTrack:{ height: 7, background: "rgba(255,255,255,0.14)", borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", background: "#F2B705", transition: "width 0.3s ease" },
  progressLabel:{ fontSize: 10.5, color: "#C9C4B4" },
  priorityBanner: { marginTop: 12, background: "#2E211B", border: "1px solid #BF4B34", color: "#F0C9BC", fontSize: 11.5, padding: "7px 10px", borderRadius: 6, display: "flex", alignItems: "center", gap: 6 },

  viewSwitch:   { display: "flex", gap: 8, padding: "12px 16px 0", flexWrap: "wrap" },
  viewBtn:      { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, padding: "8px 16px", borderRadius: 6, borderWidth: 1, borderStyle: "solid", borderColor: "#E7E3D6", background: "#FFFFFF", color: "#6B6862", cursor: "pointer" },
  viewBtnActive:{ background: "#232323", color: "#F7F6F1", borderColor: "#232323" },

  toolbar:      { padding: "14px 16px 4px" },
  searchBox:    { display: "flex", alignItems: "center", gap: 8, background: "#FFFFFF", border: "1px solid #E7E3D6", borderRadius: 6, padding: "9px 12px" },
  searchInput:  { border: "none", outline: "none", flex: 1, fontSize: 14, background: "transparent", color: "#232323" },
  filterRow:    { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" },
  filterGroupLabel: { fontSize: 11, fontWeight: 700, color: "#9A9488", textTransform: "uppercase", letterSpacing: 0.5, marginRight: 2 },
  filterChip:   { fontFamily: "'Poppins', monospace", fontSize: 11, padding: "5px 10px", borderRadius: 20, borderWidth: 1, borderStyle: "solid", borderColor: "#E7E3D6", background: "#FFFFFF", color: "#6B6862", cursor: "pointer" },
  filterChipActive:   { background: "#232323", color: "#F7F6F1", borderColor: "#232323" },
  filterChipBoulevard:{ background: "#D6E8F4", color: "#3D6B8E", borderColor: "#3D6B8E" },
  filterChipPriority: { background: "#F5E1DA", color: "#BF4B34", borderColor: "#BF4B34" },
  actionRow:    { display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" },

  btnGhost:     { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, padding: "8px 12px", borderRadius: 6, border: "1px solid #DAD5C5", background: "#FFFFFF", color: "#232323", cursor: "pointer" },
  btnPrimary:   { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: 6, border: "none", background: "#F2B705", color: "#232323", cursor: "pointer", marginLeft: "auto" },
  btnPrimaryFull:{ width: "100%", marginTop: 16, padding: "11px", borderRadius: 6, border: "none", background: "#F2B705", color: "#232323", fontWeight: 700, fontSize: 13.5, cursor: "pointer" },
  btnDangerFull:{ width: "100%", marginTop: 8, padding: "10px", borderRadius: 6, border: "1px solid #BF4B34", background: "#FFFFFF", color: "#BF4B34", fontWeight: 600, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 },

  list:         { padding: "8px 16px" },
  emptyState:   { padding: "40px 0", display: "flex", justifyContent: "center" },
  loadMoreBtn:  { display: "block", width: "100%", marginTop: 4, marginBottom: 16, padding: "12px", borderRadius: 8, border: "1px dashed #DAD5C5", background: "#FAFAF7", color: "#6B6862", fontSize: 13, cursor: "pointer", textAlign: "center" },
  loadMoreCount:{ fontSize: 11, opacity: 0.7 },
  row:          { background: "#FFFFFF", borderRadius: 8, padding: "12px 14px", marginBottom: 8, borderLeft: "4px solid #E7E3D6" },
  rowHeader:    { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  rowTitleGroup:{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" },
  rowTitle:     { fontFamily: "'Poppins', sans-serif", fontWeight: 600, fontSize: 13.5, color: "#232323" },
  rowVia:       { fontSize: 10.5, fontWeight: 600, color: "#6B6862", background: "#F0EFE7", borderRadius: 20, padding: "2px 8px" },
  pinTag:       { fontSize: 9, fontWeight: 800, letterSpacing: 0.6, color: "#B47F1F", background: "#F4E7CD", borderRadius: 4, padding: "2px 6px" },
  iconBtn:      { background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 4, display: "flex", alignItems: "center" },
  statusSelector:{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  statusBtn:    { display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, padding: "5px 10px", borderRadius: 6, borderWidth: 1, borderStyle: "solid", cursor: "pointer", background: "transparent" },
  dateRow:      { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  dateLabel:    { fontSize: 12, color: "#6B6862" },
  dateInput:    { fontSize: 12, padding: "4px 8px", border: "1px solid #E7E3D6", borderRadius: 6 },
  obsInput:     { width: "100%", fontSize: 12.5, padding: "7px 10px", border: "1px solid #E7E3D6", borderRadius: 6, color: "#232323", background: "#FAFAF7", marginBottom: 6 },
  priorityRow:  { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6B6862", cursor: "pointer" },

  mapWrap:      { padding: "8px 0" },
  mapLegend:    { display: "flex", gap: 14, padding: "8px 16px", flexWrap: "wrap", alignItems: "center" },
  legendItem:   { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B6862" },
  legendSwatch: { width: 14, height: 14, borderRadius: 3, display: "inline-block" },
  mapControls:  { marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" },
  mapToggleBtn: { display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 6, borderWidth: 1, borderStyle: "solid", borderColor: "#DAD5C5", background: "#FFFFFF", color: "#6B6862", cursor: "pointer" },
  mapToggleActive: { background: "#232323", color: "#F7F6F1", borderColor: "#232323" },
  mapPinActive: { background: "#F2B705", color: "#232323", borderColor: "#F2B705" },
  mapResetBtn:  { fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 6, border: "1px solid #DAD5C5", background: "#FFFFFF", color: "#6B6862", cursor: "pointer" },
  mapViewport:  { position: "relative", margin: "0 16px", height: "calc(100vh - 320px)", minHeight: 400, overflow: "hidden", borderRadius: 8, border: "1px solid #E7E3D6", background: "#F0EFE7", touchAction: "none" },

  modalBackdrop:{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 100 },
  modalBackdropTop:{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 100, paddingTop: "8vh" },
  lotDetailCard:{ background: "#FFFFFF", borderRadius: 12, width: "100%", maxWidth: 440, maxHeight: "82vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.35)" },
  lotStatusBadge:{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, padding: "6px 12px", borderRadius: 20, borderWidth: 1, borderStyle: "solid", marginBottom: 10 },
  readOnlyNote: { display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, color: "#6B6862", background: "#F0EFE7", borderRadius: 6, padding: "5px 10px", margin: "0 0 10px" },
  modalCard:    { background: "#FFFFFF", borderRadius: "12px 12px 0 0", width: "100%", maxWidth: 440, maxHeight: "88vh", overflowY: "auto" },
  pinDetailCard:{ background: "#FFFFFF", borderRadius: "12px 12px 0 0", width: "100%", maxWidth: 440, maxHeight: "80vh", overflowY: "auto" },
  modalHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px 10px", borderBottom: "1px solid #E7E3D6" },
  modalTitle:   { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 14, color: "#232323" },
  modalSubtitle:{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 12, color: "#6B6862" },
  modalBody:    { padding: "12px 16px 20px" },
  modalInput:   { width: "100%", fontSize: 13.5, padding: "9px 10px", border: "1px solid #E7E3D6", borderRadius: 6, color: "#232323", marginBottom: 4 },
  modalSelect:  { width: "100%", fontSize: 13.5, padding: "9px 10px", border: "1px solid #E7E3D6", borderRadius: 6, color: "#232323", marginBottom: 4, background: "#FFFFFF" },
  fieldLabel:   { display: "block", fontSize: 11.5, fontWeight: 600, color: "#6B6862", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, marginTop: 10 },
  checkboxRow:  { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#232323", cursor: "pointer", marginTop: 8 },

  reportPage:   { background: "#F7F6F1", minHeight: "100vh", padding: 16 },
  reportToolbar:{ display: "flex", gap: 10, marginBottom: 16, justifyContent: "space-between" },
  reportSheet:  { background: "#FFFFFF", maxWidth: 740, margin: "0 auto", padding: "28px 32px", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" },
  reportBrandRow:{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 },
  reportMonogram:{ width: 30, height: 30, borderRadius: 5, background: "#FFFFFF", border: "1px solid #E7E3D6", display: "flex", alignItems: "center", justifyContent: "center", padding: 3, overflow: "hidden" },
  reportLogoImg: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" },
  reportBrandLabel:{ fontSize: 11, color: "#6B6862", letterSpacing: 0.3 },
  reportHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid #232323", paddingBottom: 12, marginBottom: 16 },
  reportTitle:  { fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 800, color: "#232323", margin: "0 0 3px" },
  reportSub:    { fontSize: 11, color: "#6B6862", margin: 0 },
  reportStampBox:{ border: "1px solid #E7E3D6", borderRadius: 6, padding: "8px 14px", minWidth: 110, textAlign: "center" },
  reportStampBig:{ fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 800, color: "#5C6B33", lineHeight: 1 },
  reportStampCaption:{ fontSize: 9, color: "#6B6862", marginTop: 3 },

  reportSummaryBox: { background: "#FAFAF7", border: "1px solid #E7E3D6", borderRadius: 8, padding: "14px 18px", marginBottom: 20 },
  reportSummaryTitle:{ fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: 1, color: "#232323", margin: "0 0 8px", textTransform: "uppercase" },
  reportSummaryList:{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "#232323", lineHeight: 1.7 },

  reportSection: { marginBottom: 20 },
  reportSectionHeader:{ display: "flex", justifyContent: "space-between", borderLeft: "3px solid", paddingLeft: 8, marginBottom: 8 },
  reportSectionTitle: { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 12, letterSpacing: 1 },
  reportTableEl:{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 },
  th:           { textAlign: "center", padding: "5px 6px", borderBottom: "2px solid #232323", color: "#6B6862", fontWeight: 700, fontSize: 10.5 },
  thLeft:       { textAlign: "left", padding: "5px 6px", borderBottom: "2px solid #232323", color: "#6B6862", fontWeight: 700, fontSize: 10.5 },
  td:           { textAlign: "center", padding: "5px 6px", borderBottom: "1px solid #F0EDE4", color: "#232323" },
  tdLeft:       { textAlign: "left", padding: "5px 6px", borderBottom: "1px solid #F0EDE4", color: "#232323", fontWeight: 600 },

  // ---- Dashboard ----
  dashWrap:     { padding: "12px 16px 8px", display: "flex", flexDirection: "column", gap: 12 },
  dashKpiGrid:  { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 8 },
  dashKpi:      { background: "#FFFFFF", border: "1px solid #E7E3D6", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2 },
  dashKpiValue: { fontFamily: "'Poppins', sans-serif", fontSize: 22, fontWeight: 800, lineHeight: 1 },
  dashKpiLabel: { fontSize: 10, color: "#9A9488", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 3 },
  dashKpiSub:   { fontSize: 11, fontWeight: 700, marginTop: 1 },

  dashCard:     { background: "#FFFFFF", border: "1px solid #E7E3D6", borderRadius: 12, padding: "14px 14px 16px" },
  dashCardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  dashCardTitle:{ display: "flex", alignItems: "center", gap: 6, fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 13.5, color: "#232323" },
  dashToggle:   { display: "flex", gap: 4, background: "#F0EFE7", borderRadius: 8, padding: 3 },
  dashToggleBtn:{ fontFamily: "'Poppins', sans-serif", fontSize: 11.5, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "none", background: "transparent", color: "#6B6862", cursor: "pointer" },
  dashToggleActive:{ background: "#232323", color: "#F7F6F1" },

  dashCrumbs:   { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginTop: 12 },
  crumbBtn:     { fontSize: 11.5, fontWeight: 600, padding: "3px 8px", borderRadius: 6, border: "none", background: "#F0EFE7", color: "#6B6862", cursor: "pointer" },
  crumbActive:  { background: "#E7E9D6", color: "#5C6B33" },
  dashHint:     { fontSize: 11, color: "#B9B39C", margin: "8px 0 4px", fontStyle: "italic" },

  chartScroll:  { overflowX: "auto", overflowY: "hidden", paddingBottom: 4, WebkitOverflowScrolling: "touch" },
  chartRow:     { display: "flex", alignItems: "flex-end", gap: 6, minWidth: "min-content", paddingTop: 6 },
  chartCol:     { flex: "1 0 34px", minWidth: 34, maxWidth: 64, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, border: "none", background: "transparent", padding: 0 },
  chartVal:     { fontFamily: "'Poppins', sans-serif", fontSize: 11, fontWeight: 700, color: "#5C6B33", height: 14 },
  chartBarWrap: { width: "100%", maxWidth: 46, display: "flex", alignItems: "flex-end", background: "#F5F4EE", borderRadius: "4px 4px 0 0" },
  chartLbl:     { fontSize: 10, color: "#6B6862", whiteSpace: "nowrap", fontWeight: 600 },

  dashCompGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 8 },
  compCard:     { background: "#FFFFFF", border: "1px solid #E7E3D6", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 },
  compTitle:    { fontSize: 10.5, fontWeight: 700, color: "#9A9488", textTransform: "uppercase", letterSpacing: 0.5 },
  compValue:    { fontFamily: "'Poppins', sans-serif", fontSize: 26, fontWeight: 800, color: "#5C6B33", lineHeight: 1 },
  compCaption:  { fontSize: 11, color: "#6B6862" },

  // ── Módulo de Logs (auditoria) ──
  logsHeader:   { display: "flex", alignItems: "center", gap: 10, background: "#FFFFFF", border: "1px solid #E7E3D6", borderRadius: 12, padding: "12px 14px" },
  logsTitle:    { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 15, color: "#232323" },
  logsSubtitle: { fontSize: 11.5, color: "#6B6862", marginTop: 2 },
  logsLastRow:  { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6B6862", padding: "0 2px" },
  logsSplit:    { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 },
  logsEmpty:    { fontSize: 12, color: "#9A9488", fontStyle: "italic" },

  logBarRow:    { display: "flex", alignItems: "center", gap: 8 },
  logBarName:   { fontSize: 12, fontWeight: 600, color: "#232323", width: 72, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  logBarTrack:  { flex: 1, height: 8, background: "#F0EFE7", borderRadius: 5, overflow: "hidden" },
  logBarFill:   { height: "100%", background: "#5C6B33", borderRadius: 5 },
  logBarVal:    { fontFamily: "'Poppins', sans-serif", fontSize: 12.5, fontWeight: 700, color: "#232323", width: 34, textAlign: "right", flexShrink: 0 },
  logAcaoRow:   { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },

  logBadge:     { display: "inline-block", fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 999, letterSpacing: 0.2 },

  logsFilters:  { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  logsSelect:   { fontFamily: "'Inter', sans-serif", fontSize: 12.5, padding: "8px 10px", borderRadius: 8, border: "1px solid #E7E3D6", background: "#FFFFFF", color: "#232323", cursor: "pointer" },
  logsCount:    { fontSize: 11.5, fontWeight: 600, color: "#9A9488" },

  logsTableWrap:{ overflowX: "auto", marginTop: 10, WebkitOverflowScrolling: "touch" },
  logsTable:    { width: "100%", borderCollapse: "collapse", minWidth: 560 },
  logsTh:       { textAlign: "left", fontSize: 10.5, fontWeight: 700, color: "#9A9488", textTransform: "uppercase", letterSpacing: 0.5, padding: "6px 10px", borderBottom: "1px solid #E7E3D6", whiteSpace: "nowrap" },
  logsTr:       { borderBottom: "1px solid #F0EDE4" },
  logsTd:       { fontSize: 12.5, color: "#232323", padding: "8px 10px", verticalAlign: "top" },
  logsTdEmpty:  { fontSize: 12.5, color: "#9A9488", fontStyle: "italic", padding: "16px 10px", textAlign: "center" },

  estGrid:      { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginTop: 12 },
  estItem:      { display: "flex", flexDirection: "column", gap: 3 },
  estLabel:     { fontSize: 10.5, color: "#9A9488", textTransform: "uppercase", letterSpacing: 0.5 },
  estValue:     { fontFamily: "'Poppins', sans-serif", fontSize: 16, fontWeight: 700, color: "#232323" },
  estValueHi:   { color: "#B47F1F" },

  perfRow:      { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 4px", borderTop: "1px solid #F0EDE4", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" },
  perfLabel:    { fontFamily: "'Poppins', sans-serif", fontSize: 12, fontWeight: 600, color: "#232323", width: 58, flexShrink: 0 },
  perfBarTrack: { flex: 1, height: 8, background: "#F0EFE7", borderRadius: 4, overflow: "hidden", minWidth: 40 },
  perfBarFill:  { height: "100%", background: "#5C6B33", borderRadius: 4 },
  perfPct:      { fontSize: 11.5, fontWeight: 700, color: "#5C6B33", width: 48, textAlign: "right", flexShrink: 0 },
  perfCount:    { fontSize: 11, color: "#9A9488", width: 46, textAlign: "right", flexShrink: 0 },

  dashEmpty:    { fontSize: 12.5, color: "#9A9488", fontStyle: "italic", margin: "10px 2px", lineHeight: 1.5 },
  panelRow:     { display: "flex", alignItems: "center", gap: 8, padding: "8px 2px", borderBottom: "1px solid #F0EDE4", flexWrap: "wrap" },
  panelDot:     { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  panelName:    { fontFamily: "'Poppins', sans-serif", fontWeight: 600, fontSize: 12.5, color: "#232323" },
  panelVia:     { fontSize: 10, fontWeight: 600, color: "#6B6862", background: "#F0EFE7", borderRadius: 20, padding: "1px 7px" },
  panelStatus:  { fontSize: 11, color: "#6B6862", marginLeft: "auto" },

  // ---- Calendário ----
  calWrap:      { padding: "12px 16px 8px" },
  calHeader:    { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 },
  calNav:       { display: "flex", alignItems: "center", gap: 6 },
  calNavBtn:    { display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderStyle: "solid", borderColor: "#E7E3D6", background: "#FFFFFF", color: "#232323", cursor: "pointer" },
  calTitle:     { fontFamily: "'Poppins', sans-serif", fontWeight: 700, fontSize: 15.5, color: "#232323", minWidth: 130, textAlign: "center" },
  calTodayBtn:  { fontSize: 12, fontWeight: 600, padding: "7px 14px", borderRadius: 8, borderWidth: 1, borderStyle: "solid", borderColor: "#DAD5C5", background: "#FFFFFF", color: "#232323", cursor: "pointer" },
  calSummary:   { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#6B6862", background: "#F4E7CD", border: "1px solid #E6D3A8", borderRadius: 8, padding: "8px 12px", marginBottom: 10 },
  calGrid:      { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 },
  calWeekday:   { textAlign: "center", fontSize: 10.5, fontWeight: 700, color: "#9A9488", textTransform: "uppercase", letterSpacing: 0.3, padding: "2px 0 6px" },
  calCell:      { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minHeight: 62, padding: "4px 2px 5px", borderRadius: 8, borderWidth: 1, borderStyle: "solid", borderColor: "#EDEAE0", background: "#FFFFFF", textAlign: "center", overflow: "hidden" },
  calCellMuted: { background: "#FAFAF7", borderColor: "#F2F0E9", opacity: 0.55 },
  calCellToday: { borderColor: "#232323", borderWidth: 2 },
  calDayNum:    { fontFamily: "'Poppins', sans-serif", fontSize: 12.5, fontWeight: 600, color: "#232323" },
  calDayNumToday:{ background: "#232323", color: "#F7F6F1", borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, fontSize: 11.5 },
  calLotList:   { display: "flex", flexDirection: "column", gap: 2, width: "100%", marginTop: 1 },
  calLotChip:   { display: "block", width: "100%", fontFamily: "'Poppins', sans-serif", fontSize: 8.5, fontWeight: 700, color: "#7A5000", background: "#F7DE8B", borderRadius: 3, padding: "1px 2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.35, textAlign: "center" },
  calLotMore:   { display: "block", fontSize: 8, fontWeight: 700, color: "#8A5A00", marginTop: 1 },
  calHint:      { fontSize: 11, color: "#B9B39C", fontStyle: "italic", marginTop: 10, textAlign: "center" },
};
