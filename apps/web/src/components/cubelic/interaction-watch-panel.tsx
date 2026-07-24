'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  cubelicApi,
  type InteractionCandidate,
  type InteractionWatch,
} from '@/lib/api'

export default function InteractionWatchPanel({
  enabled,
  humanKey,
}: {
  enabled: boolean
  humanKey: string
}) {
  const [watches, setWatches] = useState<InteractionWatch[]>([])
  const [candidates, setCandidates] = useState<InteractionCandidate[]>([])
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const [watchResponse, candidateResponse] = await Promise.all([
        cubelicApi.interactionWatch.list(),
        cubelicApi.interactionWatch.candidates(),
      ])
      setWatches(watchResponse.data)
      setCandidates(candidateResponse.data)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '監視候補の取得に失敗しました')
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!enabled) return null

  const act = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '監視操作に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const watch = watches[0]

  return (
    <section className="mb-6 rounded-2xl border border-violet-200 bg-violet-50 p-5">
      <h2 className="font-bold text-violet-950">X投稿の監視候補</h2>
      <p className="mt-1 text-sm text-violet-800">
        1アカウントの新規オリジナル投稿だけを検知します。Xへの操作は行いません。
      </p>

      {!watch && (
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value.replace(/^@/, ''))}
            placeholder="Xユーザー名（@なし）"
            className="min-w-64 rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm"
          />
          <button
            disabled={busy || !humanKey || !/^[A-Za-z0-9_]{1,15}$/.test(username)}
            onClick={() => void act(async () => {
              await cubelicApi.interactionWatch.create(username, humanKey)
              setUsername('')
              setNotice('X上のユーザーIDを照合して監視対象を登録しました。')
            })}
            className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-bold text-white disabled:bg-gray-300"
          >
            {busy ? '照合中…' : '照合して登録'}
          </button>
        </div>
      )}

      {watch && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4">
          <div>
            <p className="font-semibold text-gray-900">@{watch.targetUsername}</p>
            <p className="text-xs text-gray-500">
              ID {watch.targetUserId}・照合 {new Date(watch.verifiedAt).toLocaleString('ja-JP')}
            </p>
          </div>
          <button
            disabled={busy || !humanKey}
            onClick={() => void act(async () => {
              const response = await cubelicApi.interactionWatch.poll(watch.watchId, humanKey)
              setNotice(`${response.data.discovered}件の新規候補を追加しました。`)
            })}
            className="rounded-lg border border-violet-300 bg-white px-4 py-2 text-sm font-bold text-violet-800 disabled:opacity-40"
          >
            {busy ? '確認中…' : '今すぐ確認'}
          </button>
        </div>
      )}

      {notice && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 space-y-2">
        {candidates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-violet-200 p-4 text-center text-sm text-violet-700">
            検知候補はまだありません。
          </p>
        ) : candidates.map((candidate) => (
          <article key={candidate.candidateId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4">
            <div>
              <p className="text-sm font-semibold text-gray-900">投稿 {candidate.postId}</p>
              <p className="text-xs text-gray-500">
                投稿日時 {new Date(candidate.postCreatedAt).toLocaleString('ja-JP')}
              </p>
            </div>
            <a
              href={`https://x.com/i/web/status/${candidate.postId}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-violet-300 px-3 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-100"
            >
              Xで確認
            </a>
          </article>
        ))}
      </div>
    </section>
  )
}
