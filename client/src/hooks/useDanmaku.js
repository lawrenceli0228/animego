import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import { getDanmaku } from '../api/danmaku.api'
import { getAccessToken } from '../api/axiosClient'

// HTTP: fetch historical danmaku for an episode
export function useDanmakuHistory(anilistId, episode, enabled) {
  return useQuery({
    queryKey: ['danmaku', anilistId, episode],
    queryFn: () => getDanmaku(anilistId, episode).then(r => r.data),
    enabled: !!enabled,
    staleTime: 30_000,
  })
}

// WebSocket: real-time danmaku for an episode
export function useDanmakuSocket(anilistId, episode, enabled) {
  const socketRef = useRef(null)
  const [live, setLive]           = useState([])    // new messages since mount
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled) return

    if (!getAccessToken()) return   // must be logged in to receive live danmaku

    const base = import.meta.env.VITE_API_BASE_URL
      ? import.meta.env.VITE_API_BASE_URL.replace('/api', '')
      : ''

    const socket = io(base, {
      auth: (cb) => cb({ token: getAccessToken() }),
      transports: ['websocket'],
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      socket.emit('danmaku:join', { anilistId, episode })
    })
    socket.on('disconnect', () => setConnected(false))
    socket.on('auth:expired', () => socket.disconnect())

    socket.on('danmaku:new', (msg) => {
      setLive(prev => [...prev, msg])
    })

    return () => {
      socket.emit('danmaku:leave', { anilistId, episode })
      socket.disconnect()
      socketRef.current = null
    }
  }, [anilistId, episode, enabled])

  const send = useCallback((content) => {
    socketRef.current?.emit('danmaku:send', { anilistId, episode, content })
  }, [anilistId, episode])

  return { live, connected, send }
}
