import { useState, useCallback } from 'react'
import { loadSettingsSync, saveSettings } from '../utils/storage'
import type { AppSettings, ImportHistoryEntry, SleepImportMethod } from '../types'

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettingsSync())

  const setSleepMethod = useCallback((method: SleepImportMethod) => {
    setSettings(prev => {
      const next = { ...prev, sleepImportMethod: method }
      saveSettings(next)
      return next
    })
  }, [])

  const addImportHistory = useCallback((entry: Omit<ImportHistoryEntry, 'id'>) => {
    setSettings(prev => {
      const next = {
        ...prev,
        importHistory: [
          ...prev.importHistory,
          { ...entry, id: Math.random().toString(36).slice(2) },
        ],
      }
      saveSettings(next)
      return next
    })
  }, [])

  const clearHistory = useCallback(() => {
    setSettings(prev => {
      const next = { ...prev, importHistory: [] }
      saveSettings(next)
      return next
    })
  }, [])

  return { settings, setSleepMethod, addImportHistory, clearHistory }
}
