import { useState, useCallback } from 'react';
import { getComments } from '../api/dandanplay.api';
import { dandanToArtplayer } from '../utils/episodeParser';

export default function useDandanComments() {
  const [danmakuList, setDanmakuList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [count, setCount] = useState(0);

  const loadComments = useCallback(async (episodeId) => {
    if (!episodeId) return;
    setLoading(true);
    setError(null);

    try {
      const data = await getComments(episodeId);
      const converted = (data.comments || []).map(dandanToArtplayer);
      setDanmakuList(converted);
      setCount(data.count || 0);
    } catch (err) {
      setError(err.message || 'Failed to load comments');
      setDanmakuList([]);
      setCount(0);
    } finally {
      setLoading(false);
    }
  }, []);

  const clearComments = useCallback(() => {
    setDanmakuList([]);
    setCount(0);
    setError(null);
  }, []);

  return { danmakuList, loading, error, count, loadComments, clearComments };
}
