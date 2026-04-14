import { useEffect, useRef } from 'react';
import Artplayer from 'artplayer';
import artplayerPluginDanmuku from 'artplayer-plugin-danmuku';

const s = {
  wrapper: { width: '100%', position: 'relative' },
  player: { width: '100%', aspectRatio: '16/9', background: '#000' },
};

export default function VideoPlayer({ videoUrl, danmakuList, subtitleUrl, subtitleType, subtitleContent, onEnded }) {
  const containerRef = useRef(null);
  const artRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !videoUrl) return;

    // All subtitle types use VTT via Artplayer's native subtitle
    // (ASS is converted to VTT by the extraction worker)
    const subtitleConfig = subtitleUrl
      ? { url: subtitleUrl, type: 'vtt', encoding: 'utf-8', style: { color: '#fff', fontSize: '20px' } }
      : {};

    const art = new Artplayer({
      container: containerRef.current,
      url: videoUrl,
      autoSize: true,
      fullscreen: true,
      autoplay: true,
      theme: '#0a84ff',
      volume: 0.8,
      subtitle: subtitleConfig,
      plugins: [
        artplayerPluginDanmuku({
          danmuku: danmakuList || [],
          speed: 5,
          opacity: 0.8,
          fontSize: 24,
          antiOverlap: true,
          synchronousPlayback: true,
          emitter: false,
        }),
      ],
    });

    if (onEnded) art.on('video:ended', onEnded);

    artRef.current = art;
    return () => {
      art.destroy(false);
      artRef.current = null;
    };
  }, [videoUrl, subtitleUrl, subtitleType, subtitleContent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const danmuku = artRef.current?.plugins?.artplayerPluginDanmuku;
    if (danmuku && danmakuList?.length) {
      danmuku.load(danmakuList);
    }
  }, [danmakuList]);

  return (
    <div style={s.wrapper}>
      <div ref={containerRef} style={s.player} />
    </div>
  );
}
