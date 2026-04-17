import { useState, useCallback } from 'react';
import { getComments } from '../api/dandanplay.api';
import { dandanToArtplayer } from '../utils/episodeParser';
import useIsMounted from './useIsMounted';

export default function useDandanComments() {
  const [danmakuList, setDanmakuList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [count, setCount] = useState(0);
  const mounted = useIsMounted();

  const loadComments = useCallback(async (episodeId) => {
    if (!episodeId) return;
    setLoading(true);
    setError(null);

    try {
      const data = await getComments(episodeId);
      if (!mounted.current) return;
      const converted = (data.comments || []).map(dandanToArtplayer);
      setDanmakuList(converted);
      setCount(data.count || 0);
    } catch (err) {
      if (!mounted.current) return;
      // 401 is handled globally via auth:expired — don't surface it as a load error
      if (err?.response?.status === 401) {
        setDanmakuList([]);
        setCount(0);
        return;
      }
      setError(err.message || 'Failed to load comments');
      setDanmakuList([]);
      setCount(0);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [mounted]);

  const clearComments = useCallback(() => {
    setDanmakuList([]);
    setCount(0);
    setError(null);
  }, []);

  return { danmakuList, loading, error, count, loadComments, clearComments };
}
