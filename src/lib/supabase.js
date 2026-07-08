import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Cliente ativado quando as variáveis existem. Sem elas → null (app usa localStorage).
export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      })
    : null

export const SUPA_ON = !!supabase

// Domínio de e-mail das editoras. Login "nayara" vira "nayara@<domínio>".
// As contas são criadas no painel do Supabase (Authentication → Users).
export const EDIT_EMAIL_DOMAIN =
  (import.meta.env.VITE_EDIT_EMAIL_DOMAIN || 'recanto.app').trim()

// ---- Mapeamento entre modelo do app (camelCase) e banco (snake_case) ----
const uToRow = (u) => ({
  id: u.id,
  svg_id: u.svgId || null,
  numero: u.numero ?? null,
  quadra: u.quadra || null,
  rua: u.rua || null,
  via_tipo: u.viaTipo || null,
  prioridade: !!u.prioridade,
  status: u.status || 'pendente',
  data_agendada: u.dataAgendada || null,
  data_concluida: u.dataConcluida || null,
  obs: u.obs || null,
  updated_at: new Date().toISOString(),
})
const rowToU = (r) => ({
  id: r.id,
  svgId: r.svg_id || '',
  numero: r.numero || '',
  quadra: r.quadra || '',
  rua: r.rua || '',
  viaTipo: r.via_tipo || '',
  prioridade: !!r.prioridade,
  status: r.status || 'pendente',
  dataAgendada: r.data_agendada || '',
  dataConcluida: r.data_concluida || '',
  obs: r.obs || '',
})
const pToRow = (p) => ({
  id: p.id,
  x: p.x,
  y: p.y,
  label: p.label || null,
  status: p.status || 'pendente',
  obs: p.obs || null,
  area: p.area || null,
  data_concluida: p.dataConcluida || null,
  updated_at: new Date().toISOString(),
})
const rowToP = (r) => ({
  id: r.id,
  x: r.x,
  y: r.y,
  label: r.label || '',
  status: r.status || 'pendente',
  obs: r.obs || '',
  area: r.area || 'condominial',
  dataConcluida: r.data_concluida || '',
})

// ---- Leitura ----
export async function loadAll() {
  const [u, p] = await Promise.all([
    supabase.from('unidades').select('*'),
    supabase.from('pins').select('*'),
  ])
  if (u.error) throw u.error
  return {
    units: (u.data || []).map(rowToU),
    pins: p.error ? [] : (p.data || []).map(rowToP),
  }
}

// ---- Escrita ----
export async function saveUnidade(u) { return supabase.from('unidades').upsert(uToRow(u)) }
export async function removeUnidade(id) { return supabase.from('unidades').delete().eq('id', id) }
export async function savePin(p) { return supabase.from('pins').upsert(pToRow(p)) }
export async function removePin(id) { return supabase.from('pins').delete().eq('id', id) }

// Salva todos os dados de uma vez (upsert em lote)
export async function saveAllData(units, pins) {
  const r1 = await supabase.from('unidades').upsert(units.map(uToRow))
  if (r1.error) throw r1.error
  if (pins.length > 0) {
    const r2 = await supabase.from('pins').upsert(pins.map(pToRow))
    if (r2.error) throw r2.error
  }
}

// ---- Realtime: avisa quando algo muda em qualquer aparelho ----
export function subscribe(onChange) {
  const ch = supabase
    .channel('rt-hidrometros')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'unidades' }, () => onChange('unidades'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pins' }, () => onChange('pins'))
    .subscribe()
  return () => { try { supabase.removeChannel(ch) } catch { /* ignore */ } }
}

// ---- Autenticação (login das editoras) ----
export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password })
}
export async function signOut() { return supabase.auth.signOut() }
export async function getSession() { return supabase.auth.getSession() }
export function onAuthChange(cb) { return supabase.auth.onAuthStateChange((_e, session) => cb(session)) }

// "nayara@recanto.app" → "Nayara"
export function nameFromEmail(email) {
  const n = String(email || '').split('@')[0] || 'Editor'
  return n.charAt(0).toUpperCase() + n.slice(1)
}
