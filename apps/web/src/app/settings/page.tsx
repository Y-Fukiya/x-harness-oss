'use client'

import { useState, useEffect } from 'react'
import { fetchApi } from '@/lib/api'
import Header from '@/components/layout/header'

interface LineConnection {
  id: string
  name: string
  worker_url: string
  has_api_key: boolean
  created_at: string
}

export default function SettingsPage() {
  const [connections, setConnections] = useState<LineConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [autoEnabled, setAutoEnabled] = useState(false)
  const [autoLoading, setAutoLoading] = useState(true)
  const [autoSaving, setAutoSaving] = useState(false)

  // New connection form
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      const res = await fetchApi<{ success: boolean; data: LineConnection[] }>('/api/line-connections')
      if (res.success) setConnections(res.data)
    } catch { /* ignore */ }
    setLoading(false)
  }

  const loadSettings = async () => {
    try {
      const res = await fetchApi<{ success: boolean; data: Record<string, string> }>('/api/settings')
      if (res.success) {
        setAutoEnabled(res.data.auto_features_enabled === 'true')
      }
    } catch { /* ignore */ }
    setAutoLoading(false)
  }

  const toggleAuto = async () => {
    const newValue = !autoEnabled
    if (newValue && !confirm(
      '⚠️ 自動機能を有効にすると X API 使用料が発生します。\n\n' +
      '・エンゲージメントゲートの自動ポーリング（$0.005/回）\n' +
      '・予約投稿の自動実行（$0.010/回）\n' +
      '・ステップシーケンスの自動実行\n\n' +
      '5分ごとに課金が発生します。有効にしますか？'
    )) return
    setAutoSaving(true)
    try {
      await fetchApi('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ auto_features_enabled: String(newValue) }),
      })
      setAutoEnabled(newValue)
    } catch { /* ignore */ }
    setAutoSaving(false)
  }

  useEffect(() => { load(); loadSettings() }, [])

  const handleAdd = async () => {
    if (!name || !url || !apiKey) return
    setSaving(true)
    try {
      await fetchApi('/api/line-connections', {
        method: 'POST',
        body: JSON.stringify({ name, workerUrl: url.replace(/\/$/, ''), apiKey }),
      })
      setName('')
      setUrl('')
      setApiKey('')
      await load()
    } catch { /* ignore */ }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('削除しますか？')) return
    await fetchApi(`/api/line-connections/${id}`, { method: 'DELETE' })
    await load()
  }

  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const handleTest = async (conn: LineConnection) => {
    setTestResults(prev => ({ ...prev, [conn.id]: '...' }))
    try {
      const res = await fetchApi<{ success: boolean; data: { status: number } }>(
        `/api/line-connections/${conn.id}/test`,
        { method: 'POST' },
      )
      setTestResults(prev => ({
        ...prev,
        [conn.id]: res.success ? '✅ 接続OK' : `❌ ${res.data.status}`,
      }))
    } catch (err) {
      setTestResults(prev => ({ ...prev, [conn.id]: `❌ ${err}` }))
    }
  }

  return (
    <div>
      <Header title="L Harness 設定" description="自動機能・L Harness 接続の管理" />

      <div className="max-w-2xl space-y-6">
        {/* 自動機能トグル */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">自動機能</h2>
              <p className="text-xs text-gray-500 mt-1">
                エンゲージメントゲート・予約投稿・ステップシーケンスの自動実行
              </p>
            </div>
            {autoLoading ? (
              <div className="w-12 h-6 bg-gray-200 rounded-full animate-pulse" />
            ) : (
              <button
                onClick={toggleAuto}
                disabled={autoSaving}
                className={`relative w-12 h-6 rounded-full transition-colors ${autoEnabled ? 'bg-green-500' : 'bg-gray-300'} ${autoSaving ? 'opacity-50' : ''}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${autoEnabled ? 'translate-x-6' : ''}`} />
              </button>
            )}
          </div>
          {!autoEnabled && !autoLoading && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-xs text-amber-700">
                <strong>オフ</strong> — cron ジョブは停止中です。ゲートのポーリング・予約投稿・ステップシーケンスは実行されません。
                API 使用料は発生しません。
              </p>
            </div>
          )}
          {autoEnabled && !autoLoading && (
            <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-xs text-green-700">
                <strong>オン</strong> — 5分ごとに自動実行されます。X API 使用料が発生します（Read: $0.005/回、Write: $0.010/回）。
              </p>
            </div>
          )}
        </div>

        {/* 登録済み一覧 */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">L Harness 接続先</h2>

          {loading ? (
            <p className="text-sm text-gray-400">読み込み中...</p>
          ) : connections.length === 0 ? (
            <p className="text-sm text-gray-400">接続先が未登録です</p>
          ) : (
            <div className="space-y-3">
              {connections.map((conn) => (
                <div key={conn.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{conn.name}</p>
                    <p className="text-xs text-gray-400">{conn.worker_url}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {testResults[conn.id] && (
                      <span className="text-xs">{testResults[conn.id]}</span>
                    )}
                    <button
                      onClick={() => handleTest(conn)}
                      className="px-2 py-1 text-xs text-gray-500 bg-white border border-gray-200 rounded hover:bg-gray-50"
                    >
                      テスト
                    </button>
                    <button
                      onClick={() => handleDelete(conn.id)}
                      className="px-2 py-1 text-xs text-red-500 bg-white border border-red-200 rounded hover:bg-red-50"
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 新規追加 */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">接続先を追加</h2>
          <div className="space-y-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名前（例: 本番、テスト環境）"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Worker URL（例: https://line-crm-worker.workers.dev）"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API Key（lh_xxxxxxxx）"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleAdd}
              disabled={saving || !name || !url || !apiKey}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 rounded-lg disabled:opacity-50 transition-colors"
            >
              {saving ? '追加中...' : '追加'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
