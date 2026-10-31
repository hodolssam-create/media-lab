import fs from 'fs';

const API_KEY = process.env.GEMINI_API_KEY;
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const OUTLETS = [
  { id: 'chosun', name: '조선일보', group: '보수', home: 'https://www.chosun.com/opinion/editorial/', q: 'site:chosun.com/opinion/editorial "[사설]"' },
  { id: 'joongang', name: '중앙일보', group: '보수', home: 'https://www.joongang.co.kr/opinion/editorialcolumn', q: 'site:joongang.co.kr "[사설]"' },
  { id: 'donga', name: '동아일보', group: '보수', home: 'https://www.donga.com/news/Opinion', q: 'site:donga.com/news/Opinion "[사설]"' },
  { id: 'hani', name: '한겨레', group: '진보', home: 'https://www.hani.co.kr/arti/opinion/editorial', q: 'site:hani.co.kr/arti/opinion/editorial "[사설]"' },
  { id: 'khan', name: '경향신문', group: '진보', home: 'https://www.khan.co.kr/opinion/editorial/articles', q: 'site:khan.co.kr "[사설]"' },
  { id: 'hankook', name: '한국일보', group: '중도', home: 'https://www.hankookilbo.com', q: 'site:hankookilbo.com "[사설]"' }
];

async function fetchRSS(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:2d')}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 3);
  return items.map(m => {
    const block = m[1];
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/) || [,''])[1].replace(/\s*-\s*[^-]+$/, '').trim();
    const link = (block.match(/<link>(.*?)<\/link>/) || [,''])[1].trim();
    const desc = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || block.match(/<description>(.*?)<\/description>/) || [,''])[1].replace(/<[^>]+>/g, ' ').trim();
    return { title, link, desc };
  });
}

async function main() {
  const rawList = [];
  for (const o of OUTLETS) {
    const items = await fetchRSS(o.q);
    items.forEach((it, idx) => rawList.push({ id: `${o.id}${idx + 1}`, outlet: o.id, outletName: o.name, published: today, ...it }));
  }

  const prompt = `당신은 고등학교 '사회와 문화' 미디어 리터러시 수업 자료 제작자입니다.
다음 오늘자(${today}) 6대 일간지 사설 목록을 분석하여 프로그램용 JSON 데이터를 생성하세요.
- 같은 주제를 다루는 사설들은 동일한 'issue'(의제명)로 묶어 비교 가능하게 하세요.
- frameTags는 반드시 ["책임","갈등","위기","주권","원칙","효율","시민"] 중에서만 1~2개 고르세요.
- verification은 "발췌" 또는 "제목"으로 표기하세요.
- 응답은 마크다운 코드블록 없이 순수 JSON만 출력하세요.

입력 사설 목록:
${JSON.stringify(rawList, null, 2)}

출력 JSON 형식:
{
  "schemaVersion": 1,
  "id": "editorials-${today}-v1",
  "title": "${today} 조간 사설",
  "issueDate": "${today}",
  "checkedAt": "${today}",
  "scope": "6개 종합일간지 최신 사설 자동 수집 및 AI 재구성 자료",
  "classificationNote": "보수·진보·중도는 비교 수업을 위한 잠정적 분류입니다.",
  "outlets": ${JSON.stringify(OUTLETS.map(({id, name, group, home}) => ({id, name, group, home, coverage: '자동 수집 사설 수록'})))},
  "articles": [
    {
      "id": "c1", "outlet": "chosun", "title": "사설 제목", "published": "${today}", "issue": "비교 가능한 공통 의제명",
      "url": "https://...", "summary": "2~3문장 요약", "message": "핵심 주장 한 문장",
      "quote": "제목 또는 발췌 핵심 구절", "quoteLocation": "제목의 표현", "verification": "발췌",
      "frame": { "problem": "문제 정의", "cause": "원인·책임", "value": "핵심 가치", "solution": "제시 해법", "missing": "덜 드러난 대안 관점" },
      "frameTags": ["책임", "원칙"]
    }
  ]
}`;

  const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });

  const aiData = await aiRes.json();
  const jsonText = aiData.candidates[0].content.parts[0].text;
  const parsed = JSON.parse(jsonText);

  fs.writeFileSync('latest-dataset.json', JSON.stringify(parsed, null, 2), 'utf8');
  console.log('latest-dataset.json 업데이트 완료!');
}

main();
