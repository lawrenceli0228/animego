const { buildEpisodeMap } = require('../../shared/episodeMap.cjs');

describe('buildEpisodeMap — level 1: pure number match', () => {
  it('maps requested episodes to dandan episodes by number', () => {
    const dandan = [
      { dandanEpisodeId: 5001, title: '第1話', number: 1, rawEpisodeNumber: '1' },
      { dandanEpisodeId: 5002, title: '第2話', number: 2, rawEpisodeNumber: '2' },
      { dandanEpisodeId: 5003, title: '第3話', number: 3, rawEpisodeNumber: '3' },
    ];
    const map = buildEpisodeMap(dandan, [1, 3]);
    expect(map[1].dandanEpisodeId).toBe(5001);
    expect(map[3].dandanEpisodeId).toBe(5003);
    expect(map[2]).toBeUndefined();
  });

  it('returns empty map for empty dandanEpisodes', () => {
    expect(buildEpisodeMap([], [1, 2])).toEqual({});
  });

  it('returns empty map when dandanEpisodes is null/undefined', () => {
    expect(buildEpisodeMap(null, [1])).toEqual({});
    expect(buildEpisodeMap(undefined, [1])).toEqual({});
  });
});

describe('buildEpisodeMap — level 2: OVA/Special prefix', () => {
  it('matches O1/S1 prefixes to numeric epNum', () => {
    const dandan = [
      { dandanEpisodeId: 1, title: 'Regular', number: 1, rawEpisodeNumber: '1' },
      { dandanEpisodeId: 100, title: 'OVA 1', number: null, rawEpisodeNumber: 'O1' },
      { dandanEpisodeId: 200, title: 'Special 2', number: null, rawEpisodeNumber: 'S2' },
    ];
    // Request OVA epNum=1 when no pure-numeric 1 exists first — drop the regular to force level 2
    const map = buildEpisodeMap(dandan.slice(1), [1, 2]);
    expect(map[1].dandanEpisodeId).toBe(100);
    expect(map[2].dandanEpisodeId).toBe(200);
  });
});

describe('buildEpisodeMap — level 3: index-based fallback for continuation seasons', () => {
  // Regression: Oshi no Ko S3 (animeId 18901) has raw numbers 25..35 for real
  // episodes plus C1/C2/C3 for openings/endings. User file parses as epNum=11.
  const s3 = [
    { dandanEpisodeId: 9025, title: '第25话 投入', number: 25, rawEpisodeNumber: '25' },
    { dandanEpisodeId: 9026, title: '第26话 盘算', number: 26, rawEpisodeNumber: '26' },
    { dandanEpisodeId: 9027, title: '第27话 规范', number: 27, rawEpisodeNumber: '27' },
    { dandanEpisodeId: 9028, title: '第28话 盲目', number: 28, rawEpisodeNumber: '28' },
    { dandanEpisodeId: 9029, title: '第29话 应酬', number: 29, rawEpisodeNumber: '29' },
    { dandanEpisodeId: 9030, title: '第30话 偶像与恋爱', number: 30, rawEpisodeNumber: '30' },
    { dandanEpisodeId: 9031, title: '第31话 决裂', number: 31, rawEpisodeNumber: '31' },
    { dandanEpisodeId: 9032, title: '第32话 计画', number: 32, rawEpisodeNumber: '32' },
    { dandanEpisodeId: 9033, title: '第33话 拜金与热情', number: 33, rawEpisodeNumber: '33' },
    { dandanEpisodeId: 9034, title: '第34话 私下试镜会', number: 34, rawEpisodeNumber: '34' },
    { dandanEpisodeId: 9035, title: '第35话 那就是一切的开端', number: 35, rawEpisodeNumber: '35' },
    { dandanEpisodeId: 8001, title: 'C1 Opening 1', number: null, rawEpisodeNumber: 'C1' },
    { dandanEpisodeId: 8002, title: 'C2 Opening 2', number: null, rawEpisodeNumber: 'C2' },
    { dandanEpisodeId: 8003, title: 'C3 Ending', number: null, rawEpisodeNumber: 'C3' },
  ];

  it('REGRESSION: Oshi no Ko S3 E11 maps to 第35话 (the 11th regular episode)', () => {
    const map = buildEpisodeMap(s3, [11]);
    expect(map[11]).toBeDefined();
    expect(map[11].dandanEpisodeId).toBe(9035);
    expect(map[11].title).toBe('第35话 那就是一切的开端');
  });

  it('REGRESSION: index fallback filters C1/C2/C3 specials so E12 does NOT map to Opening', () => {
    // S3 has only 11 regular episodes. E12 should either map to nothing or
    // to something non-C prefixed — never to C1 Opening 1.
    const map = buildEpisodeMap(s3, [12]);
    if (map[12]) {
      expect(map[12].dandanEpisodeId).not.toBe(8001); // not C1
      expect(map[12].dandanEpisodeId).not.toBe(8002); // not C2
      expect(map[12].dandanEpisodeId).not.toBe(8003); // not C3
    }
  });

  it('REGRESSION: batch request [1..11] on S3 all map correctly via index fallback', () => {
    const map = buildEpisodeMap(s3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(map[1].dandanEpisodeId).toBe(9025);
    expect(map[11].dandanEpisodeId).toBe(9035);
    expect(Object.keys(map)).toHaveLength(11);
  });

  it('partial level-1 hit does not defeat level-3 for the misses', () => {
    // Mixed: one episode matches level 1 (number=25 = epNum=25), others need index
    const map = buildEpisodeMap(s3, [25, 1, 2]);
    expect(map[25].dandanEpisodeId).toBe(9025); // level 1
    expect(map[1].dandanEpisodeId).toBe(9025);  // level 3 — also 9025 (index 0)
    expect(map[2].dandanEpisodeId).toBe(9026);  // level 3
  });
});

describe('buildEpisodeMap — regular S1 anime (no regression)', () => {
  it('standard 1..12 episode anime maps cleanly at level 1', () => {
    const s1 = Array.from({ length: 12 }, (_, i) => ({
      dandanEpisodeId: 1000 + i + 1,
      title: `第${i + 1}話`,
      number: i + 1,
      rawEpisodeNumber: String(i + 1),
    }));
    const map = buildEpisodeMap(s1, [1, 7, 12]);
    expect(map[1].dandanEpisodeId).toBe(1001);
    expect(map[7].dandanEpisodeId).toBe(1007);
    expect(map[12].dandanEpisodeId).toBe(1012);
  });
});
