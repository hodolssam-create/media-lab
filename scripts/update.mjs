// 의제와 프레임 실험실 · 매일 사설 자동 수집 스크립트 (v3.1)
//
// 원칙
// 1. 자동 수집은 사설의 '제목·링크·발행일'만 확인한다. 본문을 읽지 않았으므로
//    요약·핵심 메시지·프레임 분석을 만들어 넣지 않는다(autoCollected 표시).
// 2. AI(Gemini)는 같은 사건을 다룬 사설을 묶는 '의제명' 붙이기에만 쓴다.
//    API 키가 없거나 AI 호출이 실패하면 제목 키워드 규칙으로 대신 분류한다.
// 3. 발행일은 RSS의 pubDate를 한국 시간으로 바꿔 기록한다(수집일로 덮어쓰지 않음).

import fs from 'fs';

const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const DAY_MS = 24 * 3600 * 1000;
const kstDate = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const now = new Date();
const today = kstDate(now);

const OUTLETS = [
  { id: 'chosun', name: '조선일보', group: '보수', home: 'https://www.chosun.com/opinion/editorial/', q: 'site:chosun.com/opinion/editorial "[사설]"' },
  { id: 'joongang', name: '중앙일보', group: '보수', home: 'https://www.joongang.co.kr/opinion/editorialcolumn', q: 'site:joongang.co.kr "[사설]"' },
  { id: 'donga', name: '동아일보', group: '보수', home: 'https://www.donga.com/news/Opinion', q: 'site:donga.com/news/Opinion "[사설]"' },
  { id: 'hani', name: '한겨레', group: '진보', home: 'https://www.hani.co.kr/arti/opinion/editorial', q: 'site:hani.co.kr/arti/opinion/editorial "[사설]"' },
  { id: 'khan', name: '경향신문', group: '진보', home: 'https://www.khan.co.kr/opinion/editorial/articles', q: 'site:khan.co.kr "[사설]"' },
  { id: 'hankook', name: '한국일보', group: '중도', home: 'https://www.hankookilbo.com', q: 'site:hankookilbo.com "[사설]"' }
];
const PER_OUTLET = 3;
const WINDOW = '2d';

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .trim();
const pick = (block, tag) => decode((block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [, ''])[1]);

async function fetchRSS(outlet) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(outlet.q + ' when:' + WINDOW)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const seen = new Set();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => {
      const block = m[1];
      const title = pick(block, 'title').replace(/\s+-\s+[^-]+$/, '').trim(); // 끝의 " - 언론사명" 제거
      const link = pick(block, 'link');
      const pub = new Date(pick(block, 'pubDate'));
      return { title, link, pub: isNaN(pub) ? null : pub };
    })
    .filter((it) => it.title && it.link && /\[사설\]/.test(it.title))  // 제목에 [사설]이 붙은 글만 남김
    .filter((it) => !seen.has(it.link) && seen.add(it.link))
    .sort((a, b) => (b.pub?.getTime() || 0) - (a.pub?.getTime() || 0))
    .slice(0, PER_OUTLET);
}

// AI가 실패했을 때 쓰는 제목 키워드 분류(index.html의 실시간 수집 경로와 같은 규칙)
function guessIssueFromTitle(title) {
  const rules = [
    ['한미 외교·안보', /한미|외교|동맹|북한|안보|관세|트럼프|미국|중국|국방/],
    ['의회·정치 갈등', /국회|여당|야당|대통령|특검|탄핵|의원|정쟁|독재|입법|공천|정치/],
    ['사법·검찰·인권', /대법|법원|검찰|재판|인권|판사|수사|구속|기소/],
    ['경제·산업·기술', /반도체|경제|성장|수출|주가|금리|재정|기업|AI|환율/],
    ['부동산·주거·지역', /집값|부동산|주택|대출|전세|그린벨트|공급|LH|세종|수도권/],
    ['사회·안전·교육', /범죄|안전|의대|교육|시험|수능|연금|노동|의료|기후|환경|이주|다문화|외국인/]
  ];
  for (const [label, reg] of rules) if (reg.test(title)) return label;
  return '기타 오늘의 시사 현안';
}

async function getAvailableModels() {
  const defaults = ['gemini-2.5-flash'];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
    const data = await res.json();
    if (data.models) {
      const dynamic = data.models
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && m.name.includes('gemini'))
        .map((m) => m.name.replace('models/', ''))
        .sort((a, b) => (b.includes('flash') ? 1 : 0) - (a.includes('flash') ? 1 : 0));
      return [...new Set([...dynamic, ...defaults])];
    }
  } catch (e) {}
  return defaults;
}

// 제목 목록만 주고 '의제명'만 받는다. 요약·주장·프레임은 요청하지 않는다.
async function classifyIssues(list) {
  if (!API_KEY) return null;
  const prompt = `다음은 한국 6개 종합일간지의 사설 제목 목록입니다. 각 사설에 '의제명'만 붙이세요.

규칙
- 의제명은 사설이 다루는 사건·주제의 이름입니다. 찬반, 책임 판단, 평가어(예: 논란 자초, 실패, 폭주)를 넣지 마세요.
- 같은 사건·정책을 다룬 사설은 반드시 같은 의제명으로 묶으세요.
- 의제명은 25자 이내의 명사구로 쓰세요.
- 제목에 없는 사실을 추측해 넣지 마세요.
- 응답은 마크다운 없이 순수 JSON만: {"issues":[{"id":"...","issue":"..."}]}

사설 목록:
${JSON.stringify(list.map(({ id, title }) => ({ id, title })), null, 2)}`;

  for (const model of await getAvailableModels()) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } })
      });
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!res.ok || !text) { console.warn(`${model} 호출 실패:`, JSON.stringify(data.error || data).slice(0, 300)); continue; }
      const parsed = JSON.parse(text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim());
      const map = new Map((parsed.issues || []).map((x) => [x.id, String(x.issue || '').trim().slice(0, 40)]));
      if (list.every((a) => map.get(a.id))) { console.log(`✅ ${model}로 의제명 분류`); return { map, model }; }
      console.warn(`${model}: 일부 사설의 의제명이 비어 있어 다음 모델을 시도합니다.`);
    } catch (e) {
      console.warn(`${model} 처리 오류:`, e.message);
    }
  }
  return null;
}

async function main() {
  const list = [];
  const coverage = {};
  for (const o of OUTLETS) {
    try {
      const items = await fetchRSS(o);
      coverage[o.id] = items.length;
      console.log(`${o.name}: ${items.length}편`);
      items.forEach((it, i) => list.push({ id: `${o.id}${i + 1}`, outlet: o.id, ...it }));
    } catch (e) {
      coverage[o.id] = 0;
      console.warn(`${o.name} RSS 수집 오류:`, e.message);
    }
  }
  if (!list.length) { console.error('❌ 수집된 사설이 0편입니다. 기존 자료를 유지합니다.'); process.exit(1); }

  const ai = await classifyIssues(list);
  if (!ai) console.warn('AI 분류를 쓰지 못해 제목 키워드 규칙으로 의제를 분류합니다.');

  const articles = list.map((a) => ({
    id: a.id,
    outlet: a.outlet,
    title: a.title,
    published: a.pub ? kstDate(a.pub) : today,
    publishedVerified: !!a.pub,
    issue: ai ? ai.map.get(a.id) : guessIssueFromTitle(a.title),
    url: a.link,
    summary: '제목·링크·발행일만 자동으로 확인한 자료입니다. [원문 읽기]로 본문을 확인하고 직접 요약해 보세요.',
    summaryKind: '자동 수집 · 제목만 확인',
    message: '원문을 읽고 이 사설의 핵심 주장을 한 문장으로 정리해 보세요.',
    quote: a.title.replace(/^\[사설\]\s*/, ''),
    quoteLocation: '사설 제목',
    verification: '제목',
    autoCollected: true,
    frame: {
      problem: '원문 확인 후 직접 판독',
      cause: '원문 확인 후 직접 판독',
      value: '원문 확인 후 직접 판독',
      solution: '원문 확인 후 직접 판독',
      missing: '다른 신문 사설과 비교해 덜 드러난 관점을 찾아보세요.'
    },
    frameTags: []
  }));

  const dataset = {
    schemaVersion: 1,
    id: `editorials-${today}-v1`,
    title: `${today} 조간 사설`,
    issueDate: today,
    checkedAt: today,
    scope: `6개 종합일간지의 최근 ${WINDOW.replace('d', '일')} '[사설]' 검색 결과에서 신문별 최대 ${PER_OUTLET}편을 자동 수집했습니다. 제목·링크·발행일만 확인했으며 요약과 프레임 분석은 넣지 않았습니다. 의제명은 ${ai ? 'AI가 제목만 보고 붙인' : '제목 키워드로 붙인'} 임시 분류입니다.`,
    classificationNote: '보수·진보·중도는 비교 수업을 위한 잠정적 분류입니다.',
    auto: {
      method: 'GitHub Actions 자동 수집',
      collectedAt: now.toISOString(),
      verification: '제목',
      issueClassifier: ai ? `AI(${ai.model}) · 제목 기준` : '제목 키워드 규칙'
    },
    outlets: OUTLETS.map(({ id, name, group, home }) => ({ id, name, group, home, coverage: `자동 수집 ${coverage[id] || 0}편 · 제목만 확인` })),
    articles
  };

  fs.writeFileSync('latest-dataset.json', JSON.stringify(dataset, null, 2), 'utf8');
  console.log(`✅ latest-dataset.json 업데이트 완료 (${articles.length}편)`);
}

main().catch((err) => { console.error('❌ 실행 중 예외 발생:', err); process.exit(1); });
