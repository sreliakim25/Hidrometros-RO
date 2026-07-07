// Camada de dados — Fase 1 usa localStorage.
// Fase 2: substitua os blocos marcados com "// TODO: Supabase" pelas chamadas reais.
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const STORAGE_KEY = 'hidrometro-unidades'

export function useUnits(seed) {
  const [units, setUnits] = useState(null)
  const [saving, setSaving] = useState(false)

  // --- CARREGAR ---
  useEffect(() => {
    if (supabase) {
      // TODO: Supabase — substituir localStorage por:
      // supabase.from('units').select('*').then(({ data }) => setUnits(data ?? []))
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      setUnits(raw ? JSON.parse(raw) : seed ?? [])
    } catch {
      setUnits(seed ?? [])
    }
  }, [])

  // --- SALVAR (debounce 600ms) ---
  useEffect(() => {
    if (units === null) return
    setSaving(true)
    const t = setTimeout(() => {
      if (supabase) {
        // TODO: Supabase — substituir por upsert:
        // supabase.from('units').upsert(units).then(() => setSaving(false))
        // return
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(units))
      setSaving(false)
    }, 600)
    return () => clearTimeout(t)
  }, [units])

  return { units, setUnits, saving }
}
